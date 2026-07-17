import {
  DEFAULT_REVIEW_DECISIONS_DIR,
  GUARD_IDS,
  type ReviewProfile,
  type Selection,
} from '../components.mts';

export interface ReviewFlagValues {
  review: boolean | null;
  reviewGuards: string[] | null;
  reviewDecisionsDir: string | null;
}

/** Parse the review-profile slice independently so init orchestration stays below its size ceiling. */
export function parseReviewFlags(args: string[]): ReviewFlagValues {
  const flags: ReviewFlagValues = {
    review: null,
    reviewGuards: null,
    reviewDecisionsDir: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--review') flags.review = true;
    else if (args[i] === '--no-review') flags.review = false;
    else if (args[i] === '--review-guards')
      flags.reviewGuards = (args[++i] ?? '')
        .split(',')
        .map((guard) => guard.trim())
        .filter(Boolean);
    else if (args[i] === '--review-decisions-dir') flags.reviewDecisionsDir = args[++i] ?? '';
  }
  return flags;
}

export function reviewPlanFromFlags(
  flags: ReviewFlagValues,
  selection: Selection,
): { profile?: Partial<ReviewProfile>; error?: string } {
  if (flags.review === null && flags.reviewGuards === null && flags.reviewDecisionsDir === null)
    return {};
  if (flags.review !== false && !selection.husky) {
    return {
      error: 'devkit init: --review requires the husky pre-commit component (remove --no-husky).',
    };
  }
  const unknown = (flags.reviewGuards ?? []).filter((guard) => !GUARD_IDS.includes(guard));
  const uninstalled = (flags.reviewGuards ?? []).filter(
    (guard) => GUARD_IDS.includes(guard) && !selection.guards.includes(guard),
  );
  if (unknown.length > 0 || uninstalled.length > 0) {
    const details = [
      unknown.length ? `unknown: ${unknown.join(', ')}` : '',
      uninstalled.length ? `not selected by --guards: ${uninstalled.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    return { error: `devkit init: invalid --review-guards (${details}).` };
  }
  return {
    profile: {
      enabled: flags.review ?? true,
      guards: flags.reviewGuards ?? selection.guards,
      decisionsDir: flags.reviewDecisionsDir || DEFAULT_REVIEW_DECISIONS_DIR,
    },
  };
}
