#!/usr/bin/env bun

/**
 * sc-1119 edge-cases judge benchmark. PREREGISTRATION.md is the rule book — every denominator,
 * gate, margin and seed used here is pinned there BEFORE the first judged run; this file only
 * executes those rules. Corpus: cases.jsonl (EDGE_CASES_CORPUS env or the local gitignored copy);
 * synthetic precision guards: guards-synthetic.jsonl (guards-generate.mts).
 *
 *   bun bench.mts --ceiling            re-extraction ceiling (19 bearing rows × K) → raw/bench/ceiling.json
 *   bun bench.mts --config <id>        run one config's judge calls (resume-safe transcripts)
 *   bun bench.mts --config <id> --summary   also judge the summary tier for this config
 *   bun bench.mts --all                run every pre-registered config in cost order
 *   bun bench.mts --score              score transcripts, print the per-config table (no LLM)
 *   bun bench.mts --analyze            paired analysis vs best + bootstrap + audit queue (no LLM)
 *   bun bench.mts --baseline           write results.baseline.json (winner, numbers + IDs only)
 *   bun bench.mts --fail               regression gate vs baseline (hash mismatch → exit 2 SKIP)
 *
 * Exit codes: 0 ok · 1 regression (--fail) · 2 cannot run / hash-mismatch SKIP.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import { isolateBenchTelemetry } from '../../judge/run-context.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { readCases } from './counts.mts';
import { anchorFilesOf, matchFindings, overlapCount } from './lib/match.mts';
import { CATEGORIES, sha8 } from './lib/schema.mts';
import { betaSamplerGrid, clopperPearson, mean, mulberry32, sd } from './lib/stats.mts';
import { ARMS, buildJudgeInput, FOOTER, PROMPT_SHAS, systemAppend, WRAPPERS } from './prompts.mts';

isolateBenchTelemetry();
export const here = path.dirname(fileURLToPath(import.meta.url));
export const benchDir = path.join(here, 'raw', 'bench');
export const guardsPath = path.join(here, 'guards-synthetic.jsonl');
export const baselinePath = path.join(here, 'results.baseline.json');
export const ceilingPath = path.join(benchDir, 'ceiling.json');
export const epsilonPath = path.join(here, 'raw', 'noise-audit-epsilon.json');

// ── pre-registered constants (mirrored in PREREGISTRATION.md) ────────────────────────────────────
export const K = 3; // runs per (config, diff-set row); summary tier K=1
export const SEED = 1119;
export const B = 2000; // bootstrap replicates
export const GUARD_FIRE_MAX = 0.2; // hard gate: majority-fired guard rows must be ≤ 20% of N
export const GUARD_MIN_N = 15; // below this the guard gate is descriptive-only
export const RECEIPTS_MIN = 4; // soft gate: of the 7 anchored liveBug receipts
export const T_FLOOR = 0.35; // T = max(0.6 × C, T_FLOOR); C < C_MIN → matcher-limited
export const C_MIN = 0.45;
export const CEILING_MODEL = 'sonnet';
export const TIMEOUT = 240000;
const CONCURRENCY = 4;

/** The EXACT pre-registered grid, in pre-registered COST order (cheapest first: model tier ≫
 * prompt length; channel/realization are cost-neutral and keep enumeration order). */
export const CONFIGS = [
  { id: 'hai-FS-U-r1', model: 'haiku', arm: 'FS', channel: 'U', r: 0 },
  { id: 'hai-FS-Guser-r1', model: 'haiku', arm: 'FS', channel: 'G-user', r: 0 },
  { id: 'hai-FS-Gsys-r1', model: 'haiku', arm: 'FS', channel: 'G-sys', r: 0 },
  { id: 'son-FS-Guser-r1', model: 'sonnet', arm: 'FS', channel: 'G-user', r: 0 },
  { id: 'son-FS-Guser-r2', model: 'sonnet', arm: 'FS', channel: 'G-user', r: 1 },
  { id: 'son-FS-U-r1', model: 'sonnet', arm: 'FS', channel: 'U', r: 0 },
  { id: 'son-FS-U-r2', model: 'sonnet', arm: 'FS', channel: 'U', r: 1 },
  { id: 'son-FS-Gsys-r1', model: 'sonnet', arm: 'FS', channel: 'G-sys', r: 0 },
  { id: 'son-FS-Gsys-r2', model: 'sonnet', arm: 'FS', channel: 'G-sys', r: 1 },
  { id: 'son-PS-Guser-r1', model: 'sonnet', arm: 'PS', channel: 'G-user', r: 0 },
  { id: 'son-FL-Guser-r1', model: 'sonnet', arm: 'FL', channel: 'G-user', r: 0 },
  { id: 'son-PL-Guser-r1', model: 'sonnet', arm: 'PL', channel: 'G-user', r: 0 },
];
export const SUMMARY_REFERENCE = 'son-FS-Guser-r1';

