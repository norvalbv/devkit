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
 *   node bench.mjs all --fail                     # exit 1 if a headline metric regressed vs baseline
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
import {
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
import { resolveFromCwd, resolveGuardConfig } from '../../config.mjs';
import {
  judgeDetailed,
  matchScope,
  parseDepthVerdict,
  runDepthJudge,
} from '../check-alignment.mjs';
import { currentTarget, parseDecision } from '../decisions.mjs';
import { buildDetectJudgeInput, detectSmells, parseVerdict, runDetectJudge } from '../detect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'results.baseline.json');

const MODEL = process.env.BENCH_MODEL ?? 'haiku';
const ESCALATE_MODEL = process.env.BENCH_ESCALATE_MODEL ?? 'opus';
const CASCADE = (process.env.BENCH_CASCADE ?? 'on') !== 'off';

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
  let rows;
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
}

// ─── Sub-benches ──────────────────────────────────────────────────────────────────

const rowLine = (id, ok, got, want, suffix = '') =>
  console.log(`  ${id.padEnd(30)} ${ok ? 'OK  ' : 'FAIL'}  got=${got} want=${want}${suffix}`);

/**
 * detect: rows whose declarative entries raise NO smell free-skip as ROUTINE (the gate never calls
 * the LLM there); the rest run the real downgrade judge on the row's diff. A dark judge aborts —
 * detect rows are cheap, a polluted run is worth less than a rerun.
 */
