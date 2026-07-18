#!/usr/bin/env node

/**
 * decisions-eval: accuracy benchmark for the three decisions-gate LLM judges —
 *   detect    the smell-downgrade judge (../detect.mjs): DECISION | ROUTINE | null
 *   alignment the agentic haiku→opus cascade (../check-alignment.mjs): ALIGN | CONTRADICT | UNCLEAR | null
 *   depth     the Target rationale-depth judge (../check-alignment.mjs): PASS | THIN | null
 *
 * A prompt/model/config edit to any judge is unverifiable without a measurable check; this scores
 * the judges against labelled corpora so a change is a delta, not a guess. It imports the judge
 * runners FROM THE GATES (runDetectJudge / judgeDetailed / runDepthJudge + the parsers), so the
 * benchmark exercises the exact prompt/argv/truncation/timeout/cascade the gates run — no drift.
 *
 * SEED corpora: cases-*.jsonl ship small, GENERIC starter sets (no repo-specific content). They are
 * seeds, not data the gates read at runtime — copy and grow them with your own real cases for a
 * meaningful score. No baseline ships: generate yours with --baseline once tuned.
 *
 *   node bench.mjs [detect|alignment|depth|all]   # run, print confusion matrix + per-class P/R/F1
 *   node bench.mjs all --baseline                 # write this run as the baseline (results.baseline.json)
 *   node bench.mjs all --fail                     # exit 1 on floor breach or significant flips vs baseline
 *   node bench.mjs detect --dev                   # prompt-iteration tier: holdout rows excluded
 *   node bench.mjs coverage                       # corpus coverage matrix (zero claude calls)
 *   node bench.mjs depth-audit                    # the 100-year audit: judge THIS repo's real decision
 *                                                 # records (docs/decisions/) — no labels, informational
 *
 * Sweeps:
 *   BENCH_MODEL=haiku|sonnet           first/only model for all three judges (default haiku)
 *   BENCH_ESCALATE_MODEL=opus|sonnet   alignment second pass (default opus)
 *   BENCH_CASCADE=on|off               off = never escalate to the second model (default on).
 *                                      A cascade-ON run scores BOTH configs at once: the final
 *                                      (cascade) verdicts AND the first-pass (haiku-alone) verdicts,
 *                                      plus the escalation rate — one run, both cells.
 *   BENCH_RUNS=1|3                     K trials per judged detect/depth row, majority vote (default 1;
 *                                      use 3 for --baseline/--fail — a single nondeterministic run is
 *                                      not a baseline). Alignment stays K=1 and instead re-runs only
 *                                      baseline-discordant rows once before counting a flip.
 *
 * Statistics (small-n honesty — the corpus is a large-effect tripwire, not a 5pp detector):
 * headline metrics print raw counts + Wilson 95% intervals; --fail gates on the per-row FLIP TABLE
 * vs baseline (mid-p McNemar < 0.05, stable flips only) plus hard floors on the safety metrics —
 * never on raw aggregate deltas. Baselines embed gate-code + corpus hashes; a mismatch skips the
 * comparison instead of lying. Every run appends to runs.log (gitignored) — the anti-Goodhart
 * ledger of how often prompts were iterated against this corpus.
 *
 * Headline metrics (each judge fails differently — a single accuracy hides what matters):
 *   detect    → DECISION recall      (a false ROUTINE silently unrecords a decision — the worst case)
 *   alignment → CONTRADICT precision (a false CONTRADICT blocks a legitimate commit — the worst case)
 *   depth     → accuracy             (warn-only)
 *
 * NULL is a verdict, not an error: each parser returns null on ambiguity and each gate fails safe in
 * its own direction (detect: block stands · alignment: no block · depth: no warn). NULL gets its own
 * confusion-matrix column; detect rows may even EXPECT it — those rows are scored and displayed but
 * excluded from the --fail comparison (deliberate-ambiguity is the least stable ground truth).
 *
 * Exit 0 = ran (no regression under --fail) · 1 = regression (with --fail) · 2 = could not run.
 * Outage policy is asymmetric BY COST: a detect/depth row is ~30s, so the first dark-judge row
 * aborts (exit 2, sentry-style); an alignment row is 1–6 min, so a mid-run outage scores that row
 * NULL and continues (exit 2 only when every judged row was an outage). Outages print in the summary.
 *
 * Cost: every judged row is a `claude -p` cold start. Budget ≈ detect 30s · depth 40s · alignment
 * 60–120s per row + 120–240s per escalation. An estimate prints before any token is spent.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveFromCwd, resolveGuardConfig } from '../../config.mts';
import { wilsonScoreInterval } from '../../eval/statistics.mts';
import {
  judgeDetailed,
  matchScope,
  parseDepthVerdict,
  runDepthJudge,
} from '../check-alignment.mts';
import { currentTarget, parseDecision } from '../decisions.mts';
import { buildDetectJudgeInput, detectSmells, parseVerdict, runDetectJudge } from '../detect.mts';
import { DECISIONS_ACCEPTANCE, selectAlignmentContradiction } from './acceptance.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'results.baseline.json');

const MODEL = process.env.BENCH_MODEL ?? 'haiku';
const ESCALATE_MODEL = process.env.BENCH_ESCALATE_MODEL ?? 'opus';
const CASCADE = (process.env.BENCH_CASCADE ?? 'on') !== 'off';
// K trials per judged row (detect/depth): the judge is nondeterministic (rows observed flipping
// between identical runs), so baseline/--fail runs vote majority-of-K and report the flip rate.
// Alignment stays K=1 (rows cost 10x) and retries only baseline-discordant rows instead.
const RUNS = Math.max(1, Number.parseInt(process.env.BENCH_RUNS ?? '1', 10) || 1);

const SUBS = ['detect', 'alignment', 'depth'];

/** Deliberate abort with a bench exit code — thrown (not process.exit) so tests can assert it. */
export class BenchAbort extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ─── Environment hygiene ──────────────────────────────────────────────────────────
// GUARD_*/FRINK_* leak straight into the judges via resolveGuardConfig (NO_LLM nulls every row;
// DECISIONS_DIR redirects fixture config). The GIT_* control vars are the documented repo-corruption
// class: inherited by a hook-launched process, they point fixture `git init/commit` at the HOST
// repo's .git. Strip both families; bench knobs are all BENCH_* so a wholesale strip is safe.
const GUARD_ENV_RE = /^(GUARD|FRINK)_/;
const REVISIT_LINE_RE = /^\*\*Revisit-when:\*\*/m;
const GIT_CONTROL_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
];

