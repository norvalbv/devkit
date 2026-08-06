#!/usr/bin/env node
// prior-art-eval BENCH — scores the step-0 prior-art agent on hand-authored intrinsic rows.
//
// Seed-tier bench (sc-1518): intrinsic rows only — each row inlines its ENTIRE reachable research
// corpus and pins the leg attestations, so the tier measures recognition + frame courage, never
// retrieval (that is the Phase-3 workflow tier). Metrics, all row-level with Wilson intervals:
//   · verdict accuracy      — majority-of-K verdict ∈ the row's expected set
//   · framing accuracy      — majority frameChallenge.framing ∈ the row's expected set
//   · gold evidence recall  — matcher: the dissolving/solving artifact is actually NAMED
//   · decoy endorsement     — matcher: a within-frame patch endorsed as the way forward (lower)
//   · genuine-control clean — controls not misdeclared SOLVED/DISSOLVE (the anti-"cry solved"
//     floor; UNDERPOWERED at seed size — see README; report, don't over-trust)
//   · response contract     — closed prior_art JSON validity per run
//
// Baselines embed agentHash + runnerHash + corpusHash; any mismatch is a new experiment. Regression
// checks are row-FLIP based (a baseline-passing row now failing), never aggregate deltas — the
// corpus is far too small for delta claims (bench-gates-on-flips-not-deltas).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchAbort, cleanBenchEnv, majorityVerdict, wilson } from '../../decisions/eval/bench.mts';
import { parsePriorArtResponse } from '../response-contract.mts';
import { casesPath, loadRows, type Row } from './cases.mts';
import { mapPool, projectResponse, runMatcher, scoreCase } from './matcher.mts';
import {
  AGENT_MD_PATH,
  type AgentSource,
  buildBenchmarkDirective,
  loadAgent,
  runIntrinsic,
} from './run-agent.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'results.baseline.json');
const runsLogPath = path.join(here, 'runs.log');
const checkpointPath = path.join(here, 'checkpoint.jsonl');

const RUNS = Math.max(1, Number.parseInt(process.env.BENCH_RUNS ?? '1', 10) || 1);
const MATCH_RUNS = Math.max(1, Number.parseInt(process.env.BENCH_MATCH_RUNS ?? '3', 10) || 3);
const AGENT_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.BENCH_AGENT_CONCURRENCY ?? '7', 10) || 7,
);

// ─── Hashes (a changed input is a changed experiment) ─────────────────────────────

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function experimentHashes(agent: AgentSource): {
  agentHash: string;
  runnerHash: string;
  corpusHash: string;
} {
  const runnerFiles = ['bench.mts', 'cases.mts', 'run-agent.mts', 'matcher.mts'].map((name) =>
    readFileSync(path.join(here, name), 'utf8'),
  );
  return {
    agentHash: sha256(agent.raw),
    runnerHash: sha256(runnerFiles.join('\n')),
    corpusHash: sha256(readFileSync(casesPath, 'utf8')),
  };
}

/**
 * Checkpoint-bank key. Banked responses depend only on what shapes the agent CALL — the md, the
 * corpus prompts, the directive-building runner, and the model — never on scoring/orchestration
 * code, so matcher/bench/adapter edits keep the bank while any change to the call inputs drops it.
 */
export function responseFingerprint(agent: AgentSource): string {
  const runAgent = readFileSync(path.join(here, 'run-agent.mts'), 'utf8');
  return [
    sha256(agent.raw),
    sha256(readFileSync(casesPath, 'utf8')),
    sha256(runAgent),
    agent.model,
  ].join(':');
}

// ─── Per-row execution ────────────────────────────────────────────────────────────

interface RowResult {
  id: string;
  verdict: string;
  verdictOk: boolean;
  framing: string;
  framingOk: boolean | null;
  unanimous: boolean;
  valid: { ok: number; total: number };
  gold: { slotId: string; hit: boolean }[];
  decoys: { slotId: string; endorsed: boolean }[];
  genuineClean: boolean | null;
  outages: number;
}

interface RunRecord {
  raw: string | null;
  valid: boolean;
  verdict: string;
  framing: string;
}

function recordRun(raw: string | null): RunRecord {
  if (raw === null) return { raw, valid: false, verdict: 'DARK', framing: 'DARK' };
  const parsed = parsePriorArtResponse(raw);
  if (!parsed.ok || parsed.value.status !== 'reviewed')
    return { raw, valid: false, verdict: 'INVALID', framing: 'INVALID' };
  // The coupling makes verdict and frameChallenge non-null on every `reviewed` response, so the
  // fallbacks are unreachable — they exist so the record's declared types hold without a cast.
  return {
    raw,
    valid: true,
    verdict: parsed.value.verdict ?? 'INVALID',
    framing: parsed.value.frameChallenge?.framing ?? 'INVALID',
  };
}

