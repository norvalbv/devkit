/** A network or GitHub-side fault that heals with time. Anything unlisted stays `gh-failed`. */
const TRANSPORT = /dial tcp|i\/o timeout|TLS handshake timeout|context deadline exceeded|connection (refused|reset)|no such host|network is unreachable|unexpected EOF|HTTP 5\d\d|rate limit|something went wrong|check your internet connection/i;
/**
 * A deliberate SIBLING of classify() in baseline-status/gh.mts, not an import: that one is reachable
 * only through a helper which discards `e.stdout`, which is exactly the exit-8 path this caller needs.
 */
export function classifyChecksFailure(e) {
    if (e?.code === 'ENOENT')
        return { kind: 'unavailable', reason: 'gh-missing', message: 'the `gh` CLI is not on PATH' };
    // A killed exec is the per-poll cap firing: a stalled network, retried until the wait's deadline.
    if (e?.killed)
        return { kind: 'unavailable', reason: 'gh-unreachable', message: 'gh pr checks timed out' };
    const stderr = String(e?.stderr ?? '');
    const msg = stderr.trim() || e?.message || String(e);
    // gh exits 1 both for a PR with no checks and for --required on an unprotected branch. Both are
    // an empty check set — an answer — not a failure to reach gh.
    if (/no (required )?checks reported/i.test(stderr))
        return { kind: 'rows', rows: [] };
    if (/gh auth login|authentication|not logged/i.test(stderr))
        return {
            kind: 'unavailable',
            reason: 'gh-unauthenticated',
            message: `gh is not authenticated: ${msg}`,
        };
    if (/could not resolve to a pullrequest|no pull requests found/i.test(stderr))
        return { kind: 'unavailable', reason: 'pr-not-found', message: msg };
    if (/no git remotes|not a git repository|could not determine|none of the git remotes/i.test(stderr))
        return {
            kind: 'unavailable',
            reason: 'not-a-github-repo',
            message: `no GitHub remote to query: ${msg}`,
        };
    if (TRANSPORT.test(stderr))
        return { kind: 'unavailable', reason: 'gh-unreachable', message: msg };
    return { kind: 'unavailable', reason: 'gh-failed', message: msg };
}
