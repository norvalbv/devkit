#!/usr/bin/env node

/**
 * critique-eval: accuracy benchmark for the feature-critique agent (agents/feature-critique.md).
 *
 * A prompt edit to the critic is unverifiable without a measured check; this scores the agent
 * against a labelled proposal corpus so an edit is a delta, not a vibe. House pattern:
 * gate-engine/decisions/eval/README.md is the standard; departures are listed in ./README.md.
 *
 * Two row modes (one bench):
 *   intrinsic — no tools, everything inlined (BENCHMARK directive); scores the closed-set summary
 *               fields (VERDICT / FRAME_META / counts) + the seed benches' ported text checks.
 *   workflow  — the exact JSON contract in a disposable fixture repo with read-only tools; adds
 *               finding-set metrics and asserts that runtime repository artifacts remain absent.
 *
 *   node bench.mts                     # full run
 *   node bench.mts --dev               # prompt-iteration tier: holdout rows excluded
 *   node bench.mts --only <idPrefix>   # subset (iteration; usage lands in runs.log)
 *   BENCH_RUNS=3 node bench.mts --baseline   # write results.baseline.json (committed)
 *   BENCH_RUNS=3 node bench.mts --fail       # exit 1 on floor breach / significant stable flips
 *   node bench.mts coverage            # corpus coverage matrix — zero claude calls
 *   node bench.mts matcher-audit       # matcher agreement vs committed labels (percent + kappa)
 *
 * Sweeps: BENCH_MODEL (default = the agent md's frontmatter model, opus — the bench measures the
 * production config) · BENCH_RUNS=1|3 (K critic trials per row; 3 for baseline/gate — user ruling
 * sc-1059: strict K=3, "do it once and leave it") · BENCH_MATCH_MODEL / BENCH_MATCH_RUNS (matcher).
 *
 * Headline metrics — one per failure mode:
 *   valid-flaw recall        hits/gold-slots        a missed real flaw defeats the agent → HARD FLOOR
 *   sound-proposal clean rate clean decoy-only rows  a fabricated blocker erodes trust  → HARD FLOOR
 *   decoy flag rate          flagged/decoy-slots    re-litigating settled choices       → HARD CEILING
 *   per-class recall         7 critique classes     reported per class, NEVER averaged
 * Overall finding precision prints informationally only: gold is not exhaustive, so an unmatched
 * finding is not provably wrong (sc-1058 convention) — the decoy set and the decoy-only rows are
 * the measured false-alarm instruments.
 *
 * Statistical honesty (verbatim house rules): every headline ships raw counts + a Wilson 95%
 * interval; --fail gates on hard floors plus per-ROW flip tables under mid-p McNemar — never on
 * aggregate deltas, and never on slot-level pairing (slots within a row share one critic
 * transcript and are correlated; slot-level McNemar is anti-conservative — cluster by item
 * source, Miller arXiv:2411.00640). Baselines embed agentHash + runnerHash (run-critic.mts +
 * matcher.mts + contract.mts) + corpusHash + config; any mismatch skips the comparison mechanically. runs.log is
 * the anti-Goodhart ledger. Holdout rows are excluded from --dev and included in baseline/gate.
 *
 * NULL is a verdict: an unparseable summary scores NULL (its own confusion column). An outage is
 * NOT a parse-NULL: intrinsic rows abort on the first dark row (cheap class, a polluted run is
 * worth less than a rerun); a workflow row needs ≥2 completed trials at K=3 (1 at K=1) or it
 * scores NULL and counts in `outages`. A baseline refuses to write with outages > 0; --fail
 * skips the comparison when the current run has outages. Exit 0 ran · 1 regression · 2 could not run.
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
  majorityVerdict,
  materializeFixture,
  mcnemarMidP,
  parseCasesText,
  wilson,
} from '../../decisions/eval/bench.mts';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import {
  type ContractRunOutcome,
  nullableMajority,
  runPhaseContractBench,
  scoreContractResponse,
  summarizeContract,
} from './contract-bench.mts';
import {
  buildDecoyPrompt,
  buildGoldPrompt,
  CRITIQUE_CLASSES,
  type CritiqueClass,
  type DecoySlot,
  type Finding,
  type FindingSeverity,
  type GoldSlot,
  kappa,
  mapPool,
  parseReportFindings,
  parseSlotReply,
  runMatcher,
  scoreCase,
  voteSlot,
} from './matcher.mts';
import {
  type CriticSource,
  FRAME_METAS,
  type FrameMeta,
  loadCritic,
  type ParsedSummary,
  parseSummary,
  runIntrinsic,
  runWorkflow,
  VERDICTS,
  type Verdict,
} from './run-critic.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'results.baseline.json');
const casesPath = path.join(here, 'cases-critique.jsonl');
const contractCasesPath = path.join(here, 'cases-contract.jsonl');
const auditPath = path.join(here, 'matcher-audit.jsonl');
const transcriptsDir = path.join(here, 'transcripts');

const RUNS = Math.max(1, Number.parseInt(process.env.BENCH_RUNS ?? '1', 10) || 1);
const MATCH_MODEL = process.env.BENCH_MATCH_MODEL ?? 'haiku';
const MATCH_RUNS = Math.max(1, Number.parseInt(process.env.BENCH_MATCH_RUNS ?? '3', 10) || 3);
/** Bounded row fan-out: workflow rows are minutes each, but >3 concurrent opus agents invites the
 * machine-contention SIGTERM class (sc-1049) that reads as fake outages. */
const ROW_CONCURRENCY = Math.max(1, Number.parseInt(process.env.BENCH_CONCURRENCY ?? '3', 10) || 3);

// Hard floors/ceilings on the safety metrics — catastrophic breakage fails immediately regardless
// of flip statistics. Point estimates, not Wilson bounds (the lower bound is uselessly wide here).
const RECALL_FLOOR = 0.75;
const CLEAN_RATE_FLOOR = 0.75;
const DECOY_FLAG_CEILING = 0.25;
/** ≤300-token contract with chars/4 heuristic slack — measured, reported, never floored. */

// ─── Corpus ───────────────────────────────────────────────────────────────────────

