// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/** A corpus row must be measurable in the configuration production runs. The bench judges every
 * row un-chunked, so a row production would chunk at the shipped cap is refused (sc-2494 AC1). */
import { materializeFixture } from '../../../../decisions/eval/bench.mts';
import { gitCached } from '../../../evidence/staged-git.mts';
import { chunkPlanFacts, resolveChunkCap } from '../../../lens/chunk-tasks.mts';
import { resolveLensGroups } from '../../../lens/groups.mts';
import { REVIEWERS } from '../../../reviewers.mts';

/** ONE cap for the whole run — env, else the bench cwd's guard.config, else the package default —
 * resolved once so the checkpoint's recorded cap and the refusals below can never disagree. */
export const BENCH_CHUNK_LOC = resolveChunkCap(process.env.GUARD_CORRECTNESS_CHUNK);

/** The refusal message when production would chunk this row's staged diff, else null. */
export function chunkRefusal(row, sel, cwd, cap = BENCH_CHUNK_LOC, groups = resolveLensGroups()) {
  if (!groups || sel.reviewer.name !== 'correctness-reviewer' || cap === null) return null;
  const facts = chunkPlanFacts(sel, gitCached(cwd, [], sel.files), groups, cap);
  return facts
    ? `${row.id}: production would judge this diff in ${facts.count} chunks at cap ${cap} LOC; the bench runs every row un-chunked — split the fixture or add bench chunk support first`
    : null;
}

/** Every refusal across a run's rows, computed BEFORE any judge runs (a stop at the door, never an
 * abort inside the row pool); only the diff matters, so fixtures materialize without gate assets. */
export function preflightChunkRefusals(rows, cap = BENCH_CHUNK_LOC) {
  const reviewer = REVIEWERS.find((r) => r.name === 'correctness-reviewer');
  const out = [];
  for (const row of rows) {
    if (row.reviewer !== 'correctness-reviewer' || !reviewer) continue;
    const fx = materializeFixture({ repo: row.repo });
    try {
      const refusal = chunkRefusal(
        row,
        { reviewer, files: Object.keys(row.repo.staged) },
        fx.repo,
        cap,
      );
      if (refusal) out.push(refusal);
    } finally {
      fx.cleanup();
    }
  }
  return out;
}
