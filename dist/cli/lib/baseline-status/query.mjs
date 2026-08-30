/**
 * The READER side of the baseline oracle — the logic behind `devkit baseline-status`.
 *
 * Answers "was this already broken on the default branch?" from the structured artifact
 * cli/lib/baseline-status/produce.mts emits, so no caller ever has to parse a CI log again.
 *
 * The design constraint that shapes everything here: an agent uses this answer to decide whether a
 * failure is its own. A confidently wrong "it was already red" is worse than no oracle at all, so
 * every path that cannot establish a fact returns a NAMED unknown instead of a plausible default.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { detectGitRoot } from '../detect-git-root.mjs';
import { GhUnavailable, downloadSummary, isUsableRun, listRuns, parseSummary, assertProvenance, } from './gh.mjs';
import { escapesRoot } from './produce.mjs';
export const CACHE_DIR = '.devkit/baseline-status';
export const DEFAULT_WORKFLOW = 'gate.yml';
export const DEFAULT_ARTIFACT = 'test-report-summary';
export const DEFAULT_MAX_RUNS = 10;
/**
 * Hard ceiling on the walk-back.
 *
 * `gh run list --limit` does NOT reject an absurd value — it happily returns the branch's whole
 * history (335 runs on this repo today). Without a ceiling, `--max-runs 9007199254740991` turns one
 * question into hundreds of sequential artifact downloads. The bound belongs here, not in an
 * argument check, because every caller of queryBaseline inherits it.
 */
export const MAX_RUNS_CEILING = 50;
/** The default branch, preferring what the remote actually says over a guess at its name. */
export function resolveRef(cwd, override) {
    if (override)
        return override;
    try {
        const head = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (head.startsWith('origin/'))
            return head.slice('origin/'.length);
    }
    catch {
        // no origin/HEAD ref (a fresh clone that never ran `git remote set-head`) — fall through
    }
    return 'main';
}
/** Put a `--file` into the form the summary is keyed by: CWD-resolved, git-root-relative, POSIX. */
export function normaliseFilePath(cwd, path) {
    const { gitRoot } = detectGitRoot(cwd);
    // Same POSIX convention as the artifact's keys — a host separator here would miss every one.
    const rel = relative(gitRoot, resolve(cwd, path)).split(sep).join('/');
    return escapesRoot(rel) ? path : rel;
}
/**
 * Did `path` exist at `sha`? null when the answer cannot be established.
 *
 * The commit is probed first: an unfetched commit would otherwise report every path as absent.
 */
export function fileExistsAt(cwd, sha, path) {
    const has = (arg) => {
        try {
            execFileSync('git', ['cat-file', '-e', arg], { cwd, stdio: 'ignore' });
            return true;
        }
        catch {
            return false;
        }
    };
    if (!has(`${sha}^{commit}`))
        return null;
    return has(`${sha}:${path}`);
}
/**
 * The summary for one run, from cache or from GitHub. Keyed on runId + ATTEMPT, never sha: a re-run
 * keeps the sha, so a sha key would serve the pre-re-run answer after main was made green.
 */
export function loadSummary({ cwd, run, artifact, }) {
    const cacheFile = join(cwd, CACHE_DIR, `${run.databaseId}-${run.attempt}.json`);
    if (existsSync(cacheFile)) {
        try {
            // Re-validated, not trusted: `{}` parses, so JSON.parse alone would admit it.
            const label = `cached run ${run.databaseId}`;
            const cached = parseSummary(readFileSync(cacheFile, 'utf8'), label);
            // The FILENAME is not provenance: a correctly named entry can describe another run.
            assertProvenance(cached, { runId: run.databaseId, attempt: run.attempt }, label);
            return cached;
        }
        catch {
            // unreadable or non-conforming — fall through and refetch
        }
    }
    const summary = downloadSummary({
        cwd,
        runId: run.databaseId,
        attempt: run.attempt,
        artifact,
    });
    try {
        mkdirSync(join(cwd, CACHE_DIR), { recursive: true });
        writeFileAtomic(cacheFile, `${JSON.stringify(summary, null, 2)}\n`);
    }
    catch {
        // an unwritable cache costs a refetch, nothing more
    }
    return summary;
}
/** Resolve one file against a summary, splitting the three very different kinds of "did not run". */
function statusOf({ cwd, summary, run, path, }) {
    // hasOwn, not truthiness: `files.toString` is a FUNCTION on any JSON-parsed object, so a query
    // for a file named `toString` was answered with an inherited member instead of a real outcome.
    if (Object.hasOwn(summary.files, path))
        return { status: summary.files[path] };
    // Not collected by the runner. WHY matters: an agent reads an undifferentiated "did not run" as
    // reassurance, and a path typo would land in exactly that bucket.
    const exists = fileExistsAt(cwd, run.headSha, path);
    if (exists === null) {
        return {
            status: 'unknown',
            reason: `commit ${run.headSha.slice(0, 8)} is not in this checkout — run \`git fetch\` and retry`,
        };
    }
    if (!exists) {
        return { status: 'absent', reason: `no such path at ${run.headSha.slice(0, 8)}` };
    }
    return {
        status: 'excluded',
        reason: "existed at that commit but the test runner did not collect it (check the suite's include globs)",
    };
}
/**
 * Walk back for the most recent run in which `path` passed. Fetches only the small summary per run.
 */
