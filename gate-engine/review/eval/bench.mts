#!/usr/bin/env node

/**
 * completeness-eval: accuracy benchmark for the feature-completeness reviewer gate
 * (`guard-review completeness --gate` — ../completeness.mts + agents/feature-completeness-reviewer.md).
 *
 * A prompt/model edit to the reviewer brief is unverifiable without a measured check; this scores
 * the EXACT gate path against a labelled corpus so an edit is a delta, not a vibe. The bench calls
 * `runCompleteness()` FROM THE GATE with a spy `exec` that delegates to the real judge runner —
 * prompt construction, Target loading, diff capping, argv, model and isolation flags all run
 * inside the gate; the spy only observes the transcript. Bench and gate cannot drift.
 *
 * THE HARD PART — open-ended output. The reviewer emits a free-text findings list, not a closed
 * label set, so each corpus row carries a GOLD finding-set (gaps that MUST surface, with target
 * severity) and DECOYS (recorded decisions / out-of-scope items it must NOT flag). An audited LLM
 * matcher (matcher.mts) maps emitted findings onto those slots with per-slot forced-choice
 * questions; scoring is recall against gold and flag-rate against decoys — never string equality,
 * never "did it produce output".
 *
 *   node bench.mts                # full run: reviewer + matcher, confusion + headline metrics
 *   node bench.mts --baseline     # write results.baseline.json (committed — corpus is repo-specific)
 *   node bench.mts --fail         # exit 1 on floor breach or significant stable flips vs baseline
 *   node bench.mts --dev          # prompt-iteration tier: holdout rows excluded
 *   node bench.mts --only <id>    # id-prefix subset (iteration; usage lands in runs.log)
 *   node bench.mts coverage       # corpus coverage matrix — zero claude calls
 *   node bench.mts matcher-audit  # matcher agreement vs committed labels (percent + Cohen's κ)
 *
 * Sweeps: BENCH_MATCH_MODEL=haiku|sonnet (matcher; default haiku) · BENCH_MATCH_RUNS=1|3 (matcher
 * votes; default 3). The REVIEWER has no model sweep on purpose: the gate hardcodes opus (user
 * ruling: the gap-finder gets the strongest model or it isn't worth running) and the bench runs
 * the gate, not a copy of it.
 *
 * Headline metrics — one per failure mode (each reviewer failure is different):
 *   gap recall        H/G  — a missed gap is what the reviewer exists to prevent → HARD FLOOR
 *   false-flag rate   FD/D — decoys flagged / recorded decisions re-litigated → HARD CEILING
 *   severity calibration    — of the gaps it caught, were build-breakers CRITICAL? (warn tier)
 * Finding precision (matched/emitted) prints informationally only: gold is not exhaustive, so an
 * unmatched finding is not provably wrong — the decoy set is the measured precision instrument.
 *
 * Statistical honesty (verbatim from decisions-eval, the house standard): every headline ships
 * raw counts + a Wilson 95% interval; --fail gates on hard floors plus the paired flip table vs
 * baseline under a mid-p McNemar test — never aggregate deltas. THE FLIP GATE CLUSTERS BY CASE:
 * slots within one case share a single reviewer transcript and are correlated, so slot-level
 * pairing would be anti-conservative (Miller arXiv:2411.00640 — cluster by item source); the
 * slot-level flip table still prints informationally. Reviewer rows are the expensive class
 * (agentic opus, 1–6 min) so they run K=1 with retry-on-baseline-discordance (the alignment
 * convention — a flip counts only when confirmed 2-of-2); the matcher takes the K=3 vote budget
 * instead. Baselines embed gate-code + agent-brief + matcher + corpus hashes; any mismatch skips
 * the comparison mechanically. Every run appends to runs.log — the anti-Goodhart ledger.
 *
 * Outage policy (alignment-style — rows are too expensive to vaporise a run on a quota blip):
 * a dark reviewer scores the CASE as an outage and continues; a dark matcher slot (after retry)
 * scores the SLOT as an outage; either sets outages>0, which makes --fail skip the comparison.
 * All-outage aborts (exit 2). A gate FREE-SKIP (exec never called: nothing staged, agent md
 * missing, noLlm) is NEVER an outage — it aborts as a fixture bug, because "the gate didn't run"
 * must not read as "the reviewer passed".
 *
 * Exit 0 = ran (no regression under --fail) · 1 = regression (with --fail) · 2 = could not run.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BenchAbort,
  cleanBenchEnv,
  materializeFixture,
  mcnemarMidP,
  parseCasesText,
  wilson,
} from '../../decisions/eval/bench.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { runCompleteness } from '../completeness.mts';
import { parseReviewVerdict } from '../reviewers.mts';
import {
  type CaseScore,
  type DecoySlot,
  type GoldSlot,
  kappa,
  parseFindings,
  runMatcher,
  SEVERITIES,
  scoreCase,
} from './matcher.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'results.baseline.json');
const casesPath = path.join(here, 'cases-completeness.jsonl');
const transcriptsDir = path.join(here, 'transcripts');
const auditLabelsPath = path.join(here, 'matcher-audit.labels.jsonl');

const MATCH_MODEL = process.env.BENCH_MATCH_MODEL ?? 'haiku';
const MATCH_RUNS = Math.max(1, Number.parseInt(process.env.BENCH_MATCH_RUNS ?? '3', 10) || 3);
const MATCH_CONCURRENCY = 4; // bounded — a slot storm gets judges SIGTERM'd under contention
const AGENTS_DIR = path.resolve(here, '../../../agents');
const AGENT_MD = path.join(AGENTS_DIR, 'feature-completeness-reviewer.md');

// Hard floors on the safety metrics (catastrophic breakage fails regardless of flip statistics).
// Point estimates, not Wilson bounds — the lower bound is uselessly wide at this n. Set ONCE from
// the first honest baseline; never retro-tuned to make a red run green.
export const FLOOR_GAP_RECALL = 0.7;
export const CEILING_FALSE_FLAG = 0.25;

// ─── Corpus ───────────────────────────────────────────────────────────────────────

export interface CompletenessCase {
  id: string;
  category: string;
  difficulty?: 'clear' | 'borderline' | 'adversarial';
  provenance?: 'authored' | 'mined' | 'adapted';
  note: string;
  variantOf?: string | null;
  variantKind?: 'invariance' | 'directional' | null;
  holdout?: boolean;
  message: string;
  repo: { base: Record<string, string>; staged: Record<string, string | null> };
  gold: GoldSlot[];
  decoys: DecoySlot[];
  expectedVerdict?: 'PASS' | 'FAIL';
}

/** Free corpus lint — every defect here would otherwise surface mid-run after paid opus calls.
 * Exported so the unit tests run it over the committed corpus. */