async function scoreRow(row: Row, runs: RunRecord[], outages: number): Promise<RowResult> {
  const verdictVote = majorityVerdict(runs.map((run) => run.verdict)) as {
    verdict: string;
    unanimous: boolean;
  };
  const framingVote = majorityVerdict(runs.map((run) => run.framing)) as { verdict: string };
  const verdictOk = row.expectVerdict.includes(verdictVote.verdict);
  const framingOk = row.expectFraming.length
    ? row.expectFraming.includes(framingVote.verdict)
    : null;
  // Positive list, not negative: DARK/INVALID/NULL majorities are UNMEASURED, never "clean" —
  // an all-outage control row must not pass the anti-cry-solved floor by default.
  const genuineClean = row.genuineControl
    ? ['GENUINE_NEW_WORK', 'INSUFFICIENT_EVIDENCE'].includes(verdictVote.verdict)
    : null;

  // Matcher: per valid run, slots voted internally (K=MATCH_RUNS); a slot counts across runs by
  // majority so one aberrant run cannot flip it. Zero valid runs = all gold missed, decoys clean.
  const gold: RowResult['gold'] = row.gold.map((slot) => ({ slotId: slot.id, hit: false }));
  const decoys: RowResult['decoys'] = row.decoys.map((slot) => ({
    slotId: slot.id,
    endorsed: false,
  }));
  if (!row.contractOnly && (row.gold.length || row.decoys.length)) {
    const hitCounts = new Map<string, number>();
    const endorseCounts = new Map<string, number>();
    const validRuns = runs.filter((run) => run.valid && run.raw !== null);
    for (const run of validRuns) {
      const items = projectResponse(run.raw as string);
      const outcomes = await runMatcher(row.gold, row.decoys, items, { runs: MATCH_RUNS });
      for (const slot of scoreCase(outcomes).slots) {
        if (slot.kind === 'gold' && slot.got === 'hit')
          hitCounts.set(slot.slotId, (hitCounts.get(slot.slotId) ?? 0) + 1);
        if (slot.kind === 'decoy' && slot.got === 'endorsed')
          endorseCounts.set(slot.slotId, (endorseCounts.get(slot.slotId) ?? 0) + 1);
      }
    }
    const majority = Math.floor(validRuns.length / 2) + 1;
    for (const entry of gold) entry.hit = (hitCounts.get(entry.slotId) ?? 0) >= majority;
    for (const entry of decoys) entry.endorsed = (endorseCounts.get(entry.slotId) ?? 0) >= majority;
  }
  return {
    id: row.id,
    verdict: verdictVote.verdict,
    verdictOk,
    framing: framingVote.verdict,
    framingOk,
    unanimous: verdictVote.unanimous,
    valid: { ok: runs.filter((run) => run.valid).length, total: runs.length },
    gold,
    decoys,
    genuineClean,
    outages,
  };
}

// ─── Aggregation ──────────────────────────────────────────────────────────────────

interface Summary {
  priorArt: {
    model: string;
    runs: number;
    matchRuns: number;
    outages: number;
    /** Rows actually executed vs the loaded corpus — `--only` runs report a partial denominator. */
    corpus: { executed: number; total: number };
    agentHash: string;
    runnerHash: string;
    corpusHash: string;
    verdictAccuracy: { correct: number; total: number };
    framingAccuracy: { correct: number; total: number };
    goldRecall: { hits: number; total: number };
    decoyEndorsements: { endorsed: number; total: number };
    genuineControls: { clean: number; total: number };
    contract: { responseValid: { ok: number; total: number } };
    rows: Record<string, Omit<RowResult, 'id'>>;
  };
}

