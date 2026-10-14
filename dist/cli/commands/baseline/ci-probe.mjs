/**
 * `devkit ci-probe`: run the CI suite on the worktree's uncommitted state, then name the test files
 * that fail there and not on the default branch. CI is the oracle; anything unreadable is `unknown`.
 */
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { capped, compareSummaries, lostFiles } from '../../lib/baseline-status/attribution.mjs';
import { GhUnavailable, commitCi, gh, isUsableRun, runView, runsForCommit, } from '../../lib/baseline-status/gh.mjs';
import { loadSummary, resolveRef, workflowSelector } from '../../lib/baseline-status/query.mjs';
import { configuredSource } from '../../lib/baseline-status/source.mjs';
/** The only branch namespace the pre-push hook lets a probe push through without the local suite. */
export const PROBE_NAMESPACE = 'devkit-probe/';
export const POLL_MS = 30_000;
/** A probe that cannot answer, with the reason a caller branches on. */
export class ProbeUnknown extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.name = 'ProbeUnknown';
        this.reason = reason;
    }
}
function git(cwd, args, env = {}) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
    }).trim();
}
/** A git step the probe cannot get past, as a named unknown carrying git's own words. */
function gitStep(reason, step) {
    try {
        return step();
    }
    catch (e) {
        // SAFETY: execFileSync rejects with an Error that carries the child's stderr when piped.
        const stderr = String(e.stderr ?? '').trim();
        throw new ProbeUnknown(reason, stderr || (e instanceof Error ? e.message : String(e)));
    }
}
/** HEAD plus every tracked change, committed through a throwaway index: branch, index, tree untouched. */
export function snapshotCommit(cwd) {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-probe-'));
    try {
        const index = join(dir, 'index');
        const real = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index']));
        if (existsSync(real))
            copyFileSync(real, index);
        git(cwd, ['add', '-u'], { GIT_INDEX_FILE: index });
        const tree = git(cwd, ['write-tree'], { GIT_INDEX_FILE: index });
        const sha = git(cwd, ['commit-tree', tree, '-p', 'HEAD', '-m', 'devkit ci-probe snapshot']);
        const others = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ':/']);
        return { sha, untracked: others.split('\0').filter(Boolean).length };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** Dispatch the workflow on the probe branch; a workflow without the trigger is a named reason. */