export function lintCases(rows: CompletenessCase[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const r of rows) {
    const at = `row ${r.id ?? '(no id)'}`;
    if (!r.id) errors.push(`${at}: missing id`);
    else if (ids.has(r.id)) errors.push(`${at}: duplicate id`);
    else ids.add(r.id);
    for (const field of ['category', 'note', 'message'] as const)
      if (!r[field]) errors.push(`${at}: missing ${field}`);
    if (!r.repo?.base || !r.repo?.staged) errors.push(`${at}: missing repo.base/staged`);
    else if (Object.keys(r.repo.staged).length === 0) errors.push(`${at}: nothing staged`);
    if (!Array.isArray(r.gold) || !Array.isArray(r.decoys))
      errors.push(`${at}: gold/decoys must be arrays`);
    const slotIds = new Set<string>();
    for (const s of [...(r.gold ?? []), ...(r.decoys ?? [])]) {
      if (slotIds.has(s.id)) errors.push(`${at}: duplicate slot id ${s.id}`);
      slotIds.add(s.id);
    }
    for (const g of r.gold ?? [])
      if (!SEVERITIES.includes(g.severity)) errors.push(`${at}: gold ${g.id} bad severity`);
    for (const d of r.decoys ?? []) {
      if (d.kind === 'recorded-decision') {
        // The decoy must be BACKED by a Target file the gate will actually load — existence is
        // not enough: a Target block without a parseable **Scope:** is silently dropped by
        // loadScopedTargets, and the reviewer would never be tempted. Catch it here, free.
        const file = `docs/decisions/${d.targetSlug}.md`;
        if (!d.targetSlug) errors.push(`${at}: decoy ${d.id} recorded-decision needs targetSlug`);
        else if (!r.repo.base[file]) errors.push(`${at}: decoy ${d.id} — ${file} not in repo.base`);
      }
    }
  }
  return errors;
}

function loadCases(): CompletenessCase[] {
  let rows: CompletenessCase[];
  try {
    rows = parseCasesText(readFileSync(casesPath, 'utf8'));
  } catch (e) {
    throw new BenchAbort(2, `completeness-eval: cannot read ${path.basename(casesPath)} — ${e}`);
  }
  if (!rows.length) throw new BenchAbort(2, 'completeness-eval: corpus is empty');
  const errors = lintCases(rows);
  if (errors.length)
    throw new BenchAbort(2, `completeness-eval: corpus lint failed —\n  ${errors.join('\n  ')}`);
  return rows;
}

// ─── Fixture wrapper ──────────────────────────────────────────────────────────────

/**
 * A completeness fixture is an alignment fixture (disposable git repo, base committed, staged in
 * the index) plus: a guard.config.json in BASE pointing review.agentsDir at the REAL agents/ dir
 * (absolute — so an edit to agents/feature-completeness-reviewer.md is exactly what a run
 * measures), and the commit message under .git/ where the judge's git status/diff can't see it.
 * Decoy Targets are ordinary docs/decisions/*.md files in base — the gate's own scopedTargets()
 * reads them directly (no index, no CLI), so the Target-loading path is exercised end-to-end.
 */