// ── row loading ──────────────────────────────────────────────────────────────────────────────────
export const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Annotate a bearing row with the pre-registered index sets the scorer needs. */
export const annotateBearingRow = (row) => {
  const anchorFiles = anchorFilesOf(row.anchor.nameStatus);
  const anchoredWSIdx = new Set();
  const anchoredNoiseIdx = new Set();
  const receiptsIdx = new Set();
  for (const f of row.findings) {
    const anchored = overlapCount(f.files, anchorFiles) > 0;
    if (!anchored) continue;
    if (f.verdict === 'noise') anchoredNoiseIdx.add(f.idx);
    else anchoredWSIdx.add(f.idx);
    if (String(f.wasLiveBug) === 'true') receiptsIdx.add(f.idx);
  }
  return { ...row, anchoredWSIdx, anchoredNoiseIdx, receiptsIdx };
};

export const loadBenchRows = () => {
  const cases = readCases();
  if (!cases.length) return null;
  const judged = cases.filter((c) => !(c.degenerate && c.degenerateReason === 'no-response'));
  const diff = judged.filter((c) => c.anchor.kind === 'diff');
  const synth = readJsonl(guardsPath);
  return {
    bearing: diff.filter((c) => c.findings.length > 0).map(annotateBearingRow),
    guards: [...diff.filter((c) => c.degenerate), ...synth],
    summaryBearing: judged.filter(
      (c) => c.anchor.kind === 'session-summary' && c.findings.length > 0,
    ),
    summaryGuards: judged.filter((c) => c.anchor.kind === 'session-summary' && c.degenerate),
  };
};

