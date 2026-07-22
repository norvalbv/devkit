import { DEFAULT_REVIEW_DECISIONS_DIR, REVIEWABLE_GUARD_IDS, } from "../components.mjs";
/** Classify requested review guards once so init and review enforce the same allowlist. */
export function reviewGuardIssues(requested, installed) {
    const issues = { invalid: [], unknown: [], uninstalled: [] };
    for (const guard of requested) {
        if (!REVIEWABLE_GUARD_IDS.includes(guard))
            issues.unknown.push(guard);
        else if (!installed.includes(guard))
            issues.uninstalled.push(guard);
        else
            continue;
        issues.invalid.push(guard);
    }
    return issues;
}
/** Parse the review-profile slice independently so init orchestration stays below its size ceiling. */
export function parseReviewFlags(args) {
    const flags = {
        review: null,
        reviewGuards: null,
        reviewDecisionsDir: null,
    };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--review')
            flags.review = true;
        else if (args[i] === '--no-review')
            flags.review = false;
        else if (args[i] === '--review-guards')
            flags.reviewGuards = (args[++i] ?? '')
                .split(',')
                .map((guard) => guard.trim())
                .filter(Boolean);
        else if (args[i] === '--review-decisions-dir')
            flags.reviewDecisionsDir = args[++i] ?? '';
    }
    return flags;
}
export function reviewPlanFromFlags(flags, selection) {
    if (flags.review === null && flags.reviewGuards === null && flags.reviewDecisionsDir === null)
        return {};
    const modifiers = [
        flags.reviewGuards !== null ? '--review-guards' : '',
        flags.reviewDecisionsDir !== null ? '--review-decisions-dir' : '',
    ].filter(Boolean);
    if (flags.review !== true && modifiers.length > 0) {
        return { error: `devkit init: ${modifiers.join(' and ')} require --review.` };
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
            decisionsDir: flags.reviewDecisionsDir || DEFAULT_REVIEW_DECISIONS_DIR,
        },
    };
}