export interface Row {
  id: string;
  mode: 'intrinsic' | 'workflow';
  prompt: string;
  repo?: { base: Record<string, string>; staged: Record<string, string | null> };
  gold?: GoldSlot[];
  decoys?: DecoySlot[];
  expectVerdict: Verdict[];
  expectFrameMeta?: FrameMeta[];
  /** Ported seed-bench text checks (intrinsic rows): case-insensitive substring any/none. */
  requireAny?: string[];
  forbid?: string[];
  category: string;
  note: string;
  difficulty?: 'clear' | 'borderline' | 'adversarial';
  provenance?: 'authored' | 'mined' | 'adapted';
  variantOf?: string;
  variantKind?: 'invariance' | 'directional';
  holdout?: boolean;
}

export function loadRows(): Row[] {
  let rows: Row[];
  try {
    rows = parseCasesText(readFileSync(casesPath, 'utf8')) as Row[];
  } catch (e) {
    throw new BenchAbort(2, `critique-eval: cannot read cases-critique.jsonl — ${e}`);
  }
  if (!rows.length) throw new BenchAbort(2, 'critique-eval: cases-critique.jsonl is empty');
  const problems = lintRows(rows);
  if (problems.length)
    throw new BenchAbort(2, `critique-eval: corpus lint failed —\n  ${problems.join('\n  ')}`);
  return rows;
}

/** Corpus lint (pure, unit-tested): schema drift in a labelled corpus is silent metric corruption. */
export function lintRows(rows: Row[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const knownIds = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const where = r.id ?? '(missing id)';
    if (!r.id) problems.push('row without id');
    else if (ids.has(r.id)) problems.push(`${where}: duplicate id`);
    ids.add(r.id);
    if (r.mode !== 'intrinsic' && r.mode !== 'workflow') problems.push(`${where}: bad mode`);
    if (!r.prompt?.trim()) problems.push(`${where}: empty prompt`);
    if (!r.note?.trim()) problems.push(`${where}: note is mandatory (why is the label right?)`);
    if (!r.category?.trim()) problems.push(`${where}: category is mandatory`);
    if (!Array.isArray(r.expectVerdict) || r.expectVerdict.length === 0)
      problems.push(`${where}: expectVerdict must be a non-empty array`);
    else
      for (const v of r.expectVerdict)
        if (!VERDICTS.includes(v)) problems.push(`${where}: unknown verdict ${v}`);
    for (const m of r.expectFrameMeta ?? [])
      if (!FRAME_METAS.includes(m)) problems.push(`${where}: unknown frame meta ${m}`);
    if (r.mode === 'workflow' && !r.repo?.base)
      problems.push(`${where}: workflow row needs repo.base`);
    if (r.mode === 'workflow' && !r.repo?.staged)
      problems.push(`${where}: workflow row needs repo.staged (use {} — fixture contract)`);
    if (r.mode === 'intrinsic' && (r.gold?.length || r.decoys?.length))
      problems.push(`${where}: intrinsic rows are closed-set only — no gold/decoy slots`);
    for (const g of r.gold ?? []) {
      if (!CRITIQUE_CLASSES.includes(g.class))
        problems.push(`${where}/${g.id}: unknown class ${g.class}`);
      if (g.severity !== 'CRITICAL' && g.severity !== 'WARNING')
        problems.push(`${where}/${g.id}: bad severity`);
    }
    for (const d of r.decoys ?? [])
      if (!['sound-choice', 'recorded-decision', 'out-of-scope'].includes(d.kind))
        problems.push(`${where}/${d.id}: bad decoy kind`);
    if (r.variantOf && !knownIds.has(r.variantOf))
      problems.push(`${where}: variantOf ${r.variantOf} not in corpus`);
  }
  return problems;
}

/** Decoy-only rows are the measured false-alarm instrument: gold empty + a sound-proposal verdict. */
export const isDecoyOnly = (r: Row): boolean =>
  r.mode === 'workflow' && (r.gold?.length ?? 0) === 0;

// ─── Per-row execution ────────────────────────────────────────────────────────────

interface SlotState {
  kind: 'gold' | 'decoy';
  class?: CritiqueClass;
  got: string;
  ok: boolean;
  stable: boolean;
}

export interface RowResult {
  id: string;
  mode: Row['mode'];
  expected: string; // canonical (first-listed) expectVerdict — confusion-matrix key
  verdict: { got: string; ok: boolean; stable: boolean };
  frameMeta: { got: string; ok: boolean; stable: boolean } | null;
  textOk: boolean | null; // ported requireAny/forbid checks (intrinsic only)
  slots: Record<string, SlotState>;
  severity: { expected: FindingSeverity; got: FindingSeverity }[];
  /** Decoy-only rows: did any run-majority fabricate a CRITICAL? null elsewhere. */
  falseAlarm: { got: boolean; ok: boolean; stable: boolean } | null;
  contract: {
    jsonContractValid: boolean;
    edgeCasesValid: boolean;
    noFlowId: boolean;
    repositoryUnchanged: boolean | null;
    providerArtifactsAbsent: boolean | null;
  } | null;
  fabricatedPerRun: number[];
  findingCount: number;
  outage: boolean;
  ok: boolean; // composite — the ledger/summary line, never the flip-gate unit
}

const majorityBool = (xs: boolean[]): { got: boolean; stable: boolean } => {
  const t = xs.filter(Boolean).length;
  return { got: t * 2 > xs.length, stable: t === 0 || t === xs.length };
};

function textCheck(raw: string, row: Row): boolean {
  const lower = raw.toLowerCase();
  const anyOk =
    !row.requireAny?.length || row.requireAny.some((k) => lower.includes(k.toLowerCase()));
  const noneOk = !(row.forbid ?? []).some((k) => lower.includes(k.toLowerCase()));
  return anyOk && noneOk;
}

export interface RunDeps {
  critic: CriticSource;
  runs: number;
  saveTranscript?: (name: string, content: string) => void;
  registerCleanup: (fn: (() => void) | null) => void;
  execIntrinsic?: typeof runIntrinsic;
  execWorkflow?: typeof runWorkflow;
  match?: typeof runMatcher;
  /** `--salvage <dir>`: returns saved trial transcripts for a row (an interrupted run's spend).
   * A row with enough salvaged trials for a K-majority spawns NOTHING; the matcher (cheap haiku)
   * still runs live on the parsed findings. Trials are exchangeable across runs of the same
   * agentHash+corpus — the salvage run re-verifies both before accepting the directory. */
  salvage?: (rowId: string) => SalvagedTrial[];
}

