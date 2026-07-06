#!/usr/bin/env node

/**
 * reviewer-eval — benchmark the domain pre-commit reviewers (api-security, backend-performance,
 * frontend-security, frontend-performance) by driving the REAL gate cascade (runCascade) over
 * labeled fixture repos, sweepable across first-pass models. The bench exists to answer, with
 * numbers: (a) can the first pass drop to haiku, (b) did a checklist/brief edit help or hurt.
 *
 *   node bench.mts run [reviewer|all] [--dev] [--only <idPrefix>] [--baseline] [--fail]
 *   node bench.mts validate          # 0 LLM calls: corpus linter (selection + expectItems + injection)
 *   node bench.mts coverage          # 0 LLM calls: catalog/type coverage of the corpus
 *
 * Knobs: BENCH_MODEL first-pass model (default sonnet = production) · BENCH_CASCADE=off skips the
 * opus escalation (first-pass metrics only, zero opus spend) · BENCH_CONCURRENCY rows in flight
 * (default 2, the gate's own judge-contention default).
 *
 * Scoring is DETERMINISTIC (no LLM matcher): expected verdict vs the captured first-pass verdict +
 * the end-to-end cascade outcome + the checklist state-file artifact snapshotted per judge pass
 * (runCascade deletes it afterwards, so the spy exec snapshots immediately after each pass).
 * Right-reason attribution: expectItems ⊆ failed checklist items → right-item; else reasonPattern
 * on the failure text → pattern-only; else unattributed (the seam where an LLM matcher plugs in
 * later). A FAIL verdict with an all-pass artifact is its own bucket (fail-unattributed) because
 * verifyChecklist never scrutinizes FAILs.
 *
 * House conventions (decisions-eval): NULL is a verdict — an inconclusive row costs its expected
 * class. Baselines embed gateHash (brief + checklist + gate source) + corpusHash and comparison
 * mechanically SKIPS on mismatch. --fail = hard floors + per-row McNemar flip table (stable flips
 * only), never raw aggregate deltas. Every run appends one line to runs.log.
 *
 * Cost (48 rows, concurrency 2): haiku cascade-off --dev ≈ 25–35 min · sonnet cascade-on ≈ 1.5–2 h ·
 * haiku cascade-on ≈ 1–1.5 h · opus cascade-on ≈ 2.5–3 h. A budget line prints before any spend.
 *
 * BENCH-ONLY: this directory is excluded from tsc + the build (tsconfig* `**⁄eval⁄**`) and the
 * published package ships `dist` only — nothing here (bench, miner, corpus) reaches production.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BenchAbort,
  cleanBenchEnv,
  materializeFixture,
  mcnemarMidP,
  parseCasesText,
  wilson,
} from '../../../decisions/eval/bench.mts';
import { resolveGuardConfig } from '../../../config.mts';
import { execJudgeAsync } from '../../../judge/run-judge.mts';
import { REVIEWERS, checklistScript, parseReviewVerdict, selectReviewers } from '../../reviewers.mts';
import { runCascade } from '../../run-review.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
// gate-engine/review/eval/reviewers → repo root is four levels up.
const repoRoot = path.resolve(here, '../../../..');

const MODEL = process.env.BENCH_MODEL ?? 'sonnet';
const CASCADE = (process.env.BENCH_CASCADE ?? 'on') !== 'off';
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.BENCH_CONCURRENCY ?? '2', 10) || 2);

const BASELINE_FILE = path.join(here, 'results.baseline.json');
const RUNS_LOG = path.join(here, 'runs.log');

// Checkpoint/resume: every completed row is appended to a per-config progress file the moment it
// lands, so a run killed by a rate limit / account switch loses NOTHING — re-running the same
// command auto-resumes (rows with matching config+hashes and a non-outage result are reused;
// --fresh discards). After OUTAGE_TRIP consecutive judge outages the run pauses itself early:
// under a drained credit pool every further row would burn its attempt and score as an outage.
const progressFile = (model, cascade) =>
  path.join(here, `progress-${model}-${cascade ? 'on' : 'off'}.jsonl`);
const OUTAGE_TRIP = 3;
const RETRYABLE = new Set(['outage', 'engine-error']);

/** The reviewers this bench covers — the 4 domain reviewers. commit-guard is deferred: its
 * allowlist appends the consumer's semantic-search MCP tool, which cannot resolve inside a bare
 * fixture repo. A future correctness reviewer joins by adding its cases file here. */
