#!/usr/bin/env node

/**
 * Decision Log — architectural-decision *why* timeline.
 *
 * Captures the *target / why* behind reversible architectural choices (the "road not
 * taken"), keyed by decision *axis* (slug). The most recent ruling per axis is the living
 * architecture record. md is the source of truth; the per-axis embedding cache
 * (`<cwd>/.decisions/index.json`) is a derived, gitignored, rebuildable cache (lazy
 * content-hash rehash) used by `query`. It holds nothing the md files don't.
 *
 * APPEND-ONLY: a written entry is never mutated (rewriting a past ruling would lose the
 * flip-flop history this exists to preserve). The current ruling per axis = its LAST entry.
 * Per-file frontmatter is two immutable fields — {slug, created} — with NO current/updated/
 * status pointer (those duplicate the timeline and invite the "docs now say B" rewrite).
 *
 * Storage (git-tracked, under <decisionsDir>/, default docs/decisions/):
 *   INDEX.md          derived current-state spine: | [slug](slug.md) | current ruling | why-hook | updated |
 *                     (regenerable cache over the timelines — holds no history, so mutation-safe)
 *   <slug>.md         per-axis append-only timeline: {slug, created} frontmatter + dated entries
 *
 * A decision is an EPIC (PRD-altitude), not an impl patch-note. Each axis file = a stack of
 * `## Target ·` blocks (rare, the PRD) + cheap `- <date> — note`s (implementation convergence
 * under the current Target). INDEX shows the Target, never a note.
 *
 * ── W-3 (portability invariant) ──────────────────────────────────────────────────
 * All paths resolve relative to the CONSUMER cwd via resolveGuardConfig(cwd), NEVER
 * __dirname (the package dir). Run from a consumer's node_modules, this engine reads and
 * writes the CONSUMER's decision log, not files inside the package.
 *
 * Commands:
 *   add <slug> --target --context "..." --ruling "..." --consequences "..." --tradeoff "..."
 *              --vision-fit "..." [--title ... --researched ... --rejected ...
 *               --anchored-bet "[BET]" --scope "glob,glob" --source ... --ref ... --new
 *               --evidence-change "..."]                  (epic Target; updates INDEX)
 *   add <slug> --note "..."          cheap convergence note under the current Target (INDEX untouched)
 *   amend <slug> --target …|--note … replace only the newest entry when it is absent from HEAD
 *   query "<text>" [--top K] [--json]  rank axes — semantic (Ollama), lexical floor on fallback;
 *                                   --json emits the machine-readable envelope the bench scores
 *   reindex                         cold-build the derived embedding cache
 *   list / show <slug> / check <slug>
 *
 * Re-targeting an axis that already has a Target requires --evidence-change (a target moves only
 * on an evidence-state change, never on impl pain → that's a --note). APPEND-ONLY: never mutate a
 * past block; archive a mis-filed entry by moving it under a `## [archived …]` heading, never delete.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from '../config.mts';
import { amendDecision, type DecisionPaths } from './amend.mts';
import { writeFileAtomic } from './atomic-write.mts';
import {
  type AddOptions,
  currentTarget,
  hasTargetFields,
  type IndexRow,
  parseDecision,
  parseIndex,
  renderDecision,
  renderIndex,
  renderNote,
  renderTarget,
  sanitizeCell,
  today,
  upsertRow,
  whyHook,
} from './decision-format.mts';
import { type RankResult, rankAxes as rankAxesIn, reindexAll } from './recall/retrieval.mts';

export {
  type AddOptions,
  type CurrentTarget,
  currentTarget,
  type IndexRow,
  parseDecision,
  parseIndex,
  renderDecision,
  renderIndex,
  renderNote,
  renderTarget,
  type TargetOptions,
  upsertRow,
} from './decision-format.mts';
// The recall path lives in retrieval.mts; re-exported so consumers and tests keep one entry point.
export {
  bm25Rank,
  clampGist,
  cosine,
  gistOf,
  loadAxisRows,
  type RankResult,
} from './recall/retrieval.mts';

// Top-level regexes (these run in loops).
const TRAILING_WS_RE = /\s*$/;
/** How many qualifying notes the PROSE surface shows before pointing at `show`. */
const PROSE_QUALIFIERS = 3;