export interface SalvagedTrial {
  raw: string;
  report: string | null;
  /** null = the interrupted run predates artifact persistence — validity is UNKNOWN for this
   * trial (scored null, excluded from the contract denominator), never assumed pass/fail. */
  artifact: string | null;
}

/** Read saved trials for one row from a transcripts dir (summary is the trial's existence). */
export function loadSalvageDir(dir: string, rowId: string): SalvagedTrial[] {
  const trials: SalvagedTrial[] = [];
  const readOrNull = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  for (let k = 1; k <= 3; k += 1) {
    const raw = readOrNull(path.join(dir, `${rowId}.run${k}.summary.txt`));
    if (raw === null) continue;
    trials.push({
      raw,
      report: readOrNull(path.join(dir, `${rowId}.run${k}.report.md`)),
      artifact: readOrNull(path.join(dir, `${rowId}.run${k}.artifact.json`)),
    });
  }
  return trials;
}

/** Enough salvaged trials to stand in for a full row: the same bar as the outage rule (a K=3
 * majority needs ≥2 trials; a K=1 dev row needs 1). */
export const salvageUsable = (trials: SalvagedTrial[], runs: number): boolean =>
  trials.length >= (runs >= 3 ? 2 : 1);

/** Aggregate K parsed summaries into row-level verdict/frameMeta majorities. */
export function aggregateSummaries(
  summaries: ParsedSummary[],
  row: Pick<Row, 'expectVerdict' | 'expectFrameMeta'>,
): Pick<RowResult, 'verdict' | 'frameMeta'> {
  const v = majorityVerdict(summaries.map((s) => s.verdict ?? 'NULL'));
  const verdictOk = row.expectVerdict.includes(v.verdict as Verdict);
  const m = majorityVerdict(summaries.map((s) => s.frameMeta ?? 'NULL'));
  const wantMeta = row.expectFrameMeta ?? [];
  return {
    verdict: { got: v.verdict, ok: verdictOk, stable: v.unanimous },
    frameMeta: wantMeta.length
      ? { got: m.verdict, ok: wantMeta.includes(m.verdict as FrameMeta), stable: m.unanimous }
      : null,
  };
}

export async function runIntrinsicRow(row: Row, deps: RunDeps): Promise<RowResult> {
  const summaries: ParsedSummary[] = [];
  const textOks: boolean[] = [];
  const salvaged = deps.salvage?.(row.id) ?? [];
  const trialRaws: string[] = [];
  if (salvageUsable(salvaged, deps.runs)) {
    for (const t of salvaged) trialRaws.push(t.raw);
  } else {
    for (let k = 0; k < deps.runs; k += 1) {
      const raw = await (deps.execIntrinsic ?? runIntrinsic)({
        critic: deps.critic,
        prompt: row.prompt,
      });
      // Cheap class: the first dark row aborts the run (sentry convention) — a polluted run is
      // worth less than a rerun.
      if (raw === null) throw new BenchAbort(2, `critique-eval: claude went dark on ${row.id}`);
      deps.saveTranscript?.(`${row.id}.run${k + 1}.summary.txt`, raw);
      trialRaws.push(raw);
    }
  }
  for (const raw of trialRaws) {
    summaries.push(parseSummary(raw));
    textOks.push(textCheck(raw, row));
  }
  const agg = aggregateSummaries(summaries, row);
  const text = majorityBool(textOks);
  const textOk = row.requireAny?.length || row.forbid?.length ? text.got : null;
  return {
    id: row.id,
    mode: 'intrinsic',
    expected: row.expectVerdict[0],
    ...agg,
    textOk,
    slots: {},
    severity: [],
    falseAlarm: null,
    contract: null,
    fabricatedPerRun: [],
    findingCount: 0,
    outage: false,
    ok: agg.verdict.ok && (agg.frameMeta?.ok ?? true) && (textOk ?? true),
  };
}

