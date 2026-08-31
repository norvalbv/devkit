/**
 * `guard-decisions integrity --staged` — the commit-time half of the structural-integrity check.
 *
 * Judges only the records a commit touches, and only findings absent from the same record at HEAD.
 * Identity is (slug, check, block), never the slug: the decision log is append-only, so a record
 * carrying an unrepairable historical finding must stay committable.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { envFlag, resolveFromCwd, resolveGuardConfig } from '../../config.mts';
import { repositorySource } from '../../eval/source.mts';
import { emitGateBypass } from '../../judge/gate-events.mts';
import { stagedTouchedSet } from '../../ratchets/git-index.mts';
import { type IndexRow, parseDecision, parseIndex } from '../decision-format.mts';
import { axisNotes } from '../recall/note-relations.mts';
import { checkAxis, type IntegrityFinding, integrityFindingKey } from './checks.mts';

// envFlag prepends GUARD_/FRINK_, so it takes the bare suffix; every message prints the full
// canonical name, which is the only spelling a remedy line may show.
const BYPASS_SUFFIX = 'DECISIONS_INTEGRITY_OK';
const BYPASS_FLAG = `GUARD_${BYPASS_SUFFIX}`;
const BYPASS_REMEDY =
  '   Believe the finding is wrong? Assert it for THIS run only:\n' +
  `     export ${BYPASS_FLAG}=1`;

export interface StagedIntegrityVerdict {
  code: 0 | 1;
  /** Findings on an in-scope record that do NOT exist at HEAD — this change introduced them. */
  blocking: IntegrityFinding[];
  /** In-scope findings already present at HEAD — reported, never blocking. */
  preexisting: IntegrityFinding[];
  scoped: string[];
  /** Set when nothing could be judged (no git, no decisions dir); never a verdict. */
  inert: string | null;
}

/**
 * Resolve the worktree root, because `stagedSet` reports paths relative to it and the decisions dir
 * is matched against them by prefix. Taking `cwd` on faith would silently mis-scope every path when
 * the gate is invoked from a subdirectory — a scoping miss reports nothing rather than failing.
 */
function repoRoot(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  try {
    return realpathSync(result.stdout.trim());
  } catch {
    return null;
  }
}

/**
 * The path prefix for a record inside the decisions dir. `decisionsDir: "."` is legal and makes the
 * root-relative dir empty, where a bare `<rel>/` would be "/" and match nothing — silently scoping a
 * root-level corpus out of the gate entirely.
 */
function decisionsPrefix(decisionsRel: string): string {
  return decisionsRel ? `${decisionsRel}/` : '';
}

function indexRowMap(text: string | null): Map<string, IndexRow> {
  return new Map((text ? parseIndex(text) : []).map((r) => [r.slug, r]));
}

/**
 * Which axis slugs does this commit put in scope?
 *
 * A staged INDEX.md contributes every slug whose row CHANGED, because `checkIndexStale` compares
 * the row's date against the axis's own last Target — so an INDEX edit can make a record stale
 * without that record being staged. Removed rows are deliberately not scoped: checkIndexStale
 * returns nothing for an absent row, so a removal cannot produce a finding to attribute.
 */
function scopedSlugs(staged: Set<string>, decisionsRel: string, root: string): string[] {
  const slugs = new Set<string>();
  const prefix = decisionsPrefix(decisionsRel);
  const indexRel = `${prefix}INDEX.md`;
  for (const file of staged) {
    if (!file.startsWith(prefix) || !file.endsWith('.md')) continue;
    if (file.slice(prefix.length).includes('/')) continue;
    if (file === indexRel) continue;
    slugs.add(path.basename(file, '.md'));
  }
  if (staged.has(indexRel)) {
    const now = indexRowMap(repositorySource(root, 'staged').read(indexRel));
    const base = indexRowMap(repositorySource(root, 'tree', 'HEAD').read(indexRel));
    for (const [slug, row] of now) {
      const was = base.get(slug);
      if (!was || was.updated !== row.updated || was.ruling !== row.ruling) slugs.add(slug);
    }
  }
  return [...slugs].sort();
}