export function materializeCompletenessFixture(row: CompletenessCase, agentsDirAbs = AGENTS_DIR) {
  const base = {
    ...row.repo.base,
    'guard.config.json': `${JSON.stringify({ review: { agentsDir: agentsDirAbs } }, null, 2)}\n`,
  };
  const fx = materializeFixture({ repo: { base, staged: row.repo.staged } });
  const msgFile = path.join(fx.repo, '.git', 'COMMIT_EDITMSG');
  writeFileSync(msgFile, row.message.endsWith('\n') ? row.message : `${row.message}\n`);
  return { ...fx, msgFile };
}

// ─── One case through the exact gate path ─────────────────────────────────────────

interface SpyCapture {
  called: boolean;
  args: string[] | null;
  raw: string | null;
}

/** Spy exec: delegates to the real judge runner (or a test stub), records what the gate sent and
 * what came back. Drift-proof by construction — the gate builds everything, the spy observes. */
function spyExec(capture: SpyCapture, delegate: typeof execJudgeAsync): typeof execJudgeAsync {
  return async (opts) => {
    capture.called = true;
    capture.args = opts.args;
    capture.raw = await delegate(opts);
    return capture.raw;
  };
}

export interface CaseResult {
  id: string;
  outage: boolean;
  score: CaseScore | null;
  verdict: string | null;
  exit: number;
  warnings: string[];
}

/**
 * Run one corpus row through runCompleteness() and the matcher. Exported with an injectable exec
 * chain so the tests drive it without claude. Throws BenchAbort on fixture bugs (free-skip) —
 * "the gate didn't run" must never score as a pass.
 */
export async function runCase(
  row: CompletenessCase,
  {
    reviewerExec = execJudgeAsync,
    matcherExec = execJudgeAsync,
    matchModel = MATCH_MODEL,
    matchRuns = MATCH_RUNS,
    agentsDir = AGENTS_DIR,
    saveTranscript = true,
  }: {
    reviewerExec?: typeof execJudgeAsync;
    matcherExec?: typeof execJudgeAsync;
    matchModel?: string;
    matchRuns?: number;
    agentsDir?: string;
    saveTranscript?: boolean;
  } = {},
): Promise<CaseResult> {
  const fx = materializeCompletenessFixture(row, agentsDir);
  activeCleanup = fx.cleanup;
  try {
    if (fx.staged.length === 0)
      throw new BenchAbort(2, `completeness-eval: fixture bug in ${row.id} — nothing staged`);
    const capture: SpyCapture = { called: false, args: null, raw: null };
    // The injectable exec is the seam runCompleteness's own tests use; everything else is the gate.
    let exit: number;
    try {
      exit = await runCompleteness(fx.msgFile, fx.repo, { exec: spyExec(capture, reviewerExec) });
    } catch (e) {
      throw new BenchAbort(2, `completeness-eval: gate threw on ${row.id} — ${e}`);
    }
    if (!capture.called)
      throw new BenchAbort(
        2,
        `completeness-eval: gate free-skipped ${row.id} (exit ${exit}) — fixture bug, not a pass`,
      );
    // Fixture-sanity: every recorded-decision decoy's Target must have reached the prompt. An
    // unloaded decoy means the reviewer was never tempted and the slot would measure nothing.
    const prompt = capture.args?.[1] ?? '';
    for (const d of row.decoys)
      if (d.kind === 'recorded-decision' && d.targetSlug && !prompt.includes(d.targetSlug))
        throw new BenchAbort(
          2,
          `completeness-eval: fixture bug in ${row.id} — decoy Target ${d.targetSlug} not in the gate prompt (scope mismatch?)`,
        );
    if (capture.raw === null)
      return { id: row.id, outage: true, score: null, verdict: null, exit, warnings: [] };

    const parsed = parseFindings(capture.raw);
    const outcomes = await runMatcher(row.gold, row.decoys, parsed.findings, {
      model: matchModel,
      runs: matchRuns,
      concurrency: MATCH_CONCURRENCY,
      exec: matcherExec,
    });
    const score = scoreCase(row.gold, row.decoys, parsed.findings, outcomes);
    const verdict = parseReviewVerdict(capture.raw).verdict;
    if (saveTranscript) {
      try {
        mkdirSync(transcriptsDir, { recursive: true });
        writeFileSync(
          path.join(transcriptsDir, `${row.id}.json`),
          `${JSON.stringify({ id: row.id, findings: parsed.findings, gold: row.gold, decoys: row.decoys, outcomes, verdict, raw: capture.raw }, null, 2)}\n`,
        );
      } catch {
        // Transcripts are audit material, not scoring input — never fail a paid run on them.
      }
    }
    return { id: row.id, outage: false, score, verdict, exit, warnings: parsed.warnings };
  } finally {
    activeCleanup = null;
    fx.cleanup();
  }
}