export async function runWorkflowRow(row: Row, deps: RunDeps): Promise<RowResult> {
  const gold = row.gold ?? [];
  const decoys = row.decoys ?? [];
  const summaries: ParsedSummary[] = [];
  const contractPerRun: ContractRunOutcome[] = [];
  const slotGotPerRun: Record<string, string>[] = [];
  const severityPerRun: { slotId: string; got: FindingSeverity }[][] = [];
  const fabricatedPerRun: number[] = [];
  let findingCount = 0;
  let completed = 0;

  // One trial's scoring, shared by the live and salvaged paths. artifactKnowable=false means the
  // trial predates artifact persistence: validity scores null (excluded from the denominator),
  // never an assumed pass/fail.
  const scoreTrial = async (
    out: {
      raw: string;
      report: string | null;
      artifact: string | null;
      repositoryUnchanged?: boolean | null;
      providerArtifactsAbsent?: boolean | null;
    },
    repositoryEffectsKnowable: boolean,
  ) => {
    const summary = parseSummary(out.raw);
    summaries.push(summary);
    const findings = out.report ? parseReportFindings(out.report) : [];
    findingCount = Math.max(findingCount, findings.length);
    contractPerRun.push(scoreContractResponse(out.raw, repositoryEffectsKnowable, out));
    const outcomes = await (deps.match ?? runMatcher)(gold, decoys, findings, {
      model: MATCH_MODEL,
      runs: MATCH_RUNS,
    });
    const score = scoreCase(gold, decoys, findings, outcomes);
    slotGotPerRun.push(Object.fromEntries(score.slots.map((s) => [s.slotId, s.got])));
    severityPerRun.push(score.severity.map((p) => ({ slotId: p.slotId, got: p.got })));
    fabricatedPerRun.push(score.fabricatedCriticals.length);
  };

  const salvaged = deps.salvage?.(row.id) ?? [];
  if (salvageUsable(salvaged, deps.runs)) {
    // Already-paid trials from an interrupted run: no fixture, no spawn — matcher only.
    for (const t of salvaged) {
      completed += 1;
      await scoreTrial(t, false);
    }
  } else {
    for (let k = 0; k < deps.runs; k += 1) {
      const fx = materializeFixture(row); // fresh world per trial — no cross-run state bleed
      deps.registerCleanup(fx.cleanup);
      try {
        const out = await (deps.execWorkflow ?? runWorkflow)({
          critic: deps.critic,
          prompt: row.prompt,
          fixtureDir: fx.repo,
        });
        if (out.raw === null) continue; // expensive class: score what completed, count the outage
        completed += 1;
        deps.saveTranscript?.(`${row.id}.run${k + 1}.summary.txt`, out.raw);
        if (out.report) deps.saveTranscript?.(`${row.id}.run${k + 1}.report.md`, out.report);
        if (out.artifact)
          deps.saveTranscript?.(`${row.id}.run${k + 1}.artifact.json`, out.artifact);
        await scoreTrial(
          {
            raw: out.raw,
            report: out.report,
            artifact: out.artifact,
            repositoryUnchanged: out.repositoryUnchanged,
            providerArtifactsAbsent: out.providerArtifactsAbsent,
          },
          true,
        );
      } finally {
        fx.cleanup();
        deps.registerCleanup(null);
      }
    }
  }

  // A K=3 row needs ≥2 completed trials for a majority worth the name; a K=1 (--dev) row needs 1.
  const minCompleted = deps.runs >= 3 ? 2 : 1;
  if (completed < minCompleted) {
    return {
      id: row.id,
      mode: 'workflow',
      expected: row.expectVerdict[0],
      verdict: { got: 'NULL', ok: false, stable: false },
      frameMeta: null,
      textOk: null,
      slots: {},
      severity: [],
      falseAlarm: null,
      contract: null,
      fabricatedPerRun,
      findingCount: 0,
      outage: true,
      ok: false,
    };
  }

  const agg = aggregateSummaries(summaries, row);
  const slots: RowResult['slots'] = {};
  for (const s of [...gold, ...decoys.map((d) => ({ ...d, class: undefined }))]) {
    const gots = slotGotPerRun.map((m) => m[s.id]).filter((g): g is string => g !== undefined);
    const m = majorityVerdict(gots);
    const kind = gold.some((g) => g.id === s.id) ? ('gold' as const) : ('decoy' as const);
    const got = m.verdict === 'NULL' ? (kind === 'gold' ? 'miss' : 'clean') : m.verdict;
    slots[s.id] = {
      kind,
      class: (s as GoldSlot).class,
      got,
      ok: kind === 'gold' ? got === 'hit' : got !== 'flagged',
      stable: m.unanimous,
    };
  }
  // Severity calibration per majority-hit slot: majority emitted tier across its hit trials.
  const severity: RowResult['severity'] = [];
  for (const g of gold) {
    if (slots[g.id]?.got !== 'hit') continue;
    const tiers = severityPerRun.flatMap((run) =>
      run.filter((p) => p.slotId === g.id).map((p) => p.got),
    );
    if (tiers.length)
      severity.push({
        expected: g.severity,
        got: majorityVerdict(tiers).verdict as FindingSeverity,
      });
  }
  const fabricated = majorityBool(fabricatedPerRun.map((n) => n > 0));
  const falseAlarm = isDecoyOnly(row)
    ? { got: fabricated.got, ok: !fabricated.got, stable: fabricated.stable }
    : null;
  const contract: RowResult['contract'] = {
    jsonContractValid: majorityBool(contractPerRun.map((c) => c.jsonContractValid)).got,
    edgeCasesValid: majorityBool(contractPerRun.map((c) => c.edgeCasesValid)).got,
    noFlowId: majorityBool(contractPerRun.map((c) => c.noFlowId)).got,
    repositoryUnchanged: nullableMajority(contractPerRun.map((c) => c.repositoryUnchanged)),
    providerArtifactsAbsent: nullableMajority(contractPerRun.map((c) => c.providerArtifactsAbsent)),
  };
  const goldOk = gold.every((g) => slots[g.id]?.ok);
  const decoysOk = decoys.every((d) => slots[d.id]?.ok);
  return {
    id: row.id,
    mode: 'workflow',
    expected: row.expectVerdict[0],
    ...agg,
    textOk: null,
    slots,
    severity,
    falseAlarm,
    contract,
    fabricatedPerRun,
    findingCount,
    outage: false,
    ok:
      agg.verdict.ok &&
      (agg.frameMeta?.ok ?? true) &&
      goldOk &&
      decoysOk &&
      (falseAlarm?.ok ?? true),
  };
}

// ─── Aggregation ──────────────────────────────────────────────────────────────────

export interface Summary {
  model: string;
  matchModel: string;
  runs: number;
  matchRuns: number;
  agentHash?: string;
  runnerHash?: string;
  corpusHash?: string;
  outages: number;
  /** Rows whose trials were ingested from an interrupted run's transcripts (`--salvage`). */
  salvagedRows?: string[];
  recall: { hits: number; total: number };
  cleanRate: { clean: number; total: number };
  decoyFlags: { flagged: number; mentioned: number; total: number };
  perClass: Record<CritiqueClass, { hits: number; total: number }>;
  verdictAccuracy: { correct: number; total: number };
  confusion: Record<string, Record<string, number>>;
  frameMetaAccuracy: { correct: number; total: number };
  severityCalibration: { exact: number; total: number };
  precisionInfo: { matched: number; emitted: number };
  contract: Record<string, { ok: number; total: number }>;
  rows: Record<
    string,
    {
      expected: string;
      got: string;
      ok: boolean;
      verdictOk: boolean;
      verdictStable: boolean;
      slots: Record<string, { got: string; ok: boolean; stable: boolean }>;
      falseAlarm: { got: boolean; ok: boolean; stable: boolean } | null;
      outage: boolean;
    }
  >;
}

