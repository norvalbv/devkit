export const CORRECTNESS_LENSES = Object.freeze([
    'state-transitions',
    'concurrency-races',
    'writer-reader-contracts',
    'error-and-edge-classification',
]);
/** The pilot's paired shape: the measured-strong pair together, the measured-weak pair together.
 * No longer the default — kept addressable as `1`/`on` so the A/B's registered arm stays runnable. */
export const DEFAULT_LENS_GROUPS = Object.freeze([
    Object.freeze(['concurrency-races', 'state-transitions']),
    Object.freeze(['writer-reader-contracts', 'error-and-edge-classification']),
]);
/** One judge per lens — the shipped shape. See docs/decisions/correctness-lens-split-shipped.md:
 * this ships on DIRECTIONAL evidence, not a cleared bar. The 2026-08-04 A/B put it ahead of the
 * monolith on both co-primaries with zero regressions and ~35% lower per-row cost, but its
 * null-adjusted +4 sat under the repo's ~5-flip floor, and the arm that WAS pre-registered (the
 * paired shape above) failed. It is on because a configuration nobody runs mints no telemetry to
 * decide it with, and `off` reverts in one env var. */
export const FOUR_WAY_LENS_GROUPS = Object.freeze(CORRECTNESS_LENSES.map((lens) => Object.freeze([lens])));
/** Stable id for a group — sorted, so `a,b` and `b,a` are the SAME group everywhere (state-file
 * name, cache key, progress label). Mirrors `lensPath` in the correctness checklist script. */
export const lensGroupId = (group) => [...group].sort().join('+');
/**
 * Parse `GUARD_CORRECTNESS_SPLIT` into lens groups, or null when the split is off.
 *
 * Accepted: unset → FOUR_WAY_LENS_GROUPS (the shipped shape) · `0`/`off` → null (the monolith, the
 * pre-2026-08 behaviour) · `1`/`on` → DEFAULT_LENS_GROUPS (the A/B's registered paired arm) · an
 * explicit spec `a,b|c,d` → those groups. An explicit spec must be a PARTITION of the four lenses:
 * a missing lens would silently stop being reviewed — a correctness lens dropping out of a BLOCKING
 * gate is exactly the blindness this reviewer exists to prevent — and a duplicated one would
 * double-judge the same class. Both throw rather than degrade.
 */
export function resolveLensGroups(raw = process.env.GUARD_CORRECTNESS_SPLIT) {
    const spec = String(raw ?? '').trim();
    if (spec === '')
        return FOUR_WAY_LENS_GROUPS;
    if (spec === '0' || spec.toLowerCase() === 'off')
        return null;
    if (spec === '1' || spec.toLowerCase() === 'on')
        return DEFAULT_LENS_GROUPS;
    const groups = spec
        .split('|')
        .map((g) => g
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean))
        .filter((g) => g.length > 0);
    const flat = groups.flat();
    const known = new Set(CORRECTNESS_LENSES);
    const unknown = flat.filter((l) => !known.has(l));
    if (unknown.length > 0)
        throw new Error(`GUARD_CORRECTNESS_SPLIT: unknown lens ${unknown.join(', ')} — expected a subset of ${CORRECTNESS_LENSES.join(', ')}`);
    if (new Set(flat).size !== flat.length)
        throw new Error('GUARD_CORRECTNESS_SPLIT: a lens may appear in only one group');
    if (flat.length !== CORRECTNESS_LENSES.length)
        throw new Error(`GUARD_CORRECTNESS_SPLIT: every lens must appear exactly once (missing ${CORRECTNESS_LENSES.filter((l) => !flat.includes(l)).join(', ') || 'none'})`);
    return Object.freeze(groups.map((g) => Object.freeze(g)));
}
/** A per-group clone. Only the state file and the checklist commands become group-scoped — see the
 * module header on why the name must not. */
export function deriveLensReviewer(reviewer, group, chunk) {
    // `--chunk` scopes the state file per diff slice: one lens runs once per chunk concurrently,
    // and two judges sharing a checklist would clobber each other. checklist.mjs's lensPath appends
    // the identical `+c<n>` suffix. Absent chunk → today's paths, byte-for-byte.
    const suffix = chunk === undefined ? '' : ` --chunk ${chunk}`;
    const arg = `--lens ${[...group].sort().join(',')}${suffix}`;
    // SAFETY: a spread of a ChecklistReviewer overriding only lens/stateFile/cmds keeps the shape;
    // Object.freeze widens the literal, so the assertion restores the input's own type.
    return Object.freeze({
        ...reviewer,
        lens: group,
        stateFile: `.claude/.correctness-review-${lensGroupId(group)}${chunk === undefined ? '' : `+c${chunk}`}.json`,
        cmds: Object.freeze({
            gen: `${reviewer.cmds.gen} ${arg}`,
            check: `${reviewer.cmds.check} ${arg}`,
            fin: `${reviewer.cmds.fin ?? 'finalize'} ${arg}`,
        }),
    });
}