// ─── Consumer-cwd path resolution (W-3) ──────────────────────────────────────────
// Every on-disk path is derived from the CONSUMER cwd via the shared config loader.
// Resolved lazily (per call) so tests and consumers can vary cwd / GUARD_* env between
// invocations without the module caching a stale package-relative path.

// A parsed INDEX.md spine row (also the ranked-row base shape).
// Resolved on-disk paths for one consumer cwd.
interface Paths extends DecisionPaths {
  vecIndexPath: string;
}

function paths(cwd = process.cwd()): Paths {
  const cfg = resolveGuardConfig(cwd);
  const decisionsDir = resolveFromCwd(cfg, 'decisionsDir');
  // decisionsDir always resolves via DEFAULTS ('docs/decisions'); a null means a broken config
  // contract, so fail loud rather than feeding null into path.join.
  if (decisionsDir == null) throw new Error('decisionsDir did not resolve — check guard config');
  return {
    cwd,
    decisionsDir,
    indexPath: path.join(decisionsDir, 'INDEX.md'),
    // Derived, gitignored, rebuildable embedding cache for `query` (lazy content-hash rehash).
    // DECISIONS_INDEX overrides the location (tests point it at a temp file).
    vecIndexPath: process.env.DECISIONS_INDEX ?? path.join(cwd, '.decisions', 'index.json'),
  };
}

// ─── Small pure helpers (kept top-level for ATS chunking) ───────────────────────

function slugPath(p: Paths, slug: string) {
  return path.join(p.decisionsDir, `${slug}.md`);
}

// ─── INDEX.md parse / render (the bounded axis spine) ───────────────────────────

function readIndexRows(p: Paths): IndexRow[] {
  return existsSync(p.indexPath) ? parseIndex(readFileSync(p.indexPath, 'utf8')) : [];
}

// ─── Commands ───────────────────────────────────────────────────────────────────

export function cmdAdd(slug: string, o: AddOptions, cwd = process.cwd()) {
  if (!slug) {
    console.error('Usage: guard-decisions add <slug> --target … | --note "…"');
    process.exit(1);
  }
  return o.isTarget ? addTarget(slug, o, paths(cwd)) : addNote(slug, o, paths(cwd));
}

export function cmdAmend(slug: string, o: AddOptions, cwd = process.cwd()) {
  return amendDecision(slug, o, paths(cwd));
}