export function summarize(results: RowResult[], critic: { model: string }): Summary {
  const scored = results.filter((r) => !r.outage);
  const goldSlots = scored.flatMap((r) => Object.values(r.slots).filter((s) => s.kind === 'gold'));
  const decoySlots = scored.flatMap((r) =>
    Object.values(r.slots).filter((s) => s.kind === 'decoy'),
  );
  const perClass = Object.fromEntries(
    CRITIQUE_CLASSES.map((c) => [c, { hits: 0, total: 0 }]),
  ) as Summary['perClass'];
  for (const s of goldSlots) {
    if (!s.class) continue;
    perClass[s.class].total += 1;
    if (s.ok) perClass[s.class].hits += 1;
  }
  const decoyOnly = scored.filter((r) => r.falseAlarm !== null);
  const confusion: Summary['confusion'] = {};
  let verdictCorrect = 0;
  for (const r of scored) {
    confusion[r.expected] ??= {};
    confusion[r.expected][r.verdict.got] = (confusion[r.expected][r.verdict.got] ?? 0) + 1;
    if (r.verdict.ok) verdictCorrect += 1;
  }
  const metaRows = scored.filter((r) => r.frameMeta !== null);
  const sev = scored.flatMap((r) => r.severity);
  const workflowScored = scored.filter((r) => r.mode === 'workflow');
  const contract = summarizeContract(workflowScored);
  // Informational precision: emitted findings matched to gold vs emitted (majority findingCount).
  const matched = goldSlots.filter((s) => s.ok).length;
  const emitted = workflowScored.reduce((n, r) => n + r.findingCount, 0);
  return {
    model: critic.model,
    matchModel: MATCH_MODEL,
    runs: RUNS,
    matchRuns: MATCH_RUNS,
    outages: results.filter((r) => r.outage).length,
    recall: { hits: goldSlots.filter((s) => s.ok).length, total: goldSlots.length },
    cleanRate: {
      clean: decoyOnly.filter((r) => r.falseAlarm?.ok).length,
      total: decoyOnly.length,
    },
    decoyFlags: {
      flagged: decoySlots.filter((s) => s.got === 'flagged').length,
      mentioned: decoySlots.filter((s) => s.got === 'mentioned').length,
      total: decoySlots.length,
    },
    perClass,
    verdictAccuracy: { correct: verdictCorrect, total: scored.length },
    confusion,
    frameMetaAccuracy: {
      correct: metaRows.filter((r) => r.frameMeta?.ok).length,
      total: metaRows.length,
    },
    severityCalibration: {
      exact: sev.filter((p) => p.expected === p.got).length,
      total: sev.length,
    },
    precisionInfo: { matched, emitted },
    contract,
    rows: Object.fromEntries(
      results.map((r) => [
        r.id,
        {
          expected: r.expected,
          got: r.verdict.got,
          ok: r.ok,
          verdictOk: r.verdict.ok,
          verdictStable: r.verdict.stable,
          slots: Object.fromEntries(
            Object.entries(r.slots).map(([id, s]) => [
              id,
              { got: s.got, ok: s.ok, stable: s.stable },
            ]),
          ),
          falseAlarm: r.falseAlarm,
          outage: r.outage,
        },
      ]),
    ),
  };
}

// ─── Baseline + regression ────────────────────────────────────────────────────────

const CONFIG_KEYS = ['model', 'matchModel', 'runs', 'matchRuns'] as const;

/**
 * Compare vs baseline — house order: (1) comparability preconditions skip rather than lie;
 * (2) hard floors/ceilings; (3) per-ROW flip tables (verdict · recall-degradation · false-alarm)
 * under mid-p McNemar, stable flips only. Slot-level changes print informationally.
 */
export function compare(summary: Summary, base: Summary | undefined) {
  if (!base) return { regressed: false, lines: ['  no baseline — skipped'] };
  const skip = (why: string) => ({
    regressed: false,
    lines: [`  ${why} — regenerate with --baseline; comparison skipped`],
  });
  const mismatch = CONFIG_KEYS.filter((k) => summary[k] !== base[k]);
  if (mismatch.length) return skip(`baseline config differs (${mismatch.join(', ')})`);
  for (const h of ['agentHash', 'runnerHash', 'corpusHash'] as const)
    if (base[h] && summary[h] && base[h] !== summary[h])
      return skip(`${h} changed since the baseline`);
  if (summary.outages > 0) return skip(`${summary.outages} outage(s) this run — score is suspect`);

  const lines: string[] = [];
  let regressed = false;
  const floors: [string, (s: Summary) => number, number, boolean][] = [
    ['valid-flaw recall', (s) => s.recall.hits / Math.max(1, s.recall.total), RECALL_FLOOR, true],
    [
      'sound-proposal clean rate',
      (s) => (s.cleanRate.total ? s.cleanRate.clean / s.cleanRate.total : 1),
      CLEAN_RATE_FLOOR,
      true,
    ],
    [
      'decoy flag rate',
      (s) => (s.decoyFlags.total ? s.decoyFlags.flagged / s.decoyFlags.total : 0),
      DECOY_FLAG_CEILING,
      false,
    ],
  ];
  for (const [label, pick, bound, isFloor] of floors) {
    const cur = pick(summary);
    const breach = isFloor ? cur < bound : cur > bound;
    if (!breach) continue;
    const prev = pick(base);
    const prevBreach = isFloor ? prev < bound : prev > bound;
    // A floor is a tripwire for NEW catastrophic breakage. When the committed baseline itself
    // breaches (the 2026-07-06 baseline: clean rate 0.20 — the agent's measured
    // hallucinated-blocker rate, the declared B2 target), a permanent red gate would just get
    // ignored; the known breach prints loudly instead, and the flip tables still catch that
    // metric getting WORSE row-by-row.
    if (prevBreach) {
      lines.push(
        `  KNOWN FLOOR BREACH (carried from baseline — the B2 target, not a regression): ${label} ${cur.toFixed(2)} ${isFloor ? '<' : '>'} ${bound}`,
      );
    } else {
      regressed = true;
      lines.push(
        `  FLOOR BREACH — ${label} ${cur.toFixed(2)} ${isFloor ? '<' : '>'} ${bound} (new vs baseline; fails regardless of flips)`,
      );
    }
  }

  // Three row-level flip tables. Only STABLE flips count; unstable ones print as instability.
  const tables: { name: string; b: string[]; c: string[]; unstable: string[] }[] = [
    { name: 'verdict', b: [], c: [], unstable: [] },
    { name: 'recall', b: [], c: [], unstable: [] },
    { name: 'false-alarm', b: [], c: [], unstable: [] },
  ];
  for (const [id, cur] of Object.entries(summary.rows)) {
    const prev = base.rows[id];
    if (!prev || cur.outage || prev.outage) continue;
    if (prev.verdictOk && !cur.verdictOk)
      (cur.verdictStable ? tables[0].b : tables[0].unstable).push(id);
    else if (!prev.verdictOk && cur.verdictOk) tables[0].c.push(id);
    // Recall degradation: ≥1 gold slot lost and none gained (a derailed transcript flips slots
    // together — the row, not the slot, is the independent unit).
    const lost: string[] = [];
    const gained: string[] = [];
    let lostUnstable = false;
    for (const [sid, s] of Object.entries(cur.slots)) {
      const p = prev.slots[sid];
      if (!p || s.got === 'mentioned' || p.got === 'mentioned') continue;
      if (p.ok && !s.ok) {
        if (s.stable) lost.push(sid);
        else lostUnstable = true;
      } else if (!p.ok && s.ok) gained.push(sid);
    }
    // Mirror conditions on both sides (a stray composite-ok gate here undercounted improvements
    // and skewed the McNemar b/c ratio toward false regressions). The b-side stability gate is
    // the one deliberate asymmetry, as in verdict/false-alarm handling: a regression must be
    // stable to count; an improvement counts as-is (conservative direction).
    if (lost.length && !gained.length) tables[1].b.push(id);
    else if (gained.length && !lost.length) tables[1].c.push(id);
    else if (lostUnstable) tables[1].unstable.push(id);
    if (cur.falseAlarm && prev.falseAlarm) {
      if (prev.falseAlarm.ok && !cur.falseAlarm.ok)
        (cur.falseAlarm.stable ? tables[2].b : tables[2].unstable).push(id);
      else if (!prev.falseAlarm.ok && cur.falseAlarm.ok) tables[2].c.push(id);
    }
  }
  const n = Object.keys(summary.rows).length;
  for (const t of tables) {
    if (t.b.length + t.c.length > 0) {
      const midP = mcnemarMidP(t.b.length, t.c.length);
      const mde = 2.802 * Math.sqrt((t.b.length + t.c.length) / n / n);
      lines.push(
        `  ${t.name}: flips — regressed [${t.b.join(', ') || '—'}] improved [${t.c.join(', ') || '—'}] (mid-p ${midP.toFixed(3)})`,
      );
      lines.push(
        `  ${t.name}: deltas below ~${(mde * 100).toFixed(0)}pp are indistinguishable from judge noise at n=${n}`,
      );
      if (midP < 0.05 && t.b.length > t.c.length) {
        regressed = true;
        lines.push(`  ${t.name}: REGRESSION — one-directional stable flips significant`);
      }
    }
    if (t.unstable.length)
      lines.push(
        `  ${t.name}: unstable rows (instability, not regression): [${t.unstable.join(', ')}]`,
      );
  }
  return { regressed, lines };
}

