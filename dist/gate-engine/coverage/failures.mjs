import { execFileSync } from 'node:child_process';
import { commitIndexEnv } from '../ratchets/commit-index.mjs';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNHANDLED_NAME } from './unhandled-reporter.mjs';
/**
 * The regex handed to vitest's `--retry.condition`, which retries ONLY errors whose message matches.
 *
 * Deliberately narrow. A blanket `--retry` would launder genuine order-dependent and racy assertion
 * failures — the class most worth surfacing — into green, on a command consumers have already wired
 * into `test:run:coverage`. Scoped to the timeout shape it rescues the load artifact and nothing else:
 * verified against vitest 4.1.10 with one timeout flake and one `expect(2).toBe(99)` in the same file,
 * the timeout was retried and passed while the AssertionError was not retried and the run exited 1.
 */
export const RETRY_CONDITION = '(Test|Hook) timed out';
/** vitest's json-reporter output. Lands in the run directory, which only this run may touch. */
export const RESULTS_NAME = 'results.json';
/** devkit's own reporter, injected beside the json one. The compiled sibling under dist: Node will not
 * strip types from a file inside a consumer's node_modules. */
export const UNHANDLED_REPORTER = fileURLToPath(new URL(`./unhandled-reporter${import.meta.url.endsWith('.mts') ? '.mts' : '.mjs'}`, import.meta.url));
/** The advisory sidecar a CLEARING run leaves beside the artifact it removed. */
export const CLEAR_MARKER_NAME = '.last-clear.json';
/** vitest 4.1.10's json spelling of a test timeout (an upstream quirk, pinned by tests). Not unique
 * to timeouts, so it is only trusted alongside a retry — see the coverage-gate decision. */
export const TIMEOUT_FINGERPRINT = 'Error: STACK_TRACE_ERROR';
/** vitest 5's json spelling of the same attempt: the real message, budget included. Anchored, so an
 * assertion that merely quotes this text is not read as one. */
const ATTEMPT_TIMEOUT = /^Error: (?:Test|Hook) timed out in (\d+)ms\b/;
const isTimeoutAttempt = (message) => message.startsWith(TIMEOUT_FINGERPRINT) || ATTEMPT_TIMEOUT.test(message);
/** A whole-file beforeAll/afterAll timeout lands on the suite, value intact. */
const HOOK_TIMEOUT = /^Hook timed out in (\d+)ms/;
/** realpath where possible — vitest reports /private/tmp for a file created under /tmp on macOS. */
const canonical = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return resolve(p);
    }
};
/**
 * Read vitest's json report into the two facts worth printing.
 *
 * Returns null — say nothing — when the file is absent, unparseable, or not the shape we expect. An
 * older vitest silently ignores the dotted `--outputFile.json`, and a consumer who passed their own
 * `--reporter` never got ours, so "no report" is an ordinary outcome rather than an error. The gate
 * is unaffected either way: this is diagnosis, never verification.
 */