// Epic Target — the PRD. Requires context + ruling + consequences + tradeoff + vision-fit; updates INDEX.
// Reason: the branches ARE the Target-recording state machine (required-field guard, unknown-axis-without-new guard, already-targeted re-target guard, exists-vs-new render path); each guard maps to a distinct user error and extracting them hides the decision logic
// fallow-ignore-next-line complexity
function addTarget(slug: string, o: AddOptions, p: Paths) {
  if (!hasTargetFields(o)) {
    console.error(
      'Usage: guard-decisions add <slug> --target \\\n' +
        '  --context "<the forcing failure: what broke + the symptom + severity/blast-radius>" \\\n' +
        '  --ruling "<the decision / mechanism chosen>" \\\n' +
        '  --consequences "<the user/business value this protects>" \\\n' +
        '  --tradeoff "<the cost knowingly paid — latency, complexity, a road not taken>" \\\n' +
        '  --vision-fit "<which product North Star; or n/a — internal tooling>" \\\n' +
        '  [--title "<short heading>" --researched … --rejected … --anchored-bet "[BET]" --revisit-when "<condition that voids this ruling>" --scope "glob,glob" --new --evidence-change "…"]\n' +
        '(Context=WHY-now, Ruling=WHAT, Consequences/Tradeoff=SO-THAT + cost — the ADR Context/Decision/Consequences spine.)',
    );
    process.exit(1);
  }
  const file = slugPath(p, slug);
  const exists = existsSync(file);
  if (!exists && !o.isNew) {
    console.error(
      `Unknown axis "${slug}". Reuse an existing slug if this axis exists under another name;\n` +
        `otherwise re-run with --new. Current index:\n`,
    );
    console.error(existsSync(p.indexPath) ? readFileSync(p.indexPath, 'utf8') : '(index empty)');
    process.exit(1);
  }
  const date = today();
  let fm: Record<string, string>;
  let body: string;
  if (exists) {
    const parsed = parseDecision(readFileSync(file, 'utf8'));
    // Re-target guard: a Target moves only on an evidence-state change, never on impl pain.
    if (currentTarget(parsed.body) && !o.evidenceChange) {
      console.error(
        `Axis "${slug}" already has a Target. An implementation change is a NOTE — drop --target:\n` +
          `  guard-decisions add ${slug} --note "<what converged>"\n` +
          'Re-target ONLY on an evidence-state change — pass --evidence-change "<what shifted>".',
      );
      process.exit(1);
    }
    fm = { slug, created: parsed.fm.created || date };
    body = `${parsed.body.replace(TRAILING_WS_RE, '')}\n\n${renderTarget(date, o)}\n`;
  } else {
    fm = { slug, created: date };
    body = `\n# ${slug}\n\n${renderTarget(date, o)}\n`;
  }
  mkdirSync(p.decisionsDir, { recursive: true });
  writeFileAtomic(file, renderDecision(fm, body));
  const rows = upsertRow(readIndexRows(p), {
    slug,
    ruling: sanitizeCell(o.ruling),
    why: whyHook(o.context),
    updated: date,
  });
  writeFileAtomic(p.indexPath, renderIndex(rows));
  console.log(`Recorded Target "${slug}" (${date}).`);
}

// Cheap convergence note under the current Target. INDEX untouched (a note is not a ruling).
function addNote(slug: string, o: AddOptions, p: Paths) {
  if (!o.note) {
    console.error(
      'Usage: guard-decisions add <slug> --note "…"   (or --target … for an epic Target)',
    );
    process.exit(1);
  }
  const file = slugPath(p, slug);
  if (!existsSync(file)) {
    console.error(
      `Axis "${slug}" has no Target yet — record one first:\n` +
        `  guard-decisions add ${slug} --target --context … --ruling … --consequences … --tradeoff … --vision-fit … --new`,
    );
    process.exit(1);
  }
  const date = today();
  const parsed = parseDecision(readFileSync(file, 'utf8'));
  const fm = { slug, created: parsed.fm.created || date };
  const body = `${parsed.body.replace(TRAILING_WS_RE, '')}\n${renderNote(date, o.note)}\n`;
  writeFileAtomic(file, renderDecision(fm, body));
  console.log(`Noted on "${slug}" (${date}).`);
}

export function cmdList(cwd = process.cwd()) {
  const p = paths(cwd);
  if (!existsSync(p.indexPath)) {
    console.log('No decisions recorded.');
    return;
  }
  process.stdout.write(readFileSync(p.indexPath, 'utf8'));
}