// ─── Hashes, coverage, ledger, cost ───────────────────────────────────────────────

const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
export const runnerHash = () =>
  sha12(
    readFileSync(path.join(here, `run-critic${SELF_EXT}`), 'utf8') +
      readFileSync(path.join(here, `matcher${SELF_EXT}`), 'utf8') +
      readFileSync(path.join(here, `../contract${SELF_EXT}`), 'utf8'),
  );

function printCoverage(rows: Row[]) {
  console.log(`\n── cases-critique (${rows.length} rows) ──`);
  const cells: Record<string, number> = {};
  const tag: { provenance: Record<string, number>; holdout: number; variants: number } = {
    provenance: {},
    holdout: 0,
    variants: 0,
  };
  const classCount = Object.fromEntries(CRITIQUE_CLASSES.map((c) => [c, 0]));
  for (const r of rows) {
    const key = `${r.category.padEnd(26)} ${r.mode.padEnd(9)} ${r.difficulty ?? 'unset'}`;
    cells[key] = (cells[key] ?? 0) + 1;
    const p = r.provenance ?? 'authored';
    tag.provenance[p] = (tag.provenance[p] ?? 0) + 1;
    if (r.holdout) tag.holdout += 1;
    if (r.variantOf) tag.variants += 1;
    for (const g of r.gold ?? []) classCount[g.class] += 1;
  }
  console.log(`  ${'category'.padEnd(26)} ${'mode'.padEnd(9)} difficulty  rows`);
  for (const key of Object.keys(cells).sort()) console.log(`  ${key}  ${cells[key]}`);
  console.log(
    `  gold slots by class: ${CRITIQUE_CLASSES.map((c) => `${c}=${classCount[c]}`).join(' ')}`,
  );
  const empty = CRITIQUE_CLASSES.filter((c) => classCount[c] === 0);
  if (empty.length)
    console.log(`  COVERAGE DEBT: no gold slots for class(es): ${empty.join(', ')}`);
  console.log(
    `  decoy-only rows: ${rows.filter(isDecoyOnly).length} · provenance: ${Object.entries(
      tag.provenance,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')} · holdout=${tag.holdout} · variant rows=${tag.variants}`,
  );
  const unset = rows.filter((r) => !r.difficulty).length;
  if (unset) console.log(`  COVERAGE DEBT: ${unset} row(s) missing a difficulty tag`);
}

function printEstimate(rows: Row[]) {
  const intrinsic = rows.filter((r) => r.mode === 'intrinsic').length;
  const workflow = rows.filter((r) => r.mode === 'workflow').length;
  const slots = rows.reduce((s, r) => s + (r.gold?.length ?? 0) + (r.decoys?.length ?? 0), 0);
  const critic = intrinsic * 45 * RUNS + workflow * 210 * RUNS;
  const matcher = slots * MATCH_RUNS * RUNS * 12;
  const wall = Math.round((critic + matcher) / ROW_CONCURRENCY / 60);
  console.log(
    `critique-eval: budget ≈ ${Math.round((critic + matcher) / 60)} min serial · ~${wall} min at concurrency ${ROW_CONCURRENCY}\n` +
      `  (${intrinsic} intrinsic × ~45s × K=${RUNS} · ${workflow} workflow × ~3.5min × K=${RUNS} · ` +
      `${slots} matcher slots × ${MATCH_RUNS} votes × K=${RUNS} × ~12s)`,
  );
}

function appendLedger(entry: object) {
  try {
    appendFileSync(path.join(here, 'runs.log'), `${JSON.stringify(entry)}\n`);
  } catch {
    // The ledger is telemetry; never let it break a run.
  }
}

// ─── matcher-audit ────────────────────────────────────────────────────────────────

interface AuditRow {
  id: string;
  kind: 'gold' | 'decoy';
  slot: GoldSlot | DecoySlot;
  findings: Finding[];
  /** Human label: 0 = NONE, N = 1-based finding index. */
  label: number;
  note: string;
}

/** Score the matcher against committed human labels — percent + Cohen's kappa. The audit set is
 * seeded ADVERSARIALLY (near-miss paraphrases, decoy/gold confusables, two-slot findings), so this
 * is a validity check, not a convenience sample. */
