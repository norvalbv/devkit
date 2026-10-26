/**
 * The `gh` boundary for `devkit baseline-status`.
 *
 * `gh` is a SOFT dependency. It is not added to any consumer's package.json (that is what
 * docs/decisions/zero-consumer-tool-deps.md forbids) and every failure to reach it degrades to a
 * NAMED unknown rather than an exception or, far worse, a guess. This is the shape already proven by
 * `detectMerged` in cli/lib/reconcile.mts, which collapses gh-absent / offline / no-PR to a single
 * UNKNOWN and never crashes a caller.
 *
 * The one rule this module exists to enforce: no answer is better than a wrong answer. An agent that
 * reads "this file passed on main" and ships on it must never have been told that by a fallback.
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
export class GhUnavailable extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.name = 'GhUnavailable';
        this.reason = reason;
    }
}
/** Every entry must carry the fields this reader dereferences; `[null]` otherwise reaches them. */
function isRunRef(value) {
    return (!!value &&
        Number.isFinite(value.databaseId) &&
        Number.isFinite(value.attempt) &&
        STRING_FIELDS.every((f) => (value[f] ?? null) !== null && `${value[f]}` === value[f]));
}
/** The fields read as text; compared by round-trip rather than a representation check. */
const STRING_FIELDS = ['conclusion', 'status', 'headSha', 'headBranch', 'event'];
const RUN_FIELDS = 'databaseId,attempt,conclusion,status,headSha,createdAt,headBranch,event';
/**
 * A run whose tests actually executed. `status: 'completed'` is NOT the predicate — cancelled,
 * timed_out, startup_failure and skipped are all "completed" and carry no report.
 */
export function isUsableRun(run) {
    return (run.status === 'completed' && (run.conclusion === 'success' || run.conclusion === 'failure'));
}
/** Turn gh's stderr into the most specific reason it supports. */
function classify(e) {
    if (e?.code === 'ENOENT') {
        return new GhUnavailable('gh-missing', 'the `gh` CLI is not on PATH');
    }
    if (e?.code === 'ETIMEDOUT') {
        return new GhUnavailable('gh-failed', `gh did not answer within ${GH_TIMEOUT_MS / 1000}s`);
    }
    const stderr = String(e?.stderr ?? '');
    const msg = stderr.trim() || e?.message || String(e);
    // First: gh echoes the user's workflow name, so a name like "authentication" must not reach the
    // looser patterns below. A bare "HTTP 404" stays generic — an inaccessible repo 404s too.
    if (/workflow .+ not found on the default branch|could not find any workflows named/i.test(stderr)) {
        return new GhUnavailable('workflow-missing', msg);
    }
    if (/gh auth login|authentication|not logged/i.test(stderr)) {
        return new GhUnavailable('gh-unauthenticated', `gh is not authenticated: ${msg}`);
    }
    if (/no git remotes|not a git repository|could not determine|none of the git remotes/i.test(stderr)) {
        return new GhUnavailable('not-a-github-repo', `no GitHub remote to query: ${msg}`);
    }
    return new GhUnavailable('gh-failed', msg);
}
/** One gh call's budget; the walk makes one per commit, so a hung call must not stall the query. */
export const GH_TIMEOUT_MS = 60_000;
export function gh(args, cwd) {
    const debug = process.env.DEVKIT_BASELINE_DEBUG; // surface gh's stderr instead of collapsing it
    try {
        return execFileSync('gh', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: GH_TIMEOUT_MS,
            env: process.env, // explicit: Bun's spawn otherwise resolves `gh` against its startup PATH
        });
    }
    catch (e) {
        // SAFETY: execFileSync rejects with an Error carrying optional `code`/`stderr`; ExecFailure
        // declares every field optional, so a non-conforming throw classifies as the generic gh-failed.
        const failure = classify(e);
        if (debug)
            console.error(`baseline-status: gh ${args.join(' ')} — ${failure.message}`);
        throw failure;
    }
}
/**
 * This commit's runs on `ref`, newest first — by sha, since GitHub's branch listing serves stale pages.
 *
 * A pull_request run can share a branch sha, but it tested a merge ref, so it is dropped.
 */