export function aggregate(
  results: RowResult[],
  agent: AgentSource,
  hashes: ReturnType<typeof experimentHashes>,
  corpusTotal: number,
): Summary {
  const framingRows = results.filter((row) => row.framingOk !== null);
  const genuineRows = results.filter((row) => row.genuineClean !== null);
  // Slots on rows with zero valid runs are UNMEASURED — excluding them keeps gold recall from
  // being punished and the decoy ceiling from being flattered by responses that never parsed
  // (the same fail-safe classification the genuine-control positive list applies).
  const measured = results.filter((row) => row.valid.ok > 0);
  const goldSlots = measured.flatMap((row) => row.gold);
  const decoySlots = measured.flatMap((row) => row.decoys);
  return {
    priorArt: {
      model: agent.model,
      runs: RUNS,
      matchRuns: MATCH_RUNS,
      outages: results.reduce((sum, row) => sum + row.outages, 0),
      // Acceptance reads this: a `--only` subset can otherwise post K=3, zero outages and no slots
      // at all, and be read as a clean full run over a corpus it never touched.
      corpus: { executed: results.length, total: corpusTotal },
      ...hashes,
      verdictAccuracy: {
        correct: results.filter((row) => row.verdictOk).length,
        total: results.length,
      },
      framingAccuracy: {
        correct: framingRows.filter((row) => row.framingOk).length,
        total: framingRows.length,
      },
      goldRecall: {
        hits: goldSlots.filter((slot) => slot.hit).length,
        total: goldSlots.length,
      },
      decoyEndorsements: {
        endorsed: decoySlots.filter((slot) => slot.endorsed).length,
        total: decoySlots.length,
      },
      genuineControls: {
        clean: genuineRows.filter((row) => row.genuineClean).length,
        total: genuineRows.length,
      },
      contract: {
        responseValid: {
          ok: results.reduce((sum, row) => sum + row.valid.ok, 0),
          total: results.reduce((sum, row) => sum + row.valid.total, 0),
        },
      },
      rows: Object.fromEntries(results.map(({ id, ...rest }) => [id, rest])),
    },
  };
}