export const BENCH_REVIEWERS = REVIEWERS.filter(
  (r) => r.domain === 'backend' || r.domain === 'frontend' || r.domain === 'all',
);

// Fixture layout every row lands in: backend rows stage under api/, frontend rows under web/, and
// correctness (domain 'all') rows may live under any of api/, web/, or src/ (its roots = the
// union). selectReviewers then fires exactly the row's target reviewer.
const FIXTURE_CONFIG = {
  scanRoots: ['api', 'web', 'src'],
  sourceExtensions: ['ts', 'tsx', 'js', 'mjs'],
  review: { backendRoots: ['api'], frontendRoots: ['web'] },
};

// Per-pass wall-clock estimates (seconds) for the budget line. Checklist workflow ≈ 4–10 tool
// turns on top of diff reading; escalation reruns the whole workflow on opus.
const EST_FIRST_SECS = { haiku: 70, sonnet: 135, opus: 270 };
const EST_ESCALATE_SECS = 210;

// ─── Small helpers ────────────────────────────────────────────────────────────────

const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

const fmtCi = (k, n) => {
  const { lo, hi } = wilson(k, n);
  return `${k}/${n}${n ? ` = ${(k / n).toFixed(2)}` : ''} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
};

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

// ─── Corpus ───────────────────────────────────────────────────────────────────────

const casesFile = (reviewer) => path.join(here, `cases-${reviewer.skill}.jsonl`);

const ROW_ENUMS = {
  expected: ['FAIL', 'PASS'],
  difficulty: ['clear', 'borderline', 'adversarial'],
  provenance: ['authored', 'mined', 'adapted'],
};

/** Structural corpus lint — throws BenchAbort on the first malformed row. Cheap and always on:
 * a bad label silently mis-scoring a run is worse than a refused run. */
export function lintRows(rows, reviewerName) {
  const seen = new Set();
  for (const row of rows) {
    const where = `${reviewerName}/${row.id ?? '<no id>'}`;
    if (!row.id || seen.has(row.id)) throw new BenchAbort(2, `duplicate/missing id: ${where}`);
    seen.add(row.id);
    if (!row.note) throw new BenchAbort(2, `${where}: every row needs a note (why the label is right)`);
    for (const [field, allowed] of Object.entries(ROW_ENUMS))
      if (row[field] !== undefined && !allowed.includes(row[field]))
        throw new BenchAbort(2, `${where}: ${field}=${row[field]} not in ${allowed.join('|')}`);
    if (!row.expected) throw new BenchAbort(2, `${where}: missing expected`);
    if (row.expected === 'FAIL' && !(Array.isArray(row.expectItems) && row.expectItems.length > 0))
      throw new BenchAbort(2, `${where}: expected FAIL needs expectItems`);
    if (!row.repo?.base || !row.repo?.staged) throw new BenchAbort(2, `${where}: missing repo.base/staged`);
    if (row.reviewer !== reviewerName)
      throw new BenchAbort(2, `${where}: reviewer=${row.reviewer} but lives in ${reviewerName}'s file`);
  }
  return rows;
}

function loadRows(reviewer, { dev = false, only = null } = {}) {
  const file = casesFile(reviewer);
  if (!existsSync(file)) throw new BenchAbort(2, `reviewer-eval: missing ${path.basename(file)}`);
  let rows = lintRows(parseCasesText(readFileSync(file, 'utf8')), reviewer.name);
  if (dev) rows = rows.filter((r) => !r.holdout);
  if (only) rows = rows.filter((r) => r.id.startsWith(only));
  return rows;
}

// ─── Fixture assets ───────────────────────────────────────────────────────────────

/**
 * The gate files a fixture repo needs before the judge runs, keyed by fixture-relative path:
 * guard.config.json (roots that make selectReviewers fire the target), the reviewer's agent brief
 * under the default agentsDir, and its checklist script at the EXACT path allowedToolsFor
 * whitelists. All read from the repo source of truth (agents/, skills/) — bench and gate share
 * one copy, so a brief/checklist edit is automatically what gets measured.
 */