export function runsForCommit({ cwd, workflow, ref, sha, }) {
    const out = gh(
    // One full API page: filtering happens here, so gh's default 20 could cut off the branch's run.
    [
        'run',
        'list',
        '--workflow',
        workflow,
        '--commit',
        sha,
        '--limit',
        '100',
        '--json',
        RUN_FIELDS,
    ], cwd);
    let runs;
    try {
        runs = JSON.parse(out);
    }
    catch {
        throw new GhUnavailable('gh-failed', 'gh run list returned unparseable JSON');
    }
    // SAFETY: `runs` is unvalidated JSON; RunRefCandidate declares every field optional and isRunRef
    // is what admits it, so an entry that disagrees is rejected rather than read.
    if (!Array.isArray(runs) || !runs.every(isRunRef)) {
        throw new GhUnavailable('gh-failed', 'gh run list returned JSON this reader cannot use');
    }
    return runs.filter((run) => run.headBranch === ref && !run.event.startsWith('pull_request'));
}
/** GitHub's REST run object, as much of it as RunRef needs; the schema lets three fields be null. */
const apiRunSchema = z.object({
    id: z.number().int(),
    run_attempt: z.number().int(),
    conclusion: z.string().nullable(),
    status: z.string().nullable(),
    head_sha: z.string(),
    head_branch: z.string().nullable(),
    event: z.string(),
    created_at: z.string(),
    path: z.string(),
});
/** One run by id, any event or branch, with the workflow file it belongs to. */
export function runById(cwd, id) {
    const out = gh(['api', `repos/{owner}/{repo}/actions/runs/${id}`], cwd);
    let parsed;
    try {
        parsed = apiRunSchema.safeParse(JSON.parse(out));
    }
    catch {
        parsed = null; // unparseable: rejected below like any other shape this reader cannot use
    }
    if (!parsed?.success) {
        throw new GhUnavailable('gh-failed', `gh api returned run ${id} in a shape this reader cannot use`);
    }
    const run = parsed.data;
    return {
        databaseId: run.id,
        attempt: run.run_attempt,
        conclusion: run.conclusion ?? '',
        status: run.status ?? '',
        headSha: run.head_sha,
        headBranch: run.head_branch ?? '',
        event: run.event,
        createdAt: run.created_at,
        // GitHub may suffix the file with the ref the run used (`build.yml@main`).
        path: run.path.replace(/@.*$/, ''),
    };
}
/** A full SHA-1 or SHA-256 commit id, as git and GitHub print it. */
export const COMMIT_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
/** The branch head in the repository gh queries, so the head and its runs share one provenance. */
export function branchHead({ cwd, ref }) {
    let out;
    try {
        // One encoded parameter: `release/1.x` is a single branch, not two path segments.
        const path = `repos/{owner}/{repo}/branches/${encodeURIComponent(ref)}`;
        out = gh(['api', path, '--jq', '.commit.sha'], cwd);
    }
    catch (e) {
        // Only GitHub's own wording: an inaccessible repository is a bare "Not Found (HTTP 404)".
        if (e instanceof GhUnavailable &&
            e.reason === 'gh-failed' &&
            /Branch not found/.test(e.message)) {
            throw new GhUnavailable('head-unknown', `GitHub reports no branch ${ref}: ${e.message}`);
        }
        throw e;
    }
    const sha = out.trim();
    if (COMMIT_SHA.test(sha))
        return sha;
    throw new GhUnavailable('head-unknown', `gh returned no commit for branch ${ref}`);
}
/** One failed job's `job › step` entries, or the job alone when no step failed. */
function failedSteps(job) {
    const name = `${job.name}`;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const failed = steps.filter((step) => step?.conclusion === 'failure');
    if (failed.length === 0)
        return [{ label: name, job: name, step: null }];
    return failed.map((step) => ({
        label: `${name} › ${step.name}`,
        job: name,
        step: Number.isSafeInteger(step.number) ? Number(step.number) : null,
    }));
}
/** gh's answer as JSON, or null when it is not JSON at all. */
function parseView(out) {
    try {
        return JSON.parse(out);
    }
    catch {
        return null;
    }
}
/** A run's page and each failed `job › step`. */
export function runView(cwd, runId) {
    const view = parseView(gh(['run', 'view', String(runId), '--json', 'url,jobs'], cwd));
    if (`${view?.url}` !== view?.url || !Array.isArray(view?.jobs)) {
        throw new GhUnavailable('gh-failed', `gh run view ${runId} returned JSON this reader cannot use`);
    }
    const failing = view.jobs.filter((job) => job?.conclusion === 'failure').flatMap(failedSteps);
    return { url: `${view.url}`, failing };
}
/**
 * Only a newest completed run that succeeded is green, and only one that failed is red. No run or a
 * cancelled or timed-out one is `missing`; a gh failure is `unreadable`, named, never a throw.
 */
export function commitCi(opts) {
    try {
        const runs = runsForCommit(opts);
        const run = runs.find((r) => r.status === 'completed') ?? runs[0];
        if (!run) {
            return {
                verdict: 'missing',
                detail: `no-usable-run: no ${opts.workflow} run for this commit`,
            };
        }
        const { url, failing } = runView(opts.cwd, run.databaseId);
        if (run.status !== 'completed') {
            return { verdict: 'pending', detail: `run ${run.databaseId} is ${run.status}`, url };
        }
        if (run.conclusion === 'success')
            return { verdict: 'green', detail: '', url, run, failing };
        if (run.conclusion === 'failure') {
            const detail = failing.map((f) => f.label).join(', ') || 'no failed job named';
            return { verdict: 'red', detail, url, run, failing };
        }
        const detail = `no-usable-run: run ${run.databaseId} concluded ${run.conclusion}`;
        return { verdict: 'missing', detail, url };
    }
    catch (e) {
        if (!(e instanceof GhUnavailable))
            throw e;
        return { verdict: 'unreadable', detail: `${e.reason}: ${e.message}` };
    }
}