export function readDiagnosis(resultsFile, exitCode = 0) {
    try {
        const report = JSON.parse(readFileSync(resultsFile, 'utf8'));
        if (!Array.isArray(report?.testResults))
            return null;
        // A SET, not an array. vitest's `projects` put one file in the report once per project it
        // matches, so a suite run under two environments arrives twice — and every reader downstream (the
        // printed list, its count, the marker, the staged-diff answer) would repeat it. "2 test file(s)
        // failed: a.test.ts, a.test.ts" reads as two problems. Insertion order is preserved, so the list
        // still matches the order vitest reported.
        const failedFiles = new Set();
        const flaky = [];
        const failedTests = new Map();
        let allTimedOut = true;
        let timeoutMs = null;
        const observe = (ms) => {
            if (Number.isFinite(ms) && ms > 0)
                timeoutMs = Math.max(timeoutMs ?? 0, Math.round(ms));
        };
        for (const suite of report.testResults) {
            const file = suite?.name;
            if (!file)
                continue;
            let failed = false;
            for (const a of suite.assertionResults ?? []) {
                const messages = a?.failureMessages ?? [];
                if (a?.status === 'failed') {
                    failed = true;
                    const name = a.fullName ?? a.title ?? '';
                    failedTests.set(`${file}\0${name}`, { file, name });
                    if (messages.length >= 2 && messages.every(isTimeoutAttempt)) {
                        const budgets = messages.map((m) => ATTEMPT_TIMEOUT.exec(m)?.[1]);
                        if (budgets.every(Boolean)) {
                            for (const ms of budgets)
                                observe(Number(ms));
                        }
                        else {
                            // 4.1.10 hides the budget. `duration` is the SUM of every attempt, each run to the
                            // same ceiling; a missing duration divides to NaN, which observe() discards.
                            observe(Number(a.duration) / messages.length);
                        }
                    }
                    else {
                        allTimedOut = false;
                    }
                }
                else if (a?.status === 'passed' && messages.length > 0) {
                    // Passed, yet carrying the record of a failure: an earlier attempt threw and the retry
                    // rescued it. This is the ONLY place vitest exposes that, and it is why the flaky report
                    // can be exact rather than inferred from the console.
                    flaky.push({ file, name: a.fullName ?? a.title ?? '' });
                }
            }
            // A suite can fail with NO assertion results at all — a collection or import error kills the
            // file before any test runs. Naming the file is the point, so take the suite's own verdict too.
            if (suite.status === 'failed') {
                // The suite's own message is a file-level error: a hook timeout (readable, value and all),
                // or anything else — an import error, an afterAll assertion — which is not a timeout.
                const hook = HOOK_TIMEOUT.exec(suite.message ?? '');
                if (hook)
                    observe(Number(hook[1]));
                else if (suite.message || !failed)
                    allTimedOut = false;
            }
            if (failed || suite.status === 'failed')
                failedFiles.add(file);
        }
        const diagnosis = { failedFiles: [...failedFiles], flaky };
        if (failedFiles.size > 0) {
            diagnosis.failures = { tests: [...failedTests.values()], allTimedOut, timeoutMs };
        }
        else if (exitCode !== 0) {
            diagnosis.unhandled = readUnhandled(join(dirname(resultsFile), UNHANDLED_NAME), exitCode);
        }
        return diagnosis;
    }
    catch {
        // Absent, torn, or shaped unlike VitestReport. All three mean the same thing to the caller —
        // there is nothing to say — and none of them may cost somebody their test run.
        return null;
    }
}
/** The reporter's errors, once each (vitest projects repeat them), or one generic entry when it wrote
 * none: a threshold miss or an empty filter is no error at all, and an older vitest never calls it. */
function readUnhandled(file, exitCode) {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const unique = new Map(parsed.map((e) => [`${e.file}\0${e.message}`, e]));
        if (unique.size > 0)
            return [...unique.values()];
    }
    catch {
        /* absent or torn — fall through to the generic cause */
    }
    return [
        {
            file: null,
            message: `vitest exited ${exitCode} with no failed test — its output above names why: an unhandled error, a coverage threshold, or no test files matched`,
        },
    ];
}
/**
 * Absolute paths of the staged files, or null when git cannot answer.
 *
 * null is NOT an empty diff, and the caller must not collapse the two: an empty list licenses the
 * sentence "none of them are in your staged diff", which is a claim. devkit runs inside a repo it does
 * not own and may be invoked outside a work tree entirely — same reason sc-1959 ruled that a gate
 * which cannot run git must not report a missing catalog.
 */