export function buildAssets(reviewer) {
  const brief = readFileSync(path.join(repoRoot, 'agents', `${reviewer.name}.md`), 'utf8');
  const script = readFileSync(
    path.join(repoRoot, 'skills', reviewer.skill, 'scripts', 'checklist.mjs'),
    'utf8',
  );
  return {
    'guard.config.json': `${JSON.stringify(FIXTURE_CONFIG, null, 2)}\n`,
    [`.claude/agents/${reviewer.name}.md`]: brief,
    [checklistScript(reviewer)]: script,
  };
}

/** gateHash: everything whose edit invalidates comparability — the cascade source, the pure gate
 * logic, and the reviewer's own brief + checklist (the brief IS gate code, completeness-eval rule). */
export function benchGateHash(reviewer) {
  return sha12(
    [
      readFileSync(path.join(repoRoot, 'gate-engine/review/run-review.mts'), 'utf8'),
      readFileSync(path.join(repoRoot, 'gate-engine/review/reviewers.mts'), 'utf8'),
      readFileSync(path.join(repoRoot, 'agents', `${reviewer.name}.md`), 'utf8'),
      readFileSync(path.join(repoRoot, 'skills', reviewer.skill, 'scripts', 'checklist.mjs'), 'utf8'),
    ].join('\n \n'),
  );
}

const corpusHash = (reviewer) => sha12(readFileSync(casesFile(reviewer), 'utf8'));

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
      capture.push({ label: opts.label, out: 'VERDICT: FAIL — cascade disabled (bench)', ms: 0, snapshot: null, synthetic: true });
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

function subcause(reason) {
  if (/outage/i.test(reason)) return 'outage';
  if (/no VERDICT/i.test(reason)) return 'no-verdict';
  if (/checklist/i.test(reason)) return 'checklist-void';
  return 'other';
}

/**
 * Deterministic adjudication of one cascade against its row label.
 * Reason attribution (expected-FAIL rows that finally failed): the authoritative artifact is the
 * FAILING pass's snapshot (escalation's when it ran live, else the first pass's).
 */
