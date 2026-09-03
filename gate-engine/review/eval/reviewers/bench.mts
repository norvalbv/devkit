#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * reviewer-eval — benchmark the pre-commit reviewers by driving the REAL gate cascade (runCascade)
 * over labeled fixture repos, sweepable across first-pass models. It exists to answer, with
 * numbers: (a) can the first pass drop to haiku, (b) did a checklist/brief edit help or hurt.
 *
 *   node bench.mts run [reviewer|all] [--dev] [--only <idPrefix>] [--baseline] [--fail]
 *   node bench.mts run <reviewer> --against <before.json>   # A/B a prompt edit (directional, no gate)
 *   node bench.mts validate          # 0 LLM calls: corpus linter (selection + expectItems + injection)
 *   node bench.mts coverage          # 0 LLM calls: catalog/type coverage of the corpus
 *
 * Knobs: BENCH_MODEL first pass (default sonnet; a model-pinned reviewer ignores it) ·
 * BENCH_CASCADE=off skips escalation · BENCH_ESCALATE_MODEL pins the escalator (default opus — changing it changes the measured condition) · BENCH_CONCURRENCY · GUARD_CORRECTNESS_SPLIT arm.
 *
 * Scoring is DETERMINISTIC (no LLM matcher): expected verdict vs the captured first-pass verdict +
 * the cascade outcome + the checklist artifact snapshotted per judge pass (runCascade deletes it
 * afterwards, so the spy snapshots immediately). Right-reason attribution: expectItems ⊆ failed
 * items → right-item; else reasonPattern on the failure text → pattern-only; else unattributed. A
 * FAIL with an all-pass artifact is its own bucket (fail-unattributed) — verifyChecklist never
 * scrutinizes FAILs. Under a split arm the per-lens-group captures merge first (lens/split.mts).
 *
 * House conventions (decisions-eval): NULL is a verdict — an inconclusive row costs its expected
 * class. Baselines embed gateHash — a mismatch mechanically SKIPS comparison; corpus growth is NOT
 * a skip (rowHash + behaviorHash pair per row, excluding only BEHAVIOR changes). --fail = hard
 * floors + per-row McNemar flip table, never raw aggregate deltas. Every run appends to runs.log.
 * Cost anchors: docs/benchmarks/corpus-growth.md; a budget line prints before any spend.
 *
 * BENCH-ONLY: excluded from tsc + the build; the package ships `dist` only, so nothing here
 * (bench, miner, corpus) reaches production.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGuardConfig } from '../../../config.mts';
import { BenchAbort, cleanBenchEnv, materializeFixture } from '../../../decisions/eval/bench.mts';
import { execJudgeAsync } from '../../../judge/run-judge.mts';
import { lensArmSuffix, mergeLensCaptures, runReviewerCascade } from '../../lens/split.mts';
import {
  checklistScript,
  parseReviewVerdict,
  REVIEWERS,
  selectReviewers,
} from '../../reviewers.mts';
import { runCascade } from '../../run-review.mts';

// Corpus + fixture-asset layer, checkpoint/salvage/baseline IO, and flip-table statistics (split
// out to keep this file within its size ratchet).
export * from './corpus.mts';
export * from './progress.mts';
export * from './stats.mts';

import { benchGateHash, buildAssets, corpusHash, loadRows, rowHashes } from './corpus.mts';
import { loadAgainstFile, loadProgress, progressFile, RETRYABLE, salvageMap } from './progress.mts';
import {
  VERDICT_INJECTION_RE,
  buildCompareReport,
  extractCommentLines,
  fmtCi,
  jaccard,
  printSummary,
  rowChanged,
  rowUnchanged,
  subcause,
  summarize,
  wordsOf,
} from './stats.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
// gate-engine/review/eval/reviewers → repo root is four levels up.
const repoRoot = path.resolve(here, '../../../..');

const MODEL = process.env.BENCH_MODEL ?? 'sonnet';
process.env.GUARD_REVIEW_ESCALATION_MODEL = process.env.BENCH_ESCALATE_MODEL ?? 'opus'; // pinned — sectionKey/meta record only the first-pass model; an ambient escalator would blend conditions
const CASCADE = (process.env.BENCH_CASCADE ?? 'on') !== 'off';
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.BENCH_CONCURRENCY ?? '2', 10) || 2);

const BASELINE_FILE = path.join(here, 'results.baseline.json');
const RUNS_LOG = path.join(here, 'runs.log');

// Consecutive judge outages before a run pauses itself (see pause-on-drained-pool below).
const OUTAGE_TRIP = 3;

/** The reviewers this bench covers — the 4 domain reviewers. commit-guard is deferred: its
 * allowlist appends the consumer's semantic-search MCP tool, which cannot resolve inside a bare
 * fixture repo. A future correctness reviewer joins by adding its cases file here. */