export function stagedFiles(cwd) {
    const git = (args) => execFileSync('git', args, {
        cwd,
        env: commitIndexEnv(cwd),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
        const top = canonical(git(['rev-parse', '--show-toplevel']).trim());
        return git(['diff', '--cached', '--name-only', '-z'])
            .split('\0')
            .filter(Boolean)
            .map((p) => canonical(join(top, p)));
    }
    catch {
        return null;
    }
}
/** The short HEAD sha, or null outside a work tree. Recorded so a stale marker dates itself. */
export function headSha(cwd) {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    }
    catch {
        return null;
    }
}
/** Failed files that are also staged. null propagates: unknown stays unknown, never "none". */
export function stagedIntersection(failedFiles, staged) {
    if (staged === null)
        return null;
    const set = new Set(staged);
    return failedFiles.map(canonical).filter((f) => set.has(f));
}
/** Repo-relative where that is shorter and inside cwd; absolute otherwise. Paths are for humans. */
export function displayPath(file, cwd) {
    const rel = relative(canonical(cwd), canonical(file));
    return rel && !rel.startsWith('..') ? rel : file;
}
/** "4m", "2h", "3d" — how old the discarded artifact is, so its relevance is judgeable at a glance. */
export function humanAge(ms) {
    const mins = Math.max(0, Math.round(ms / 60_000));
    if (mins < 60)
        return `${mins}m`;
    const hours = Math.round(mins / 60);
    return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
/** The re-run budget never drops below this — the value that turned the field report green. */
export const RERUN_FLOOR_MS = 25_000;
/** How far above the observed ceiling a load-starved re-run is given. */
export const RERUN_MULTIPLIER = 5;
/** The re-run's timeout: observed ceiling × RERUN_MULTIPLIER, never below RERUN_FLOOR_MS. Observed,
 * not read from config — see the coverage-gate decision (sc-3473). */
export function raisedTimeoutMs(failures) {
    const observed = failures?.timeoutMs ?? 0;
    return Math.max(RERUN_FLOOR_MS, observed * RERUN_MULTIPLIER);
}
/** Enough to see the shape of a failure; short enough not to bury vitest's own summary. */
const MAX_LISTED_FILES = 10;
const markerPath = (coverageDir) => join(coverageDir, CLEAR_MARKER_NAME);
/** Best-effort: an unwritable marker must never fail somebody's test run. Advisory data only. */
export function writeClearMarker(coverageDir, marker) {
    try {
        writeFileSync(markerPath(coverageDir), `${JSON.stringify(marker, null, 2)}\n`);
    }
    catch {
        /* diagnosis is a courtesy, not a guarantee */
    }
}
export function removeClearMarker(coverageDir) {
    try {
        rmSync(markerPath(coverageDir), { force: true });
    }
    catch {
        /* see writeClearMarker */
    }
}
/** The part of a marker that says why the run ended. Every key is set, so spreading it over an older
 * marker replaces a stale unhandled list too (an undefined value is dropped on write). */
export function markerCause(diagnosis) {
    return {
        failedFiles: diagnosis?.failedFiles ?? [],
        unhandledErrors: diagnosis?.unhandled,
    };
}
/** A marker entry we could have written; anything else came from a hand edit and is dropped. */
const isUnhandledError = (e) => e?.constructor === Object &&
    String(e.message) === e.message &&
    (e.file === null || String(e.file) === e.file);
/** The marker, or null when absent/corrupt. Never throws — the gate's verdict cannot depend on it. */
export function readClearMarker(coverageDir) {
    const file = markerPath(coverageDir);
    if (!existsSync(file))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        // clearedAt is the marker's identity — a payload without one is some other file that happens to
        // share the name, and inventing a timestamp for it would date the gate's message wrongly.
        if (!parsed?.clearedAt)
            return null;
        return {
            clearedAt: parsed.clearedAt,
            previousMtime: parsed.previousMtime ?? null,
            head: parsed.head ?? null,
            failedFiles: Array.isArray(parsed.failedFiles) ? parsed.failedFiles : [],
            ...(Array.isArray(parsed.unhandledErrors) && {
                unhandledErrors: parsed.unhandledErrors.filter(isUnhandledError),
            }),
        };
    }
    catch {
        return null;
    }
}
/** The producer's post-run lines: what failed, whether it is yours, and whether it is load. Timeouts
 * are named only where provable — a retry rescue, or a FailureVerdict that proves every part timed out. */
