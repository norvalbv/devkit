// @ts-nocheck — BENCH-ONLY; one fixture's native execution, captures and scoring.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveGuardConfig } from '../../../../config.mts';
import { BenchAbort, materializeFixture } from '../../../../decisions/eval/bench.mts';
import { execJudgeAsync } from '../../../../judge/run-judge.mts';
import { mergeLensCaptures } from '../../../lens/split.mts';
import { parseReviewVerdict, selectReviewers } from '../../../reviewers.mts';
import { runCascade } from '../../../run-review.mts';
import { gateJudgeEnv } from '../../../runtime.mts';
import { BENCH_REVIEWERS, buildAssets, rowHashes } from '../corpus.mts';
import { BENCH_CHUNK_LOC, BENCH_LENS_GROUPS, executePlan, planFixture } from './chunk-guard.mts';
import { subcause } from '../stats.mts';
const MODEL = process.env.BENCH_MODEL ?? 'sonnet';
const CASCADE = (process.env.BENCH_CASCADE ?? 'on') !== 'off';

// ─── Spy exec ─────────────────────────────────────────────────────────────────────

/** Snapshot each judge pass before the cascade removes its artifact. */
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

/** A row the cascade never scored (not selected, paused, engine error): scoreRow's shape, verdicts empty. */
export function unscoredResult(row, finalStatus, subcause) {
  return {
    id: row.id,
    reviewer: row.reviewer,
    expected: row.expected,
    holdout: !!row.holdout,
    caseId: row.caseId ?? null,
    variantOf: row.variantOf ?? null,
    ...rowHashes(row),
    firstVerdict: null,
    okFirst: false,
    finalStatus,
    okFinal: false,
    escalated: false,
    escalateLive: false,
    reasonClass: null,
    subcause,
    ms: { first: 0, escalate: 0 },
  };
}

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
    variantOf: row.variantOf ?? null,
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

/** Materialize, execute and clean up one labeled fixture using the native task plan. */
export async function runRow(
  row,
  {
    model = MODEL,
    cascade = CASCADE,
    exec,
    cap = BENCH_CHUNK_LOC,
    groups = BENCH_LENS_GROUPS,
    savedTasks,
    onTask,
  } = {},
) {
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
      return unscoredResult(row, 'not-selected', 'not-selected');
    const plan = planFixture(sel, fx.repo, { cap, groups });
    const opts = { cwd: fx.repo, cfg, firstModel: model, judgeEnv: gateJudgeEnv(false, cfg) };
    const measured = await executePlan(
      plan,
      async (task) => {
        const capture = [];
        const spy = makeSpyExec(capture, { reviewer: task.sel.reviewer, cascade, delegate: exec });
        try {
          return { res: await runCascade(task.sel, { ...opts, exec: spy }), capture };
        } catch (error) {
          return { res: { name: row.reviewer, status: 'error', reason: String(error) }, capture };
        }
      },
      { saved: savedTasks, onTask },
    );
    const result = scoreRow(row, measured.capture, measured.cas);
    // Production keeps its worst-status merge; measurement separately refuses missing tasks.
    if (!measured.complete)
      Object.assign(result, {
        firstVerdict: null,
        okFirst: false,
        okFinal: false,
        subcause: measured.parts.some(
          (part) =>
            part.res.status === 'inconclusive' && subcause(part.res.reason ?? '') === 'outage',
        )
          ? 'outage'
          : 'engine-error',
      });
    return {
      ...result,
      execution: {
        ...plan.facts,
        complete: measured.complete,
        tasks: measured.parts.map(
          ({ key, group, chunk, files, stateFile, res, capture, complete }) => ({
            key,
            group,
            chunk,
            files,
            stateFile,
            status: res.status,
            complete,
            calls: capture.filter((c) => !c.synthetic).length,
          }),
        ),
      },
    };
  } finally {
    fx.cleanup();
  }
}
