/**
 * Corpus-wide runner for the structural-integrity checks (checks.mts).
 *
 * Reads every axis file + INDEX.md fresh on each call — same read-time, no-write-back shape as
 * recall/supersession.mts and drift.mts, so a finding can never be a stale cache disagreeing with
 * what is actually on disk.
 *
 * Deliberately whole-corpus, not staged-files-only (unlike check-alignment's alignment pass): these
 * checks are cheap enough that scanning everything costs nothing, and a whole-corpus view is what lets
 * `guard-decisions integrity` answer "is the log clean" as a standalone question, the same way `drift`
 * already does. A single known historical exception (see checks.mts's docstring) does not make this a
 * check that "fires on every pre-existing record" (constraint the design survey measured against) — it
 * is one finding out of 39 blocks, reported honestly rather than hidden.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveFromCwd, resolveGuardConfig } from '../../config.mts';
import { type IndexRow, parseDecision, parseIndex } from '../decision-format.mts';
import { axisNoteIds } from '../recall/note-relations.mts';
import { type AxisDoc, checkAxis, type IntegrityFinding } from './checks.mts';

export interface ScanResult {
  findings: IntegrityFinding[];
  filesScanned: number;
}

function loadAxisDocs(dir: string): AxisDoc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
    .sort()
    .map((f) => {
      const slug = f.slice(0, -3);
      const { fm, body } = parseDecision(readFileSync(path.join(dir, f), 'utf8'));
      return { slug, fm, body };
    });
}

function loadIndexRows(dir: string): Map<string, IndexRow> {
  const indexPath = path.join(dir, 'INDEX.md');
  const rows = existsSync(indexPath) ? parseIndex(readFileSync(indexPath, 'utf8')) : [];
  return new Map(rows.map((r) => [r.slug, r]));
}

/** Scan a decisions directory (real or a frozen fixture corpus) and return every finding. */
export function scanCorpus(dir: string): ScanResult {
  if (!existsSync(dir)) return { findings: [], filesScanned: 0 };
  const axes = loadAxisDocs(dir);
  const indexRows = loadIndexRows(dir);
  // Cross-axis note ids, built once: a `slug#note:<date>` Amends can only be judged against the
  // OTHER file, and resolving it per-axis would re-read the corpus for every reference.
  const noteIds = new Map(axes.map((a) => [a.slug, axisNoteIds(a.body)]));
  const findings = axes.flatMap((axis) => checkAxis(axis, indexRows.get(axis.slug), noteIds));
  return { findings, filesScanned: axes.length };
}

/** `guard-decisions integrity` — exit 1 when any structural-integrity finding exists, else 0. Mirrors
 * runDrift's shape (a plain return value, never process.exit, so callers/tests choose how to surface
 * it) and its console-error remediation style. */
export function runIntegrity(dir: string): number {
  if (!existsSync(dir)) {
    console.error(`guard-decisions integrity: no such directory ${dir}`);
    return 2;
  }
  const { findings, filesScanned } = scanCorpus(dir);
  if (!findings.length) {
    console.log(
      `decision integrity: every record has the shape the CLI would have written ✓ (${filesScanned} files)`,
    );
    return 0;
  }
  console.error(
    `🚫 ${findings.length} structural-integrity finding(s) across ${filesScanned} file(s):`,
  );
  for (const f of findings) console.error(`   ${f.slug} [${f.check}] — ${f.detail}`);
  console.error(
    '\n   These records do not have the shape `guard-decisions add`/`amend` would have written — a ' +
      'hand-edit, a bad merge, or a non-CLI writer touched them. Repair the mechanical mismatch (slug, ' +
      'heading depth, INDEX date) so the file matches what the CLI would have produced; if a re-target ' +
      'is missing its Evidence-change, re-record it via `guard-decisions amend` (or a new --target with ' +
      '--evidence-change) rather than editing the ruling text in place.',
  );
  return 1;
}

/** `guard-decisions integrity` as the CLI invokes it: resolve the decisions dir from the CONSUMER
 * repo's config (never the package dir — W-3), then delegate. Split from runIntegrity so the tests and
 * the save-quality bench can keep pointing it at a fixture corpus by path. Mirrors cmdCategories(cwd)
 * rather than runDrift(root), because there is no second root-relative scan to do here — the checks
 * read the decision records and nothing else. */
export function cmdIntegrity(cwd = process.cwd()): number {
  const dir = resolveFromCwd(resolveGuardConfig(cwd), 'decisionsDir');
  if (!dir || !existsSync(dir)) {
    // A repo that has not recorded a decision yet is not a broken repo. runIntegrity keeps its
    // stricter contract (an explicit path that is not there → 2), because a path someone TYPED and
    // got wrong must not read as a pass; a configured default that nobody has populated is different.
    console.log('decision integrity: no decision records yet — nothing to check ✓');
    return 0;
  }
  return runIntegrity(dir);
}