// Best-effort ^C cleanup: the imported materializeFixture keeps its own module-private handle that
// only the DECISIONS bench's main() registers — this bench must hold its own.
let activeCleanup: (() => void) | null = null;

// ─── Bench run + metrics ──────────────────────────────────────────────────────────

interface SlotRow {
  kind: 'gold' | 'decoy';
  got: string;
  ok: boolean;
  stable: boolean;
  expected: string;
}

export interface BenchSummary {
  matchModel: string;
  matchRuns: number;
  cases: number;
  caseOutages: number;
  slotOutages: number;
  outages: number;
  gold: { total: number; hit: number };
  decoys: { total: number; flagged: number; recorded: { total: number; flagged: number } };
  findings: { total: number; matched: number; spurious: number };
  severity: { total: number; exact: number; confusion: Record<string, Record<string, number>> };
  verdicts: { total: number; correct: number };
  gapRecall: number;
  falseFlagRate: number;
  rows: Record<string, { ok: boolean; stable: boolean }>;
  slots: Record<string, SlotRow>;
  gateHash?: string;
  matcherHash?: string;
  corpusHash?: string;
}

const pct = (k: number, n: number) => (n ? k / n : 0);
const fmtCi = (k: number, n: number) => {
  const { lo, hi } = wilson(k, n);
  return `${k}/${n} = ${n ? (k / n).toFixed(2) : '—'} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
};

/** Aggregate per-case results into the summary. Pure — unit-tested on synthetic results. */
export function summarize(
  rows: CompletenessCase[],
  results: CaseResult[],
  { matchModel = MATCH_MODEL, matchRuns = MATCH_RUNS } = {},
): BenchSummary {
  const s: BenchSummary = {
    matchModel,
    matchRuns,
    cases: results.length,
    caseOutages: 0,
    slotOutages: 0,
    outages: 0,
    gold: { total: 0, hit: 0 },
    decoys: { total: 0, flagged: 0, recorded: { total: 0, flagged: 0 } },
    findings: { total: 0, matched: 0, spurious: 0 },
    severity: { total: 0, exact: 0, confusion: {} },
    verdicts: { total: 0, correct: 0 },
    gapRecall: 0,
    falseFlagRate: 0,
    rows: {},
    slots: {},
  };
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const res of results) {
    const row = byId.get(res.id);
    if (!row) continue;
    if (res.outage || !res.score) {
      s.caseOutages += 1;
      continue;
    }
    let caseOk = true;
    let caseStable = true;
    for (const slot of res.score.slots) {
      if (slot.outage) {
        s.slotOutages += 1;
        continue; // an unmeasured slot joins no metric — outages>0 already taints the run
      }
      const key = `${res.id}::${slot.slotId}`;
      s.slots[key] = {
        kind: slot.kind,
        got: slot.got,
        ok: slot.ok,
        stable: slot.stable,
        expected: slot.kind === 'gold' ? 'hit' : 'clean',
      };
      caseOk &&= slot.ok;
      caseStable &&= slot.stable;
      if (slot.kind === 'gold') {
        s.gold.total += 1;
        if (slot.ok) s.gold.hit += 1;
      } else {
        s.decoys.total += 1;
        const decoy = row.decoys.find((d) => d.id === slot.slotId);
        const flagged = !slot.ok;
        if (flagged) s.decoys.flagged += 1;
        if (decoy?.kind === 'recorded-decision') {
          s.decoys.recorded.total += 1;
          if (flagged) s.decoys.recorded.flagged += 1;
        }
      }
    }
    s.rows[res.id] = { ok: caseOk, stable: caseStable };
    s.findings.total += res.score.findingCount;
    s.findings.spurious += res.score.spurious.length;
    s.findings.matched += res.score.findingCount - res.score.spurious.length;
    for (const p of res.score.severity) {
      s.severity.total += 1;
      if (p.expected === p.got) s.severity.exact += 1;
      s.severity.confusion[p.expected] ??= {};
      s.severity.confusion[p.expected][p.got] = (s.severity.confusion[p.expected][p.got] ?? 0) + 1;
    }
    if (row.expectedVerdict) {
      s.verdicts.total += 1;
      // A null verdict reads as PASS — the gate's own fail-open interpretation.
      if ((res.verdict ?? 'PASS') === row.expectedVerdict) s.verdicts.correct += 1;
    }
  }
  s.outages = s.caseOutages + s.slotOutages;
  s.gapRecall = pct(s.gold.hit, s.gold.total);
  s.falseFlagRate = pct(s.decoys.flagged, s.decoys.total);
  return s;
}

/** Metamorphic groups: invariance variants must land the same per-slot outcome pattern. */
export function variantConsistency(rows: CompletenessCase[], summary: BenchSummary) {
  const groups: Record<string, Set<string>> = {};
  for (const r of rows) {
    if (!r.variantOf || r.variantKind === 'directional') continue;
    groups[r.variantOf] ??= new Set([r.variantOf]);
    groups[r.variantOf].add(r.id);
  }
  const ids = Object.keys(groups);
  if (!ids.length) return null;
  const pattern = (caseId: string) =>
    Object.entries(summary.slots)
      .filter(([k]) => k.startsWith(`${caseId}::`))
      .map(([k, v]) => `${k.split('::')[1]}=${v.got}`)
      .sort()
      .join(',');
  let consistent = 0;
  const broken: string[] = [];
  for (const g of ids) {
    const patterns = new Set([...groups[g]].map(pattern).filter((p) => p !== ''));
    if (patterns.size <= 1) consistent += 1;
    else broken.push(g);
  }
  return { consistent, total: ids.length, broken };
}

// ─── Baseline comparison — floors + case-level flip gate ──────────────────────────

/**
 * Statistically honest at small n, decisions-eval order of evaluation: (1) comparability
 * preconditions (config, gateHash, matcherHash, corpusHash, outages) skip rather than lie;
 * (2) hard floors on the safety metrics; (3) the paired CASE-level flip table under mid-p
 * McNemar, stable flips only; (4) informational deltas + slot-level flips + the MDE line.
 */
export function compareCompleteness(summary: BenchSummary, base: BenchSummary | undefined) {
  if (!base) return { regressed: false, lines: ['  no baseline — skipped'] };
  const skip = (why: string) => ({
    regressed: false,
    lines: [`  ${why} — regenerate with --baseline; comparison skipped`],
  });
  for (const k of ['matchModel', 'matchRuns'] as const)
    if (summary[k] !== base[k]) return skip(`baseline config differs (${k})`);
  if (base.gateHash && summary.gateHash && base.gateHash !== summary.gateHash)
    return skip('gate code / agent brief changed since the baseline');
  if (base.matcherHash && summary.matcherHash && base.matcherHash !== summary.matcherHash)
    return skip('matcher changed since the baseline');
  if (base.corpusHash && summary.corpusHash && base.corpusHash !== summary.corpusHash)
    return skip('corpus changed since the baseline');
  if (summary.outages > 0) return skip(`${summary.outages} outage(s) this run — score is suspect`);

  const lines: string[] = [];
  let regressed = false;
  const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(3)}`;
  lines.push(`  gap recall Δ ${signed(summary.gapRecall - base.gapRecall)}  (informational)`);
  lines.push(
    `  false-flag rate Δ ${signed(summary.falseFlagRate - base.falseFlagRate)}  (informational)`,
  );

  if (summary.gapRecall < FLOOR_GAP_RECALL) {
    regressed = true;
    lines.push(
      `  FLOOR BREACH — gap recall ${summary.gapRecall.toFixed(2)} < ${FLOOR_GAP_RECALL} (catastrophic; fails regardless of flip statistics)`,
    );
  }
  if (summary.falseFlagRate > CEILING_FALSE_FLAG) {
    regressed = true;
    lines.push(
      `  CEILING BREACH — false-flag rate ${summary.falseFlagRate.toFixed(2)} > ${CEILING_FALSE_FLAG} (catastrophic; fails regardless of flip statistics)`,
    );
  }

  // The gate: CASE-level flips (slots within a case share one transcript — clustered unit).
  const b: string[] = [];
  const c: string[] = [];
  const unstable: string[] = [];
  for (const [id, cur] of Object.entries(summary.rows)) {
    const prev = base.rows?.[id];
    if (!prev) continue;
    if (prev.ok && !cur.ok) (cur.stable ? b : unstable).push(id);
    else if (!prev.ok && cur.ok) c.push(id);
  }
  const midP = mcnemarMidP(b.length, c.length);
  if (b.length + c.length > 0) {
    const n = Object.keys(summary.rows).length;
    const mde = 2.802 * Math.sqrt((b.length + c.length) / n / n);
    lines.push(
      `  case flips vs baseline — regressed [${b.join(', ') || '—'}] improved [${c.join(', ') || '—'}] (mid-p ${midP.toFixed(3)})`,
    );
    lines.push(
      `  this bench cannot distinguish deltas below ~${(mde * 100).toFixed(0)}pp from judge noise at n=${n} cases`,
    );
  }
  if (unstable.length)
    lines.push(
      `  unstable cases (unconfirmed flips — instability, not regression): [${unstable.join(', ')}]`,
    );
  // Slot-level flips print informationally — finer-grained diagnosis, never the gate.
  const slotB = Object.entries(summary.slots)
    .filter(([k, cur]) => base.slots?.[k]?.ok && !cur.ok && cur.stable)
    .map(([k]) => k);
  const slotC = Object.entries(summary.slots)
    .filter(([k, cur]) => base.slots?.[k] && !base.slots[k].ok && cur.ok)
    .map(([k]) => k);
  if (slotB.length + slotC.length > 0)
    lines.push(
      `  slot flips (informational) — regressed [${slotB.join(', ') || '—'}] improved [${slotC.join(', ') || '—'}]`,
    );
  if (midP < 0.05 && b.length > c.length) {
    regressed = true;
    lines.push(
      `  REGRESSION — one-directional case flips are significant (mid-p ${midP.toFixed(3)} < 0.05)`,
    );
  }
  return { regressed, lines };
}