async function runMatcherAudit() {
  let rows: AuditRow[];
  try {
    rows = parseCasesText(readFileSync(auditPath, 'utf8')) as AuditRow[];
  } catch (e) {
    throw new BenchAbort(2, `critique-eval: cannot read matcher-audit.jsonl — ${e}`);
  }
  if (!rows.length) throw new BenchAbort(2, 'critique-eval: matcher-audit.jsonl is empty');
  console.log(
    `critique-eval: matcher-audit — ${rows.length} labelled slots [model=${MATCH_MODEL} K=${MATCH_RUNS}]`,
  );
  const got: string[] = [];
  const want: string[] = [];
  let unstable = 0;
  await mapPool(rows, 4, async (r) => {
    const prompt =
      r.kind === 'gold'
        ? buildGoldPrompt(r.slot as GoldSlot, r.findings)
        : buildDecoyPrompt(r.slot as DecoySlot, r.findings);
    const trials: (number | null)[] = [];
    for (let k = 0; k < MATCH_RUNS; k += 1) {
      const raw = await execJudgeAsync({
        label: `critique-eval:audit:${r.id}`,
        args: ['-p', prompt, '--model', MATCH_MODEL, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION],
        timeout: 60_000,
      });
      trials.push(raw === null ? null : parseSlotReply(raw, r.findings.length));
    }
    const v = voteSlot(trials);
    if (!v.stable) unstable += 1;
    got.push(String(v.match));
    want.push(String(r.label));
    console.log(
      `  ${r.id.padEnd(30)} ${v.match === r.label ? 'OK  ' : 'FAIL'} got=${v.match} want=${r.label}${v.stable ? '' : ' (unstable)'}`,
    );
  });
  const agree = got.filter((g, i) => g === want[i]).length;
  const k = kappa(got, want);
  console.log(
    `\nmatcher-audit: agreement ${agree}/${got.length} (${((agree / got.length) * 100).toFixed(0)}%) · Cohen's κ ${k.toFixed(2)} · unstable ${unstable}`,
  );
  console.log(
    '  (κ < 0.6 = the matcher is too noisy to trust the finding-set metrics — fix it first)',
  );
}

// ─── Orchestration ────────────────────────────────────────────────────────────────