// ── judge output parsing (pre-registered coercions) ─────────────────────────────────────────────
const FENCE_OPEN_RE = /^```(?:json)?\s*/i;
const FENCE_CLOSE_RE = /```\s*$/;
export const parseFindings = (raw) => {
  const stripped = raw.trim().replace(FENCE_OPEN_RE, '').replace(FENCE_CLOSE_RE, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in reply');
  const obj = JSON.parse(stripped.slice(start, end + 1));
  if (!Array.isArray(obj.findings)) throw new Error('no findings array');
  return obj.findings.map((f) => ({
    claim: String(f.claim ?? ''),
    files: Array.isArray(f.files) ? f.files.filter((p) => typeof p === 'string') : [],
    category: CATEGORIES.includes(f.category) ? f.category : 'other',
    severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'unstated',
  }));
};

// ── scoring (pre-registered; see PREREGISTRATION.md "Scoring") ───────────────────────────────────
/** Score ONE judge run against ONE bearing row. */
export const scoreRunOnBearingRow = (judgeFindings, row) => {
  const m = matchFindings(judgeFindings, row.findings);
  const matchedGold = [...m.pairs.map((p) => p.g), ...m.item3Credits.map((c) => c.g)];
  const recalledIdx = new Set(
    matchedGold.filter((g) => row.anchoredWSIdx.has(g.idx)).map((g) => g.idx),
  );
  // precision is judged against the WHOLE row's gold; a match to a noise-verdict gold is an FP
  // (the judge reproduced a claim the labeler verified wrong), never recall credit
  const tp = m.pairs.filter((p) => p.g.verdict !== 'noise').length;
  const fp = m.unmatchedJudge.length + m.pairs.filter((p) => p.g.verdict === 'noise').length;
  return {
    recalledIdx,
    // matched anchored-noise golds: needed by the label-perturbation bootstrap (a noise→WS flip
    // enters the denominator, and counts recalled iff the judge had matched it)
    noiseMatchedIdx: new Set(
      matchedGold.filter((g) => row.anchoredNoiseIdx.has(g.idx)).map((g) => g.idx),
    ),
    recall: row.anchoredWSIdx.size ? recalledIdx.size / row.anchoredWSIdx.size : Number.NaN,
    tp,
    fp,
    judgeTotal: judgeFindings.length,
    item3Count: m.item3Credits.filter((c) => row.anchoredWSIdx.has(c.g.idx)).length,
    receiptsRecalled: new Set([...recalledIdx].filter((i) => row.receiptsIdx.has(i))),
  };
};

const jaccardSets = (a, b) => {
  if (!a.size && !b.size) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / (a.size + b.size - inter);
};

/** Aggregate one config's per-(row,k) run scores into the pre-registered metrics. */
export const aggregateConfig = (perRow, guardFired, parseFailures, totalCells) => {
  const rows = [...perRow.values()];
  const perCaseRecall = rows.map((runs) => mean(runs.map((r) => r.recall)));
  const macroRecall = mean(perCaseRecall);
  const anchoredTotal = rows.reduce((s, runs) => s + (runs.anchoredWSSize ?? 0), 0);
  const microRecall = anchoredTotal
    ? rows.reduce((s, runs) => s + mean(runs.map((r) => r.recalledIdx.size)), 0) / anchoredTotal
    : Number.NaN;
  const perCaseF1 = rows.map((runs) =>
    mean(
      runs.map((r) => {
        const precision = r.judgeTotal ? r.tp / r.judgeTotal : 0;
        return precision + r.recall ? (2 * precision * r.recall) / (precision + r.recall) : 0;
      }),
    ),
  );
  const fpRate = mean(rows.map((runs) => mean(runs.map((r) => r.fp))));
  const precisionLB = mean(
    rows.map((runs) => mean(runs.map((r) => (r.judgeTotal ? r.tp / r.judgeTotal : 1)))),
  );
  // receipts: a receipt counts when recalled in a MAJORITY of its row's K runs
  let receiptsHit = 0;
  for (const runs of rows)
    for (const idx of runs.receiptsIdxAll ?? [])
      if (runs.filter((r) => r.receiptsRecalled.has(idx)).length * 2 > runs.length) receiptsHit++;
  const item3Share =
    rows.reduce((s, runs) => s + mean(runs.map((r) => r.item3Count)), 0) /
    Math.max(
      1e-9,
      rows.reduce((s, runs) => s + mean(runs.map((r) => r.recalledIdx.size)), 0),
    );
  // stability
  const stabilityCountSD = mean(rows.map((runs) => sd(runs.map((r) => r.judgeTotal))));
  const stabilityJaccard = mean(
    rows.flatMap((runs) => {
      const js = [];
      for (let i = 0; i < runs.length; i++)
        for (let j = i + 1; j < runs.length; j++)
          js.push(jaccardSets(runs[i].recalledIdx, runs[j].recalledIdx));
      return js.length ? [mean(js)] : [];
    }),
  );
  const guardsFiredCount = [...guardFired.values()].filter(Boolean).length;
  const guardCI = guardFired.size ? clopperPearson(guardsFiredCount, guardFired.size) : null;
  return {
    guardCI,
    macroRecall,
    perCaseRecall,
    perCaseF1,
    meanF1: mean(perCaseF1),
    fpPerBearingRow: fpRate,
    precisionLowerBound: precisionLB,
    receiptsHit,
    item3Share,
    stabilityCountSD,
    stabilityJaccard,
    guardsFiredCount,
    guardN: guardFired.size,
    guardFireRate: guardFired.size ? guardsFiredCount / guardFired.size : Number.NaN,
    parseFailureRate: totalCells ? parseFailures / totalCells : 0,
    anchoredTotal,
    microRecall,
  };
};

// ── transcripts ──────────────────────────────────────────────────────────────────────────────────
const transcriptPath = (configId, rowId, k) => path.join(benchDir, configId, `${rowId}.k${k}.json`);

export const readTranscript = (configId, rowId, k) => {
  const p = transcriptPath(configId, rowId, k);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

export const writeTranscript = (configId, rowId, k, data) => {
  mkdirSync(path.dirname(transcriptPath(configId, rowId, k)), { recursive: true });
  writeFileSync(transcriptPath(configId, rowId, k), JSON.stringify(data));
};

// ── judge invocation ─────────────────────────────────────────────────────────────────────────────
const judgeCell = async (config, row, k) => {
  const existing = readTranscript(config.id, row.id, k);
  if (existing) return existing; // idempotent resume — parseFailed cells are data, not retries
  const framing = config.channel === 'G-sys' ? null : WRAPPERS[config.channel][config.r];
  const prompt = [framing, `${ARMS[config.arm]}${FOOTER}`].filter(Boolean).join('\n\n');
  const sys = systemAppend(config.channel, config.r);
  const args = [
    '-p',
    '--model',
    config.model,
    ...(sys ? ['--append-system-prompt', sys] : []),
    ...JUDGE_READ_ONLY,
    ...JUDGE_ISOLATION,
    prompt,
  ];
  const input = `=== CHANGE ===\n${buildJudgeInput(row)}`;
  // pre-registered: at most TWO exec attempts total — an outage retries once, an unparseable
  // reply re-asks once; a still-failing cell is recorded as parseFailed (a pushback/
  // non-compliance datum for the provenance experiment, never silently retried further)
  let data = null;
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    const raw = await execJudgeAsync({
      label: `edge-bench:${config.id}:${row.id}.k${k}`,
      args,
      input,
      timeout: TIMEOUT,
      cwd: here,
    });
    if (raw === null) continue;
    try {
      data = { findings: parseFindings(raw), parseFailed: false, raw };
    } catch {
      data = attempt === 0 ? null : { findings: null, parseFailed: true, raw };
    }
  }
  // A judge OUTAGE (quota/offline — execJudgeAsync returned null twice) is NOT data: persisting
  // it would make the resume path skip the cell forever and score it as a zero-finding run
  // (the 2026-07-13 usage-limit window wrote 1,267 such cells before this guard). Only real
  // replies — parseable or not — are transcripts; an outage cell stays absent and the next
  // `--all` run retries it.
  if (!data) return { findings: null, parseFailed: true, judgeUnavailable: true };
  writeTranscript(config.id, row.id, k, data);
  return data;
};

export const runPool = async (cells, worker) => {
  let i = 0;
  const next = async () => {
    while (i < cells.length) {
      const mine = cells[i++];
      await worker(mine);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
};

export const runConfig = async (config, rows, withSummary) => {
  const cells = [];
  for (const row of [...rows.bearing, ...rows.guards])
    for (let k = 0; k < K; k++) cells.push({ row, k });
  if (withSummary)
    for (const row of [...rows.summaryBearing, ...rows.summaryGuards])
      cells.push({ row, k: 0, summary: true });
  let done = 0;
  await runPool(cells, async (cell) => {
    await judgeCell(config, cell.row, cell.summary ? 's0' : cell.k);
    done++;
    if (done % 20 === 0) console.log(`  ${config.id}: ${done}/${cells.length}`);
  });
  console.log(`${config.id}: ${cells.length} cells complete`);
};

// ── config scoring from transcripts ──────────────────────────────────────────────────────────────
export const scoreConfig = (config, rows) => {
  const perRow = new Map();
  let parseFailures = 0;
  let totalCells = 0;
  let missing = 0;
  for (const row of rows.bearing) {
    const runs = [];
    for (let k = 0; k < K; k++) {
      const t = readTranscript(config.id, row.id, k);
      totalCells++;
      if (!t) {
        missing++;
        continue;
      }
      if (t.parseFailed) {
        parseFailures++;
        runs.push({ ...scoreRunOnBearingRow([], row), parseFailed: true });
        continue;
      }
      runs.push(scoreRunOnBearingRow(t.findings, row));
    }
    if (runs.length) {
      runs.anchoredWSSize = row.anchoredWSIdx.size;
      runs.anchoredWSList = [...row.anchoredWSIdx];
      runs.anchoredNoiseList = [...row.anchoredNoiseIdx];
      runs.receiptsIdxAll = [...row.receiptsIdx].filter((i) => row.anchoredWSIdx.has(i));
      perRow.set(row.id, runs);
    }
  }
  const guardFired = new Map();
  for (const row of rows.guards) {
    const fired = [];
    for (let k = 0; k < K; k++) {
      const t = readTranscript(config.id, row.id, k);
      totalCells++;
      if (!t) {
        missing++;
        continue;
      }
      if (t.parseFailed) {
        parseFailures++;
        fired.push(false); // an unparseable reply surfaces in parseFailureRate, not as a firing
        continue;
      }
      fired.push(t.findings.length > 0);
    }
    if (fired.length) guardFired.set(row.id, fired.filter(Boolean).length * 2 > fired.length);
  }
  const agg = aggregateConfig(perRow, guardFired, parseFailures, totalCells);
  return { ...agg, perRow, guardFired, missing };
};

// ── the pre-registered decision rule ─────────────────────────────────────────────────────────────
export const evaluateGates = (score, T, ceilingLimited) => {
  const guardGateActive = score.guardN >= GUARD_MIN_N;
  const guardDisqualified = guardGateActive && score.guardFireRate > GUARD_FIRE_MAX;
  const softFlag = score.receiptsHit < RECEIPTS_MIN;
  const clearsTarget =
    !ceilingLimited &&
    T != null &&
    score.macroRecall >= T &&
    !guardDisqualified &&
    !softFlag &&
    (score.ciLower == null || score.ciLower >= T - 0.15);
  return { guardGateActive, guardDisqualified, softFlag, clearsTarget };
};

// ── nested label-perturbation bootstrap ──────────────────────────────────────────────────────────
/**
 * Per replicate: resample the 19 bearing cases; per case pick ONE of its K runs (run-to-run
 * variance term); flip each anchored-WS gold OUT of the denominator w.p. ε and each anchored-noise
 * gold IN w.p. ε (label-noise term — flips perturb the GOLD inside the resample, never a scalar
 * added to a CI); recompute macro recall (or the paired Δ vs `scoreB`). ε drawn once per replicate
 * from the diff-decision-stratum Beta posterior via the inverse-CDF grid (deterministic under the
 * pre-registered seed). Flip decisions are shared between the two configs within a replicate —
 * label noise is a property of the GOLD, so a paired Δ must apply identical flips to both sides.
 */
export const nestedBootstrap = (scoreA, scoreB, epsilon, opts = {}) => {
  const seed = opts.seed ?? SEED;
  const reps = opts.B ?? B;
  const rng = mulberry32(seed);
  const sampler = epsilon ? betaSamplerGrid(epsilon.alpha, epsilon.beta) : null;
  const ids = [...scoreA.perRow.keys()];
  const out = [];
  for (let b = 0; b < reps; b++) {
    const eps = sampler ? sampler(rng()) : 0;
    const caseVals = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[Math.floor(rng() * ids.length)];
      const runsA = scoreA.perRow.get(id);
      const kPick = Math.floor(rng() * runsA.length);
      // one flip decision per gold finding, shared across both configs (gold is one object)
      const dropWS = new Set();
      const addNoise = new Set();
      if (eps > 0) {
        for (const idx of runsA.anchoredWSList) if (rng() < eps) dropWS.add(idx);
        for (const idx of runsA.anchoredNoiseList) if (rng() < eps) addNoise.add(idx);
      }
      const recallOf = (runs) => {
        const r = runs[Math.min(kPick, runs.length - 1)];
        const denom = runs.anchoredWSSize - dropWS.size + addNoise.size;
        let hit = [...r.recalledIdx].filter((idx) => !dropWS.has(idx)).length;
        hit += [...addNoise].filter((idx) => r.noiseMatchedIdx.has(idx)).length;
        return denom > 0 ? hit / denom : 1;
      };
      const a = recallOf(runsA);
      if (scoreB) {
        const runsB = scoreB.perRow.get(id);
        caseVals.push(runsB ? a - recallOf(runsB) : a);
      } else caseVals.push(a);
    }
    out.push(mean(caseVals));
  }
  return out;
};

// ── comparability hashes ─────────────────────────────────────────────────────────────────────────
export const comparabilityHashes = () => {
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return {
    corpusHash: sha8(read(process.env.EDGE_CASES_CORPUS ?? path.join(here, 'cases.jsonl'))),
    guardsHash: sha8(read(guardsPath)),
    matcherHash: sha8(read(path.join(here, 'lib', 'match.mts'))),
    benchCodeHash: sha8(read(path.join(here, 'bench.mts'))),
    promptShas: PROMPT_SHAS,
    K,
    seed: SEED,
    B,
  };
};

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) void import('./bench-cli.mts').then((m) => m.main());