export const BENCH_REVIEWERS = REVIEWERS.filter(
  (r) => r.domain === 'backend' || r.domain === 'frontend' || r.domain === 'all',
);

// Per-pass wall-clock estimates (seconds) for the budget line. Checklist ≈ 4–10 tool turns on top of diff reading; escalation reruns the whole workflow on the escalator.
const EST_FIRST_SECS = { haiku: 70, sonnet: 135, opus: 270 };
const EST_ESCALATE_SECS = 210;

// ─── Small helpers ────────────────────────────────────────────────────────────────

// Bounded-concurrency map (run-review's pool shape; not exported there). fn must not reject —
// callers wrap row bodies in try/catch so one broken fixture cannot abandon its siblings.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function preflightClaude() {
  try {
    execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000 });
  } catch {
    throw new BenchAbort(2, 'reviewer-eval: `claude` CLI not available — cannot benchmark');
  }
}

// ─── Spy exec ─────────────────────────────────────────────────────────────────────

/**
 * Wrap execJudgeAsync: capture each pass's raw output + duration + a snapshot of the checklist
 * state-file artifact taken IMMEDIATELY after the judge subprocess resolves — runCascade deletes
 * the artifact when it returns, and the escalation pass regenerates it, so per-pass snapshots are
 * the only honest record. With cascade=false an escalate call is short-circuited to a synthetic
 * FAIL (zero opus spend; end-to-end metrics are suppressed for such runs).
 */
export function makeSpyExec(capture, { reviewer, cascade, delegate = execJudgeAsync }) {
  return async (opts) => {
    const isEscalate = opts.label.endsWith(':escalate');
    if (isEscalate && !cascade) {
      capture.push({
        label: opts.label,
        out: 'VERDICT: FAIL — cascade disabled (bench)',
        ms: 0,
        snapshot: null,
        synthetic: true,
      });
      return 'VERDICT: FAIL — cascade disabled (bench)';
    }
    const t0 = Date.now();
    const out = await delegate(opts);
    let snapshot = null;
    try {
      snapshot = JSON.parse(readFileSync(path.resolve(opts.cwd, reviewer.stateFile), 'utf8'));
    } catch {
      /* missing/corrupt artifact = null snapshot; scoring buckets it */
    }
    capture.push({ label: opts.label, out, ms: Date.now() - t0, snapshot });
    return out;
  };
}

// ─── Row scoring ──────────────────────────────────────────────────────────────────
// subcause/VERDICT_INJECTION_RE (pure regex classifiers) now live in stats.mts.

/**
 * Deterministic adjudication of one cascade against its row label.
 * Reason attribution (expected-FAIL rows that finally failed): the authoritative artifact is the
 * FAILING pass's snapshot (escalation's when it ran live, else the first pass's).
 */
export function scoreRow(row, capture, cas) {
  // filter+merge, not find: a split arm captures one entry PER LENS GROUP under the same label.
  const pick = (l) => mergeLensCaptures(capture.filter((c) => c.label === l));
  const first = pick(`review:${row.reviewer}`);
  const esc = pick(`review:${row.reviewer}:escalate`);
  const firstVerdict = first?.out ? parseReviewVerdict(first.out).verdict : null;
  const okFirst = firstVerdict === row.expected;
  const okFinal = cas.status === (row.expected === 'FAIL' ? 'fail' : 'pass');
  let reasonClass = null;
  if (row.expected === 'FAIL' && cas.status === 'fail') {
    const snap = (esc && !esc.synthetic ? esc.snapshot : null) ?? first?.snapshot ?? null;
    const items = Array.isArray(snap?.items) ? snap.items : [];
    const failedItems = items.filter((i) => i.status === 'fail').map((i) => i.name);
    const want = row.expectItems ?? [];
    if (want.length > 0 && want.every((n) => failedItems.includes(n))) reasonClass = 'right-item';
    else {
      const text = [
        ...items.flatMap((i) => i.issues ?? []),
        cas.reason ?? '',
        esc?.out ?? '',
        first?.out ?? '',
      ].join('\n');
      if (row.reasonPattern && new RegExp(row.reasonPattern, 'i').test(text))
        reasonClass = 'pattern-only';
      else reasonClass = failedItems.length === 0 ? 'fail-unattributed' : 'unattributed';
    }
  }
  return {
    id: row.id,
    reviewer: row.reviewer,
    expected: row.expected,
    holdout: !!row.holdout,
    caseId: row.caseId ?? null,
    ...rowHashes(row),
    firstVerdict,
    okFirst,
    finalStatus: cas.status,
    okFinal,
    escalated: !!cas.escalated,
    escalateLive: !!esc && !esc.synthetic,
    reasonClass,
    subcause: cas.status === 'inconclusive' ? subcause(cas.reason) : null,
    ms: { first: first?.ms ?? 0, escalate: esc?.ms ?? 0 },
  };
}