const line = (label: string, k: number, n: number) => {
  if (n === 0) return `  ${label}: —`;
  const { lo, hi } = wilson(k, n) as { lo: number; hi: number };
  return `  ${label}: ${k}/${n} = ${(k / n).toFixed(2)} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
};

function printSummary(summary: Summary): void {
  const value = summary.priorArt;
  console.log(`\nprior-art-eval — model=${value.model} K=${value.runs} matchK=${value.matchRuns}`);
  console.log(
    line('verdict accuracy   ', value.verdictAccuracy.correct, value.verdictAccuracy.total),
  );
  console.log(
    line('framing accuracy   ', value.framingAccuracy.correct, value.framingAccuracy.total),
  );
  console.log(line('gold recall        ', value.goldRecall.hits, value.goldRecall.total));
  console.log(
    line('decoy endorsement  ', value.decoyEndorsements.endorsed, value.decoyEndorsements.total),
  );
  console.log(
    line('genuine clean rate ', value.genuineControls.clean, value.genuineControls.total),
  );
  console.log(
    line(
      'response contract  ',
      value.contract.responseValid.ok,
      value.contract.responseValid.total,
    ),
  );
  console.log(`  outages: ${value.outages}`);
  for (const [id, row] of Object.entries(value.rows)) {
    const marks = [
      row.verdictOk ? 'V✓' : `V✗(${row.verdict})`,
      row.framingOk === null ? '' : row.framingOk ? 'F✓' : `F✗(${row.framing})`,
      row.gold.length
        ? `gold ${row.gold.filter((slot) => slot.hit).length}/${row.gold.length}`
        : '',
      row.decoys.some((slot) => slot.endorsed) ? 'DECOY-ENDORSED' : '',
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`    ${id}: ${marks}`);
  }
}

// ─── Regression check (row flips, never aggregate deltas) ─────────────────────────

export function regressionFlips(summary: Summary, baselineRaw: string): string[] {
  const baseline = JSON.parse(baselineRaw) as Summary;
  const flips: string[] = [];
  for (const [id, base] of Object.entries(baseline.priorArt.rows)) {
    const now = summary.priorArt.rows[id];
    if (!now) continue;
    if (base.verdictOk && !now.verdictOk) flips.push(`${id}: verdict ok→fail (${now.verdict})`);
    for (const slot of base.gold.filter((entry) => entry.hit))
      if (now.gold.find((entry) => entry.slotId === slot.slotId)?.hit === false)
        flips.push(`${id}: gold ${slot.slotId} hit→miss`);
    for (const slot of base.decoys.filter((entry) => !entry.endorsed))
      if (now.decoys.find((entry) => entry.slotId === slot.slotId)?.endorsed === true)
        flips.push(`${id}: decoy ${slot.slotId} clean→endorsed`);
  }
  return flips;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: node bench.mts <coverage | --dev | --baseline | --fail> [--only <rowId>]\n' +
  '  coverage    lint the corpus and print slot counts (no LLM calls)\n' +
  '  --dev       K=1 scoring run, no baseline write\n' +
  '  --baseline  full run (set BENCH_RUNS=3), writes results.baseline.json\n' +
  '  --fail      full run, exit 1 on any row flip vs the committed baseline';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const mode = argv.find((arg) => ['coverage', '--dev', '--baseline', '--fail'].includes(arg));
  if (!mode) throw new BenchAbort(2, USAGE);

  const corpus = loadRows();
  let rows = corpus;
  if (only) {
    rows = rows.filter((row) => row.id === only);
    if (!rows.length) throw new BenchAbort(2, `prior-art-eval: no row matches --only ${only}`);
  }

  if (mode === 'coverage') {
    const gold = rows.reduce((sum, row) => sum + row.gold.length, 0);
    const decoys = rows.reduce((sum, row) => sum + row.decoys.length, 0);
    const genuine = rows.filter((row) => row.genuineControl).length;
    const contractOnly = rows.filter((row) => row.contractOnly).length;
    console.log(
      `prior-art-eval corpus: ${rows.length} rows · ${gold} gold slots · ${decoys} decoy slots · ` +
        `${genuine} genuine controls · ${contractOnly} contract-only`,
    );
    return;
  }

  cleanBenchEnv();
  try {
    execFileSync('claude', ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    throw new BenchAbort(2, 'prior-art-eval: `claude` CLI not available — cannot benchmark');
  }
  const agent = loadAgent();
  const hashes = experimentHashes(agent);

  // Checkpoint/resume: completed agent calls are banked per (row, runIndex) under the experiment
  // fingerprint, so a K=1 pass can be upgraded to K=3 later paying only the missing runs — and an
  // edited agent/corpus/runner can never silently reuse a stale response
  // (bench-runs-resume-from-checkpoint). Matcher calls are haiku-cheap and are not banked.
  const fingerprint = responseFingerprint(agent);
  const banked = new Map<string, string>();
  if (process.env.BENCH_NO_RESUME !== '1' && existsSync(checkpointPath)) {
    for (const lineText of readFileSync(checkpointPath, 'utf8').split('\n')) {
      if (!lineText.trim()) continue;
      try {
        const entry = JSON.parse(lineText) as {
          fp: string;
          rowId: string;
          run: number;
          raw: string;
        };
        if (entry.fp === fingerprint) banked.set(`${entry.rowId}::${entry.run}`, entry.raw);
      } catch {
        // A torn tail line from a killed run is expected; skip it.
      }
    }
  }
  let reused = 0;

  // One work item per (row, run) so the pool bounds total concurrent opus calls. Records are
  // written at their RUN INDEX, never appended: mapPool completes work items out of order and a
  // resumed pass resolves banked entries first, so append order is not reproducible — and a
  // reproducible bank must score identically on every pass, whatever majorityVerdict does on ties.
  const runsByRow = new Map<string, RunRecord[]>(
    rows.map((row) => [row.id, Array.from({ length: RUNS }, () => recordRun(null))]),
  );
  const outagesByRow = new Map<string, number>(rows.map((row) => [row.id, 0]));
  const work = rows.flatMap((row) => Array.from({ length: RUNS }, (_, run) => ({ row, run })));
  await mapPool(work, AGENT_CONCURRENCY, async ({ row, run }) => {
    const key = `${row.id}::${run}`;
    let raw = banked.get(key) ?? null;
    if (raw !== null) {
      reused += 1;
    } else {
      raw = await runIntrinsic({
        agent,
        prompt: row.prompt,
        fixture: row.legs,
        onOutage: () => outagesByRow.set(row.id, (outagesByRow.get(row.id) ?? 0) + 1),
      });
      if (raw !== null)
        appendFileSync(
          checkpointPath,
          `${JSON.stringify({ fp: fingerprint, rowId: row.id, run, raw })}\n`,
        );
    }
    (runsByRow.get(row.id) as RunRecord[])[run] = recordRun(raw);
  });

  const results: RowResult[] = [];
  for (const row of rows)
    results.push(
      await scoreRow(row, runsByRow.get(row.id) as RunRecord[], outagesByRow.get(row.id) ?? 0),
    );
  const summary = aggregate(results, agent, hashes, corpus.length);
  if (reused > 0) console.log(`\nresumed ${reused}/${work.length} agent calls from checkpoint`);
  printSummary(summary);
  appendFileSync(
    runsLogPath,
    `${JSON.stringify({ at: new Date().toISOString(), mode, ...summary.priorArt })}\n`,
  );

  if (mode === '--baseline') {
    writeFileSync(baselinePath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\nwrote ${path.relative(process.cwd(), baselinePath)}`);
  }
  if (mode === '--fail') {
    if (!existsSync(baselinePath))
      throw new BenchAbort(
        2,
        `prior-art-eval: no baseline at ${path.relative(process.cwd(), baselinePath)} — ` +
          'run `--baseline` first',
      );
    const flips = regressionFlips(summary, readFileSync(baselinePath, 'utf8'));
    if (flips.length) {
      console.error(`\nREGRESSION FLIPS:\n  ${flips.join('\n  ')}`);
      process.exitCode = 1;
    } else console.log('\nno row flips vs baseline');
  }
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  main().catch((error: unknown) => {
    if (error instanceof BenchAbort) {
      console.error(error.message);
      process.exit(error.code as number);
    }
    throw error;
  });

export { AGENT_MD_PATH, buildBenchmarkDirective };