interface CorpusNotes {
  /** slug -> note ids that axis defines. */
  ids: Map<string, Set<string>>;
  /** slug -> fully-qualified `<slug>#<id>` pointers that axis declares via `**Amends:**`. */
  refs: Map<string, Set<string>>;
}

/**
 * Note ids and declared pointers, read from ONE snapshot. Only paid on a commit that actually stages
 * a decision record, so the ~95% of commits that touch none never reach it.
 */
function corpusNotes(
  source: ReturnType<typeof repositorySource>,
  decisionsRel: string,
): CorpusNotes {
  const ids = new Map<string, Set<string>>();
  const refs = new Map<string, Set<string>>();
  const prefix = decisionsPrefix(decisionsRel);
  for (const file of source.listFiles()) {
    if (!file.startsWith(prefix) || !file.endsWith('.md')) continue;
    if (file.slice(prefix.length).includes('/')) continue;
    if (file === `${prefix}INDEX.md`) continue;
    const text = source.read(file);
    if (text === null) continue;
    const slug = path.basename(file, '.md');
    const notes = axisNotes(parseDecision(text).body);
    ids.set(slug, new Set(notes.map((n) => n.id)));
    refs.set(
      slug,
      new Set(
        notes
          .map((n) => n.amends)
          .filter((a): a is string => a !== null)
          .map((a) => (a.includes('#') ? a : `${slug}#${a}`)),
      ),
    );
  }
  return { ids, refs };
}

/**
 * Axes that must be judged even though this commit did not stage them: removing a note leaves every
 * pointer to it dangling, and the axis holding that pointer may be untouched. Without this the
 * commit that breaks the reference is the one commit that never checks it.
 */
function slugsOrphanedByRemovedNotes(now: CorpusNotes, head: CorpusNotes): string[] {
  const removed = new Set<string>();
  for (const [slug, before] of head.ids) {
    const after = now.ids.get(slug) ?? new Set<string>();
    for (const id of before) if (!after.has(id)) removed.add(`${slug}#${id}`);
  }
  if (!removed.size) return [];
  const orphaned: string[] = [];
  for (const [slug, declared] of now.refs) {
    for (const ref of declared) {
      if (removed.has(ref)) {
        orphaned.push(slug);
        break;
      }
    }
  }
  return orphaned;
}