export function formatDiagnosis(diagnosis, cwd, staged) {
    const lines = [];
    if (diagnosis.flaky.length > 0) {
        lines.push(`⚠️  ${diagnosis.flaky.length} test(s) passed only on retry — the suite is flaking, not green:`);
        for (const t of diagnosis.flaky)
            lines.push(`     ${displayPath(t.file, cwd)} > ${t.name}`);
        lines.push('   These timed out rather than failing an assertion, which is the load-flake shape.');
        lines.push('   If it recurs, lower parallelism (--maxWorkers=50%) or raise testTimeout.');
    }
    if (diagnosis.failedFiles.length > 0) {
        lines.push(`🚫 ${diagnosis.failedFiles.length} test file(s) failed:`);
        for (const f of diagnosis.failedFiles.slice(0, MAX_LISTED_FILES)) {
            lines.push(`     ${displayPath(f, cwd)}`);
        }
        const hidden = diagnosis.failedFiles.length - MAX_LISTED_FILES;
        if (hidden > 0)
            lines.push(`     …and ${hidden} more`);
        lines.push(...stagedSentence(diagnosis.failedFiles, staged, cwd));
        // Said HERE, where the run failed — not only after a rescue — so the remedy arrives before the
        // next full run is spent rather than after it (sc-3473).
        if (diagnosis.failures?.allTimedOut) {
            lines.push('   Every failure timed out — the load-flake shape, not a broken test.');
            lines.push(`   Re-run with a bigger budget: -- --testTimeout=${raisedTimeoutMs(diagnosis.failures)} --maxWorkers=50%`);
        }
    }
    if (diagnosis.unhandled) {
        lines.push('🚫 vitest exited non-zero, but no test failed — the run ended on:');
        lines.push(...formatUnhandled(diagnosis.unhandled, cwd).slice(0, MAX_LISTED_FILES));
        const hidden = diagnosis.unhandled.length - MAX_LISTED_FILES;
        if (hidden > 0)
            lines.push(`     …and ${hidden} more`);
        const files = diagnosis.unhandled.flatMap((e) => (e.file ? [e.file] : []));
        if (files.length > 0)
            lines.push(...stagedSentence(files, staged, cwd));
        lines.push('   The coverage artifact was discarded: devkit publishes only from a run vitest calls green.');
    }
    return lines;
}
/** Whether the named files are yours. Silent when git cannot answer: unknown is never "none". */
function stagedSentence(files, staged, cwd) {
    const mine = stagedIntersection(files, staged);
    if (mine === null)
        return [];
    return [
        mine.length === 0
            ? '   None of them are in your staged diff.'
            : `   In your staged diff: ${mine.map((f) => displayPath(f, cwd)).join(', ')}`,
    ];
}
const formatUnhandled = (errors, cwd) => errors.map((e) => `     ${e.file ? displayPath(e.file, cwd) : 'file unknown'} — ${e.message}`);
/** The gate's extra lines when the artifact is absent BECAUSE a failed run discarded it. */
export function formatClearMarker(marker, cwd, now = Date.now()) {
    const age = humanAge(now - Date.parse(marker.clearedAt));
    const at = Number.isNaN(Date.parse(marker.clearedAt)) ? marker.clearedAt : `${age} ago`;
    const head = marker.head ? ` (HEAD ${marker.head})` : '';
    const lines = [
        `   The previous artifact was discarded by a test run that produced no report,`,
        `   ${at}${head}.`,
    ];
    if (marker.failedFiles.length > 0) {
        lines.push(`   Failed: ${marker.failedFiles.map((f) => displayPath(f, cwd)).join(', ')}`);
    }
    if (marker.unhandledErrors?.length) {
        lines.push('   No test failed; the run ended on:');
        lines.push(...formatUnhandled(marker.unhandledErrors, cwd).slice(0, MAX_LISTED_FILES));
    }
    return lines;
}
/** Said BEFORE the second pass starts: what is about to happen, why, and how to refuse it. */
export function formatRerunNotice(budgetMs) {
    return [
        `🔁 Every failure timed out, so re-running the whole suite ONCE at testTimeout=${budgetMs}ms.`,
        '   A retry cannot help here: vitest re-runs a timed-out test at the same ceiling, and under',
        '   load it starves again. The artifact is published only if this complete run passes.',
        '   Opt out with DEVKIT_COVERAGE_NO_RERUN=1 or --retry=0, or pass your own --testTimeout.',
        '   Still starving? Also lower parallelism: -- --maxWorkers=50%',
    ];
}
/** Said AFTER a green second pass: what only the bigger budget got through — flaky, not green. */
export function formatRerunRescue(first, cwd, budgetMs) {
    const tests = first?.failures?.tests ?? [];
    const files = first?.failedFiles ?? [];
    const items = tests.length > 0
        ? tests.map((t) => `${displayPath(t.file, cwd)} > ${t.name}`)
        : files.map((f) => displayPath(f, cwd));
    if (items.length === 0)
        return [];
    const lines = [
        `⚠️  ${items.length} ${tests.length > 0 ? 'test(s)' : 'file(s)'} passed only at the raised timeout (${budgetMs}ms) — the suite is flaking, not green:`,
    ];
    for (const item of items.slice(0, MAX_LISTED_FILES))
        lines.push(`     ${item}`);
    const hidden = items.length - MAX_LISTED_FILES;
    if (hidden > 0)
        lines.push(`     …and ${hidden} more`);
    return lines;
}