// ─── Row runner ───────────────────────────────────────────────────────────────────

/**
 * Materialize one row's fixture (gate assets + row base committed, row.staged in the index), run
 * the real cascade with the spy exec, and score it. Row files may not collide with asset paths.
 */
export async function runRow(row, { model = MODEL, cascade = CASCADE, exec } = {}) {
  const reviewer = BENCH_REVIEWERS.find((r) => r.name === row.reviewer);
  if (!reviewer) throw new BenchAbort(2, `${row.id}: unknown reviewer ${row.reviewer}`);
  const assets = buildAssets(reviewer);
  for (const key of Object.keys(assets))
    if (row.repo.base[key] !== undefined || row.repo.staged[key] !== undefined)
      throw new BenchAbort(2, `${row.id}: row must not define gate asset path ${key}`);
  const fx = materializeFixture({
    repo: { base: { ...row.repo.base, ...assets }, staged: row.repo.staged },
  });
  try {
    const cfg = resolveGuardConfig(fx.repo);
    const sel = selectReviewers(fx.staged, cfg).find((s) => s.reviewer.name === row.reviewer);
    if (!sel)
      // Selection itself is under test: a row whose staged files don't reach its reviewer is wrong.
      return {
        id: row.id,
        reviewer: row.reviewer,
        expected: row.expected,
        holdout: !!row.holdout,
        caseId: row.caseId ?? null,
        ...rowHashes(row),
        firstVerdict: null,
        okFirst: false,
        finalStatus: 'not-selected',
        okFinal: false,
        escalated: false,
        escalateLive: false,
        reasonClass: null,
        subcause: 'not-selected',
        ms: { first: 0, escalate: 0 },
      };
    const capture = [];
    const spy = (r) => makeSpyExec(capture, { reviewer: r, cascade, delegate: exec });
    const cas = await runReviewerCascade(sel, (s) =>
      runCascade(s, { cwd: fx.repo, cfg, exec: spy(s.reviewer), firstModel: model }),
    );
    return scoreRow(row, capture, cas);
  } finally {
    fx.cleanup();
  }
}

// summarize (metrics for one scope) and printSummary live in stats.mts (pure; size ratchet).

// ─── Baseline / compare ───────────────────────────────────────────────────────────

const sectionKey = (reviewerName, model, cascade) =>
  `${reviewerName}@${model}@${cascade ? 'cascade-on' : 'cascade-off'}${lensArmSuffix(reviewerName)}`;

// A model-pinned reviewer (correctness) runs single-pass at its pinned model regardless of
// BENCH_MODEL / BENCH_CASCADE — the gate ignores both for it. Report and key it by that reality so
// its section, metrics, and baseline reflect what actually ran, not the swept knobs.
const effModel = (reviewer) => reviewer.model ?? MODEL;
const effCascade = (reviewer) => (reviewer.model ? false : CASCADE);

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Floors are POOLED (48 rows is a tripwire, not a per-reviewer detector). firstFailRecall floors
// only on the production model — for haiku/opus sweeps it is the decision INPUT, not a gate.
const FLOORS = { blockRecall: 0.75, cleanPass: 0.85, firstFailRecallSonnetOnly: 0.6 };

/**
 * Regression verdict for one reviewer section vs baseline. gateHash mismatch → SKIPPED loudly;
 * then row-set-aware pairing: the flip table runs over the INTERSECTION of row ids in both runs
 * (corpus growth is not a skip), excluding shared ids whose behavior changed (rowChanged — a
 * metadata-only edit still pairs; hash-less baselines pair all, warned). Flips use okFinal when both runs had
 * the cascade, else okFirst. Returns {skipped, regressed, improved, detail}; unstable rows
 * (2-of-2 rerun flip-backs) are excluded and counted.
 */