export function cleanBenchEnv(env = process.env) {
  const stripped = [];
  for (const key of Object.keys(env)) {
    if (GUARD_ENV_RE.test(key) || GIT_CONTROL_VARS.includes(key)) {
      delete env[key];
      stripped.push(key);
    }
  }
  return stripped;
}

function preflightClaude() {
  try {
    execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000 });
  } catch {
    throw new BenchAbort(2, 'decisions-eval: `claude` CLI not available — cannot benchmark');
  }
}

// ─── Corpus loading ───────────────────────────────────────────────────────────────

export const parseCasesText = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function loadCases(name) {
  const file = path.join(here, `cases-${name}.jsonl`);
  let rows: ReturnType<typeof parseCasesText>;
  try {
    rows = parseCasesText(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new BenchAbort(2, `decisions-eval: cannot read ${path.basename(file)} — ${e}`);
  }
  if (!rows.length) throw new BenchAbort(2, `decisions-eval: ${path.basename(file)} is empty`);
  return rows;
}

// ─── Metrics (pure) ───────────────────────────────────────────────────────────────

/**
 * Multiclass tally. `rows` = [{expected, got}]; `classes` = the REAL judge vocabulary. NULL (and
 * NO-MATCH for alignment) appear as confusion columns/rows but never join the macro-F1 mean — a
 * got-NULL still costs its expected class recall, which is the honest penalty. Accuracy covers ALL
 * rows (free-skips included, sentry convention).
 */
export function tally(rows, classes) {
  const confusion = {};
  let correct = 0;
  for (const { expected, got } of rows) {
    confusion[expected] ??= {};
    confusion[expected][got] = (confusion[expected][got] ?? 0) + 1;
    if (expected === got) correct += 1;
  }
  const perClass = {};
  for (const c of classes) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const { expected, got } of rows) {
      if (expected === c && got === c) tp += 1;
      else if (expected !== c && got === c) fp += 1;
      else if (expected === c && got !== c) fn += 1;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    perClass[c] = { tp, fp, fn, precision, recall, f1 };
  }
  const macroF1 = classes.reduce((s, c) => s + perClass[c].f1, 0) / classes.length;
  const total = rows.length;
  return {
    confusion,
    perClass,
    macroF1,
    correct,
    total,
    accuracy: total ? Number(((correct / total) * 100).toFixed(1)) : 0,
  };
}

// ─── Small-n statistics (pure, dep-free) ────────────────────────────────────────
// At this corpus size the bench is a LARGE-EFFECT TRIPWIRE, not a 5pp regression detector:
// Wilson 95% on 14/16 is ~[64%, 96%], and detecting a 5pp drop with power would need ~630 rows.
// So every metric ships its interval, and the --fail gate runs on the per-row FLIP TABLE with a
// paired mid-p McNemar test — never on raw aggregate deltas (two runs with identical accuracy can
// disagree on a third of rows; the aggregate hides it). Wilson over bootstrap/Wald: closed-form and
// correctly covered below n=100 (Brown/Cai/DasGupta 2001; Miller arXiv:2411.00640).

/** Wilson 95% score interval for k successes of n. */
export function wilson(k, n, z = 1.96) {
  const { lower, upper } = wilsonScoreInterval(k, n, z);
  return { lo: lower, hi: upper };
}

