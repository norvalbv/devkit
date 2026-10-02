/** What a blocked anti-slop run tells its author to do next (sc-3469). Hints never go in a rule
 * message: the diagnostic is part of the baseline fingerprint (see oxc-toolchain-migration). */
/** Acceptance route with a committed baseline. No one-run bypass: CI's `check --base` would still
 * fail the PR, while an override is durable and visible in the diff. */
export const ACCEPT_VIA_OVERRIDE = "to accept it deliberately, change the rule's severity or add a path-scoped override in the repository Oxlint config (a reviewer sees it in the diff; anti-slop has no one-run bypass)";
/** Overlay rewrites its entry config on every sync, so the override route would silently vanish. */
const ACCEPT_IN_OVERLAY = 'to accept it in this clone, run `devkit anti-slop create --force <paths>` — the overlay baseline is per-clone and git-ignored, and the overlay entry config is rewritten on every sync, so an override there would not last';
/** Concrete alternatives, keyed on the namespaced ruleId the diagnostics carry. */
const RULE_REMEDIES = new Map([
    [
        'anti-slop/no-module-mocking',
        'no-module-mocking: give the module a seam instead of mocking its imports — e.g. an optional `deps = { spawn, existsSync }` parameter (defaulting to the real imports) that the test passes fakes through',
    ],
]);
/** One hint per distinct rule, then the acceptance route this install mode actually supports. */
export function antiSlopRemedyLines(ruleIds, overlay) {
    const hints = [...new Set(ruleIds)].flatMap((ruleId) => {
        const hint = RULE_REMEDIES.get(ruleId);
        return hint === undefined ? [] : [`anti-slop: hint — ${hint}`];
    });
    return [...hints, `anti-slop: ${overlay ? ACCEPT_IN_OVERLAY : ACCEPT_VIA_OVERRIDE}`];
}