// ─── Hashes, ledger, estimate, coverage ───────────────────────────────────────────

const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
// The agent brief IS gate code here — the prompt is what a run measures.
const gateHash = () =>
  sha12(
    readFileSync(path.join(here, `../completeness${SELF_EXT}`), 'utf8') +
      readFileSync(AGENT_MD, 'utf8'),
  );
const matcherHash = () => sha12(readFileSync(path.join(here, `matcher${SELF_EXT}`), 'utf8'));

function appendLedger(entry: object) {
  try {
    appendFileSync(path.join(here, 'runs.log'), `${JSON.stringify(entry)}\n`);
  } catch {
    // The ledger is telemetry; never let it break a run.
  }
}

function preflightClaude() {
  try {
    execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000 });
  } catch {
    throw new BenchAbort(2, 'completeness-eval: `claude` CLI not available — cannot benchmark');
  }
}

/** Budget from per-row costs (house convention), printed BEFORE any token is spent. */
function printEstimate(rows: CompletenessCase[], matchRuns: number) {
  const slots = rows.reduce((n, r) => n + r.gold.length + r.decoys.length, 0);
  const revLo = rows.length * 60;
  const revHi = rows.length * 360; // the gate's own TIMEOUT_MS ceiling
  const matcher = Math.round((slots * matchRuns * 15) / MATCH_CONCURRENCY);
  console.log(
    `completeness-eval: budget ≈ ${Math.round((revLo + matcher) / 60)}–${Math.round((revHi + matcher) / 60)} min  ` +
      `(${rows.length} reviewer rows × 60–360s · ${slots} slots × K=${matchRuns} matcher ÷ pool ${MATCH_CONCURRENCY}` +
      ' · + one case re-run per baseline-discordant case)',
  );
}