export function cmdShow(slug: string, cwd = process.cwd()) {
  const file = slugPath(paths(cwd), slug);
  if (!existsSync(file)) {
    console.error(`No decision axis "${slug}".`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(file, 'utf8'));
}

export function checkExists(slug: string, cwd = process.cwd()) {
  return existsSync(slugPath(paths(cwd), slug));
}

/** Rank axes for a consumer cwd. Thin wrapper: retrieval.mts takes resolved paths, not a cwd. */
export async function rankAxes(text: string, k = 5, cwd = process.cwd()): Promise<RankResult> {
  return rankAxesIn(text, k, paths(cwd));
}

// `why` is now the axis file's full Context (the INDEX cell was truncated to 70 chars), so bound it
// at print time — the ranker wants the whole thing, a terminal reader does not.
function printRanked(rows: RankResult['rows'], mode: string) {
  console.log(`# top ${rows.length} ${rows.length === 1 ? 'axis' : 'axes'} (${mode})`);
  for (const r of rows) {
    console.log(`- ${r.slug} · ${r.ruling}${r.why ? ` · ${whyHook(r.why)}` : ''}`);
    // Never print a ruling alone when later notes qualify it — an agent reading only the ruling
    // acts on a decision the record has already walked back. But a real axis carries ~20 notes, so
    // the prose surface shows the most QUERY-RELEVANT few (retrieval ordered them that way) and says
    // how many it held back. --json still carries the full set for machine consumers.
    for (const q of r.qualifiers.slice(0, PROSE_QUALIFIERS))
      console.log(`    ⚠ qualified by ${q.date} — ${whyHook(q.text)}`);
    if (r.qualifiers.length > PROSE_QUALIFIERS)
      console.log(
        `    … ${r.qualifiers.length - PROSE_QUALIFIERS} more note(s): guard-decisions show ${r.slug}`,
      );
  }
}

/**
 * Machine-readable `query` output — the ONLY contract the retrieval benchmark has with this CLI.
 *
 * The prose form cannot express what a bench must score: it shows no rank scores, and renders
 * "nothing rules on this" identically to a hit. Every field here exists because a specific failure
 * mode is otherwise unmeasurable — `state` for abstention, `score`/`margin` for rank quality,
 * `liveRulingId` for which block answered.
 *
 * `state` declares only the two states retrieval can currently REACH. A third, `SUPERSEDED`, belongs
 * here the moment the format records supersession, and is deliberately NOT declared before then: an
 * enum member no code path can produce is a dead state, and this repo's own correctness reviewer
 * treats those as defects rather than forward-compatibility.
 *
 * `tau` is null because no relevance threshold is applied yet — abstention is currently only the
 * zero-lexical-overlap case. It becomes a number when the threshold is calibrated against the gold
 * set; null means "no threshold", never "threshold of zero".
 */
export interface QueryEnvelope {
  state: 'RULED' | 'NO_RULING';
  source: RankResult['source'];
  tau: number | null;
  margin: number | null;
  rows: {
    rank: number;
    slug: string;
    score: number;
    liveRulingId: string | null;
    /**
     * Which unit of the axis matched: a `note:<date>` means a NOTE answered rather than the ruling.
     *
     * NULL means the tier could not attribute the match — not that the ruling matched. The semantic
     * tier embeds the whole axis as one vector and so always reports null; only the lexical tier,
     * which scores each entry separately, can name the unit.
     */
    matchedEntryId: string | null;
    ruling: string;
    /**
     * Notes appended after the ruling. A caller that reads `ruling` alone gets the recorded
     * decision; a caller that wants CURRENT STATE has to read these too, because this is exactly
     * where "we ruled X" and "X turned out to be impossible" diverge.
     */
    qualifiedBy: { id: string; date: string; text: string }[];
    why: string;
    updated: string;
  }[];
  cost: { llmCalls: number; ms: number };
}

export async function queryEnvelope(
  text: string,
  k = 5,
  cwd = process.cwd(),
): Promise<QueryEnvelope> {
  const started = Date.now();
  const { source, rows } = await rankAxes(text, k, cwd);
  return {
    state: rows.length ? 'RULED' : 'NO_RULING',
    source,
    tau: null,
    // Flatness of the top of the ranking. A near-zero margin over several axes is the signature of
    // the "five loosely-related results, none of which settled it" failure, so it is reported even
    // though nothing acts on it yet. Null when there is no second row to compare against.
    margin: rows.length >= 2 ? rows[0].score - rows[1].score : null,
    rows: rows.map((r, i) => ({
      rank: i + 1,
      slug: r.slug,
      score: r.score,
      liveRulingId: r.liveRulingId,
      matchedEntryId: r.matchedEntryId,
      ruling: r.ruling,
      qualifiedBy: r.qualifiers.map((q) => ({ id: q.id, date: q.date, text: q.text })),
      why: r.why,
      updated: r.updated,
    })),
    // Retrieval makes no model calls. Embedding runs on a local Ollama and is free but not
    // instant, so its cost shows up in `ms` rather than as a separate priced counter.
    cost: { llmCalls: 0, ms: Date.now() - started },
  };
}

export async function cmdQuery(text: string | undefined, k = 5, cwd = process.cwd(), json = false) {
  if (!text?.trim()) {
    console.error('Usage: guard-decisions query "<text>" [--top K] [--json]');
    process.exit(1);
  }
  if (json) {
    console.log(JSON.stringify(await queryEnvelope(text, k, cwd), null, 2));
    return;
  }
  const { source, rows } = await rankAxes(text, k, cwd);
  if (rows.length === 0) {
    // Two different answers, deliberately worded differently — an agent must be able to tell an
    // empty log from a searched log that rules on nothing.
    console.log(
      source === 'empty'
        ? 'No decisions recorded.'
        : 'No recorded decision rules on this. (searched every axis; nothing matched)',
    );
    return;
  }
  printRanked(rows, source);
}

export async function cmdReindex(cwd = process.cwd()) {
  const { done, total } = await reindexAll(paths(cwd));
  console.log(
    `Reindexed ${done}/${total} axes${done < total ? ' (some embeds unavailable — lexical still covers them)' : ''}.`,
  );
}

// ─── Dispatch (run-as-main only, so tests can import the pure helpers) ───────────

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  return i !== -1 ? rest[i + 1] : undefined;
}