export function compareReviewer(name, nowRows, nowMeta, base, { crossGate = false } = {}) {
  const key = sectionKey(name, nowMeta.model, nowMeta.cascade);
  const section = base?.sections?.[key];
  if (!section) return { skipped: `no baseline section ${key}` };
  // crossGate (--against A/B): a deliberate brief/checklist edit is EXPECTED to change gateHash,
  // so bypass that guard — the flip table pairs purely by row.id and is meaningful across the edit.
  if (!crossGate && section.gateHash !== nowMeta.gateHash)
    return {
      skipped: `gate code / brief / checklist changed (${key}) — regenerate with --baseline`,
    };
  const baseRows = section.rows ?? {};
  const nowById = new Map(nowRows.map((r) => [r.id, r]));
  const nowIds = [...nowById.keys()];
  const baseIds = Object.keys(baseRows);
  const sharedIds = nowIds.filter((id) => Object.hasOwn(baseRows, id));
  const added = nowIds.filter((id) => !Object.hasOwn(baseRows, id)).length;
  const removed = baseIds.filter((id) => !nowById.has(id)).length;
  const hasRowHash = sharedIds.some((id) => baseRows[id].rowHash !== undefined);
  let changed = 0;
  let unstable = 0;
  const pairs = [];
  for (const id of sharedIds) {
    const baseRow = baseRows[id];
    const row = nowById.get(id);
    if (row.stable === false) {
      unstable += 1;
      continue;
    }
    if (hasRowHash && row.rowHash !== undefined && rowChanged(baseRow, row)) {
      changed += 1;
      continue;
    }
    pairs.push({
      id,
      expected: row.expected,
      caseId: row.caseId ?? row.id,
      wasOk: nowMeta.cascade ? baseRow.okFinal : baseRow.okFirst,
      isOk: nowMeta.cascade ? row.okFinal : row.okFirst,
    });
  }
  return {
    skipped: null,
    ...buildCompareReport({
      pairs,
      crossGate,
      shared: sharedIds.length,
      changed,
      unstable,
      added,
      removed,
      hasRowHash,
    }),
  };
}

// ─── validate / coverage (0 LLM calls) ────────────────────────────────────────────

// extractCommentLines/wordsOf/jaccard (comment-leakage heuristics, see validateRow below) live in stats.mts.

/** Corpus linter: selection fires the target reviewer, expectItems ⊆ what the REAL checklist
 * generate enumerates, no VERDICT prompt-injection in staged content, per-row item counts.
 *
 * Two classes of finding: `problems` are HARD FAILs (validate exits 1) — a malformed reasonPattern
 * regex belongs here, because a row whose pattern can't even compile silently scores every FAIL as
 * `fail-unattributed`/`unattributed` forever. `warnings` are comment-leakage tells — a
 * `reasonPattern` or `note` that echoes a comment left in the fixture text COULD mean the row is
 * scoreable for the wrong reason — but corpus rows legitimately reuse plain-English vocabulary
 * ("sql injection", "race condition") between prose and code comments, so these are printed and
 * never fail validate. */
export function validateRow(row) {
  const problems = [];
  const warnings = [];
  const reviewer = BENCH_REVIEWERS.find((r) => r.name === row.reviewer);
  if (!reviewer) return { problems: [`unknown reviewer ${row.reviewer}`], warnings, itemCount: 0 };
  let compiled = null;
  if (row.reasonPattern) {
    try {
      compiled = new RegExp(row.reasonPattern, 'i');
    } catch (e) {
      problems.push(`reasonPattern is not a valid regex: ${e?.message ?? e}`);
    }
  }
  for (const content of Object.values(row.repo.staged))
    if (content && VERDICT_INJECTION_RE.test(content))
      problems.push('staged content contains "VERDICT:" (prompt-injection hazard)');
  const commentLines = extractCommentLines({ ...row.repo.base, ...row.repo.staged });
  if (compiled && commentLines.length && compiled.test(commentLines.join('\n')))
    warnings.push('⚠ possible leakage: reasonPattern matches fixture comment text');
  if (row.note) {
    const noteWords = wordsOf(row.note);
    if (commentLines.some((line) => jaccard(noteWords, wordsOf(line)) > 0.5))
      warnings.push('⚠ possible leakage: note overlaps fixture comment');
  }
  const assets = buildAssets(reviewer);
  const fx = materializeFixture({
    repo: { base: { ...row.repo.base, ...assets }, staged: row.repo.staged },
  });
  let itemCount = 0;
  try {
    const cfg = resolveGuardConfig(fx.repo);
    const sel = selectReviewers(fx.staged, cfg).find((s) => s.reviewer.name === row.reviewer);
    if (!sel) problems.push('selectReviewers does not fire the target reviewer');
    execFileSync('node', [checklistScript(reviewer), 'generate'], {
      cwd: fx.repo,
      encoding: 'utf8',
    });
    let names = [];
    try {
      const state = JSON.parse(readFileSync(path.join(fx.repo, reviewer.stateFile), 'utf8'));
      names = (state.items ?? []).map((i) => i.name);
      itemCount = names.length;
    } catch {
      problems.push('checklist generate left no readable artifact');
    }
    for (const want of row.expectItems ?? [])
      if (!names.includes(want))
        problems.push(`expectItems: ${want} not in generated [${names.join(', ')}]`);
  } finally {
    fx.cleanup();
  }
  return { problems, warnings, itemCount };
}

