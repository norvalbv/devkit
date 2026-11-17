import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import {
  baselinePath,
  benchDir,
  C_MIN,
  CEILING_MODEL,
  CONFIGS,
  ceilingPath,
  comparabilityHashes,
  epsilonPath,
  evaluateGates,
  GUARD_MIN_N,
  here,
  K,
  loadBenchRows,
  nestedBootstrap,
  parseFindings,
  readJsonl,
  readTranscript,
  runConfig,
  runPool,
  scoreConfig,
  scoreRunOnBearingRow,
  TIMEOUT,
  writeTranscript,
} from './bench.mts';
import { matchFindings } from './lib/match.mts';
import { bcaCI, mcnemarMidP, mean, percentileCI, wilcoxonSignedRank } from './lib/stats.mts';
import { CEILING_PROMPT } from './prompts.mts';

/** CLI dispatcher for bench.mts (modes documented in its header). Always exits the process. */
export async function main() {
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
