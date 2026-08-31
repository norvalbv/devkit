import { line, ok } from './git-run.mjs';
const CONVENTIONAL = ['main', 'master'];
/** Strip a leading `origin/` so `--base origin/main` and `--base main` mean the same thing. */
export function normalizeBaseName(raw) {
    const trimmed = raw.trim();
    return trimmed.startsWith('origin/') ? trimmed.slice('origin/'.length) : trimmed;
}
/**
 * Is this a name git would accept as a branch? The value reaches us from argv or the environment,
 * and it is interpolated into refspecs and hashed into a marker filename — so a `../..`-shaped or
 * control-character name has to be rejected at the boundary rather than defended against at each
 * use. `check-ref-format` is git's own answer to the question, which beats a hand-rolled regex.
 */
function wellFormed(run, base) {
    if (!base || base.includes('\0'))
        return false;
    return ok(run(['check-ref-format', `refs/heads/${base}`]));
}
/** Does refs/remotes/origin/<base> exist locally right now? */
export function trackingRefExists(run, base) {
    return ok(run(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${base}`]));
}
function tipOf(run, base) {
    const result = run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`]);
    return ok(result) ? line(result) : '';
}
function resolved(base, source, sha) {
    return { kind: 'resolved', base, ref: `refs/remotes/origin/${base}`, source, sha };
}
/**
 * The explicit tier, and why it never falls through.
 *
 * `devkit ship` has already resolved BASE_REF under its own rules (ship-branch.sh:239-247) and the
 * frink provisioner knows what it cut from. Re-deriving a different answer would report drift
 * against a base the PR does not target, which is worse than staying quiet. So an explicit base
 * that cannot be verified is `explicit-missing`, never a silent downgrade to origin/HEAD.
 *
 * The one retry exists because a freshly provisioned worktree can legitimately lack the tracking
 * ref for a base that does exist on origin; `refetch` is the caller's fetch, already TTL-bounded.
 */
function resolveExplicit(run, base, refetch) {
    if (!wellFormed(run, base))
        return { kind: 'unresolvable', reason: 'explicit-missing' };
    if (!trackingRefExists(run, base)) {
        const freshness = refetch?.(base);
        if (!trackingRefExists(run, base)) {
            // "origin does not have this branch" and "we could not reach origin to find out" are
            // different answers. Reporting the second as the first is the silent-failure this whole
            // feature exists to prevent, so it keeps its own reason and carries the name for the note.
            return freshness === 'unknown'
                ? { kind: 'unresolvable', reason: 'fetch-failed', base }
                : { kind: 'unresolvable', reason: 'explicit-missing' };
        }
    }
    const sha = tipOf(run, base);
    return sha
        ? resolved(base, 'explicit', sha)
        : { kind: 'unresolvable', reason: 'explicit-missing' };
}
/**
 * Resolve the base. Precedence: --base > $DEVKIT_BASE_REF > origin/HEAD > main > master > give up.
 *
 * Returning `unresolvable` is a normal outcome, not a failure: every caller renders nothing for it.
 * Naming a base we cannot verify would produce confident reports about a branch that is not there,
 * which is the failure mode origin-base.sh was written to end.
 */
export function resolveBase(run, opts = {}) {
    const explicit = opts.explicit?.trim() || (opts.env ?? process.env).DEVKIT_BASE_REF?.trim();
    if (explicit)
        return resolveExplicit(run, normalizeBaseName(explicit), opts.refetch);
    // Tier 1. `origin/HEAD` is only believable after both of origin-base.sh's rejections.
    const symref = run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (ok(symref)) {
        const target = line(symref);
        if (target.startsWith('origin/')) {
            const candidate = target.slice('origin/'.length);
            // Local existence only — see the header on why no round-trip proves it is still on origin.
            if (candidate && trackingRefExists(run, candidate)) {
                const sha = tipOf(run, candidate);
                if (sha)
                    return resolved(candidate, 'origin-head', sha);
            }
        }
    }
    // Tier 2. Convention, still proven against a real ref before it is trusted.
    for (const candidate of CONVENTIONAL) {
        if (!trackingRefExists(run, candidate))
            continue;
        const sha = tipOf(run, candidate);
        if (sha)
            return resolved(candidate, candidate, sha);
    }
    // Tier 3. Distinguish "no origin at all" from "origin exists but offers no candidate", because
    // the first is a repo that was never going to have a base and the second may just need a fetch.
    const remotes = run(['remote']);
    const hasOrigin = ok(remotes) && line(remotes).split('\n').includes('origin');
    return { kind: 'unresolvable', reason: hasOrigin ? 'no-candidate' : 'no-origin' };
}