function validate({ dev = false, targets = [...BENCH_REVIEWERS] } = {}) {
  cleanBenchEnv();
  let bad = 0;
  for (const reviewer of targets) {
    const rows = loadRows(reviewer, { dev });
    console.log(`\n${reviewer.name} — ${rows.length} rows`);
    for (const row of rows) {
      const { problems, warnings, itemCount } = validateRow(row);
      const fat = itemCount > 6 ? '  ⚠ fat row (cost)' : '';
      if (problems.length === 0)
        console.log(`  ${row.id.padEnd(36)} OK    ${itemCount} items${fat}`);
      else {
        bad += 1;
        console.log(`  ${row.id.padEnd(36)} BAD   ${problems.join(' | ')}`);
      }
      for (const w of warnings) console.log(`  ${row.id.padEnd(36)} ${w}`);
    }
  }
  if (bad > 0) throw new BenchAbort(1, `reviewer-eval: validate found ${bad} bad row(s)`);
  console.log('\nvalidate: all rows OK');
}

/** Which catalog items each corpus exercises — parsed from the checklist scripts themselves so
 * coverage stays honest against catalog drift. */
function coverage() {
  for (const reviewer of BENCH_REVIEWERS) {
    const script = readFileSync(
      path.join(repoRoot, 'skills', reviewer.skill, 'scripts', 'checklist.mjs'),
      'utf8',
    );
    const catalog = [...script.matchAll(/name:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
    const rows = loadRows(reviewer);
    const hit = new Set(rows.flatMap((r) => r.expectItems ?? []));
    const gold = rows.filter((r) => r.expected === 'FAIL').length;
    const byProv = {};
    for (const r of rows) byProv[r.provenance ?? '?'] = (byProv[r.provenance ?? '?'] ?? 0) + 1;
    // Per-lens GOLD counts + difficulty histogram: catalog "covered/uncovered" is binary and hides
    // thin lenses (a lens with 1 gold reads as "covered"). These counts are what balancing targets.
    const goldByItem = {};
    const byDiff = {};
    for (const r of rows.filter((x) => x.expected === 'FAIL')) {
      for (const it of r.expectItems ?? []) goldByItem[it] = (goldByItem[it] ?? 0) + 1;
      byDiff[r.difficulty ?? '?'] = (byDiff[r.difficulty ?? '?'] ?? 0) + 1;
    }
    console.log(
      `\n${reviewer.name}: ${rows.length} rows (${gold} gold), provenance ${JSON.stringify(byProv)}`,
    );
    console.log(`  covered items   ${catalog.filter((c) => hit.has(c)).join(', ') || '—'}`);
    console.log(`  uncovered items ${catalog.filter((c) => !hit.has(c)).join(', ') || '—'}`);
    console.log(`  gold by item    ${catalog.map((c) => `${c}:${goldByItem[c] ?? 0}`).join('  ')}`);
    console.log(`  gold difficulty ${JSON.stringify(byDiff)}`);
  }
}

// ─── run ──────────────────────────────────────────────────────────────────────────
// loadProgress/salvageMap (checkpoint reuse across a killed run) now live in progress.mts.

async function runBench(targets, { dev, only, writeBaseline, failMode, fresh, against }) {
  cleanBenchEnv();
  const abMode = !!against;
  if (abMode && writeBaseline)
    throw new BenchAbort(2, 'reviewer-eval: --against is a read-only A/B; drop --baseline');
  preflightClaude();
  if (fresh) rmSync(progressFile(MODEL, CASCADE), { force: true });
  const plan = targets.map((reviewer) => ({ reviewer, rows: loadRows(reviewer, { dev, only }) }));
  const totalRows = plan.reduce((s, p) => s + p.rows.length, 0);
  if (totalRows === 0) throw new BenchAbort(2, 'reviewer-eval: no rows selected');
  const progress = loadProgress(MODEL, CASCADE);
  const goldRows = plan.reduce((s, p) => s + p.rows.filter((r) => r.expected === 'FAIL').length, 0);
  // Only NON-pinned reviewers escalate (and only when the cascade is on) — a pinned reviewer
  // (correctness) runs single-pass regardless of BENCH_CASCADE.
  const estEscalations = CASCADE
    ? plan.reduce(
        (s, p) =>
          s +
          (p.reviewer.model
            ? 0
            : p.rows.filter((r) => r.expected === 'FAIL').length +
              Math.round(p.rows.filter((r) => r.expected === 'PASS').length * 0.15)),
        0,
      )
    : 0;
  const estMins = Math.round(
    (totalRows * (EST_FIRST_SECS[MODEL] ?? EST_FIRST_SECS.sonnet) +
      estEscalations * EST_ESCALATE_SECS) /
      60 /
      CONCURRENCY,
  );
  const allPinned = plan.every((p) => p.reviewer.model);
  const modelLabel = allPinned ? [...new Set(plan.map((p) => p.reviewer.model))].join('/') : MODEL;
  const cascadeLabel = allPinned ? 'single-pass' : CASCADE ? 'on' : 'off';
  console.log(
    `reviewer-eval: ${totalRows} rows (${goldRows} gold) · model ${modelLabel} · cascade ${cascadeLabel} · ` +
      `concurrency ${CONCURRENCY} · est ≈ ${estMins} min wall-clock${dev ? ' · --dev (holdouts excluded)' : ''}` +
      `${progress.length ? ` · resuming (${progress.length} checkpointed row(s) on disk)` : ''}`,
  );

  // Pause-on-drained-pool: after OUTAGE_TRIP consecutive judge outages, stop STARTING rows —
  // every completed row is already checkpointed, so the same command resumes after an account
  // switch. In-flight rows are left to finish (their checkpoint still counts).
  let consecutiveOutages = 0;
  let paused = false;

  // A/B (--against): compare the just-run (edited) prompt against an explicit "before" snapshot,
  // pairing per row.id across the deliberate gateHash change. Loaded ONCE and used for BOTH the
  // stability rerun AND compareReviewer — never falling back to results.baseline.json, which a
  // later --baseline would overwrite and desync from the "before" the flips are measured against.
  const baseline = abMode ? loadAgainstFile(against) : loadBaseline();
  if (abMode)
    console.log(
      `reviewer-eval: A/B vs ${path.basename(against)} — directional only (writes no baseline, exits 0)`,
    );
  const allResults = [];
  const perReviewer = [];
  for (const { reviewer, rows } of plan) {
    const meta = {
      model: effModel(reviewer),
      cascade: effCascade(reviewer),
      gateHash: benchGateHash(reviewer),
      corpusHash: corpusHash(reviewer),
    };
    const salvage = salvageMap(progress, reviewer.name, meta, rows);
    console.log(
      `\n── ${reviewer.name} (${rows.length} rows${salvage.size ? `, ${salvage.size} salvaged` : ''}) ──`,
    );
    const results = await mapLimit(rows, CONCURRENCY, async (row) => {
      const saved = salvage.get(row.id);
      if (saved) {
        console.log(`  ${row.id.padEnd(36)} SALVAGED (checkpoint)`);
        return saved;
      }
      if (paused)
        return {
          id: row.id,
          reviewer: row.reviewer,
          expected: row.expected,
          holdout: !!row.holdout,
          caseId: row.caseId ?? null,
          ...rowHashes(row),
          firstVerdict: null,
          okFirst: false,
          finalStatus: 'paused-skipped',
          okFinal: false,
          escalated: false,
          escalateLive: false,
          reasonClass: null,
          subcause: 'paused',
          ms: { first: 0, escalate: 0 },
        };
      let res: Awaited<ReturnType<typeof runRow>>;
      try {
        res = await runRow(row);
        const ok = CASCADE ? res.okFinal : res.okFirst;
        console.log(
          `  ${row.id.padEnd(36)} ${ok ? 'OK  ' : 'MISS'}  first=${res.firstVerdict ?? '∅'} final=${res.finalStatus}` +
            `${res.escalateLive ? ' (escalated)' : ''}${res.reasonClass ? ` [${res.reasonClass}]` : ''}`,
        );
      } catch (e) {
        console.error(`  ${row.id}: engine error — ${e?.message ?? e}`);
        res = {
          id: row.id,
          reviewer: row.reviewer,
          expected: row.expected,
          holdout: !!row.holdout,
          caseId: row.caseId ?? null,
          ...rowHashes(row),
          firstVerdict: null,
          okFirst: false,
          finalStatus: 'engine-error',
          okFinal: false,
          escalated: false,
          escalateLive: false,
          reasonClass: null,
          subcause: 'engine-error',
          ms: { first: 0, escalate: 0 },
        };
      }
      appendFileSync(
        progressFile(MODEL, CASCADE),
        `${JSON.stringify({ reviewer: reviewer.name, gateHash: meta.gateHash, ...rowHashes(row), res })}\n`,
      );
      if (RETRYABLE.has(res.subcause)) {
        consecutiveOutages += 1;
        if (consecutiveOutages >= OUTAGE_TRIP && !paused) {
          paused = true;
          console.error(
            `reviewer-eval: ${OUTAGE_TRIP} consecutive judge outages — pausing (rate limit / drained pool?). ` +
              'Completed rows are checkpointed; re-run the SAME command to resume.',
          );
        }
      } else consecutiveOutages = 0;
      return res;
    });

    // Stability pass: rows discordant with the baseline verdict re-run ONCE; a flip must confirm
    // 2-of-2 to count in the McNemar table (alignment-bench convention — K=1 rows are noisy).
    const key = sectionKey(reviewer.name, meta.model, meta.cascade);
    const section = baseline?.sections?.[key];
    // Stability rerun fires for --fail AND for A/B (--against); gateHash must match ONLY outside
    // A/B mode. corpusHash is deliberately NOT checked: it is a row-SET hash that changes on any
    // corpus growth, which would defeat row-level pairing — each row pairs individually below via
    // `rowHash`, mirroring compareReviewer.
    if ((failMode || abMode) && section && (abMode || section.gateHash === meta.gateHash)) {
      for (const res of results) {
        const baseRow = section.rows?.[res.id];
        // A hand-edited/replaced row is not the same fixture — skip it rather than pairing
        // stale content with a fresh run (rowUnchanged treats hash-less old baselines as safe
        // to pair, since drift can't be detected there — matches compareReviewer's fallback).
        if (!rowUnchanged(baseRow, res)) continue;
        const wasOk = meta.cascade ? baseRow.okFinal : baseRow.okFirst;
        const isOk = meta.cascade ? res.okFinal : res.okFirst;
        if (wasOk !== isOk) {
          console.log(`  ${res.id}: discordant with baseline — re-running once to confirm`);
          try {
            const rerun = await runRow(
              plan.find((p) => p.reviewer === reviewer).rows.find((r) => r.id === res.id),
            );
            const rerunOk = meta.cascade ? rerun.okFinal : rerun.okFirst;
            res.stable = rerunOk === isOk;
            if (!res.stable)
              console.log(`  ${res.id}: flip did not reproduce — excluded from flip table`);
          } catch {
            res.stable = false;
          }
        }
      }
    }

    perReviewer.push({ reviewer, results, meta });
    allResults.push(...results);
  }

  // ── Report ── (paused-skipped rows never ran — they are excluded, not counted as misses)
  const ran = (rows) => rows.filter((r) => r.finalStatus !== 'paused-skipped');
  const skippedCount = allResults.length - ran(allResults).length;
  // A run's pooled cascade view is true only when EVERY ran reviewer cascaded (a mixed
  // cascade + single-pass `all` run has no coherent end-to-end pool → treat as first-pass).
  const pooledCascade = perReviewer.every(({ reviewer }) => effCascade(reviewer));
  for (const { reviewer, results } of perReviewer)
    printSummary(reviewer.name, summarize(ran(results), { cascade: effCascade(reviewer) }), {
      cascade: effCascade(reviewer),
    });
  const pooled = summarize(ran(allResults), { cascade: pooledCascade });
  printSummary(paused ? 'POOLED (PARTIAL — paused)' : 'POOLED', pooled, { cascade: pooledCascade });

  if (paused) {
    // Ledger the partial run, then bail BEFORE floors/baseline — partial numbers must never
    // gate or become a baseline. The checkpoint file holds every completed row.
    appendFileSync(
      RUNS_LOG,
      `${JSON.stringify({ ts: new Date().toISOString(), args: process.argv.slice(2), model: MODEL, cascade: CASCADE, paused: true, ran: ran(allResults).length, skipped: skippedCount })}\n`,
    );
    throw new BenchAbort(
      2,
      `reviewer-eval: PAUSED after ${ran(allResults).length}/${totalRows} rows (${skippedCount} not run). ` +
        'Re-run the SAME command to resume from the checkpoint (switch accounts first if rate-limited).',
    );
  }

  // ── Floors + flips (--fail) / A/B directional compare (--against) ──
  // In A/B mode floors + the flip table PRINT for context but never set the exit — an A/B is
  // informational, the accept/revert decision is the caller's.
  let failed = false;
  if (failMode || abMode) {
    if (pooledCascade) {
      const br = pooled.blockRecall;
      const cp = pooled.cleanPass;
      if (br.n && br.k / br.n < FLOORS.blockRecall) {
        console.error(`FLOOR: pooled block recall ${fmtCi(br.k, br.n)} < ${FLOORS.blockRecall}`);
        if (!abMode) failed = true;
      }
      if (cp.n && cp.k / cp.n < FLOORS.cleanPass) {
        console.error(`FLOOR: pooled clean-pass ${fmtCi(cp.k, cp.n)} < ${FLOORS.cleanPass}`);
        if (!abMode) failed = true;
      }
    }
    // sonnet-only floor: gates on what actually RAN, not the env default — a per-reviewer model
    // pin (correctness) or a BENCH_MODEL override must not silently apply/skip this floor.
    const allSonnet = perReviewer.every(({ reviewer }) => effModel(reviewer) === 'sonnet');
    if (allSonnet) {
      const fr = pooled.firstFailRecall;
      if (fr.n && fr.k / fr.n < FLOORS.firstFailRecallSonnetOnly) {
        console.error(
          `FLOOR: pooled first-pass FAIL-recall ${fmtCi(fr.k, fr.n)} < ${FLOORS.firstFailRecallSonnetOnly}`,
        );
        if (!abMode) failed = true;
      }
    }
    for (const { reviewer, results, meta } of perReviewer) {
      const cmp = compareReviewer(reviewer.name, results, meta, baseline, { crossGate: abMode });
      if (cmp.skipped) console.log(`compare ${reviewer.name}: SKIPPED — ${cmp.skipped}`);
      else {
        const label = abMode
          ? cmp.improved
            ? 'IMPROVED'
            : cmp.regressed
              ? 'REGRESSED'
              : 'no-change'
          : cmp.regressed
            ? 'REGRESSED'
            : 'ok';
        console.log(`compare ${reviewer.name}: ${label} — ${cmp.detail}`);
        if (!abMode && cmp.regressed) failed = true;
      }
    }
  }

  // ── Baseline write ──
  if (writeBaseline) {
    if (only)
      throw new BenchAbort(2, 'reviewer-eval: refusing --baseline with --only (partial corpus)');
    const outages = allResults.filter(
      (r) => r.subcause === 'outage' || r.subcause === 'engine-error',
    ).length;
    if (outages > 0)
      throw new BenchAbort(
        2,
        `reviewer-eval: refusing --baseline with ${outages} outage/error row(s)`,
      );
    const next = loadBaseline() ?? { sections: {} };
    for (const { reviewer, results, meta } of perReviewer) {
      next.sections[sectionKey(reviewer.name, meta.model, meta.cascade)] = {
        ...meta,
        when: new Date().toISOString(),
        dev,
        rows: Object.fromEntries(
          results.map((r) => [
            r.id,
            {
              expected: r.expected,
              okFirst: r.okFirst,
              okFinal: r.okFinal,
              finalStatus: r.finalStatus,
              rowHash: r.rowHash,
              behaviorHash: r.behaviorHash,
              // sc-2498: pair identity, holdout and right-reason attribution survive into the
              // checkpoint so pair-consistency and reason audits are recomputable from disk.
              caseId: r.caseId,
              holdout: r.holdout,
              reasonClass: r.reasonClass,
            },
          ]),
        ),
        metrics: summarize(results, { cascade: meta.cascade }),
      };
    }
    writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\nbaseline written → ${path.basename(BASELINE_FILE)}`);
  }

  // Run completed → the checkpoint file has served its purpose (keeping it would salvage stale
  // results into a future run only until the next gate/corpus edit, but clean is clean).
  rmSync(progressFile(MODEL, CASCADE), { force: true });

  // ── Ledger ──
  appendFileSync(
    RUNS_LOG,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      args: process.argv.slice(2),
      model: MODEL,
      cascade: CASCADE,
      rows: totalRows,
      pooled: {
        firstFailRecall: pooled.firstFailRecall,
        firstCleanPass: pooled.firstCleanPass,
        ...(CASCADE ? { blockRecall: pooled.blockRecall, cleanPass: pooled.cleanPass } : {}),
      },
    })}\n`,
  );

  if (failed) throw new BenchAbort(1, 'reviewer-eval: floors/regression gate failed');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;
  const againstIdx = argv.indexOf('--against');
  const against = againstIdx !== -1 ? argv[againstIdx + 1] : null;
  const positional = argv.filter(
    (a, i) => !a.startsWith('--') && argv[i - 1] !== '--only' && argv[i - 1] !== '--against',
  );
  const cmd = ['run', 'validate', 'coverage'].includes(positional[0]) ? positional[0] : 'run';
  const target = positional.find((p) => p !== cmd);
  const targets =
    target && target !== 'all'
      ? BENCH_REVIEWERS.filter((r) => r.name === target || r.skill === target)
      : [...BENCH_REVIEWERS];
  if (targets.length === 0) {
    console.error(`reviewer-eval: unknown reviewer ${target}`);
    process.exit(2);
  }
  try {
    if (cmd === 'validate') validate({ dev: flags.has('--dev'), targets });
    else if (cmd === 'coverage') coverage();
    else {
      await runBench(targets, {
        dev: flags.has('--dev'),
        only,
        against,
        writeBaseline: flags.has('--baseline'),
        failMode: flags.has('--fail'),
        fresh: flags.has('--fresh'),
      });
    }
  } catch (e) {
    if (e instanceof BenchAbort) {
      console.error(e.message);
      process.exit(e.code);
    }
    throw e;
  }
}
