/**
 * The PRODUCER side of the baseline oracle — `devkit test-report-run` (sc-2245).
 *
 * A CI log cannot answer "did THIS file fail?" here: the suite runs vitest inside vitest
 * (gate-engine/coverage/__tests__/produce.test.mts spawns a real child), so the log carries a second
 * "Test Files N failed" summary that no grep can attribute. Hence a structured per-file artifact.
 *
 * Vitest-only; the SUMMARY shape below is not, and `devkit baseline-status` reads only that.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { resolveVitest, runVitest } from '../../../gate-engine/coverage/produce.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';
/**
 * Every run writes into its OWN directory under here and nothing is ever published to a shared path.
 *
 * There is no stable pair to hand off, so a concurrent run cannot overwrite, clear, or interleave
 * with another's artifact, and a directory left by an earlier run cannot be uploaded as this run's
 * result — the reader selects by recorded provenance, not by filename.
 */
export const RUNS_DIR = '.devkit/test-reports';
/** vitest's full Jest-compatible report. Multi-MB for a suite this size — never fetched by a walk. */
export const REPORT_NAME = 'report.json';
/** The few-KB reduction `devkit baseline-status` actually reads. Both sides import this name. */
export const SUMMARY_NAME = 'summary.json';
/** Bumped only on a breaking change to the summary shape, so an old artifact is rejected, not misread. */
export const SUMMARY_SCHEMA = 1;
/** What the report says happened to one test FILE. Not the same as the run's overall conclusion. */
export const FILE_OUTCOMES = ['passed', 'failed', 'skipped'];
/** vitest's suite-level statuses, mapped to this artifact's vocabulary. Anything else is omitted. */
const REPORT_STATUS = {
    passed: 'passed',
    failed: 'failed',
    skipped: 'skipped',
    pending: 'skipped',
    todo: 'skipped',
};
/** Merge precedence when one file is reported by several projects: failed > passed > skipped. */
const OUTCOME_RANK = { skipped: 0, passed: 1, failed: 2 };
/** True when a repo-relative path leaves the root. Segment-wise: `..smoke.mts` is a real filename. */
export function escapesRoot(rel) {
    return rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith(`..${sep}`);
}
/** The flags this runner owns — forwarding them too would defeat the point of the command. */
export const RESERVED_FLAGS = ['--reporter', '--outputFile'];
/** True when the forwarded args try to set a flag this runner must control. */
export function reservesReporter(argv) {
    return argv.some((arg) => RESERVED_FLAGS.some((f) => arg === f || arg.startsWith(`${f}=`) || arg.startsWith(`${f}.`)));
}
/**
 * Reduce vitest's report to the summary artifact. Covered by baseline-status-edges.test.mts.
 */
export function summarise(report, cwd, env = process.env) {
    // Object.create(null), not `{}`: a test file named `constructor` or `toString` would otherwise
    // read back as an inherited Object.prototype member and be compared against as if it were an
    // outcome.
    const files = Object.create(null);
    let droppedForeignPaths = 0;
    for (const result of report.testResults ?? []) {
        if (!result?.name)
            continue;
        // POSIX separators always: the artifact is written by CI on Linux and may be read anywhere, so
        // one convention has to win and it is the artifact's.
        const rel = relative(cwd, resolve(cwd, result.name)).split(sep).join('/');
        // A leading `..` SEGMENT (or an absolute result) means the path escaped the root. Tested as a
        // segment, not a prefix: `..smoke.test.mts` is an ordinary filename, not an escape.
        if (escapesRoot(rel) || resolve(cwd, rel) !== resolve(cwd, result.name)) {
            droppedForeignPaths++;
            continue;
        }
        // Only vitest's OWN vocabulary maps to an outcome; anything else is omitted rather than folded
        // into `skipped`, which would assert a result we do not have. hasOwn, not a bare index: a status
        // of `toString` would otherwise return an inherited function and be stored as the outcome.
        const status = result.status ?? '';
        if (!Object.hasOwn(REPORT_STATUS, status))
            continue;
        // SAFETY: hasOwn above proves `status` is one of REPORT_STATUS's own keys.
        const outcome = REPORT_STATUS[status];
        // Fixed precedence, not arrival order — a file can be reported once per vitest project.
        const existing = files[rel];
        files[rel] = !existing || OUTCOME_RANK[outcome] > OUTCOME_RANK[existing] ? outcome : existing;
    }
    const runId = Number(env.GITHUB_RUN_ID);
    const attempt = Number(env.GITHUB_RUN_ATTEMPT);
    return {
        schema: SUMMARY_SCHEMA,
        sha: env.GITHUB_SHA ?? null,
        runId: Number.isFinite(runId) && runId > 0 ? runId : null,
        attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : null,
        // Only vitest's own run-level verdict counts. Its absence means a truncated or foreign report,
        // and deriving "everything passed" from whatever entries survived is the fabricated green.
        testsPassed: report.success === true,
        files,
        droppedForeignPaths,
    };
}
/**
 * Run the suite with a machine-readable reporter and write this run's two artifacts.
 */
export async function produceTestReport(cwd = process.cwd(), argv = []) {
    const vitest = resolveVitest(cwd);
    if (!vitest) {
        console.error('🚫 devkit test-report-run needs vitest — node_modules/.bin/vitest not found.');
        console.error('   This runner is vitest-only. `devkit baseline-status` is not: it reads the');
        console.error(`   ${SUMMARY_NAME} shape, so emit one with your own runner and query as normal.`);
        return 1;
    }
    if (reservesReporter(argv)) {
        console.error(`🚫 ${RESERVED_FLAGS.join(' / ')} are owned by \`devkit test-report-run\`.`);
        console.error('   Emitting the machine-readable report IS this command, and overriding the');
        console.error('   reporter set would silently drop the console summary or the PR annotations.');
        return 1;
    }
    // pid + clock + uuid: two calls in ONE process within the same millisecond would otherwise share a
    // directory and overwrite each other's report.
    const runDir = join(cwd, RUNS_DIR, `${process.pid}-${Date.now()}-${randomUUID()}`);
    const reportPath = join(runDir, REPORT_NAME);
    mkdirSync(runDir, { recursive: true });
    const code = await runVitest(vitest, [
        'run',
        '--reporter=default',
        '--reporter=github-actions',
        '--reporter=json',
        `--outputFile.json=${relative(cwd, reportPath)}`,
        ...argv,
    ], cwd);
    if (!existsSync(reportPath)) {
        console.error('⚠️  no test report was written — `devkit baseline-status` has no data for this');
        console.error('   run. Usually means the run was killed before the reporter flushed.');
        rmSync(runDir, { recursive: true, force: true });
        // Non-zero even when vitest passed: producing the artifact IS this command, so a green suite
        // with nothing to publish is a failed run of it. Mirrors `produceCoverage`'s same arm.
        return code === 0 ? 1 : code;
    }
    try {
        // SAFETY: written by vitest's own json reporter into a directory only this run holds, and every
        // VitestJsonReport field is optional — a disagreeing shape yields an empty summary, never a pass.
        const report = JSON.parse(readFileSync(reportPath, 'utf8'));
        writeFileAtomic(join(runDir, SUMMARY_NAME), `${JSON.stringify(summarise(report, cwd), null, 2)}\n`);
    }
    catch (e) {
        console.error(`⚠️  could not summarise the test report: ${e instanceof Error ? e.message : e}`);
        rmSync(runDir, { recursive: true, force: true });
        return code === 0 ? 1 : code;
    }
    return code;
}
