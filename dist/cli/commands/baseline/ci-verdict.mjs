/** `devkit ci-verdict` — ship's --wait-ci verdict for a PR that is already open. */
import { z } from 'zod';
import { MIN_TIMEOUT_S, attribute, classifyChecksFailure, defaultExec, ghChecksPoller, parseTimeoutSeconds, verdictLine, waitForChecks, } from '../../lib/ship/wait-ci/wait.mjs';
const DEFAULT_TIMEOUT_S = 900;
export const meta = {
    name: 'ci-verdict',
    agentFacing: true,
    summary: "Print an open PR's CI verdict, attributing red checks to the PR or to its base.",
    help: `devkit ci-verdict — the \`devkit ship --wait-ci\` verdict for a PR that is already open.

Usage:
  devkit ci-verdict <pr-number|branch> [--timeout <${MIN_TIMEOUT_S}..7200>] [--required]

  --timeout <s>  how long to wait for pending checks (default ${DEFAULT_TIMEOUT_S})
  --required     only the branch-protection required checks (same caveats as --wait-ci-required)

Polls the PR's checks until they settle, then prints ONE line on stdout, byte-identical to the one
ship prints: \`ship: ci-outcome=<passed|failed|cancelled|no-checks|timed-out|unavailable> pr=<n> …\`.
On failed it adds \`attribution=<inherited-only|new|unknown> … base-run=<id>\`: which failures the
base CI merged the PR onto already had, from the per-file test summaries of both runs. Progress goes
to stderr. Nothing is pushed and no ship slot is taken.
Run it from a checkout of the PR's repository: attribution reads the runs of that checkout, so
a PR url from another repository ends in attribution=unknown.

A settled PR still answers after a ~30s confirmation grace. For CI that is still running, pass a
--timeout that outlasts it and run the command in the background: a killed wait prints no verdict.

Exit 0 = a verdict, red or timed-out included. Exit 2 = no verdict could be formed (no gh, not
authenticated, no such PR, no GitHub remote). Exit 1 = a bad argument.`,
};
class UsageError extends Error {
}
const prViewSchema = z.object({ number: z.number().int(), url: z.url() });
/** `[HOST/]OWNER/REPO` as gh's --repo takes it, from the PR url gh itself returned. */
export function repoOfPrUrl(url) {
    const { host, pathname } = new URL(url);
    const [owner, name, kind] = pathname.split('/').filter(Boolean);
    if (!owner || !name || kind !== 'pull')
        return null;
    return host === 'github.com' ? `${owner}/${name}` : `${host}/${owner}/${name}`;
}
/** One `gh pr view` from cwd, so the poller and attribution can never read two different repos. */
export function resolvePr(arg, cwd, exec = defaultExec()) {
    let raw;
    try {
        raw = exec(['pr', 'view', arg, '--json', 'number,url'], cwd);
    }
    catch (e) {
        // SAFETY: execFileSync rejects with an Error carrying optional code/stderr, which is all read.
        const polled = classifyChecksFailure(e);
        return { reason: polled.kind === 'unavailable' ? polled.reason : 'gh-failed' };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { reason: 'gh-json-unparseable' };
    }
    const view = prViewSchema.safeParse(parsed);
    const repo = view.success ? repoOfPrUrl(view.data.url) : null;
    if (view.success && repo)
        return { pr: String(view.data.number), repo };
    return { reason: 'gh-json-unparseable' };
}
/** Positional PR and flags; anything else is refused rather than silently ignored. */
function parseArgs(args) {
    const positionals = [];
    let timeoutS = DEFAULT_TIMEOUT_S;
    let required = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? '';
        if (arg === '--required')
            required = true;
        else if (arg === '--timeout') {
            const parsed = parseTimeoutSeconds(args[++i]);
            if (parsed === null)
                throw new UsageError(`--timeout must be ${MIN_TIMEOUT_S}..7200 seconds (got ${args[i]})`);
            timeoutS = parsed;
        }
        else if (arg.startsWith('--'))
            throw new UsageError(`unknown option ${arg}`);
        else
            positionals.push(arg);
    }
    if (positionals.length !== 1)
        throw new UsageError('exactly one <pr-number|branch> is required');
    return { target: positionals[0] ?? '', timeoutS, required };
}
const unresolved = (reason) => ({
    outcome: 'unavailable',
    polls: 0,
    elapsedMs: 0,
    counts: { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 },
    failures: [],
    pending: [],
    cancelled: [],
    unavailableReason: reason,
});
export default async function ciVerdict(args, cwd, deps = {}) {
    let parsed;
    try {
        parsed = parseArgs(args);
    }
    catch (e) {
        if (!(e instanceof UsageError))
            throw e;
        console.error(`🚫 ${e.message}.`);
        return 1;
    }
    const { target, timeoutS, required } = parsed;
    const resolved = resolvePr(target, cwd, deps.exec);
    if ('reason' in resolved) {
        console.log(verdictLine(unresolved(resolved.reason), target));
        return 2;
    }
    const { pr, repo } = resolved;
    const result = await waitForChecks({
        poll: ghChecksPoller({ pr, repo, cwd, required, exec: deps.exec }),
        timeoutMs: timeoutS * 1000,
        ...deps.wait,
    }).then((r) => ({ ...r, required }));
    if (result.outcome === 'failed')
        result.attribution = await attribute(pr, result.failures, cwd, deps.attribute);
    console.log(verdictLine(result, pr));
    return result.outcome === 'unavailable' ? 2 : 0;
}