export function runDetectBench(rows, { model = MODEL } = {}) {
  const results = [];
  let judgedChars = 0;
  let judgedRaw = 0;
  let judgedCount = 0;
  for (const c of rows) {
    const smells = detectSmells(c.entries, c.boundaries ?? []);
    let got;
    let freeSkip = false;
    if (smells.length === 0) {
      got = 'ROUTINE';
      freeSkip = true;
    } else {
      // Exact gate path: evidence extraction first, then the judge (never the raw diff).
      const input = buildDetectJudgeInput(c.diff, c.entries, c.boundaries ?? []);
      judgedCount += 1;
      judgedChars += input.length;
      judgedRaw += String(c.diff).length;
      const raw = runDetectJudge(process.cwd(), input, model);
      if (raw === null) throw new BenchAbort(2, 'decisions-eval: claude went dark mid-run');
      got = parseVerdict(raw) ?? 'NULL';
    }
    const ok = got === c.expected;
    results.push({ id: c.id, category: c.category, expected: c.expected, got, ok, freeSkip });
    rowLine(c.id, ok, got, c.expected, freeSkip ? ' (free-skip)' : '');
  }
  const t = tally(results, ['DECISION', 'ROUTINE']);
  // Expected-NULL rows are deliberate-ambiguity probes — displayed, but too unstable to gate on.
  const scored = tally(
    results.filter((r) => r.expected !== 'NULL'),
    ['DECISION', 'ROUTINE'],
  );
  return {
    model,
    correct: t.correct,
    total: t.total,
    accuracy: t.accuracy,
    accuracyScored: scored.accuracy,
    decision: round3(scored.perClass.DECISION),
    routine: round3(scored.perClass.ROUTINE),
    // The cost metric: mean judge-input size vs the raw diff it was extracted from — keeps the
    // "evidence-only is cheaper" claim measured, and a prompt change that bloats input shows up.
    meanInputChars: judgedCount ? Math.round(judgedChars / judgedCount) : 0,
    meanRawDiffChars: judgedCount ? Math.round(judgedRaw / judgedCount) : 0,
    confusion: t.confusion,
    byCategory: byCategory(results),
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
  { model = MODEL, escalateModel = ESCALATE_MODEL, cascade = CASCADE } = {},
) {
  const results = [];
  let judged = 0;
  let outages = 0;
  let escalated = 0;
  for (const c of rows) {
    const fx = materializeFixture(c);
    let first;
    let final;
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
    const ok = final === c.expected;
    results.push({ id: c.id, expected: c.expected, first, final, escalated: didEscalate, ok });
    const detail = first === final ? '' : ` (haiku: ${first}${didEscalate ? ' → escalated' : ''})`;
    rowLine(c.id, ok, final, c.expected, `${detail}${outage ? ' (outage)' : ''}`);
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
    results,
  };
}

/** depth: pure-text judge on each row's Target block. No free-skip class — the gate judges every
 * staged Target. Dark judge aborts (cheap rows, sentry-style). */
export function runDepthBench(rows, { model = MODEL } = {}) {
  const results = [];
  for (const c of rows) {
    const raw = runDepthJudge(process.cwd(), c.block, model);
    if (raw === null) throw new BenchAbort(2, 'decisions-eval: claude went dark mid-run');
    const got = parseDepthVerdict(raw) ?? 'NULL';
    const ok = got === c.expected;
    results.push({ id: c.id, expected: c.expected, got, ok });
    rowLine(c.id, ok, got, c.expected);
  }
  const t = tally(results, ['PASS', 'THIN']);
  return {
    model,
    correct: t.correct,
    total: t.total,
    accuracy: t.accuracy,
    pass: round3(t.perClass.PASS),
    thin: round3(t.perClass.THIN),
    confusion: t.confusion,
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

/** The metrics --fail gates on, per sub-bench (headline first). */
const COMPARED = {
  detect: [
    ['DECISION recall', (s) => s.decision.recall],
    ['accuracy (scored rows)', (s) => s.accuracyScored],
  ],
  alignment: [
    ['CONTRADICT precision', (s) => (s.cascade ? s.final : s.firstPass).contradict.precision],
    ['macro-F1', (s) => (s.cascade ? s.final : s.firstPass).macroF1],
  ],
  depth: [['accuracy', (s) => s.accuracy]],
};

const CONFIG_KEYS = {
  detect: ['model'],
  alignment: ['model', 'escalateModel', 'cascade'],
  depth: ['model'],
};

/** Compare one sub-bench vs its baseline section. Incomparable configs skip with a warning. */
export function compare(name, summary, base) {
  if (!base) return { regressed: false, lines: [`  ${name}: no baseline section — skipped`] };
  const mismatch = CONFIG_KEYS[name].filter((k) => summary[k] !== base[k]);
  if (mismatch.length)
    return {
      regressed: false,
      lines: [
        `  ${name}: baseline config differs (${mismatch.join(', ')}) — regenerate with --baseline; comparison skipped`,
      ],
    };
  const arrow = (n) => (n > 0 ? '↑' : n < 0 ? '↓' : '=');
  const signed = (n) => `${n > 0 ? '+' : ''}${n.toFixed(3)}`;
  let regressed = false;
  const lines = [];
  for (const [label, pick] of COMPARED[name]) {
    const d = pick(summary) - pick(base);
    if (d < -1e-9) regressed = true;
    lines.push(`  ${name}: ${label} ${arrow(d)} ${signed(d)}`);
  }
  return { regressed, lines };
}

// ─── Orchestration ────────────────────────────────────────────────────────────────

function printEstimate(plan) {
  const parts = [];
  let seconds = 0;
  if (plan.detect) {
    const judged = plan.detect.filter(
      (c) => detectSmells(c.entries, c.boundaries ?? []).length,
    ).length;
    seconds += judged * 30;
    parts.push(`detect ${judged} judged × ~30s`);
  }
  if (plan.alignment) {
    const judged = plan.alignment.filter((c) =>
      Object.keys(c.repo.staged).some((f) => matchScope([f], c.target.scope)),
    ).length;
    seconds += judged * 90;
    parts.push(`alignment ${judged} judged × ~90s (+120–240s per escalation)`);
  }
  if (plan.depth) {
    seconds += plan.depth.length * 40;
    parts.push(`depth ${plan.depth.length} judged × ~40s`);
  }
  console.log(`decisions-eval: budget ≈ ${Math.round(seconds / 60)} min  (${parts.join(' · ')})`);
}

function main(argv) {
  const args = new Set(argv);
  const which = SUBS.filter((s) => args.has(s));
  const run = which.length ? which : SUBS;
  const writeBaseline = args.has('--baseline');
  const failOnRegression = args.has('--fail');

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

  const plan = Object.fromEntries(run.map((s) => [s, loadCases(s)]));
  printEstimate(plan);

  const runners = { detect: runDetectBench, alignment: runAlignmentBench, depth: runDepthBench };
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  let regressed = false;

  for (const name of run) {
    console.log(`\n── ${name} ──`);
    const s = runners[name](plan[name]);
    console.log('');
    const config =
      name === 'alignment'
        ? `[model=${s.model} escalate=${s.escalateModel} cascade=${s.cascade ? 'on' : 'off'}]`
        : `[model=${s.model}]`;
    console.log(`${name}: ${s.correct}/${s.total} correct (${s.accuracy}%)  ${config}`);
    if (name === 'detect') {
      printConfusion(s.confusion);
      printPerClass({ DECISION: s.decision, ROUTINE: s.routine });
      console.log(`  headline: DECISION recall ${s.decision.recall.toFixed(2)}`);
      console.log(
        `  judge input: mean ${s.meanInputChars} chars (extracted from mean ${s.meanRawDiffChars}-char raw diffs)`,
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
      console.log(
        `  headline: CONTRADICT precision ${s.final.contradict.precision.toFixed(2)}  ` +
          `macro-F1 ${s.final.macroF1.toFixed(2)}`,
      );
      console.log(
        `  haiku-alone: CONTRADICT precision ${s.firstPass.contradict.precision.toFixed(2)}  ` +
          `macro-F1 ${s.firstPass.macroF1.toFixed(2)}  · escalation rate ${s.escalationRate}` +
          `${s.outages ? `  · outages ${s.outages}` : ''}`,
      );
    } else {
      printConfusion(s.confusion);
      printPerClass({ PASS: s.pass, THIN: s.thin });
      console.log(`  headline: accuracy ${s.accuracy}%`);
    }
    const { regressed: r, lines } = compare(name, s, baseline[name]);
    if (existsSync(baselinePath)) for (const l of lines) console.log(l);
    regressed ||= r;
    baseline[name] = s; // read-merge-write: only run sub-benches replaced
  }

  if (writeBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\nwrote baseline → ${path.relative(process.cwd(), baselinePath)}`);
  }
  if (failOnRegression && regressed) {
    console.error('\nFAIL: a headline metric regressed vs baseline.');
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
