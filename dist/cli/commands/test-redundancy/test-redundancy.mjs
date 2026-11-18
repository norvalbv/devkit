/** `devkit test-redundancy` — which tests in the changed test files catch nothing that another
 * test does not already catch. Advisory: it reports fallow's kill-matrix evidence and never blocks. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { addedProductionLines, diffClassifier } from '../../../gate-engine/coverage/diff-gate.mjs';
import { emitGateEvent } from '../../../gate-engine/judge/gate-events.mjs';
import { detectFallow, FALLOW_PINNED_VERSION } from '../../lib/install/install-fallow.mjs';
import { gitRunner, line, ok } from '../../lib/ship/base-drift/git-run.mjs';
import { mergeBaseOf, nulList } from '../coverage/diff.mjs';
import { changedLines, killMatrixReport, redundancy, } from './report.mjs';
/** The first fallow release with `mutation --kill-matrix-for`. */
const FALLOW_FLOOR = [3, 40, 0];
const DEFAULT_BUDGET = '4m';
const MAX_UNCAUGHT = 10;
export const meta = {
    name: 'test-redundancy',
    agentFacing: true,
    summary: 'Changed lines no test catches, and changed tests that catch nothing new.',
    help: `devkit test-redundancy — which lines you changed no test catches, and which tests in the
changed test files catch no failure that another test does not already catch.

Usage:
  devkit test-redundancy [--base <ref>] [--time-budget <duration>] [-- <source path>...]

  --base <ref>              Compare against the merge-base of HEAD and <ref>. Default as
                            \`devkit coverage-diff\`.
  --time-budget <duration>  Stop starting mutants after this long, for example 90s or 10m. The
                            warm-up run of the test suite gets the same limit. Default ${DEFAULT_BUDGET}.
  -- <source path>...       The source files to mutate. Default: the production files the change
                            touches. Name them when the change touches test files only.

It runs \`fallow mutation --kill-matrix-for\` (fallow 3.40.0 or later): fallow plants small bugs in
the source, runs the whole test suite against each, and records which tests catch which bug. Run it
before you ship, after your last test edit.

  not caught     A planted bug on a line you changed that no test failed on, or a changed line no
                 test runs. This is where a test is missing or weak, and the best-evidenced of the
                 signals here. Add or strengthen a test, or note why the change cannot matter: some
                 planted bugs do not alter behaviour. The first ${MAX_UNCAUGHT} are listed, then a count.
  changed lines  How many planted bugs landed on lines you changed and how many ran. A run cut
                 short by the time budget says so; an empty list is then not a pass.
  redundant      Other tests already catch every bug this test catches. Review each one on its
                 own: two tests with equal evidence are both listed, so deleting both removes the
                 protection. This prompts a review; it never tells you to delete a test.
  kills nothing  The test ran the code and caught no planted bug. It may guard data or a removal
                 that no planted bug expresses; keep it only with that reason stated.
  not judged     fallow's evidence was incomplete, with its reason. This is never a pass.

Every flagged test in the changed test files is listed, including tests that were there before the
change. The report does not say which tests the change added.

Exit code: always 0. A wrong argument, a base that cannot be resolved and a directory outside a git
repository each print why nothing was judged.`,
};
/** fallow on PATH, then the project's own copy; a missing binary is a null status, never a throw. */
function runFallow(args, cwd) {
    for (const [cmd, prefix] of [
        ['fallow', []],
        ['npx', ['--no-install', 'fallow']],
    ]) {
        const r = spawnSync(cmd, [...prefix, ...args], {
            cwd,
            encoding: 'utf8',
            maxBuffer: 512 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        if (!r.error)
            return { status: r.status, stdout: r.stdout ?? '' };
    }
    return { status: null, stdout: '' };
}
function parseOptions(args) {
    const opts = { budget: DEFAULT_BUDGET, sources: [] };
    for (let i = 0; i < args.length; i += 1) {
        const flag = args[i];
        if (flag === '--') {
            opts.sources = args.slice(i + 1);
            break;
        }
        const value = args[i + 1];
        if (flag === '--base' && value)
            opts.base = value;
        else if (flag === '--time-budget' && value)
            opts.budget = value;
        else
            return { error: `unknown or incomplete argument: ${flag}` };
        i += 1;
    }
    return opts;
}
function atLeastFloor(version) {
    const parts = version.split('.').map((n) => Number.parseInt(n, 10));
    for (let i = 0; i < FALLOW_FLOOR.length; i += 1) {
        const have = parts[i] ?? 0;
        if (have !== FALLOW_FLOOR[i])
            return have > FALLOW_FLOOR[i];
    }
    return true;
}
const notJudged = (why, outcome = 'not_judged') => ({
    stop: `Not judged: ${why}`,
    outcome,
});
/** The change's test files and the source to mutate, or the one line that says why not. */
function findChange(cwd, opts) {
    const topResult = gitRunner(cwd)(['rev-parse', '--show-toplevel']);
    if (!ok(topResult))
        return notJudged('not inside a git repository.');
    const top = realpathSync(line(topResult));
    const here = realpathSync(cwd);
    const run = gitRunner(top);
    const mb = mergeBaseOf(run, opts.base);
    if ('error' in mb)
        return notJudged(`${mb.error}.`);
    const listed = run(['ls-files', '-z', '--others', '--exclude-standard']);
    const diffed = run(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=AM', mb.sha]);
    if (!ok(listed) || !ok(diffed))
        return notJudged('git could not list the changed files.');
    const untracked = nulList(listed.stdout);
    const changed = [...nulList(diffed.stdout), ...untracked];
    const classify = diffClassifier(cwd, top);
    const tests = changed.filter((p) => classify(p, false) === 'test');
    if (tests.length === 0) {
        return {
            stop: `No test file changed since ${mb.label}; nothing to judge.`,
            outcome: 'no_test_change',
        };
    }
    const fromHere = (p) => relative(here, join(top, p));
    const sources = opts.sources.length
        ? opts.sources
        : changed.filter((p) => classify(p, false) === 'production').map(fromHere);
    if (sources.length === 0) {
        return notJudged('the change touches no production source. Name the source these tests cover: devkit test-redundancy -- <source path>...');
    }
    const isProduction = (p) => classify(p, false) === 'production';
    const head = run(['rev-parse', '--verify', '-q', 'HEAD']);
    const status = run(['status', '--porcelain', '-z']);
    const change = {
        testFiles: tests.length,
        targets: tests.map(fromHere),
        sources,
        head: ok(head) ? line(head) : undefined,
        dirty: ok(status) ? status.stdout.length > 0 : undefined,
    };
    let added;
    try {
        added = addedProductionLines(top, isProduction, [mb.sha]);
    }
    catch {
        return { ...change, isChanged: null };
    }
    const newFiles = new Set(untracked.filter(isProduction));
    const isChanged = (file, lineNo) => {
        const path = relative(top, join(here, file));
        return newFiles.has(path) || (added.get(path)?.has(lineNo) ?? false);
    };
    return { ...change, isChanged };
}
/** fallow's kill-matrix report for the change, or why fallow could not give one. */
function askFallow(deps, cwd, change, budget) {
    const { available, version } = deps.detect({ cwd });
    if (!available || !version) {
        return notJudged('fallow was not found. `devkit init` installs it.', 'fallow_missing');
    }
    if (!atLeastFloor(version)) {
        const why = `fallow ${version} has no --kill-matrix-for; it needs ${FALLOW_FLOOR.join('.')} or later. devkit installs ${FALLOW_PINNED_VERSION} on a machine with no fallow and leaves an installed one alone, so upgrade yours, for example: bun add -g fallow@${FALLOW_PINNED_VERSION}`;
        return { ...notJudged(why, 'fallow_too_old'), version };
    }
    const ran = deps.runFallow([
        'mutation',
        ...change.sources,
        ...change.targets.flatMap((t) => ['--kill-matrix-for', t]),
        '--allow-dirty',
        '--time-budget',
        budget,
        '--setup-timeout',
        budget,
        '--format',
        'json',
        '--quiet',
    ], cwd);
    let parsed;
    try {
        parsed = killMatrixReport.safeParse(JSON.parse(ran.stdout));
    }
    catch {
        // Falls through: output that is not JSON is no report.
    }
    if (!parsed?.success) {
        return { ...notJudged(`fallow printed no report (exit ${ran.status ?? 'none'}).`), version };
    }
    const report = parsed.data;
    if (report.error) {
        return { ...notJudged(`fallow could not run: ${report.message ?? 'no message'}`), version };
    }
    return { version, report };
}
/** Prints the changed-line section and returns how many planted bugs it listed as not caught, or
 * null when git could not read the diff. */
function printChangedLines(report, isChanged) {
    if (!isChanged) {
        console.log('  changed lines  not judged: git could not read the diff.');
        return null;
    }
    const { uncaught, planned, ran } = changedLines(report, isChanged);
    for (const u of uncaught.slice(0, MAX_UNCAUGHT)) {
        console.log(`  not caught     ${u.file}:${u.line}  ${u.what}`);
    }
    if (uncaught.length > MAX_UNCAUGHT) {
        console.log(`  not caught     ... and ${uncaught.length - MAX_UNCAUGHT} more on changed lines`);
    }
    console.log(`  changed lines  ${uncaught.length} not caught of ${ran} planted bugs that ran (${planned} planned)`);
    if (ran < planned) {
        console.log(`                 ${planned - ran} did not run before the time budget, so those lines may be untested.`);
    }
    return uncaught.length;
}
/** The telemetry row for a run fallow answered: `judged` only when every changed test file was judged
 * and every planted bug ran, `partial` when some of it was not, `no_target_complete` when none was. */
function runEvent({ version, report }, change, { flagged, unjudged }, uncaught) {
    const total = report.summary?.counts?.total ?? undefined;
    const pending = report.summary?.counts?.pending ?? undefined;
    const listed = report.kill_matrix?.targets?.length ?? 0;
    let outcome = 'judged';
    if (listed === unjudged.length)
        outcome = 'no_target_complete';
    else if (unjudged.length ||
        listed < change.testFiles ||
        total === undefined ||
        pending === undefined ||
        pending > 0) {
        outcome = 'partial';
    }
    const verdicts = (v) => flagged.filter((t) => t.verdict === v).length;
    const tested = outcome !== 'no_target_complete';
    return {
        outcome,
        fallow_version: version,
        mutants_total: total,
        mutants_ran: total === undefined || pending === undefined ? undefined : total - pending,
        redundant: tested ? verdicts('redundant') : undefined,
        kills_nothing: tested ? verdicts('kills nothing') : undefined,
        changed_uncaught: uncaught ?? undefined,
    };
}
function printReport(answer, change) {
    const { version, report } = answer;
    const result = redundancy(report);
    const { flagged, unjudged, judged } = result;
    const counts = report.summary?.counts;
    const mutants = counts?.total ?? 0;
    const done = mutants - (counts?.pending ?? 0);
    const seconds = Math.round((report.elapsed_ms ?? 0) / 1000);
    console.log(`fallow ${version}: ${done} of ${mutants} planted bugs ran in ${seconds}s, ${judged} tests judged in ${change.testFiles} changed test file(s).`);
    const uncaught = printChangedLines(report, change.isChanged);
    for (const t of flagged) {
        console.log(`  ${t.verdict.padEnd(13)}  ${t.testId}`);
    }
    if (judged > 0 && flagged.length === 0)
        console.log('  No judged test is redundant.');
    for (const u of unjudged) {
        console.log(`  not judged     ${u.target} (${u.tests} tests): ${u.reasons.join(', ')}`);
    }
    if (flagged.length || uncaught) {
        console.log('What each word means: devkit help test-redundancy');
    }
    return runEvent(answer, change, result, uncaught);
}
const stopped = ({ stop, outcome, version }) => {
    console.log(stop);
    return { outcome, fallow_version: version };
};
function judge(deps, cwd, opts) {
    const change = findChange(cwd, opts);
    if ('stop' in change)
        return stopped(change);
    const answer = askFallow(deps, cwd, change, opts.budget);
    const event = 'stop' in answer ? stopped(answer) : printReport(answer, change);
    return { ...event, head: change.head, dirty: change.dirty };
}
export default function testRedundancy(args, cwd, deps = { detect: detectFallow, runFallow }) {
    const opts = parseOptions(args);
    if ('error' in opts) {
        console.log(`Not judged: ${opts.error}\n\n${meta.help}`);
        return 0;
    }
    const started = Date.now();
    const event = judge(deps, cwd, opts);
    // Set after fallow ran, so the consumer's test suite never inherits it.
    process.env.DEVKIT_AGENT_RUN_ID ||= `test-redundancy-${randomUUID()}`;
    emitGateEvent({ type: 'test_redundancy_run', ...event, wall_ms: Date.now() - started });
    return 0;
}
