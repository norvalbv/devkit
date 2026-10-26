/** `devkit baseline-status` per-file and per-test verdicts, from one run's summary. */
import { execFileSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { detectGitRoot } from '../detect-git-root.mjs';
import { escapesRoot } from './produce.mjs';
/** The console prints `<file> > describe > test`; the summary stores `describe > test`. */
export function normaliseTestName(name, path) {
    const prefix = `${path} > `;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
/** A failed file's recorded names. parseSummary has already dropped a malformed `tests` map. */
function recordedTests(summary, path) {
    if (!summary.tests)
        return { missing: 'no-data' };
    if (!Object.hasOwn(summary.tests, path))
        return { missing: 'not-recorded' };
    return summary.tests[path];
}
export function failingTestsOf(summary, path) {
    const tests = recordedTests(summary, path);
    if ('missing' in tests)
        return {};
    return tests.truncated
        ? { failingTests: tests.failed, failingTestsTruncated: true }
        : { failingTests: tests.failed };
}
/** One test's answer, given its file's status in the same run. */
export function testVerdict(summary, fileStatus, path, rawName) {
    const name = normaliseTestName(rawName, path);
    const unknown = (reason) => ({ name, status: 'unknown', reason });
    if (fileStatus === 'passed') {
        return {
            name,
            status: 'file-passed',
            reason: 'the file passed; test names are recorded only for failed files',
        };
    }
    if (fileStatus !== 'failed')
        return unknown(`the file is ${fileStatus} in this run`);
    const tests = recordedTests(summary, path);
    if ('missing' in tests) {
        return unknown(tests.missing === 'no-data'
            ? 'this run recorded no test names (its producer does not record them, or predates them)'
            : 'names for this file exceeded the summary budget');
    }
    if (tests.failed.includes(name))
        return { name, status: 'failed' };
    if (tests.passed.includes(name))
        return { name, status: 'passed' };
    const capped = tests.truncated ? "; this file's name list was capped" : '';
    return unknown(`not in this run's report (misspelt, renamed, skipped or not collected${capped})`);
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
/** Resolve one file against a summary at commit `sha`, splitting the kinds of "did not run". */
export function statusOf({ cwd, summary, sha, path, }) {
    // hasOwn, not truthiness: `files.toString` is a FUNCTION on any JSON-parsed object, so a query
    // for a file named `toString` was answered with an inherited member instead of a real outcome.
    if (Object.hasOwn(summary.files, path))
        return { status: summary.files[path] };
    if (sha === null) {
        return {
            status: 'unknown',
            reason: 'the run tested a merge commit its summary did not record',
        };
    }
    // Not collected by the runner. WHY matters: an agent reads an undifferentiated "did not run" as
    // reassurance, and a path typo would land in exactly that bucket.
    const exists = fileExistsAt(cwd, sha, path);
    if (exists === null) {
        return {
            status: 'unknown',
            reason: `commit ${sha.slice(0, 8)} is not in this checkout — run \`git fetch origin ${sha}\` and retry`,
        };
    }
    if (!exists) {
        return { status: 'absent', reason: `no such path at ${sha.slice(0, 8)}` };
    }
    return {
        status: 'excluded',
        reason: "existed at that commit but the test runner did not collect it (check the suite's include globs)",
    };
}