/** Coverage matrix (zero claude calls). Cells a category cannot populate are n/a, not debt:
 * clean-complete rows have gold:[] by construction, so their severity cells are structural. */
function printCoverage(rows: CompletenessCase[]) {
  console.log(`── completeness (${rows.length} rows) ──`);
  const cells: Record<string, number> = {};
  const tag: {
    provenance: Record<string, number>;
    holdout: number;
    variants: number;
    decoyKinds: Record<string, number>;
  } = {
    provenance: {},
    holdout: 0,
    variants: 0,
    decoyKinds: {},
  };
  for (const r of rows) {
    const sevs = r.gold.length
      ? [...new Set(r.gold.map((g) => g.severity))]
      : ['(no gold — control)'];
    for (const sev of sevs) {
      const key = `${r.category.padEnd(26)} ${sev.padEnd(22)} ${r.difficulty ?? 'unset'}`;
      cells[key] = (cells[key] ?? 0) + 1;
    }
    const p = r.provenance ?? 'authored';
    tag.provenance[p] = (tag.provenance[p] ?? 0) + 1;
    if (r.holdout) tag.holdout += 1;
    if (r.variantOf) tag.variants += 1;
    for (const d of r.decoys) tag.decoyKinds[d.kind] = (tag.decoyKinds[d.kind] ?? 0) + 1;
  }
  console.log(`  ${'category'.padEnd(26)} ${'gold severity'.padEnd(22)} difficulty  rows`);
  for (const key of Object.keys(cells).sort()) console.log(`  ${key}  ${cells[key]}`);
  console.log(
    `  provenance: ${Object.entries(tag.provenance)
      .map(([k, v]) => `${k}=${v}`)
      .join(
        ' ',
      )} · holdout=${tag.holdout} · variant rows=${tag.variants} · decoys: ${Object.entries(
      tag.decoyKinds,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
  const unset = rows.filter((r) => !r.difficulty).length;
  if (unset) console.log(`  COVERAGE DEBT: ${unset} row(s) missing a difficulty tag`);
}

// ─── Matcher audit ────────────────────────────────────────────────────────────────

/**
 * Join committed audit labels ({caseId, slotId, match: "F<n>"|"NONE"}) against the latest run's
 * transcripts and print percent agreement + Cohen's κ. κ, not raw agreement, is the trust stat:
 * most slots are NONE, and a matcher that always says NONE "agrees" often by chance. Policy:
 * κ < 0.7 → the matcher is not trusted; fix matcher.mts before reading headline metrics.
 */
export function matcherAudit(
  labelsText: string,
  readTranscript: (caseId: string) => { outcomes: { slotId: string; match: number }[] } | null,
) {
  const labels = parseCasesText(labelsText) as { caseId: string; slotId: string; match: string }[];
  if (!labels.length) throw new BenchAbort(2, 'completeness-eval: no audit labels');
  const a: string[] = [];
  const b: string[] = [];
  const missing: string[] = [];
  for (const l of labels) {
    const t = readTranscript(l.caseId);
    const o = t?.outcomes.find((x) => x.slotId === l.slotId);
    if (!o) {
      missing.push(`${l.caseId}::${l.slotId}`);
      continue;
    }
    a.push(l.match.toUpperCase());
    b.push(o.match === 0 ? 'NONE' : `F${o.match}`);
  }
  const agree = a.filter((x, i) => x === b[i]).length;
  return { n: a.length, agree, kappa: kappa(a, b), missing };
}

// ─── Orchestration ────────────────────────────────────────────────────────────────

async function main(argv: string[]) {
  const args = new Set(argv);
  const writeBaseline = args.has('--baseline');
  const failOnRegression = args.has('--fail');
  const devOnly = args.has('--dev');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;

  process.on('SIGINT', () => {
    activeCleanup?.();
    process.exit(130);
  });
  const stripped = cleanBenchEnv();
  // cleanBenchEnv covers GUARD_*/FRINK_* + the six repo-corruption GIT vars; these two reshape
  // fixture `git init/commit` through global config and must go too.
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])
    if (process.env[k] !== undefined) {
      delete process.env[k];
      stripped.push(k);
    }
  process.env.DECISIONS_NO_EMBED = '1'; // belt-and-braces: fixtures ship no INDEX.md anyway
  if (stripped.length)
    console.log(`completeness-eval: stripped env for a clean run: ${stripped.join(', ')}`);

  let rows = loadCases();

  if (args.has('coverage')) {
    printCoverage(rows);
    process.exit(0);
  }
  if (args.has('matcher-audit')) {
    if (!existsSync(auditLabelsPath))
      throw new BenchAbort(
        2,
        `completeness-eval: no ${path.basename(auditLabelsPath)} — label a held sample first`,
      );
    const res = matcherAudit(readFileSync(auditLabelsPath, 'utf8'), (caseId) => {
      const f = path.join(transcriptsDir, `${caseId}.json`);
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    });
    console.log(
      `matcher-audit: agreement ${fmtCi(res.agree, res.n)} · Cohen's κ ${res.kappa.toFixed(3)}`,
    );
    if (res.missing.length)
      console.log(
        `  ${res.missing.length} labelled slot(s) missing a transcript (stale labels or no run yet): [${res.missing.join(', ')}]`,
      );
    console.log(
      res.kappa >= 0.7
        ? '  κ ≥ 0.7 — matcher trusted'
        : '  κ < 0.7 — MATCHER NOT TRUSTED: fix matcher.mts before reading headline metrics',
    );
    process.exit(0);
  }

  if (devOnly && (writeBaseline || failOnRegression))
    throw new BenchAbort(
      2,
      'completeness-eval: --dev excludes holdout rows — not valid with --baseline/--fail',
    );
  if (only && (writeBaseline || failOnRegression))
    throw new BenchAbort(
      2,
      'completeness-eval: --only is an iteration subset — not valid with --baseline/--fail',
    );
  if (devOnly) rows = rows.filter((r) => !r.holdout);
  if (only) rows = rows.filter((r) => r.id.startsWith(only));
  if (!rows.length) throw new BenchAbort(2, 'completeness-eval: no rows after filtering');

  preflightClaude();
  if (!existsSync(AGENT_MD))
    throw new BenchAbort(2, `completeness-eval: ${AGENT_MD} missing — nothing to measure`);
  printEstimate(rows, MATCH_RUNS);

  const gh = gateHash();
  const mh = matcherHash();
  const baseline: { completeness?: BenchSummary } = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : {};
  const retryAgainst = baseline.completeness ?? null;

  const results: CaseResult[] = [];
  for (const row of rows) {
    const res = await runCase(row);
    // Alignment convention: a case whose outcome disagrees with the baseline re-runs ONCE.
    // 1-of-2 disagreement = instability (never a counted flip); 2-of-2 = a real flip.
    if (!res.outage && res.score && retryAgainst?.rows?.[row.id]) {
      const caseOk = res.score.slots.every((sl) => sl.outage || sl.ok);
      if (caseOk !== retryAgainst.rows[row.id].ok) {
        console.log(`  ${row.id.padEnd(34)} …disagrees with baseline — retrying once`);
        const res2 = await runCase(row, { saveTranscript: false });
        if (!res2.outage && res2.score) {
          const byId = new Map(res2.score.slots.map((sl) => [sl.slotId, sl]));
          for (const sl of res.score.slots) {
            const again = byId.get(sl.slotId);
            if (again && again.ok !== sl.ok) sl.stable = false; // unconfirmed → instability
          }
        }
      }
    }
    results.push(res);
    if (res.outage) console.log(`  ${row.id.padEnd(34)} OUTAGE (reviewer dark — row excluded)`);
    else if (res.score) {
      const sc = res.score;
      const hits = sc.slots.filter((x) => x.kind === 'gold' && x.ok).length;
      const goldN = sc.slots.filter((x) => x.kind === 'gold').length;
      const flagged = sc.slots.filter((x) => x.kind === 'decoy' && !x.ok).length;
      const decoyN = sc.slots.filter((x) => x.kind === 'decoy').length;
      const ok = hits === goldN && flagged === 0;
      console.log(
        `  ${row.id.padEnd(34)} ${ok ? 'OK  ' : 'FAIL'}  gold ${hits}/${goldN} · decoys flagged ${flagged}/${decoyN} · spurious ${sc.spurious.length}` +
          (res.warnings.length ? `  (${res.warnings.join('; ')})` : ''),
      );
    }
  }
  if (results.length && results.every((r) => r.outage))
    throw new BenchAbort(2, 'completeness-eval: every case was an outage');

  const s = summarize(rows, results);
  s.gateHash = gh;
  s.matcherHash = mh;
  s.corpusHash = sha12(JSON.stringify(rows));

  console.log(
    `\ncompleteness: ${results.length} case(s)  [matcher=${s.matchModel} K=${s.matchRuns} · reviewer=opus K=1]`,
  );
  console.log(
    `  headline: gap recall ${fmtCi(s.gold.hit, s.gold.total)}  (floor ${FLOOR_GAP_RECALL})`,
  );
  console.log(
    `  headline: false-flag rate ${fmtCi(s.decoys.flagged, s.decoys.total)}  (ceiling ${CEILING_FALSE_FLAG})`,
  );
  console.log(
    `    recorded decisions re-litigated: ${fmtCi(s.decoys.recorded.flagged, s.decoys.recorded.total)}`,
  );
  console.log(
    `  finding precision (informational): ${fmtCi(s.findings.matched, s.findings.total)} · spurious/case ${(s.findings.spurious / Math.max(1, s.cases - s.caseOutages)).toFixed(1)}`,
  );
  if (s.severity.total) {
    console.log(
      `  severity calibration (warn tier): exact ${fmtCi(s.severity.exact, s.severity.total)}`,
    );
    for (const want of SEVERITIES)
      if (s.severity.confusion[want])
        console.log(
          `    want ${want.padEnd(10)} → ${Object.entries(s.severity.confusion[want])
            .map(([g, n]) => `${g}=${n}`)
            .join(' ')}`,
        );
  }
  if (s.verdicts.total)
    console.log(`  verdict line (informational): ${fmtCi(s.verdicts.correct, s.verdicts.total)}`);
  if (s.outages)
    console.log(
      `  outages: ${s.caseOutages} case(s) + ${s.slotOutages} slot(s) — score is suspect, rerun before trusting`,
    );
  const vc = variantConsistency(rows, s);
  if (vc)
    console.log(
      `  variant consistency: ${vc.consistent}/${vc.total} groups${vc.broken.length ? ` — broken: [${vc.broken.join(', ')}]` : ''}`,
    );

  const { regressed, lines } = compareCompleteness(s, baseline.completeness);
  if (existsSync(baselinePath)) for (const l of lines) console.log(l);

  appendLedger({
    ts: new Date().toISOString(),
    args: [...args],
    matchModel: s.matchModel,
    matchRuns: s.matchRuns,
    gateHash: gh,
    matcherHash: mh,
    corpusHash: s.corpusHash,
    cases: s.cases,
    gapRecall: Number(s.gapRecall.toFixed(3)),
    falseFlagRate: Number(s.falseFlagRate.toFixed(3)),
    outages: s.outages,
    regressed,
  });

  if (writeBaseline) {
    baseline.completeness = s;
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\nwrote baseline → ${path.relative(process.cwd(), baselinePath)}`);
  }
  if (failOnRegression && regressed) {
    console.error(
      '\nFAIL: floor breach or statistically significant one-directional case flips vs baseline.',
    );
    process.exit(1);
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => {
    if (e instanceof BenchAbort) {
      console.error(e.message);
      process.exit(e.code);
    }
    throw e;
  });
}