export function scoreRow(row, capture, cas) {
  const first = capture.find((c) => c.label === `review:${row.reviewer}`);
  const esc = capture.find((c) => c.label === `review:${row.reviewer}:escalate`);
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
      if (row.reasonPattern && new RegExp(row.reasonPattern, 'i').test(text)) reasonClass = 'pattern-only';
      else reasonClass = failedItems.length === 0 ? 'fail-unattributed' : 'unattributed';
    }
  }
  return {
    id: row.id,
    reviewer: row.reviewer,
    expected: row.expected,
    holdout: !!row.holdout,
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
  const fx = materializeFixture({ repo: { base: { ...row.repo.base, ...assets }, staged: row.repo.staged } });
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
    const spy = makeSpyExec(capture, { reviewer, cascade, delegate: exec });
    const cas = await runCascade(sel, { cwd: fx.repo, cfg, exec: spy, firstModel: model });
    return scoreRow(row, capture, cas);
  } finally {
    fx.cleanup();
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────────

const count = (rows, pred) => rows.filter(pred).length;

/** Aggregate scored rows → the metric block for one scope (a reviewer, or pooled). */
export function summarize(results, { cascade = CASCADE } = {}) {
  const gold = results.filter((r) => r.expected === 'FAIL');
  const decoys = results.filter((r) => r.expected === 'PASS');
  const blocked = gold.filter((r) => r.okFinal);
  const reasons = {};
  for (const r of blocked) if (r.reasonClass) reasons[r.reasonClass] = (reasons[r.reasonClass] ?? 0) + 1;
  const inconclusive = {};
  for (const r of results)
    if (r.subcause) inconclusive[r.subcause] = (inconclusive[r.subcause] ?? 0) + 1;
  const liveEscalations = results.filter((r) => r.escalateLive);
  return {
    rows: results.length,
    gold: gold.length,
    decoys: decoys.length,
    firstFailRecall: { k: count(gold, (r) => r.firstVerdict === 'FAIL'), n: gold.length },
    firstCleanPass: { k: count(decoys, (r) => r.firstVerdict === 'PASS'), n: decoys.length },
    ...(cascade
      ? {
          blockRecall: { k: blocked.length, n: gold.length },
          cleanPass: { k: count(decoys, (r) => r.okFinal), n: decoys.length },
        }
      : {}),
    escalations: liveEscalations.length,
    escalateMeanSecs: liveEscalations.length
      ? Math.round(liveEscalations.reduce((s, r) => s + r.ms.escalate, 0) / liveEscalations.length / 1000)
      : 0,
    reasons,
    inconclusive,
  };
}

function printSummary(name, s, { cascade }) {
  console.log(`\n${name} (${s.rows} rows: ${s.gold} gold / ${s.decoys} decoys)`);
  console.log(`  first-pass FAIL-recall   ${fmtCi(s.firstFailRecall.k, s.firstFailRecall.n)}`);
  console.log(`  first-pass clean-pass    ${fmtCi(s.firstCleanPass.k, s.firstCleanPass.n)}`);
  if (cascade) {
    console.log(`  end-to-end block recall  ${fmtCi(s.blockRecall.k, s.blockRecall.n)}`);
    console.log(`  end-to-end clean-pass    ${fmtCi(s.cleanPass.k, s.cleanPass.n)}`);
  }
  const reasons = Object.entries(s.reasons).map(([k, v]) => `${k}:${v}`).join(' ') || '—';
  console.log(`  right-reason split       ${reasons}`);
  console.log(`  live escalations         ${s.escalations}${s.escalations ? ` (mean ${s.escalateMeanSecs}s)` : ''}`);
  const inc = Object.entries(s.inconclusive).map(([k, v]) => `${k}:${v}`).join(' ');
  if (inc) console.log(`  inconclusive             ${inc}`);
}

// ─── Baseline / compare ───────────────────────────────────────────────────────────

const sectionKey = (reviewerName, model, cascade) =>
  `${reviewerName}@${model}@${cascade ? 'cascade-on' : 'cascade-off'}`;

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
 * Regression verdict for one reviewer section vs baseline. Preconditions first (hash/config
 * mismatch → comparison SKIPPED, loudly), then the per-row flip table under mid-p McNemar.
 * Flips use okFinal when both runs had the cascade, else okFirst. Returns {skipped, regressed,
 * detail}. Stability: rows the caller re-ran and that flipped BACK are not counted (caller
 * filters via `stable`).
 */
export function compareReviewer(name, nowRows, nowMeta, base) {
  const key = sectionKey(name, nowMeta.model, nowMeta.cascade);
  const section = base?.sections?.[key];
  if (!section) return { skipped: `no baseline section ${key}` };
  if (section.gateHash !== nowMeta.gateHash)
    return { skipped: `gate code / brief / checklist changed (${key}) — regenerate with --baseline` };
  if (section.corpusHash !== nowMeta.corpusHash)
    return { skipped: `corpus changed (${key}) — regenerate with --baseline` };
  let b = 0;
  let c = 0;
  const flips = [];
  for (const row of nowRows) {
    const baseRow = section.rows[row.id];
    if (!baseRow || row.stable === false) continue;
    const wasOk = nowMeta.cascade ? baseRow.okFinal : baseRow.okFirst;
    const isOk = nowMeta.cascade ? row.okFinal : row.okFirst;
    if (wasOk && !isOk) {
      b += 1;
      flips.push(`${row.id} ↓`);
    } else if (!wasOk && isOk) {
      c += 1;
      flips.push(`${row.id} ↑`);
    }
  }
  const p = mcnemarMidP(b, c);
  const regressed = b > c && p < 0.05;
  return {
    skipped: null,
    regressed,
    detail: `flips ↓${b} ↑${c} (mid-p ${p.toFixed(3)})${flips.length ? ` — ${flips.join(', ')}` : ''}`,
  };
}

// ─── validate / coverage (0 LLM calls) ────────────────────────────────────────────

/** Corpus linter: selection fires the target reviewer, expectItems ⊆ what the REAL checklist
 * generate enumerates, no VERDICT prompt-injection in staged content, per-row item counts. */
export function validateRow(row) {
  const problems = [];
  const reviewer = BENCH_REVIEWERS.find((r) => r.name === row.reviewer);
  if (!reviewer) return { problems: [`unknown reviewer ${row.reviewer}`], itemCount: 0 };
  for (const content of Object.values(row.repo.staged))
    if (content && /VERDICT:/i.test(content)) problems.push('staged content contains "VERDICT:" (prompt-injection hazard)');
  const assets = buildAssets(reviewer);
  const fx = materializeFixture({ repo: { base: { ...row.repo.base, ...assets }, staged: row.repo.staged } });
  let itemCount = 0;
  try {
    const cfg = resolveGuardConfig(fx.repo);
    const sel = selectReviewers(fx.staged, cfg).find((s) => s.reviewer.name === row.reviewer);
    if (!sel) problems.push('selectReviewers does not fire the target reviewer');
    execFileSync('node', [checklistScript(reviewer), 'generate'], { cwd: fx.repo, encoding: 'utf8' });
    let names = [];
    try {
      const state = JSON.parse(readFileSync(path.join(fx.repo, reviewer.stateFile), 'utf8'));
      names = (state.items ?? []).map((i) => i.name);
      itemCount = names.length;
    } catch {
      problems.push('checklist generate left no readable artifact');
    }
    for (const want of row.expectItems ?? [])
      if (!names.includes(want)) problems.push(`expectItems: ${want} not in generated [${names.join(', ')}]`);
  } finally {
    fx.cleanup();
  }
  return { problems, itemCount };
}

function validate({ dev = false, targets = [...BENCH_REVIEWERS] } = {}) {
  cleanBenchEnv();
  let bad = 0;
  for (const reviewer of targets) {
    const rows = loadRows(reviewer, { dev });
    console.log(`\n${reviewer.name} — ${rows.length} rows`);
    for (const row of rows) {
      const { problems, itemCount } = validateRow(row);
      const fat = itemCount > 6 ? '  ⚠ fat row (cost)' : '';
      if (problems.length === 0) console.log(`  ${row.id.padEnd(36)} OK    ${itemCount} items${fat}`);
      else {
        bad += 1;
        console.log(`  ${row.id.padEnd(36)} BAD   ${problems.join(' | ')}`);
      }
    }
  }
  if (bad > 0) throw new BenchAbort(1, `reviewer-eval: validate found ${bad} bad row(s)`);
  console.log('\nvalidate: all rows OK');
}

/** Which catalog items each corpus exercises — parsed from the checklist scripts themselves so
 * coverage stays honest against catalog drift. */
function coverage() {
  for (const reviewer of BENCH_REVIEWERS) {
    const script = readFileSync(path.join(repoRoot, 'skills', reviewer.skill, 'scripts', 'checklist.mjs'), 'utf8');
    const catalog = [...script.matchAll(/name:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
    const rows = loadRows(reviewer);
    const hit = new Set(rows.flatMap((r) => r.expectItems ?? []));
    const gold = rows.filter((r) => r.expected === 'FAIL').length;
    const byProv = {};
    for (const r of rows) byProv[r.provenance ?? '?'] = (byProv[r.provenance ?? '?'] ?? 0) + 1;
    console.log(`\n${reviewer.name}: ${rows.length} rows (${gold} gold), provenance ${JSON.stringify(byProv)}`);
    console.log(`  covered items   ${catalog.filter((c) => hit.has(c)).join(', ') || '—'}`);
    console.log(`  uncovered items ${catalog.filter((c) => !hit.has(c)).join(', ') || '—'}`);
  }
}

// ─── run ──────────────────────────────────────────────────────────────────────────

function loadProgress(model, cascade) {
  try {
    return parseCasesText(readFileSync(progressFile(model, cascade), 'utf8'));
  } catch {
    return [];
  }
}

/** Checkpointed rows reusable for THIS reviewer + gate + corpus: retryable outcomes
 * (outage/engine-error) re-run; a hash mismatch simply never matches — stale checkpoints are
 * inert, not dangerous. */
export function salvageMap(progress, reviewerName, meta) {
  return new Map(
    progress
      .filter(
        (p) =>
          p.reviewer === reviewerName &&
          p.gateHash === meta.gateHash &&
          p.corpusHash === meta.corpusHash &&
          !RETRYABLE.has(p.res.subcause),
      )
      .map((p) => [p.res.id, p.res]),
  );
}

async function runBench(targets, { dev, only, writeBaseline, failMode, fresh }) {
  cleanBenchEnv();
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
    (totalRows * (EST_FIRST_SECS[MODEL] ?? EST_FIRST_SECS.sonnet) + estEscalations * EST_ESCALATE_SECS) /
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

  const baseline = loadBaseline();
  const allResults = [];
  const perReviewer = [];
  for (const { reviewer, rows } of plan) {
    const meta = {
      model: effModel(reviewer),
      cascade: effCascade(reviewer),
      gateHash: benchGateHash(reviewer),
      corpusHash: corpusHash(reviewer),
    };
    const salvage = salvageMap(progress, reviewer.name, meta);
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
      let res;
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
        `${JSON.stringify({ reviewer: reviewer.name, gateHash: meta.gateHash, corpusHash: meta.corpusHash, res })}\n`,
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
    if (
      failMode &&
      section &&
      section.gateHash === meta.gateHash &&
      section.corpusHash === meta.corpusHash
    ) {
      for (const res of results) {
        const baseRow = section.rows[res.id];
        if (!baseRow) continue;
        const wasOk = meta.cascade ? baseRow.okFinal : baseRow.okFirst;
        const isOk = meta.cascade ? res.okFinal : res.okFirst;
        if (wasOk !== isOk) {
          console.log(`  ${res.id}: discordant with baseline — re-running once to confirm`);
          try {
            const rerun = await runRow(plan.find((p) => p.reviewer === reviewer).rows.find((r) => r.id === res.id));
            const rerunOk = meta.cascade ? rerun.okFinal : rerun.okFirst;
            res.stable = rerunOk === isOk;
            if (!res.stable) console.log(`  ${res.id}: flip did not reproduce — excluded from flip table`);
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

  // ── Floors + flips (--fail) ──
  let failed = false;
  if (failMode) {
    if (pooledCascade) {
      const br = pooled.blockRecall;
      const cp = pooled.cleanPass;
      if (br.n && br.k / br.n < FLOORS.blockRecall) {
        console.error(`FLOOR: pooled block recall ${fmtCi(br.k, br.n)} < ${FLOORS.blockRecall}`);
        failed = true;
      }
      if (cp.n && cp.k / cp.n < FLOORS.cleanPass) {
        console.error(`FLOOR: pooled clean-pass ${fmtCi(cp.k, cp.n)} < ${FLOORS.cleanPass}`);
        failed = true;
      }
    }
    if (MODEL === 'sonnet') {
      const fr = pooled.firstFailRecall;
      if (fr.n && fr.k / fr.n < FLOORS.firstFailRecallSonnetOnly) {
        console.error(`FLOOR: pooled first-pass FAIL-recall ${fmtCi(fr.k, fr.n)} < ${FLOORS.firstFailRecallSonnetOnly}`);
        failed = true;
      }
    }
    for (const { reviewer, results, meta } of perReviewer) {
      const cmp = compareReviewer(reviewer.name, results, meta, baseline);
      if (cmp.skipped) console.log(`compare ${reviewer.name}: SKIPPED — ${cmp.skipped}`);
      else {
        console.log(`compare ${reviewer.name}: ${cmp.regressed ? 'REGRESSED' : 'ok'} — ${cmp.detail}`);
        if (cmp.regressed) failed = true;
      }
    }
  }

  // ── Baseline write ──
  if (writeBaseline) {
    if (only) throw new BenchAbort(2, 'reviewer-eval: refusing --baseline with --only (partial corpus)');
    const outages = allResults.filter((r) => r.subcause === 'outage' || r.subcause === 'engine-error').length;
    if (outages > 0)
      throw new BenchAbort(2, `reviewer-eval: refusing --baseline with ${outages} outage/error row(s)`);
    const next = loadBaseline() ?? { sections: {} };
    for (const { reviewer, results, meta } of perReviewer) {
      next.sections[sectionKey(reviewer.name, meta.model, meta.cascade)] = {
        ...meta,
        when: new Date().toISOString(),
        dev,
        rows: Object.fromEntries(
          results.map((r) => [r.id, { expected: r.expected, okFirst: r.okFirst, okFinal: r.okFinal, finalStatus: r.finalStatus }]),
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
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--only');
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
