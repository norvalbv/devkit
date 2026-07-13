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
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { readCases } from './counts.mts';
import { anchorFilesOf, matchFindings, overlapCount } from './lib/match.mts';
import { CATEGORIES, sha8 } from './lib/schema.mts';
import {
  bcaCI,
  betaSamplerGrid,
  clopperPearson,
  mcnemarMidP,
  mean,
  mulberry32,
  percentileCI,
  sd,
  wilcoxonSignedRank,
} from './lib/stats.mts';
import {
  ARMS,
  buildJudgeInput,
  CEILING_PROMPT,
  FOOTER,
  PROMPT_SHAS,
  systemAppend,
  WRAPPERS,
} from './prompts.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const benchDir = path.join(here, 'raw', 'bench');
const guardsPath = path.join(here, 'guards-synthetic.jsonl');
const baselinePath = path.join(here, 'results.baseline.json');
const ceilingPath = path.join(benchDir, 'ceiling.json');
const epsilonPath = path.join(here, 'raw', 'noise-audit-epsilon.json');

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
const TIMEOUT = 240000;
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
const readJsonl = (file) =>
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

const readTranscript = (configId, rowId, k) => {
  const p = transcriptPath(configId, rowId, k);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

const writeTranscript = (configId, rowId, k, data) => {
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
  data ??= { findings: null, parseFailed: true, judgeUnavailable: true };
  writeTranscript(config.id, row.id, k, data);
  return data;
};

const runPool = async (cells, worker) => {
  let i = 0;
  const next = async () => {
    while (i < cells.length) {
      const mine = cells[i++];
      await worker(mine);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
};

const runConfig = async (config, rows, withSummary) => {
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
if (isMain) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  const rows = loadBenchRows();
  if (!rows) {
    console.error('bench: no corpus (set EDGE_CASES_CORPUS or place eval/cases.jsonl)');
    process.exit(2);
  }
  if (rows.guards.length < GUARD_MIN_N)
    console.error(
      `bench: guard N=${rows.guards.length} < ${GUARD_MIN_N} — guard gate DESCRIPTIVE-only (regenerate guards-synthetic.jsonl)`,
    );

  if (has('--ceiling')) {
    // re-extraction ceiling: the model reads each bearing row's GOLD RESPONSE (from the local
    // harvest store — this measures matcher+segmentation+phrasing, judge skill is not involved)
    const candidates = readJsonl(path.join(here, 'raw', 'candidates.jsonl'));
    const respById = new Map(candidates.map((c) => [c.id, c.responseText]));
    const cells = [];
    for (const row of rows.bearing) {
      if (!respById.get(row.id)) {
        console.error(`ceiling: no responseText for ${row.id} — excluded (report this)`);
        continue;
      }
      for (let k = 0; k < K; k++) cells.push({ row, k });
    }
    await runPool(cells, async ({ row, k }) => {
      const existing = readTranscript('ceiling', row.id, k);
      if (existing) return;
      const raw = await execJudgeAsync({
        label: `edge-ceiling:${row.id}.k${k}`,
        args: [
          '-p',
          '--model',
          CEILING_MODEL,
          ...JUDGE_READ_ONLY,
          ...JUDGE_ISOLATION,
          CEILING_PROMPT,
        ],
        input: `=== REVIEW RESPONSE ===\n${String(respById.get(row.id)).slice(0, 30000)}`,
        timeout: TIMEOUT,
        cwd: here,
      });
      let data = { findings: null, parseFailed: true, raw };
      try {
        data = { findings: parseFindings(raw ?? ''), parseFailed: false };
      } catch {
        // recorded as parseFailed
      }
      writeTranscript('ceiling', row.id, k, data);
    });
    const perCase = [];
    for (const row of rows.bearing) {
      const recalls = [];
      for (let k = 0; k < K; k++) {
        const t = readTranscript('ceiling', row.id, k);
        if (!t) continue;
        recalls.push(scoreRunOnBearingRow(t.parseFailed ? [] : t.findings, row).recall);
      }
      if (recalls.length) perCase.push({ id: row.id, recall: mean(recalls) });
    }
    const C = mean(perCase.map((p) => p.recall));
    const sorted = perCase.map((p) => p.recall).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const ceilingLimited = C < C_MIN;
    const T = ceilingLimited ? null : Math.max(0.6 * C, T_FLOOR);
    mkdirSync(benchDir, { recursive: true });
    writeFileSync(
      ceilingPath,
      `${JSON.stringify({ C, median, T, ceilingLimited, model: CEILING_MODEL, K, perCase }, null, 2)}\n`,
    );
    console.log(
      `ceiling: C=${C.toFixed(3)} (median ${median.toFixed(3)}) → ${
        ceilingLimited
          ? `MATCHER-LIMITED (C < ${C_MIN}) — no numeric ship target`
          : `T=${T.toFixed(3)}`
      }`,
    );
    process.exit(0);
  }

  const ceiling = existsSync(ceilingPath) ? JSON.parse(readFileSync(ceilingPath, 'utf8')) : null;

  if (has('--config') || has('--all')) {
    const targets = has('--all') ? CONFIGS : CONFIGS.filter((c) => c.id === val('--config'));
    if (!targets.length) {
      console.error(`bench: unknown config ${val('--config')}`);
      process.exit(2);
    }
    for (const config of targets) await runConfig(config, rows, has('--summary'));
    process.exit(0);
  }

  // scoring/analysis modes below never call the LLM
  const scores = new Map();
  for (const config of CONFIGS) {
    const s = scoreConfig(config, rows);
    if (s.perRow.size) scores.set(config.id, s);
  }
  if (!scores.size) {
    console.error('bench: no transcripts yet — run --config/--all first');
    process.exit(2);
  }

  const epsilon = existsSync(epsilonPath) ? JSON.parse(readFileSync(epsilonPath, 'utf8')) : null;
  const T = ceiling?.ceilingLimited ? null : (ceiling?.T ?? null);

  // enrich with CI + gates
  for (const s of scores.values()) {
    const reps = nestedBootstrap(s, null, epsilon?.diffDecision ?? null);
    const ci = percentileCI(reps);
    s.ciLower = ci.lower;
    s.ciUpper = ci.upper;
    Object.assign(s, evaluateGates(s, T, ceiling?.ceilingLimited ?? false));
  }

  const table = [...scores.entries()].map(([id, s]) => ({
    id,
    macro: s.macroRecall?.toFixed(3),
    f1: s.meanF1?.toFixed(3),
    precLB: s.precisionLowerBound?.toFixed(2),
    ci: `[${s.ciLower?.toFixed(2)},${s.ciUpper?.toFixed(2)}]`,
    receipts: `${s.receiptsHit}/7`,
    guards: `${s.guardsFiredCount}/${s.guardN}`,
    item3: s.item3Share?.toFixed(2),
    stabJ: s.stabilityJaccard?.toFixed(2),
    pushback: s.parseFailureRate?.toFixed(2),
    flags: [
      s.guardDisqualified && 'GUARD-DQ',
      s.softFlag && 'SOFT-RECEIPTS',
      s.clearsTarget && 'CLEARS',
    ]
      .filter(Boolean)
      .join(','),
  }));
  console.table(table);
  if (!epsilon)
    console.log('bench: NOTE — no ε posterior yet (noise audit pending); CIs are sampling-only');
  if (T != null) console.log(`target T=${T.toFixed(3)} (C=${ceiling.C.toFixed(3)})`);

  if (has('--analyze')) {
    // paired vs best (by macro recall among non-disqualified)
    const eligible = [...scores.entries()].filter(([, s]) => !s.guardDisqualified);
    const best = eligible.sort((a, b) => b[1].macroRecall - a[1].macroRecall)[0];
    const analysis = { best: best[0], T, comparisons: {}, hashes: comparabilityHashes() };
    for (const [id, s] of scores) {
      if (id === best[0]) continue;
      const bs = best[1];
      const commonIds = [...s.perRow.keys()].filter((k) => bs.perRow.has(k));
      const dPerCase = commonIds.map(
        (k) =>
          mean(bs.perRow.get(k).map((r) => r.recall)) - mean(s.perRow.get(k).map((r) => r.recall)),
      );
      const reps = nestedBootstrap(bs, s, epsilon?.diffDecision ?? null);
      const jack = dPerCase.map((_, i) => mean(dPerCase.filter((_, j) => j !== i)));
      const binB = commonIds.filter(
        (k) =>
          bs.perRow.get(k).filter((r) => r.recalledIdx.size > 0).length * 2 >
            bs.perRow.get(k).length &&
          !(
            s.perRow.get(k).filter((r) => r.recalledIdx.size > 0).length * 2 >
            s.perRow.get(k).length
          ),
      ).length;
      const binC = commonIds.filter(
        (k) =>
          !(
            bs.perRow.get(k).filter((r) => r.recalledIdx.size > 0).length * 2 >
            bs.perRow.get(k).length
          ) &&
          s.perRow.get(k).filter((r) => r.recalledIdx.size > 0).length * 2 > s.perRow.get(k).length,
      ).length;
      analysis.comparisons[id] = {
        deltaMean: mean(dPerCase),
        nestedCI: percentileCI(reps),
        samplingBCa: bcaCI(reps, mean(dPerCase), jack),
        wilcoxon: wilcoxonSignedRank(dPerCase),
        mcnemar: mcnemarMidP(binB, binC),
        nonTiedCases: dPerCase.filter((d) => d !== 0).length,
      };
    }
    // winner = cheapest clearing config (CONFIGS is in pre-registered cost order)
    const winner = CONFIGS.find((c) => scores.get(c.id)?.clearsTarget)?.id ?? null;
    analysis.winner = winner;
    analysis.noConfigShips = winner == null;

    // disagreement-triaged audit queue
    const queue = { goldUnmatchedByAll: [], judgeConsensusExtras: [] };
    for (const row of rows.bearing) {
      for (const f of row.findings) {
        if (!row.anchoredWSIdx.has(f.idx)) continue;
        const everRecalled = [...scores.values()].some((s) =>
          (s.perRow.get(row.id) ?? []).some((r) => r.recalledIdx.has(f.idx)),
        );
        if (!everRecalled) queue.goldUnmatchedByAll.push(`${row.id}#${f.idx}`);
      }
    }
    // judge extras matched across ≥2 configs (candidate gold omissions)
    for (const row of rows.bearing) {
      const fpByConfig = [...scores.keys()].map((id) => {
        const t = readTranscript(id, row.id, 0);
        if (!t || t.parseFailed) return [];
        const m = matchFindings(t.findings, row.findings);
        return m.unmatchedJudge;
      });
      for (let a = 0; a < fpByConfig.length; a++)
        for (const fpA of fpByConfig[a]) {
          let seenIn = 1;
          for (let b = a + 1; b < fpByConfig.length; b++)
            if (matchFindings([fpA], fpByConfig[b]).pairs.length) seenIn++;
          if (seenIn >= 2)
            queue.judgeConsensusExtras.push({
              row: row.id,
              category: fpA.category,
              files: fpA.files,
              configs: seenIn,
            });
        }
    }
    mkdirSync(benchDir, { recursive: true });
    writeFileSync(path.join(benchDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    const dedupedExtras = queue.judgeConsensusExtras.slice(0, 60);
    writeFileSync(
      path.join(benchDir, 'audit-queue.json'),
      `${JSON.stringify({ ...queue, judgeConsensusExtras: dedupedExtras }, null, 2)}\n`,
    );
    console.log(
      `analyze: best=${analysis.best} winner=${winner ?? 'NO CONFIG SHIPS'} · queue: ${queue.goldUnmatchedByAll.length} gold-unmatched, ${dedupedExtras.length} consensus extras → raw/bench/audit-queue.json`,
    );
  }

  if (has('--baseline')) {
    const analysis = JSON.parse(readFileSync(path.join(benchDir, 'analysis.json'), 'utf8'));
    const winnerId = analysis.winner ?? analysis.best;
    const s = scores.get(winnerId);
    // privacy: IDs + numbers ONLY (enforced by __tests__/results-privacy.test.mts)
    const baseline = {
      story: 'sc-1119',
      winner: analysis.winner,
      best: analysis.best,
      noConfigShips: analysis.noConfigShips,
      T,
      C: ceiling?.C ?? null,
      ceilingLimited: ceiling?.ceilingLimited ?? false,
      hashes: comparabilityHashes(),
      epsilon,
      metrics: Object.fromEntries(
        [...scores.entries()].map(([id, sc]) => [
          id,
          {
            macroRecall: sc.macroRecall,
            meanF1: sc.meanF1,
            precisionLowerBound: sc.precisionLowerBound,
            ciLower: sc.ciLower,
            ciUpper: sc.ciUpper,
            receiptsHit: sc.receiptsHit,
            guardFireRate: sc.guardFireRate,
            guardN: sc.guardN,
            item3Share: sc.item3Share,
            stabilityJaccard: sc.stabilityJaccard,
            stabilityCountSD: sc.stabilityCountSD,
            parseFailureRate: sc.parseFailureRate,
            clearsTarget: sc.clearsTarget ?? false,
          },
        ]),
      ),
      winnerPerCaseBinary: Object.fromEntries(
        [...(s?.perRow ?? new Map()).entries()].map(([id, runs]) => [
          id,
          runs.filter((r) => r.recalledIdx.size > 0).length * 2 > runs.length ? 1 : 0,
        ]),
      ),
      winnerGuardFired: Object.fromEntries([...(s?.guardFired ?? new Map()).entries()]),
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      `baseline: wrote ${path.relative(process.cwd(), baselinePath)} (winner ${winnerId})`,
    );
  }

  if (has('--fail')) {
    if (!existsSync(baselinePath)) {
      console.error('bench --fail: no baseline');
      process.exit(2);
    }
    const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const now = comparabilityHashes();
    const mismatches = ['corpusHash', 'guardsHash', 'matcherHash', 'benchCodeHash'].filter(
      (k) => base.hashes[k] !== now[k],
    );
    if (mismatches.length) {
      console.error(
        `bench --fail: SKIP — comparability hash mismatch (${mismatches.join(', ')}); regenerate the baseline deliberately`,
      );
      process.exit(2);
    }
    const target = base.winner ?? base.best;
    const s = scores.get(target);
    if (!s) {
      console.error(`bench --fail: no transcripts for ${target}`);
      process.exit(2);
    }
    // house flip-table gate: per-case binary flips vs baseline, mid-p McNemar, worse-direction only
    let b = 0;
    let c = 0;
    for (const [id, wasHit] of Object.entries(base.winnerPerCaseBinary)) {
      const runs = s.perRow.get(id);
      if (!runs) continue;
      const isHit = runs.filter((r) => r.recalledIdx.size > 0).length * 2 > runs.length ? 1 : 0;
      if (wasHit && !isHit) b++;
      if (!wasHit && isHit) c++;
    }
    let gb = 0;
    let gc = 0;
    for (const [id, wasFired] of Object.entries(base.winnerGuardFired)) {
      const isFired = s.guardFired.get(id);
      if (isFired == null) continue;
      if (!wasFired && isFired) gb++;
      if (wasFired && !isFired) gc++;
    }
    const recallTest = mcnemarMidP(b, c);
    const guardTest = mcnemarMidP(gb, gc);
    const recallRegressed = b > c && recallTest.midP < 0.05;
    const guardRegressed = gb > gc && guardTest.midP < 0.05;
    console.log(
      `--fail: recall flips lost=${b} gained=${c} (mid-p ${recallTest.midP.toFixed(3)}) · guard flips new=${gb} cleared=${gc} (mid-p ${guardTest.midP.toFixed(3)})`,
    );
    if (recallRegressed || guardRegressed) {
      console.error('FAIL: regression vs baseline (flip-table)');
      process.exit(1);
    }
  }
  process.exit(0);
}