function optionsFromFlags(rest: string[]): AddOptions {
  return {
    isTarget: rest.includes('--target'),
    note: flag(rest, '--note'),
    title: flag(rest, '--title'),
    context: flag(rest, '--context'),
    ruling: flag(rest, '--ruling'),
    consequences: flag(rest, '--consequences'),
    tradeoff: flag(rest, '--tradeoff'),
    visionFit: flag(rest, '--vision-fit'),
    researched: flag(rest, '--researched'),
    rejected: flag(rest, '--rejected'),
    anchoredBet: flag(rest, '--anchored-bet'),
    revisitWhen: flag(rest, '--revisit-when'),
    scope: flag(rest, '--scope'),
    source: flag(rest, '--source'),
    ref: flag(rest, '--ref'),
    evidenceChange: flag(rest, '--evidence-change'),
    isNew: rest.includes('--new'),
  };
}

export async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'add': {
      const [slug, ...rest] = args;
      cmdAdd(slug, optionsFromFlags(rest));
      break;
    }
    case 'amend': {
      const [slug, ...rest] = args;
      cmdAmend(slug, optionsFromFlags(rest));
      break;
    }
    case 'query': {
      const [text, ...rest] = args;
      const top = flag(rest, '--top');
      const n = top ? Number.parseInt(top, 10) : 5;
      await cmdQuery(text, n > 0 ? n : 5, process.cwd(), rest.includes('--json'));
      break;
    }
    case 'reindex':
      await cmdReindex();
      break;
    case 'list':
      cmdList();
      break;
    case 'show':
      if (!args[0]) {
        console.error('Usage: guard-decisions show <slug>');
        process.exit(1);
      }
      cmdShow(args[0]);
      break;
    case 'check':
      if (!args[0]) {
        console.error('Usage: guard-decisions check <slug>');
        process.exit(1);
      }
      process.exit(checkExists(args[0]) ? 0 : 1);
      break;
    default:
      console.error('Commands: add | amend | query | reindex | list | show | check');
      process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`decisions: ${e?.message ?? e}`);
    process.exit(1);
  });
}
