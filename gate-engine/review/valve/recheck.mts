/** `guard-review lens <reviewer>[:<lens>]`: re-judge one reviewer or correctness lens group through
 * the gate's own path, so a PASS lands on the part key a full gate reads — never a reviewer-level one. */

import type { LensPart, ReviewTask } from '../lens/split.mts';
import { isShipLane } from '../cascade/consumer-assets.mts';
import { emitReviewSkipped } from '../evidence/scope.mts';
import { lensGroupId, resolveLensGroups } from '../lens/groups.mts';
import { REVIEWERS, type ReviewerSelection } from '../reviewers.mts';
import { reviewerSkipRemedy } from '../overrides.mts';
import { skippedReviewers } from '../runtime.mts';

/** The only reviewer the gate fans out into lens groups (lens/split.mts planReviewWork). */
const SPLIT_REVIEWER = 'correctness-reviewer';

export interface RecheckTarget {
  reviewer: string;
  /** A lens GROUP id (lensGroupId) — equals the lens name under the shipped four-way split. */
  lens: string | null;
}

/** Parse `<reviewer>[:<lens>]`; throws a message naming the valid choices on anything else. */
export function parseRecheckTarget(
  arg: string,
  groups: readonly (readonly string[])[] | null = resolveLensGroups(),
): RecheckTarget {
  const sep = arg.indexOf(':');
  const reviewer = sep === -1 ? arg : arg.slice(0, sep);
  const lens = sep === -1 ? null : arg.slice(sep + 1);
  const names: string[] = REVIEWERS.map((r) => r.name);
  if (!names.includes(reviewer))
    throw new Error(`unknown reviewer '${reviewer}' — expected one of: ${names.join(', ')}`);
  if (lens === null) return { reviewer, lens };
  if (reviewer !== SPLIT_REVIEWER)
    throw new Error(`${reviewer} has no lenses — re-check it whole: guard-review lens ${reviewer}`);
  const ids = groups?.map(lensGroupId) ?? [];
  if (ids.length === 0)
    throw new Error(
      `the correctness lens split is off (GUARD_CORRECTNESS_SPLIT) — re-check it whole: guard-review lens ${SPLIT_REVIEWER}`,
    );
  if (!ids.includes(lens))
    throw new Error(`unknown lens '${lens}' for ${reviewer} — expected one of: ${ids.join(', ')}`);
  return { reviewer, lens };
}

/** Keep only the target reviewer; the rest are recorded as skipped for `recheck`, never
 * `not_selected`. An empty result is named here so an unselected target never reads as a PASS. */
export function narrowSelection(
  selected: ReviewerSelection[],
  target: RecheckTarget,
  reported: Set<string>,
): ReviewerSelection[] {
  for (const { reviewer } of selected.filter((s) => s.reviewer.name !== target.reviewer)) {
    reported.add(reviewer.name);
    emitReviewSkipped(reviewer.name, 'recheck');
  }
  const kept = selected.filter((s) => s.reviewer.name === target.reviewer);
  if (kept.length === 0)
    console.error(
      skippedReviewers().has(target.reviewer)
        ? `guard-review: ${target.reviewer} is dropped by GUARD_REVIEW_SKIP — unset it to re-check`
        : `guard-review: ${target.reviewer} is not selected by the staged files — nothing to re-check`,
    );
  return kept;
}

/** Keep only the target lens group's tasks — split parts and chunk parts alike carry `group`. */
export function narrowTasks(tasks: ReviewTask[], target: RecheckTarget): ReviewTask[] {
  return target.lens === null ? tasks : tasks.filter((t) => t.group === target.lens);
}

/** The re-check line under a FAIL block: each failing lens group once (chunks share a group).
 * Under ship it says what must match the briefed worktree for the PASS to seed ship's cache. */
export function recheckHint(
  reviewer: string,
  parts: LensPart[] | undefined,
  shipLane: boolean,
): string {
  const groups = [
    ...new Set(
      (parts ?? []).filter((p) => p.res.status === 'fail').flatMap((p) => p.task.group ?? []),
    ),
  ];
  const cmds = groups.length
    ? groups.map((g) => `guard-review lens ${reviewer}:${g}`)
    : [`guard-review lens ${reviewer}`];
  const caveat = shipLane
    ? "\n     (judges YOUR checkout's staged index: stage the same paths ship briefed and keep the same GUARD_REVIEW_* model env, or its PASS will not seed ship's cache)"
    : '';
  return `   Re-check a fix locally (this reviewer only), after staging it: ${cmds.join(' · ')}${caveat}`;
}

/** A failed reviewer's remedies: the cascade skip valve when escalation confirmed it, then the
 * recheck command — omitted inside a recheck, where it would only name itself. */
export function printRemedy(
  f: { name: string; escalated: boolean },
  splitParts: Map<string, LensPart[]>,
  only: RecheckTarget | undefined,
): void {
  if (f.escalated) console.error(`   Remedy: ${reviewerSkipRemedy(f.name)}`);
  if (!only) console.error(recheckHint(f.name, splitParts.get(f.name), isShipLane()));
}