function findLastPassed({ cwd, runs, artifact, path, }) {
    let searchedRuns = 0;
    let runsWithoutArtifact = 0;
    for (const run of runs) {
        if (!isUsableRun(run))
            continue;
        searchedRuns++;
        let summary;
        try {
            summary = loadSummary({ cwd, run, artifact });
        }
        catch {
            // STOP, do not skip. "The latest run in which it passed" is only knowable if every NEWER run
            // could be read; one unavailable run means an older pass is merely the latest we have
            // evidence for, which is a weaker claim than the field's name makes.
            runsWithoutArtifact++;
            break;
        }
        if (Object.hasOwn(summary.files, path) && summary.files[path] === 'passed') {
            return {
                lastPassed: { sha: run.headSha, runId: run.databaseId, attempt: run.attempt },
                lastPassedReason: 'found',
                searchedRuns,
                runsWithoutArtifact,
            };
        }
    }
    return {
        lastPassed: null,
        // A hole in the window is a fact about the DATA; a complete window is a fact about the FILE.
        lastPassedReason: runsWithoutArtifact > 0 ? 'no-artifact-history' : 'not-in-scanned-window',
        searchedRuns,
        runsWithoutArtifact,
    };
}
function unknownAnswer(ref, reason, detail) {
    return {
        runStatus: 'unknown',
        testsStatus: 'unknown',
        ref,
        runId: null,
        attempt: null,
        sha: null,
        failingFiles: [],
        skippedRuns: [],
        reason,
        detail,
    };
}
/** The whole query. Never throws for a knowable-unknown; the caller renders whatever comes back. */
export function queryBaseline({ cwd = process.cwd(), ref, file, workflow = DEFAULT_WORKFLOW, artifact = DEFAULT_ARTIFACT, maxRuns = DEFAULT_MAX_RUNS, } = {}) {
    const branch = resolveRef(cwd, ref);
    let runs;
    try {
        runs = listRuns({
            cwd,
            workflow,
            ref: branch,
            limit: Math.min(Math.max(maxRuns, 1), MAX_RUNS_CEILING),
        });
    }
    catch (e) {
        // `instanceof` rather than a cast: gh.mts is the only thrower here, but an unexpected throw must
        // still surface as a named unknown rather than reading a `reason` off something that has none.
        if (e instanceof GhUnavailable)
            return unknownAnswer(branch, e.reason, e.message);
        return unknownAnswer(branch, 'gh-failed', e instanceof Error ? e.message : String(e));
    }
    const skippedRuns = [];
    for (const run of runs) {
        if (!isUsableRun(run)) {
            skippedRuns.push({
                runId: run.databaseId,
                conclusion: run.conclusion || run.status,
                why: 'did not run to a pass/fail conclusion, so it carries no test report',
            });
            continue;
        }
        let summary;
        try {
            summary = loadSummary({ cwd, run, artifact });
        }
        catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            skippedRuns.push({ runId: run.databaseId, conclusion: run.conclusion, why });
            // "This run has no artifact" is a fact about the run, so walking on to an older one is right.
            // ANY other failure — including a native EACCES/ENOSPC that is not a GhUnavailable at all —
            // means evidence may exist but could not be read, and answering from an older run would
            // present a stale baseline as the current one.
            const isMissing = e instanceof GhUnavailable && e.reason === 'no-artifact';
            if (!isMissing) {
                const reason = e instanceof GhUnavailable ? e.reason : 'artifact-unreadable';
                const unknown = unknownAnswer(branch, reason, why);
                unknown.skippedRuns = skippedRuns;
                return unknown;
            }
            continue;
        }
        const answer = {
            runStatus: run.conclusion === 'success' ? 'green' : 'red',
            testsStatus: summary.testsPassed ? 'green' : 'red',
            ref: branch,
            runId: run.databaseId,
            attempt: run.attempt,
            sha: run.headSha,
            failingFiles: Object.entries(summary.files)
                .filter(([, outcome]) => outcome === 'failed')
                .map(([path]) => path)
                .sort(),
            skippedRuns,
        };
        if (file) {
            // Normalised ONCE so the lookup, the git probe and the walk-back cannot disagree on the key.
            const path = normaliseFilePath(cwd, file);
            // git resolves `<sha>:<path>` from the REPO ROOT, so the existence probe must run there too.
            const { gitRoot } = detectGitRoot(cwd);
            answer.file = {
                path,
                ...statusOf({ cwd: gitRoot, summary, run, path }),
                ...findLastPassed({ cwd, runs, artifact, path }),
            };
        }
        return answer;
    }
    const answer = unknownAnswer(branch, 'no-usable-run', `no run of ${workflow} on ${branch} in the last ${runs.length} carried a \`${artifact}\` artifact`);
    answer.skippedRuns = skippedRuns;
    return answer;
}