const fmtCi = (k, n) => {
  const { lo, hi } = wilson(k, n);
  return `${k}/${n} = ${n ? (k / n).toFixed(2) : '—'} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
};

/**
 * Two-sided mid-p McNemar on a paired flip table: b = baseline-right→now-wrong, c = the reverse.
 * Exact binomial on the discordant pairs (X ~ Bin(b+c, ½)); mid-p halves the observed-point mass
 * (Fagerland 2013 — better calibrated than the exact test at tiny counts). p < 0.05 needs ~5+ net
 * one-directional flips at these corpus sizes — fewer is indistinguishable from judge noise.
 */
export function mcnemarMidP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // Bin(n, ½) pmf built iteratively — n is a flip count, always tiny.
  let pmf = 0.5 ** n; // P(X = 0)
  let cdf = 0;
  let atK = 0;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) pmf = (pmf * (n - i + 1)) / i;
    cdf += pmf;
    if (i === k) atK = pmf;
  }
  return Math.min(1, 2 * cdf - atK);
}

/** Majority verdict over K trials; a full tie is NULL (instability is fail-safe, not a vote). */
export function majorityVerdict(verdicts) {
  const counts = {};
  for (const v of verdicts) counts[v] = (counts[v] ?? 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const unanimous = sorted.length === 1;
  const verdict = sorted.length > 1 && sorted[0][1] === sorted[1][1] ? 'NULL' : sorted[0][0];
  return { verdict, unanimous };
}

// ─── Alignment fixture harness ────────────────────────────────────────────────────

/**
 * Materialize one alignment case as a disposable git repo in the system tmpdir: base tree committed,
 * staged map applied to the index (`null` content = staged deletion). The agentic judge then
 * investigates THAT world — never the host repo. realpath canonicalises the macOS /tmp symlink so
 * the judge cwd and git paths agree; local identity/gpgsign/hooksPath defuse any global git config.
 */
// Best-effort SIGINT cleanup: per-row try/finally is the primary path; this catches a ^C landing
// mid-claude-call so the current fixture doesn't linger in the tmpdir. Registered in main() only.
let activeFixtureCleanup = null;

export function materializeFixture(row) {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'decisions-eval-')));
  try {
    const g = (args) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 'bench@bench']);
    g(['config', 'user.name', 'bench']);
    g(['config', 'commit.gpgsign', 'false']);
    g(['config', 'core.hooksPath', '/dev/null']);
    for (const [rel, content] of Object.entries(row.repo.base)) {
      mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      writeFileSync(path.join(repo, rel), content);
    }
    g(['add', '-A']);
    g(['commit', '-q', '--no-verify', '-m', 'base']);
    for (const [rel, content] of Object.entries(row.repo.staged)) {
      if (content === null) rmSync(path.join(repo, rel));
      else {
        mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        writeFileSync(path.join(repo, rel), content);
      }
    }
    g(['add', '-A']);
    const staged = g(['diff', '--cached', '--name-only'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const cleanup = () => {
      activeFixtureCleanup = null;
      rmSync(repo, { recursive: true, force: true });
    };
    activeFixtureCleanup = cleanup;
    return { repo, staged, cleanup };
  } catch (e) {
    // A half-built fixture must not linger in the tmpdir when a git step throws.
    rmSync(repo, { recursive: true, force: true });
    throw e;
  }
}

// ─── Sub-benches ──────────────────────────────────────────────────────────────────

const rowLine = (id, ok, got, want, suffix = '') =>
  console.log(`  ${id.padEnd(30)} ${ok ? 'OK  ' : 'FAIL'}  got=${got} want=${want}${suffix}`);

/**
 * detect: rows whose declarative entries raise NO smell free-skip as ROUTINE (the gate never calls
 * the LLM there); the rest run the real downgrade judge on the row's diff. A dark judge aborts —
 * detect rows are cheap, a polluted run is worth less than a rerun.
 */
export function runDetectBench(rows, { model = MODEL, runs = RUNS } = {}) {
  const results = [];
  let judgedChars = 0;
  let judgedRaw = 0;
  let judgedCount = 0;
  let unstable = 0;
  for (const c of rows) {
    const smells = detectSmells(c.entries, c.boundaries ?? []);
    let got: string;
    let freeSkip = false;
    let stable = true;
    if (smells.length === 0) {
      got = 'ROUTINE';
      freeSkip = true;
    } else {
      // Exact gate path: evidence extraction first, then the judge (never the raw diff).
      const input = buildDetectJudgeInput(c.diff, c.entries, c.boundaries ?? []);
      judgedCount += 1;
      judgedChars += input.length;
      judgedRaw += String(c.diff).length;
      const verdicts = [];
      for (let k = 0; k < runs; k += 1) {
        const raw = runDetectJudge(process.cwd(), input, model);
        if (raw === null) throw new BenchAbort(2, 'decisions-eval: claude went dark mid-run');
        verdicts.push(parseVerdict(raw) ?? 'NULL');
      }
      const m = majorityVerdict(verdicts);
      got = m.verdict;
      stable = m.unanimous;
      if (!stable) unstable += 1;
    }
    const ok = got === c.expected;
    results.push({
      id: c.id,
      category: c.category,
      expected: c.expected,
      got,
      ok,
      freeSkip,
      stable,
    });
    rowLine(
      c.id,
      ok,
      got,
      c.expected,
      `${freeSkip ? ' (free-skip)' : ''}${stable ? '' : ' (unstable)'}`,
    );
  }
  const t = tally(results, ['DECISION', 'ROUTINE']);
  // Expected-NULL rows are deliberate-ambiguity probes — displayed, but too unstable to gate on.
  const scored = tally(
    results.filter((r) => r.expected !== 'NULL'),
    ['DECISION', 'ROUTINE'],
  );
  return {
    model,
    runs,
    correct: t.correct,
    total: t.total,
    accuracy: t.accuracy,
    accuracyScored: scored.accuracy,
    decision: round3(scored.perClass.DECISION),
    routine: round3(scored.perClass.ROUTINE),
    // Judge stability across the K trials — instability is reported, never folded into accuracy.
    flipRate: judgedCount && runs > 1 ? Number((unstable / judgedCount).toFixed(3)) : null,
    // The cost metric: mean judge-input size vs the raw diff it was extracted from — keeps the
    // "evidence-only is cheaper" claim measured, and a prompt change that bloats input shows up.
    meanInputChars: judgedCount ? Math.round(judgedChars / judgedCount) : 0,
    meanRawDiffChars: judgedCount ? Math.round(judgedRaw / judgedCount) : 0,
    confusion: t.confusion,
    byCategory: byCategory(results),
    rows: rowMap(results),
    results,
  };
}

/**
 * alignment: each row becomes a throwaway git repo; scope-matching mirrors alignmentPass (a no-match
 * row is the gate's free-skip). judgeDetailed runs the REAL cascade; a cascade-on run tallies both
 * the final verdicts and the haiku-alone first-pass verdicts. Outages score NULL per row (rows are
 * too expensive to vaporise a run on a quota blip) — all-outage still aborts.
 */
export function runAlignmentBench(
  rows,
  { model = MODEL, escalateModel = ESCALATE_MODEL, cascade = CASCADE, retryAgainst = null } = {},
) {
  const results = [];
  let judged = 0;
  let outages = 0;
  let escalated = 0;
  for (const c of rows) {
    let fx: ReturnType<typeof materializeFixture>;
    try {
      fx = materializeFixture(c);
    } catch (e) {
      // Fixture build failing is infra (git absent/misbehaving), not judge quality — abort with
      // the could-not-run code instead of crashing the bench with a raw stack.
      throw new BenchAbort(
        2,
        `decisions-eval: fixture build failed for ${c.id} — ${e?.message ?? e}`,
      );
    }
    let first: string;
    let final: string;
    let didEscalate = false;
    let outage = false;
    try {
      const matched = fx.staged.filter((f) => matchScope([f], c.target.scope));
      if (matched.length === 0) {
        first = 'NO-MATCH';
        final = 'NO-MATCH';
      } else {
        judged += 1;
        const d = judgeDetailed(
          matched,
          { ruling: c.target.ruling, vision: c.target.vision },
          fx.repo,
          { firstModel: model, escalateModel, escalate: cascade },
        );
        if (d === null || d.firstRaw === null) {
          outage = true;
          outages += 1;
          first = 'NULL';
          final = 'NULL';
        } else {
          first = d.firstVerdict ?? 'NULL';
          final = d.finalVerdict ?? 'NULL';
          didEscalate = d.escalated;
          if (d.escalated) escalated += 1;
        }
      }
    } finally {
      fx.cleanup();
    }
    // Alignment rows cost 10x detect rows, so instead of K trials suite-wide, only a row whose
    // verdict DISAGREES with the baseline is re-run once: a 1-of-2 disagreement is instability
    // (stable:false — never counted as a regression flip), a 2-of-2 disagreement is real.
    let stable = true;
    if (
      !outage &&
      final !== 'NO-MATCH' &&
      retryAgainst?.[c.id] &&
      final !== retryAgainst[c.id].got
    ) {
      console.log(
        `  ${c.id.padEnd(30)} …disagrees with baseline (${retryAgainst[c.id].got}) — retrying once`,
      );
      let fx2: ReturnType<typeof materializeFixture> | null;
      try {
        fx2 = materializeFixture(c);
      } catch {
        fx2 = null; // retry is best-effort; the first verdict stands, marked unstable
      }
      if (fx2) {
        try {
          const matched2 = fx2.staged.filter((f) => matchScope([f], c.target.scope));
          const d2 = judgeDetailed(
            matched2,
            { ruling: c.target.ruling, vision: c.target.vision },
            fx2.repo,
            { firstModel: model, escalateModel, escalate: cascade },
          );
          const final2 = d2 === null || d2.firstRaw === null ? 'NULL' : (d2.finalVerdict ?? 'NULL');
          stable = final2 === final; // both runs agree → the disagreement with baseline is real
        } finally {
          fx2.cleanup();
        }
      } else {
        stable = false;
      }
    }
    const ok = final === c.expected;
    results.push({
      id: c.id,
      expected: c.expected,
      first,
      final,
      escalated: didEscalate,
      ok,
      stable,
    });
    const detail = first === final ? '' : ` (haiku: ${first}${didEscalate ? ' → escalated' : ''})`;
    rowLine(
      c.id,
      ok,
      final,
      c.expected,
      `${detail}${outage ? ' (outage)' : ''}${stable ? '' : ' (unstable)'}`,
    );
  }
  if (judged > 0 && outages === judged)
    throw new BenchAbort(2, 'decisions-eval: every judged alignment row was an outage');
  const classes = ['ALIGN', 'CONTRADICT', 'UNCLEAR'];
  const finalT = tally(
    results.map((r) => ({ expected: r.expected, got: r.final })),
    classes,
  );
  const firstT = tally(
    results.map((r) => ({ expected: r.expected, got: r.first })),
    classes,
  );
  const section = (t) => ({
    accuracy: t.accuracy,
    macroF1: Number(t.macroF1.toFixed(3)),
    contradict: round3(t.perClass.CONTRADICT),
    align: round3(t.perClass.ALIGN),
    unclear: round3(t.perClass.UNCLEAR),
    confusion: t.confusion,
  });
  return {
    model,
    escalateModel,
    cascade,
    correct: finalT.correct,
    total: finalT.total,
    accuracy: finalT.accuracy,
    final: section(finalT),
    firstPass: section(firstT),
    escalationRate: judged ? Number((escalated / judged).toFixed(3)) : 0,
    outages,
    runs: 1,
    rows: rowMap(results),
    results,
  };
}

/** depth: pure-text judge on each row's Target block. No free-skip class — the gate judges every
 * staged Target. Dark judge aborts (cheap rows, sentry-style). */
export function runDepthBench(rows, { model = MODEL, runs = RUNS } = {}) {
  const results = [];
  let unstable = 0;
  for (const c of rows) {
    const verdicts = [];
    for (let k = 0; k < runs; k += 1) {
      const raw = runDepthJudge(process.cwd(), c.block, model);
      if (raw === null) throw new BenchAbort(2, 'decisions-eval: claude went dark mid-run');
      verdicts.push(parseDepthVerdict(raw) ?? 'NULL');
    }
    const { verdict: got, unanimous: stable } = majorityVerdict(verdicts);
    if (!stable) unstable += 1;
    const ok = got === c.expected;
    results.push({ id: c.id, expected: c.expected, got, ok, stable });
    rowLine(c.id, ok, got, c.expected, stable ? '' : ' (unstable)');
  }
  const t = tally(results, ['PASS', 'THIN']);
  return {
    model,
    runs,
    correct: t.correct,
    total: t.total,
    accuracy: t.accuracy,
    pass: round3(t.perClass.PASS),
    thin: round3(t.perClass.THIN),
    flipRate: runs > 1 ? Number((unstable / results.length).toFixed(3)) : null,
    confusion: t.confusion,
    rows: rowMap(results),
    results,
  };
}

/**
 * The 100-year audit: run the REAL depth judge over this repo's actual decision records (not the
 * seed corpus). Answers "could a future reader reconstruct the what/why/rejected-roads AND tell
 * when each ruling becomes invalid?" per record. Informational — no labels, no baseline, exit 0;
 * a THIN here is a record to deepen (append a Target with --evidence-change, or add Revisit-when).
 */
export function runDepthAudit({ model = MODEL } = {}) {
  const cfg = resolveGuardConfig(process.cwd());
  const dir = resolveFromCwd(cfg, 'decisionsDir');
  if (!dir || !existsSync(dir))
    throw new BenchAbort(2, `decisions-eval: no decisions dir at ${dir ?? '(unset)'}`);
  const targets = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'INDEX.md') continue;
    const t = currentTarget(parseDecision(readFileSync(path.join(dir, f), 'utf8')).body);
    if (t?.block) targets.push({ slug: f.slice(0, -3), block: t.block });
  }
  if (!targets.length) throw new BenchAbort(2, `decisions-eval: no Target blocks under ${dir}`);
  console.log(
    `decisions-eval: depth-audit — ${targets.length} record(s), ~${Math.max(1, Math.round((targets.length * 40) / 60))} min  [model=${model}]`,
  );
  const counts = { PASS: 0, THIN: 0, NULL: 0 };
  for (const t of targets) {
    const raw = runDepthJudge(process.cwd(), t.block, model);
    if (raw === null) throw new BenchAbort(2, 'decisions-eval: claude went dark mid-run');
    const got = parseDepthVerdict(raw) ?? 'NULL';
    counts[got] += 1;
    const revisit = REVISIT_LINE_RE.test(t.block) ? '' : '  (no Revisit-when)';
    console.log(`  ${t.slug.padEnd(42)} ${got.padEnd(4)}${revisit}`);
  }
  console.log(
    `\ndepth-audit: ${counts.PASS}/${targets.length} PASS · ${counts.THIN} THIN · ${counts.NULL} NULL — ` +
      'a THIN record is one a future reader cannot safely re-evaluate; deepen it or add Revisit-when.',
  );
  return counts;
}

// ─── Reporting ────────────────────────────────────────────────────────────────────

function round3(pc) {
  return {
    ...pc,
    precision: Number(pc.precision.toFixed(3)),
    recall: Number(pc.recall.toFixed(3)),
    f1: Number(pc.f1.toFixed(3)),
  };
}

/** Per-row verdict map for the baseline — what the flip-table gate diffs against. */
function rowMap(results) {
  const map = {};
  for (const r of results)
    map[r.id] = { got: r.final ?? r.got, ok: r.ok, stable: r.stable ?? true, expected: r.expected };
  return map;
}

function byCategory(results) {
  const cats = {};
  for (const r of results) {
    if (!r.category) continue;
    cats[r.category] ??= { correct: 0, total: 0 };
    cats[r.category].total += 1;
    if (r.ok) cats[r.category].correct += 1;
  }
  return cats;
}

function printConfusion(confusion) {
  const gots = [...new Set(Object.values(confusion).flatMap((g) => Object.keys(g)))].sort();
  const expecteds = Object.keys(confusion).sort();
  console.log(`  ${'want \\ got'.padEnd(14)}${gots.map((g) => g.padStart(12)).join('')}`);
  for (const e of expecteds) {
    const cells = gots.map((g) => String(confusion[e][g] ?? 0).padStart(12));
    console.log(`  ${e.padEnd(14)}${cells.join('')}`);
  }
}

function printPerClass(perClass) {
  for (const [c, s] of Object.entries(perClass)) {
    console.log(
      `  ${c.padEnd(14)} precision ${s.precision.toFixed(2)}  recall ${s.recall.toFixed(2)}  ` +
        `F1 ${s.f1.toFixed(2)}  (tp=${s.tp} fp=${s.fp} fn=${s.fn})`,
    );
  }
}

// ─── Baseline + regression ────────────────────────────────────────────────────────

/** Informational metric deltas printed per sub-bench (headline first). NEVER gate on these:
 * aggregate deltas hide compensating per-row flips; the gate runs on the flip table below. */
const COMPARED = {
  detect: [
    ['DECISION recall', (s) => s.decision.recall],
    ['accuracy (scored rows)', (s) => s.accuracyScored],
  ],
  alignment: [
    ['CONTRADICT precision', (s) => selectAlignmentContradiction(s).precision],
    ['macro-F1', (s) => (s.cascade ? s.final : s.firstPass).macroF1],
  ],
  depth: [['accuracy', (s) => s.accuracy]],
};

const CONFIG_KEYS = {
  detect: ['model'],
  alignment: ['model', 'escalateModel', 'cascade'],
  depth: ['model'],
};

// Hard floors on the safety metrics: catastrophic breakage (truncated prompt, broken parser)
// fails immediately regardless of flip statistics. Point estimates, not Wilson bounds — the lower
// bound is uselessly wide at this n.
const FLOORS = {
  detect: ['DECISION recall', (s) => s.decision.recall, DECISIONS_ACCEPTANCE.floors.decisionRecall],
  alignment: [
    'CONTRADICT precision',
    (s) => selectAlignmentContradiction(s).precision,
    DECISIONS_ACCEPTANCE.floors.contradictionPrecision,
  ],
  depth: ['accuracy', (s) => s.accuracy / 100, DECISIONS_ACCEPTANCE.floors.depthAccuracy],
};

/**
 * Compare one sub-bench vs its baseline section — statistically honest at small n.
 *
 * Order of evaluation: (1) comparability preconditions — config, gate-code hash, corpus hash, and
 * alignment outages skip the comparison rather than lie; (2) hard floors on the safety metrics;
 * (3) the paired FLIP TABLE: b = rows the baseline got right and this run got wrong (counted only
 * when the flip is STABLE — unanimous across K trials, or retry-confirmed for alignment),
 * c = the reverse; fail iff mcnemarMidP(b, c) < 0.05 (~5+ net one-directional flips at this n);
 * (4) warn tier: any b > 0 prints the regressed row ids + the mid-p + an MDE line stating what
 * this bench cannot distinguish from noise. Humans act on warns; CI acts on fails. Expected-NULL
 * rows stay excluded, as before.
 */
export function compare(name, summary, base) {
  if (!base) return { regressed: false, lines: [`  ${name}: no baseline section — skipped`] };
  const skip = (why) => ({
    regressed: false,
    lines: [`  ${name}: ${why} — regenerate with --baseline; comparison skipped`],
  });
  const mismatch = CONFIG_KEYS[name].filter((k) => summary[k] !== base[k]);
  if (mismatch.length) return skip(`baseline config differs (${mismatch.join(', ')})`);
  if (base.gateHash && summary.gateHash && base.gateHash !== summary.gateHash)
    return skip('gate code changed since the baseline');
  if (base.corpusHash && summary.corpusHash && base.corpusHash !== summary.corpusHash)
    return skip('corpus changed since the baseline');
  if (name === 'alignment' && summary.outages > 0)
    return skip(`${summary.outages} outage(s) this run — score is suspect`);

  const arrow = (n) => (n > 0 ? '↑' : n < 0 ? '↓' : '=');
  const signed = (n) => `${n > 0 ? '+' : ''}${n.toFixed(3)}`;
  const lines = [];
  let regressed = false;

  for (const [label, pick] of COMPARED[name]) {
    const d = pick(summary) - pick(base);
    lines.push(`  ${name}: ${label} ${arrow(d)} ${signed(d)}  (informational)`);
  }

  const [floorLabel, floorPick, floor] = FLOORS[name];
  if (floorPick(summary) < floor) {
    regressed = true;
    lines.push(
      `  ${name}: FLOOR BREACH — ${floorLabel} ${floorPick(summary).toFixed(2)} < ${floor} (catastrophic; fails regardless of flip statistics)`,
    );
  }

  if (summary.rows && base.rows) {
    const bIds = [];
    const cIds = [];
    const unstableIds = [];
    for (const [id, cur] of Object.entries(summary.rows)) {
      const prev = base.rows[id];
      if (!prev || cur.expected === 'NULL') continue;
      if (prev.ok && !cur.ok) (cur.stable ? bIds : unstableIds).push(id);
      else if (!prev.ok && cur.ok) cIds.push(id);
    }
    const midP = mcnemarMidP(bIds.length, cIds.length);
    if (bIds.length + cIds.length > 0) {
      const n = Object.keys(summary.rows).length;
      const mde = 2.802 * Math.sqrt((bIds.length + cIds.length) / n / n);
      lines.push(
        `  ${name}: flips vs baseline — regressed [${bIds.join(', ') || '—'}] improved [${cIds.join(', ') || '—'}] (mid-p ${midP.toFixed(3)})`,
      );
      lines.push(
        `  ${name}: this bench cannot distinguish metric deltas below ~${(mde * 100).toFixed(0)}pp from judge noise at n=${n}`,
      );
    }
    if (unstableIds.length)
      lines.push(
        `  ${name}: unstable rows (non-unanimous/unconfirmed — instability, not regression): [${unstableIds.join(', ')}]`,
      );
    if (midP < 0.05 && bIds.length > cIds.length) {
      regressed = true;
      lines.push(
        `  ${name}: REGRESSION — one-directional flips are significant (mid-p ${midP.toFixed(3)} < 0.05)`,
      );
    }
  }

  return { regressed, lines };
}

// ─── Orchestration ────────────────────────────────────────────────────────────────

function printEstimate(plan, runs) {
  const parts = [];
  let seconds = 0;
  if (plan.detect) {
    const judged = plan.detect.filter(
      (c) => detectSmells(c.entries, c.boundaries ?? []).length,
    ).length;
    seconds += judged * 30 * runs;
    parts.push(`detect ${judged} judged × ~30s${runs > 1 ? ` × K=${runs}` : ''}`);
  }
  if (plan.alignment) {
    const judged = plan.alignment.filter((c) =>
      Object.keys(c.repo.staged).some((f) => matchScope([f], c.target.scope)),
    ).length;
    seconds += judged * 90;
    parts.push(`alignment ${judged} judged × ~90s (+120–240s per escalation; K=1)`);
  }
  if (plan.depth) {
    seconds += plan.depth.length * 40 * runs;
    parts.push(`depth ${plan.depth.length} judged × ~40s${runs > 1 ? ` × K=${runs}` : ''}`);
  }
  console.log(`decisions-eval: budget ≈ ${Math.round(seconds / 60)} min  (${parts.join(' · ')})`);
}

// The judged corpus + the judge code, hashed into the baseline: a comparison against a baseline
// generated from different rows or a different gate is mechanically skipped, never silently lied.
const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
const gateHash = () =>
  sha12(
    readFileSync(path.join(here, `../detect${SELF_EXT}`), 'utf8') +
      readFileSync(path.join(here, `../check-alignment${SELF_EXT}`), 'utf8'),
  );

/** Projected precision at realistic DECISION prevalence: the corpus is deliberately ~balanced for
 * measurement power, but real commit streams are mostly ROUTINE — precision is prevalence-dependent
 * (sensitivity/specificity are not), so report what the gate would look like in the wild. */
function ppvLine(s) {
  const tpr = s.decision.recall;
  const negatives = s.routine.tp + s.decision.fp;
  const fpr = negatives ? s.decision.fp / negatives : 0;
  const ppv = (p) => {
    const v = (tpr * p) / (tpr * p + fpr * (1 - p));
    return Number.isFinite(v) ? v.toFixed(2) : '—';
  };
  return `  projected precision at real prevalence: p=5% → ${ppv(0.05)} · p=15% → ${ppv(0.15)}  (corpus is balanced by design)`;
}

/** Metamorphic variant groups: rows sharing variantOf must agree (invariance) — consistency is
 * its own metric, never folded into accuracy (a prompt that gains accuracy but loses consistency
 * is Goodharting the corpus). */
function variantConsistency(rows, rowResults) {
  const groups = {};
  for (const r of rows) {
    if (!r.variantOf || r.variantKind === 'directional') continue;
    groups[r.variantOf] ??= new Set([r.variantOf]);
    groups[r.variantOf].add(r.id);
  }
  const ids = Object.keys(groups);
  if (!ids.length) return null;
  let consistent = 0;
  const broken = [];
  for (const g of ids) {
    const verdicts = new Set(
      [...groups[g]].map((id) => rowResults[id]?.got).filter((v) => v !== undefined),
    );
    if (verdicts.size <= 1) consistent += 1;
    else broken.push(g);
  }
  return { consistent, total: ids.length, broken };
}

/**
 * `bench.mjs coverage` — the corpus-coverage instrument (zero claude calls): per sub-bench, a
 * category × label × difficulty cell-count table plus provenance/holdout/variant tallies. Empty
 * or thin cells are the corpus's documented debt; grow rows toward them, not wherever is easy.
 */
function printCoverage() {
  for (const name of SUBS) {
    const rows = loadCases(name);
    console.log(`\n── ${name} (${rows.length} rows) ──`);
    const cells = {};
    const tag = { provenance: {}, holdout: 0, variants: 0 };
    for (const r of rows) {
      const key = `${(r.category ?? 'uncategorised').padEnd(24)} ${String(r.expected).padEnd(11)} ${r.difficulty ?? 'unset'}`;
      cells[key] = (cells[key] ?? 0) + 1;
      const p = r.provenance ?? 'authored';
      tag.provenance[p] = (tag.provenance[p] ?? 0) + 1;
      if (r.holdout) tag.holdout += 1;
      if (r.variantOf) tag.variants += 1;
    }
    console.log(`  ${'category'.padEnd(24)} ${'expected'.padEnd(11)} difficulty  rows`);
    for (const key of Object.keys(cells).sort()) console.log(`  ${key}  ${cells[key]}`);
    console.log(
      `  provenance: ${Object.entries(tag.provenance)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')} · holdout=${tag.holdout} · variant rows=${tag.variants}`,
    );
    const unset = rows.filter((r) => !r.difficulty).length;
    if (unset) console.log(`  COVERAGE DEBT: ${unset} row(s) missing a difficulty tag`);
  }
}