async function main(argv: string[]) {
  const args = new Set(argv);
  const writeBaseline = args.has('--baseline');
  const failOnRegression = args.has('--fail');
  const devOnly = args.has('--dev');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;
  const salvageIdx = argv.indexOf('--salvage');
  const salvageDir = salvageIdx !== -1 ? argv[salvageIdx + 1] : null;
  if (salvageDir && !existsSync(salvageDir))
    throw new BenchAbort(2, `critique-eval: --salvage dir not found: ${salvageDir}`);

  // SIGINT: the current fixture must not linger in the tmpdir (decisions registers its own
  // cleanup in ITS main — an importer inherits none of it, so this bench keeps its own registry).
  const activeCleanups = new Set<() => void>();
  process.on('SIGINT', () => {
    for (const fn of activeCleanups) fn();
    process.exit(130);
  });

  const stripped = cleanBenchEnv();
  if (stripped.length)
    console.log(`critique-eval: stripped env for a clean run: ${stripped.join(', ')}`);
  if (!args.has('coverage')) {
    try {
      execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 30_000 });
    } catch {
      throw new BenchAbort(2, 'critique-eval: `claude` CLI not available — cannot benchmark');
    }
  }

  if (args.has('coverage')) {
    printCoverage(loadRows());
    process.exit(0);
  }
  if (args.has('matcher-audit')) {
    await runMatcherAudit();
    process.exit(0);
  }
  if (args.has('phase-contract')) {
    const critic = loadCritic();
    process.exit(
      await runPhaseContractBench({
        casesPath: contractCasesPath,
        runs: RUNS,
        critic,
        run: (prompt) => runIntrinsic({ critic, prompt }),
        majority: (statuses) => majorityVerdict(statuses).verdict,
      }),
    );
  }

  if (devOnly && (writeBaseline || failOnRegression))
    throw new BenchAbort(
      2,
      'critique-eval: --dev excludes holdout rows — not valid with --baseline/--fail',
    );
  if ((writeBaseline || failOnRegression) && RUNS < 3)
    console.log(
      'critique-eval: WARNING — baseline/--fail runs should use BENCH_RUNS=3 (a single nondeterministic run is not a baseline)',
    );
  if ((writeBaseline || failOnRegression) && only)
    throw new BenchAbort(
      2,
      'critique-eval: --only is an iteration tool — not valid with --baseline/--fail',
    );

  let rows = loadRows();
  if (devOnly) rows = rows.filter((r) => !r.holdout);
  if (only) rows = rows.filter((r) => r.id.startsWith(only));
  if (!rows.length) throw new BenchAbort(2, `critique-eval: no rows match --only ${only}`);

  const critic = loadCritic();
  // --salvage: reuse an interrupted run's saved trials instead of re-buying them. Trials are only
  // exchangeable across runs of the SAME agent prompt — a changed md means the saved transcripts
  // measured a different critic, so refuse rather than mix experiments.
  const salvagedIds: string[] = [];
  if (salvageDir) {
    const marker = path.join(salvageDir, 'agent.hash');
    const savedHash = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
    if (savedHash && savedHash !== sha12(critic.raw))
      throw new BenchAbort(2, 'critique-eval: --salvage dir was produced by a different agent md');
    for (const r of rows)
      if (salvageUsable(loadSalvageDir(salvageDir, r.id), RUNS)) salvagedIds.push(r.id);
    console.log(
      `critique-eval: salvaging ${salvagedIds.length}/${rows.length} rows from ${salvageDir} ` +
        `(${savedHash ? 'agentHash verified' : 'no agent.hash marker — verify the md is unchanged'}); ` +
        `live rows: [${
          rows
            .filter((r) => !salvagedIds.includes(r.id))
            .map((r) => r.id)
            .join(', ') || '—'
        }]`,
    );
  }
  printEstimate(rows.filter((r) => !salvagedIds.includes(r.id)));
  if (salvagedIds.length)
    console.log(
      `critique-eval: (budget above covers LIVE rows only — ${salvagedIds.length} salvaged rows cost matcher-haiku calls, not critic runs)`,
    );

  mkdirSync(transcriptsDir, { recursive: true });
  const deps: RunDeps = {
    critic,
    runs: RUNS,
    saveTranscript: (name, content) => {
      try {
        writeFileSync(path.join(transcriptsDir, name), content);
      } catch {
        // Transcripts are debugging aids; never let them break a run.
      }
    },
    registerCleanup: (fn) => {
      if (fn) activeCleanups.add(fn);
      else activeCleanups.clear();
    },
    salvage: salvageDir ? (rowId) => loadSalvageDir(salvageDir, rowId) : undefined,
  };
  // Stamp the transcripts dir with the agent hash so a FUTURE --salvage can verify exchangeability.
  try {
    writeFileSync(path.join(transcriptsDir, 'agent.hash'), sha12(critic.raw));
  } catch {
    // marker is best-effort
  }

  const results = await mapPool(rows, ROW_CONCURRENCY, async (row) => {
    const r =
      row.mode === 'intrinsic' ? await runIntrinsicRow(row, deps) : await runWorkflowRow(row, deps);
    const flags = [
      r.outage ? ' (OUTAGE)' : '',
      r.verdict.stable ? '' : ' (unstable)',
      r.mode === 'workflow' && !r.outage
        ? `  slots ${Object.values(r.slots).filter((s) => s.ok).length}/${Object.keys(r.slots).length}`
        : '',
    ].join('');
    console.log(
      `  ${r.id.padEnd(34)} ${r.ok ? 'OK  ' : 'FAIL'}  verdict=${r.verdict.got} want∈[${row.expectVerdict.join('|')}]${flags}`,
    );
    return r;
  });

  const s = summarize(results, critic);
  s.agentHash = sha12(critic.raw);
  if (salvagedIds.length) s.salvagedRows = salvagedIds;
  s.runnerHash = runnerHash();
  s.corpusHash = sha12(JSON.stringify(rows));

  const ci = (k: number, n: number) => {
    const { lo, hi } = wilson(k, n);
    return `${k}/${n} = ${n ? (k / n).toFixed(2) : '—'} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
  };
  console.log(
    `\ncritique-eval: ${results.filter((r) => r.ok).length}/${results.length} rows ok  ` +
      `[model=${s.model} K=${s.runs} matcher=${s.matchModel}×${s.matchRuns}]${s.outages ? `  · outages ${s.outages}` : ''}`,
  );
  console.log(
    `  headline: valid-flaw recall        ${ci(s.recall.hits, s.recall.total)}  (floor ${RECALL_FLOOR})`,
  );
  console.log(
    `  headline: sound-proposal clean rate ${ci(s.cleanRate.clean, s.cleanRate.total)}  (floor ${CLEAN_RATE_FLOOR})`,
  );
  console.log(
    `  headline: decoy flag rate          ${ci(s.decoyFlags.flagged, s.decoyFlags.total)}  (ceiling ${DECOY_FLAG_CEILING}; +${s.decoyFlags.mentioned} warning-tier mentions, allowed)`,
  );
  console.log('  per-class recall (never averaged):');
  for (const c of CRITIQUE_CLASSES) {
    const pc = s.perClass[c];
    console.log(`    ${c.padEnd(22)} ${pc.total ? ci(pc.hits, pc.total) : '— no gold slots'}`);
  }
  console.log(
    `  verdict accuracy (set-membership)  ${ci(s.verdictAccuracy.correct, s.verdictAccuracy.total)}`,
  );
  const gots = [...new Set(Object.values(s.confusion).flatMap((g) => Object.keys(g)))].sort();
  console.log(`  ${'canonical \\ got'.padEnd(22)}${gots.map((g) => g.padStart(22)).join('')}`);
  for (const e of Object.keys(s.confusion).sort())
    console.log(
      `  ${e.padEnd(22)}${gots.map((g) => String(s.confusion[e][g] ?? 0).padStart(22)).join('')}`,
    );
  console.log(
    `  frame-meta accuracy               ${ci(s.frameMetaAccuracy.correct, s.frameMetaAccuracy.total)}`,
  );
  console.log(
    `  severity calibration (warn tier)  ${ci(s.severityCalibration.exact, s.severityCalibration.total)}`,
  );
  console.log(
    `  finding precision (informational — gold is not exhaustive): ${s.precisionInfo.matched} matched of ${s.precisionInfo.emitted} emitted`,
  );
  for (const [key, v] of Object.entries(s.contract))
    console.log(`  contract: ${key.padEnd(18)} ${v.total ? ci(v.ok, v.total) : '—'}`);

  // Metamorphic invariance groups must agree on the verdict — consistency is its own metric.
  const groups: Record<string, Set<string>> = {};
  for (const r of rows) {
    if (!r.variantOf || r.variantKind === 'directional') continue;
    groups[r.variantOf] ??= new Set([r.variantOf]);
    groups[r.variantOf].add(r.id);
  }
  const gids = Object.keys(groups);
  if (gids.length) {
    const broken = gids.filter(
      (g) =>
        new Set([...groups[g]].map((id) => s.rows[id]?.got).filter((v) => v !== undefined)).size >
        1,
    );
    console.log(
      `  variant consistency: ${gids.length - broken.length}/${gids.length} groups${broken.length ? ` — broken: [${broken.join(', ')}]` : ''}`,
    );
  }

  const baseline: { critique?: Summary } = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : {};
  const { regressed, lines } = compare(s, baseline.critique);
  if (existsSync(baselinePath)) for (const l of lines) console.log(l);

  appendLedger({
    ts: new Date().toISOString(),
    args: [...args],
    runs: RUNS,
    agentHash: s.agentHash,
    runnerHash: s.runnerHash,
    corpusHash: s.corpusHash,
    rowsOk: results.filter((r) => r.ok).length,
    rowsTotal: results.length,
    outages: s.outages,
    regressed,
  });

  if (writeBaseline) {
    if (s.outages > 0)
      throw new BenchAbort(
        2,
        `critique-eval: refusing to write a baseline with ${s.outages} outage(s)`,
      );
    writeFileSync(baselinePath, `${JSON.stringify({ critique: s }, null, 2)}\n`);
    console.log(`\nwrote baseline → ${path.relative(process.cwd(), baselinePath)}`);
  }
  if (failOnRegression && regressed) {
    console.error(
      '\nFAIL: floor breach or statistically significant one-directional stable flips vs baseline.',
    );
    process.exit(1);
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    if (e instanceof BenchAbort) {
      console.error(e.message);
      process.exit(e.code as number);
    }
    throw e;
  });
}