export function dispatch(cwd, workflow, ref) {
    try {
        gh(['workflow', 'run', workflow, '--ref', ref], cwd);
    }
    catch (e) {
        if (e instanceof GhUnavailable && /workflow_dispatch/.test(e.message)) {
            throw new ProbeUnknown('workflow-not-dispatchable', `${workflow} has no workflow_dispatch trigger`);
        }
        throw e;
    }
}
/** The probe commit's run once it completes; an exhausted budget is `timed-out`, never a pass. */
export async function awaitRun(opts) {
    const deadline = Date.now() + opts.budgetMs;
    let seen = false;
    for (;;) {
        const run = runsForCommit({
            cwd: opts.cwd,
            workflow: opts.workflow,
            ref: opts.ref,
            sha: opts.sha,
        })[0];
        if (run && !seen) {
            seen = true;
            opts.onRun(run);
        }
        if (run?.status === 'completed')
            return run;
        const left = deadline - Date.now();
        if (left <= 0) {
            throw new ProbeUnknown('timed-out', run ? `run ${run.databaseId} is ${run.status}` : 'no run started');
        }
        await sleep(Math.min(opts.pollMs ?? POLL_MS, left));
    }
}
/** The default branch's run at HEAD's merge-base with it — the tree the probe is measured against. */
export function baseSummary(cwd, workflow, artifact) {
    const ref = resolveRef(cwd);
    let sha;
    try {
        sha = git(cwd, ['merge-base', 'HEAD', `origin/${ref}`]);
    }
    catch {
        throw new ProbeUnknown('base-unknown', `no merge-base between HEAD and origin/${ref}`);
    }
    const ci = commitCi({ cwd, workflow, ref, sha });
    if (!ci.run)
        throw new ProbeUnknown(`base-${ci.verdict}`, `${ref}@${sha.slice(0, 12)}: ${ci.detail}`);
    return { run: ci.run.databaseId, summary: loadSummary({ cwd, run: ci.run, artifact }) };
}
/** A probe summary is evidence only if it is this commit's and its tests actually reported. */
export function admitProbe(probe, sha) {
    if (probe.sha !== sha) {
        throw new ProbeUnknown('sha-mismatch', `the run tested ${probe.sha}, not the probe ${sha}`);
    }
    if (!probe.testsPassed && !Object.values(probe.files).includes('failed')) {
        throw new ProbeUnknown('no-results', 'the tests failed without naming a failed file');
    }
}
/** New = failing only in the probe, plus lost files the probe commit still holds (not deleted ones). */
export function answer(result, probe, base, tracked) {
    const files = compareSummaries(probe, base);
    const lost = lostFiles(probe, base).filter((file) => tracked.has(file));
    return {
        ...result,
        answer: 'answered',
        newFailing: [...files.fresh, ...lost],
        lost,
        inherited: files.inherited,
        unsure: files.unsure,
    };
}
export async function runProbe(opts) {
    const { cwd, workflow, artifact, log } = opts;
    let snapshot;
    try {
        snapshot = gitStep('snapshot-failed', () => snapshotCommit(cwd));
    }
    catch (e) {
        if (!(e instanceof ProbeUnknown))
            throw e;
        const empty = { newFailing: [], lost: [], inherited: [], unsure: [] };
        return { answer: 'unknown', reason: e.reason, detail: e.message, sha: '', ref: '', ...empty };
    }
    const { sha, untracked } = snapshot;
    if (untracked > 0)
        log(`ci-probe: ${untracked} untracked file(s) left out — git add them to include`);
    const ref = `${PROBE_NAMESPACE}${sha.slice(0, 12)}`;
    const result = {
        answer: 'unknown',
        sha,
        ref,
        newFailing: [],
        lost: [],
        inherited: [],
        unsure: [],
    };
    let pushed = false;
    let keepRef = false;
    try {
        const push = ['push', '--quiet', 'origin', `${sha}:refs/heads/${ref}`];
        const skip = { DEVKIT_PROBE_PREPUSH_SKIP_SHA: sha };
        gitStep('push-failed', () => git(cwd, push, skip));
        pushed = true;
        dispatch(cwd, workflow, ref);
        const onRun = (run) => {
            result.runUrl = runView(cwd, run.databaseId).url;
            log(`ci-probe: run ${result.runUrl}`);
        };
        const run = await awaitRun({ ...opts, ref, sha, onRun });
        if (!isUsableRun(run))
            throw new ProbeUnknown('run-unusable', `run concluded ${run.conclusion}`);
        const probe = loadSummary({ cwd, run, artifact });
        admitProbe(probe, sha);
        const base = baseSummary(cwd, workflow, artifact);
        const listTree = ['ls-tree', '-r', '--full-tree', '--name-only', '-z', sha];
        const tree = gitStep('snapshot-failed', () => git(cwd, listTree));
        const tracked = new Set(tree.split('\0'));
        return answer({ ...result, baseRun: base.run }, probe, base.summary, tracked);
    }
    catch (e) {
        if (!(e instanceof ProbeUnknown || e instanceof GhUnavailable))
            throw e;
        keepRef = e.reason === 'timed-out';
        return { ...result, reason: e.reason, detail: e.message };
    }
    finally {
        if (pushed && !keepRef)
            deleteProbeRef(cwd, ref, log);
    }
}
/** Through the API, not `git push --delete`, which the pre-push hook treats as a full-suite push. */
function deleteProbeRef(cwd, ref, log) {
    try {
        gh(['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${ref}`], cwd);
    }
    catch (e) {
        log(`ci-probe: could not delete ${ref} (${e instanceof Error ? e.message : e}) — delete it by hand`);
    }
}
const DEFAULT_TIMEOUT_MIN = 120;
export const meta = {
    name: 'ci-probe',
    agentFacing: true,
    summary: 'Run the CI test suite on your uncommitted change and list the files it newly breaks.',
    help: `devkit ci-probe — ask CI which test files your change breaks, before any PR or judge.

Usage:
  devkit ci-probe [--json] [--timeout <minutes>] [--workflow <file>]

  --json               machine-readable output
  --timeout <minutes>  how long to wait for the CI run (default ${DEFAULT_TIMEOUT_MIN})
  --workflow <file>    the CI workflow to dispatch (default: guard.config.json, else gate.yml)

Commits HEAD plus your tracked changes through a throwaway index (your branch, index and worktree
are untouched; untracked files are left out until you git add them), pushes it to
${PROBE_NAMESPACE}<sha>, dispatches the workflow there and waits for its per-file test summary.
That is compared with the default branch's run at HEAD's merge-base:
  new        failing in the probe and not on the base, plus lost files
  lost       passed on the base, still in the probe commit, but not run (a collection change
             hides failures); a test file the change deletes is not lost
  inherited  failing on both with the same tests
  unsure     failing on both, without complete test names to tell them apart

The workflow needs a workflow_dispatch trigger on the default branch. A full suite takes as long as
CI does (~40-50 min for devkit), so run this in the background. The probe branch is deleted after
the read; on a timeout it is kept, and \`devkit baseline-status --ref <branch>\` reads it later.
devkit's own pre-push hook skips its local suite only for this exact commit on a ${PROBE_NAMESPACE}
branch; another repository's pre-push hook runs as usual.

Exit 0 = answered (new may be non-empty). Exit 2 = unknown, with a named reason: a refused push, a
timed-out or cancelled run, a missing artifact, a base run that is pending or missing — never read
as "none new".
Exit 1 = a bad argument.`,
};
function render(r) {
    const run = r.runUrl ? ` run=${r.runUrl}` : '';
    if (r.answer === 'unknown') {
        const kept = r.reason === 'timed-out' ? ` kept=${r.ref}` : '';
        return `ci-probe: unknown reason=${r.reason}${run}${kept}\n  ${r.detail ?? ''}`;
    }
    return (`ci-probe: new=${r.newFailing.length} lost=${r.lost.length} inherited=${r.inherited.length}` +
        ` unsure=${r.unsure.length} new-failing=${capped(r.newFailing)} lost-files=${capped(r.lost)}` +
        `${run} base-run=${r.baseRun}`);
}
/** Parsed options, or the usage error to print. */
function options(args, cwd) {
    const { values } = parseArgs({
        args,
        options: {
            json: { type: 'boolean' },
            timeout: { type: 'string' },
            workflow: { type: 'string' },
        },
        strict: true,
    });
    const raw = values.timeout ?? String(DEFAULT_TIMEOUT_MIN);
    const minutes = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isNaN(minutes)) {
        throw new Error(`--timeout must be a number of minutes (got ${values.timeout})`);
    }
    const configured = configuredSource(cwd);
    const workflow = values.workflow === undefined ? configured.workflow : workflowSelector(values.workflow);
    if (!workflow)
        throw new Error(`--workflow needs a workflow file name (got "${values.workflow}")`);
    return {
        json: values.json === true,
        budgetMs: minutes * 60_000,
        workflow,
        artifact: configured.artifact,
    };
}
export default async function ciProbe(args, cwd) {
    let opts;
    try {
        opts = options(args, cwd);
    }
    catch (e) {
        console.error(`🚫 ${e instanceof Error ? e.message : e}.`);
        return 1;
    }
    const result = await runProbe({ cwd, ...opts, log: (line) => console.error(line) });
    console.log(opts.json ? JSON.stringify(result, null, 2) : render(result));
    return result.answer === 'answered' ? 0 : 2;
}