function appendLedger(entry) {
  try {
    appendFileSync(path.join(here, 'runs.log'), `${JSON.stringify(entry)}\n`);
  } catch {
    // The ledger is telemetry; never let it break a run.
  }
}

function main(argv) {
  const args = new Set(argv);
  const which = SUBS.filter((s) => args.has(s));
  const run = which.length ? which : SUBS;
  const writeBaseline = args.has('--baseline');
  const failOnRegression = args.has('--fail');
  const devOnly = args.has('--dev');

  process.on('SIGINT', () => {
    activeFixtureCleanup?.();
    process.exit(130);
  });
  const stripped = cleanBenchEnv();
  if (stripped.length)
    console.log(`decisions-eval: stripped env for a clean run: ${stripped.join(', ')}`);
  preflightClaude();

  if (args.has('depth-audit')) {
    runDepthAudit();
    process.exit(0);
  }
  if (args.has('coverage')) {
    printCoverage();
    process.exit(0);
  }

  // Policy guards: baseline/gate runs must include holdout rows and vote K≥3 on the cheap benches
  // (a single nondeterministic run is not a baseline). --dev is the prompt-iteration tier: holdout
  // rows excluded so iteration can't overfit them (they graduate into --baseline runs only).
  if (devOnly && (writeBaseline || failOnRegression))
    throw new BenchAbort(
      2,
      'decisions-eval: --dev excludes holdout rows — not valid with --baseline/--fail',
    );
  if ((writeBaseline || failOnRegression) && RUNS < 3 && run.some((s) => s !== 'alignment'))
    console.log(
      'decisions-eval: WARNING — baseline/--fail runs should use BENCH_RUNS=3 (majority vote); K=1 verdicts are noisy',
    );

  const plan = Object.fromEntries(run.map((s) => [s, loadCases(s)]));
  if (devOnly) for (const s of run) plan[s] = plan[s].filter((r) => !r.holdout);
  printEstimate(plan, RUNS);

  const gh = gateHash();
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  let regressed = false;
  const ledger = {
    ts: new Date().toISOString(),
    args: [...args],
    runs: RUNS,
    gateHash: gh,
    subs: {},
  };

  for (const name of run) {
    console.log(`\n── ${name} ──`);
    const retryAgainst = name === 'alignment' ? (baseline.alignment?.rows ?? null) : null;
    const s =
      name === 'alignment'
        ? runAlignmentBench(plan[name], { retryAgainst })
        : name === 'detect'
          ? runDetectBench(plan[name])
          : runDepthBench(plan[name]);
    s.gateHash = gh;
    s.corpusHash = sha12(JSON.stringify(plan[name]));
    console.log('');
    const config =
      name === 'alignment'
        ? `[model=${s.model} escalate=${s.escalateModel} cascade=${s.cascade ? 'on' : 'off'} K=1]`
        : `[model=${s.model} K=${s.runs}]`;
    console.log(`${name}: ${s.correct}/${s.total} correct (${s.accuracy}%)  ${config}`);
    if (name === 'detect') {
      printConfusion(s.confusion);
      printPerClass({ DECISION: s.decision, ROUTINE: s.routine });
      const d = s.decision;
      console.log(`  headline: DECISION recall ${fmtCi(d.tp, d.tp + d.fn)}`);
      console.log(ppvLine(s));
      if (s.flipRate !== null)
        console.log(`  judge stability: flip rate ${s.flipRate} across K=${s.runs} trials`);
      console.log(
        `  judge input: mean ${s.meanInputChars} chars (extracted from mean ${s.meanRawDiffChars}-char raw diffs)`,
      );
      const vc = variantConsistency(plan[name], s.rows);
      if (vc)
        console.log(
          `  variant consistency: ${vc.consistent}/${vc.total} groups${vc.broken.length ? ` — broken: [${vc.broken.join(', ')}]` : ''}`,
        );
      for (const [cat, c] of Object.entries(s.byCategory))
        console.log(`  ${cat.padEnd(16)} ${c.correct}/${c.total}`);
    } else if (name === 'alignment') {
      printConfusion(s.final.confusion);
      printPerClass({
        ALIGN: s.final.align,
        CONTRADICT: s.final.contradict,
        UNCLEAR: s.final.unclear,
      });
      const cp = s.final.contradict;
      console.log(
        `  headline: CONTRADICT precision ${fmtCi(cp.tp, cp.tp + cp.fp)}  macro-F1 ${s.final.macroF1.toFixed(2)}`,
      );
      console.log(
        `  haiku-alone: CONTRADICT precision ${s.firstPass.contradict.precision.toFixed(2)}  ` +
          `macro-F1 ${s.firstPass.macroF1.toFixed(2)}  · escalation rate ${s.escalationRate}` +
          `${s.outages ? `  · outages ${s.outages}` : ''}`,
      );
    } else {
      printConfusion(s.confusion);
      printPerClass({ PASS: s.pass, THIN: s.thin });
      console.log(`  headline: accuracy ${fmtCi(s.correct, s.total)}`);
      if (s.flipRate !== null)
        console.log(`  judge stability: flip rate ${s.flipRate} across K=${s.runs} trials`);
      const vc = variantConsistency(plan[name], s.rows);
      if (vc)
        console.log(
          `  variant consistency: ${vc.consistent}/${vc.total} groups${vc.broken.length ? ` — broken: [${vc.broken.join(', ')}]` : ''}`,
        );
    }
    const { regressed: r, lines } = compare(name, s, baseline[name]);
    if (existsSync(baselinePath)) for (const l of lines) console.log(l);
    regressed ||= r;
    ledger.subs[name] = {
      correct: s.correct,
      total: s.total,
      corpusHash: s.corpusHash,
      regressed: r,
    };
    baseline[name] = s; // read-merge-write: only run sub-benches replaced
  }

  appendLedger(ledger); // the anti-Goodhart record: every run against the corpus is on the books

  if (writeBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\nwrote baseline → ${path.relative(process.cwd(), baselinePath)}`);
  }
  if (failOnRegression && regressed) {
    console.error(
      '\nFAIL: floor breach or statistically significant one-directional flips vs baseline.',
    );
    process.exit(1);
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof BenchAbort) {
      console.error(e.message);
      process.exit(e.code);
    }
    throw e;
  }
}