/** Counts per finding key: two same-day Targets share a key, so a set would hide the second. */
function keyCounts(findings: IntegrityFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const key = integrityFindingKey(f);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Pure verdict — no printing, no process.exit, so tests can assert the partition directly. */
export function judgeStagedIntegrity(cwd = process.cwd()): StagedIntegrityVerdict {
  const empty = { code: 0 as const, blocking: [], preexisting: [], scoped: [] };
  const root = repoRoot(cwd);
  if (root === null)
    return { ...empty, inert: 'could not attribute this change (git unavailable)' };

  // Config resolved from the ROOT, not cwd: `decisionsDir` is a relative path, so resolving it
  // against a subdirectory yields <subdir>/docs/decisions and scopes nothing. Both sides are
  // realpath'd because repoRoot resolves symlinks and stagedSet's paths hang off that same root.
  const configured = resolveFromCwd(resolveGuardConfig(root), 'decisionsDir');
  if (!configured || !existsSync(configured)) return { ...empty, inert: null };
  const dir = realpathSync(configured);

  const staged = stagedTouchedSet(root);
  // No staged set means git could not answer, so there is no change to attribute. Blaming the tree
  // here is precisely what the ratchets ruling forbids.
  if (staged === null)
    return { ...empty, inert: 'could not attribute this change (git unavailable)' };

  const decisionsRel = path.relative(root, dir).replaceAll('\\', '/');
  const stagedSlugs = scopedSlugs(staged, decisionsRel, root);
  // The ~95% path: nothing decision-shaped is staged, so the corpus is never read at all.
  if (!stagedSlugs.length) return { ...empty, inert: null };

  const now = repositorySource(root, 'staged');
  const head = repositorySource(root, 'tree', 'HEAD');
  // Each side resolves cross-axis note ids against its OWN snapshot, never the worktree. Sharing one
  // map looks cheaper and is wrong in both directions: a staged `**Amends:**` pointer would resolve
  // against an unstaged referent, and removing a note another axis points at would make the newly
  // dangling pointer appear at HEAD too, classifying a defect this commit introduced as pre-existing.
  const nowNotes = corpusNotes(now, decisionsRel);
  const headNotes = corpusNotes(head, decisionsRel);
  const nowNoteIds = nowNotes.ids;
  const headNoteIds = headNotes.ids;
  const scoped = [
    ...new Set([...stagedSlugs, ...slugsOrphanedByRemovedNotes(nowNotes, headNotes)]),
  ].sort();
  const prefix = decisionsPrefix(decisionsRel);
  const nowRows = indexRowMap(now.read(`${prefix}INDEX.md`));
  const headRows = indexRowMap(head.read(`${prefix}INDEX.md`));

  const blocking: IntegrityFinding[] = [];
  const preexisting: IntegrityFinding[] = [];
  for (const slug of scoped) {
    const rel = `${prefix}${slug}.md`;
    const nowText = now.read(rel);
    if (nowText === null) continue; // staged deletion — no record left to judge
    const headText = head.read(rel);
    const parse = (text: string) => ({ slug, ...parseDecision(text) });
    const current = checkAxis(parse(nowText), nowRows.get(slug), nowNoteIds);
    // An unborn HEAD or a brand-new record has no history to inherit: every finding is yours.
    const remaining = keyCounts(
      headText ? checkAxis(parse(headText), headRows.get(slug), headNoteIds) : [],
    );
    for (const f of current) {
      const key = integrityFindingKey(f);
      const left = remaining.get(key) ?? 0;
      if (left > 0) {
        remaining.set(key, left - 1);
        preexisting.push(f);
      } else {
        blocking.push(f);
      }
    }
  }
  return { code: blocking.length ? 1 : 0, blocking, preexisting, scoped, inert: null };
}

function describe(f: IntegrityFinding): string {
  return `   ${f.slug} [${f.check}] — ${f.detail}`;
}

/** Print the verdict and return the exit code the hook propagates. */
export function runStagedIntegrity(cwd = process.cwd()): number {
  if (envFlag(BYPASS_SUFFIX)) {
    emitGateBypass('decisions-integrity', BYPASS_FLAG);
    console.log(`⚠️  Decision integrity gate BYPASSED for this run (${BYPASS_FLAG}=1).`);
    console.log('   No staged decision record was checked for this commit.');
    return 0;
  }

  let verdict: StagedIntegrityVerdict;
  try {
    verdict = judgeStagedIntegrity(cwd);
  } catch (e: unknown) {
    // An environmental throw must not read as a finding: this gate blocks on every non-zero code.
    console.log(
      `⚠ Decision integrity did not run (${e instanceof Error ? e.message : String(e)}) — nothing was judged.`,
    );
    return 0;
  }

  if (verdict.inert) {
    console.log(`⚠ Decision integrity ${verdict.inert} — nothing was judged.`);
    return 0;
  }
  if (verdict.preexisting.length) {
    console.log(
      `ℹ ${verdict.preexisting.length} structural-integrity finding(s) on a record you touched (not this change):`,
    );
    for (const f of verdict.preexisting) console.log(describe(f));
    console.log(
      '   Already like this at HEAD, and the decision log is append-only — repaired by a new\n' +
        '   `guard-decisions amend`, never in place. This commit is not blocked by it.',
    );
  }
  if (!verdict.blocking.length) {
    console.log(
      verdict.scoped.length
        ? `✓ Decision integrity passed (${verdict.scoped.length} record(s) in this change).`
        : '✓ Decision integrity passed (no decision records in this change).',
    );
    return 0;
  }

  console.error(
    `🚫 Decision integrity broken — ${verdict.blocking.length} new structural finding(s) on a record in this change:`,
  );
  for (const f of verdict.blocking) console.error(describe(f));
  console.error(
    '\n   These records do not have the shape `guard-decisions add`/`amend` would have written.\n' +
      '   Re-record the change through the CLI so the record and INDEX.md are regenerated together;\n' +
      '   a missing Evidence-change is repaired by a NEW `guard-decisions amend --evidence-change`.',
  );
  console.error(BYPASS_REMEDY);
  return 1;
}
