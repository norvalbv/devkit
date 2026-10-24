import { REVIEWABLE_GUARD_IDS, type ReviewProfile, type Selection } from '../../components.mts';

export interface ReviewFlagValues {
  review: boolean | null;
  reviewGuards: string[] | null;
}

export interface ReviewGuardIssues {
  invalid: string[];
  unknown: string[];
  uninstalled: string[];
}

/** Classify requested review guards once so init and review enforce the same allowlist. */
export function reviewGuardIssues(requested: string[], installed: string[]): ReviewGuardIssues {
  const issues: ReviewGuardIssues = { invalid: [], unknown: [], uninstalled: [] };
  for (const guard of requested) {
    if (!REVIEWABLE_GUARD_IDS.includes(guard)) issues.unknown.push(guard);
    else if (!installed.includes(guard)) issues.uninstalled.push(guard);
    else continue;
    issues.invalid.push(guard);
  }
  return issues;
}

/** Parse the review-profile slice independently so init orchestration stays below its size ceiling. */
export function parseReviewFlags(args: string[]): ReviewFlagValues {
  const flags: ReviewFlagValues = { review: null, reviewGuards: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--review') flags.review = true;
    else if (args[i] === '--no-review') flags.review = false;
    else if (args[i] === '--review-guards')
      flags.reviewGuards = (args[++i] ?? '')
        .split(',')
        .map((guard) => guard.trim())
        .filter(Boolean);
  }
  return flags;
}

export function reviewPlanFromFlags(
  flags: ReviewFlagValues,
  selection: Selection,
): { profile?: Partial<ReviewProfile>; error?: string } {
  if (flags.review === null && flags.reviewGuards === null) return {};
  if (flags.review !== true && flags.reviewGuards !== null) {
    return { error: 'devkit init: --review-guards require --review.' };
  }
  if (flags.review !== false && !selection.husky) {
    return {
      error: 'devkit init: --review requires the husky pre-commit component (remove --no-husky).',
    };
  }
  const { unknown, uninstalled } = reviewGuardIssues(flags.reviewGuards ?? [], selection.guards);
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
    },
  };
}
