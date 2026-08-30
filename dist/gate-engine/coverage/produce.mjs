/**
 * The PRODUCER side of the coverage gate — `devkit coverage-run`.
 *
 * gate-engine/coverage/run.mts reads `coverage/coverage-final.json`; this module is what puts a
 * trustworthy one there when several agents share one working tree, which is devkit's stated premise
 * (cli/lib/ship/ship-branch.sh: "parallel agents share one working tree").
 *
 * WHY it exists (sc-1214): vitest derives its coverage temp dir as `resolve(reportsDirectory, '.tmp')`
 * and deletes it TWICE per run — `clean()` at startup takes the whole reportsDirectory (`clean: true`
 * is the default), and `cleanAfterRun()` takes `.tmp` again at the end. With the conventional
 * `reportsDirectory: './coverage'`, two runs in one checkout share one `.tmp` and either sweep can
 * land inside the other's lifetime. Reproduced: the run that dies is the one that started SECOND,
 * killed by the first one FINISHING, with "Something removed the coverage directory ... Vitest
 * created earlier" and an ENOENT unhandled rejection. A consumer that selected the fail-CLOSED
 * coverage gate then cannot satisfy it at all while a sibling agent is testing.
 *
 * The fix needs NO change to the consumer's vitest config: `--coverage.reportsDirectory=<dir>` on the
 * command line overrides whatever the config file says, so each run gets `coverage/.runs/<unique>`
 * and republishes to the stable path afterwards. That keeps this a devkit-owned fix rather than one
 * every consumer has to re-implement.
 *
 * Run dirs live under `coverage/` (not os.tmpdir()) so publishing is a same-filesystem rename — atomic,
 * so a reader never sees a torn report — and so the consumer's existing `coverage` gitignore entry
 * already covers them.
 *
 * Vitest-only ON PURPOSE. The gate itself is runner-agnostic (it reads an istanbul-shaped JSON, which
 * jest/c8/nyc also emit), so this refuses loudly rather than guessing when vitest is absent.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, } from 'node:fs';
import { basename, join } from 'node:path';
import { emitGateEvent } from '../judge/gate-events.mjs';
import { formatDiagnosis, headSha, readDiagnosis, removeClearMarker, RESULTS_NAME, RETRY_CONDITION, stagedFiles, writeClearMarker, } from './failures.mjs';
export const COVERAGE_DIR = 'coverage';
export const REPORT_NAME = 'coverage-final.json';
/** The artifact path the coverage GATE reads. Single source of truth for both sides. */
export const COVERAGE_FILE = `${COVERAGE_DIR}/${REPORT_NAME}`;
export const RUNS_DIR = `${COVERAGE_DIR}/.runs`;
/** Long enough it can never catch a live run; short enough that killed runs don't pile up. */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000;
/** Forwarded to the vitest child so a Ctrl-C'd run leaves no run directory and no stale report. */
const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'];
/**
 * This run's reports directory, absolute. pid alone is not enough — pids are recycled and two runs
 * can start in the same millisecond — hence the random suffix.
 */
export function resolveRunDir(cwd, pid = process.pid, now = Date.now()) {
    return join(cwd, RUNS_DIR, `${pid}-${now}-${Math.random().toString(36).slice(2, 8)}`);
}
/**
 * Drop run directories left behind by killed runs. Best-effort: a live sibling may delete a directory
 * between our readdir and our stat, and losing that race is not a reason to fail somebody's tests.
 */
export function pruneStaleRuns(cwd, now = Date.now(), maxAgeMs = STALE_RUN_MS) {
    let entries;
    try {
        entries = readdirSync(join(cwd, RUNS_DIR), { withFileTypes: true });
    }
    catch {
        return 0; // no .runs/ yet
    }
    let pruned = 0;
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const dir = join(cwd, RUNS_DIR, entry.name);
        try {
            if (now - statSync(dir).mtimeMs < maxAgeMs)
                continue;
            rmSync(dir, { recursive: true, force: true });
            pruned++;
        }
        catch {
            // raced with a sibling, or not ours to remove
        }
    }
    return pruned;
}
/** The stable artifact's mtime, or null when there is none. Snapshot this BEFORE the run starts. */
export function snapshotArtifact(cwd) {
    try {
        return statSync(join(cwd, COVERAGE_FILE)).mtimeMs;
    }
    catch {
        return null;
    }
}
/**
 * Move this run's report to the stable path — the step that keeps the gate honest.
 *
 * Returns WHICH of the three things happened. `cleared` and `kept` are both "no report published",
 * but they are opposite facts about the artifact — one was destroyed by us, one was a sibling's and
 * survived — and only `cleared` may leave a marker saying so (sc-2298). Collapsing them, as the old
 * boolean did, is what would make that marker lie on the non-interference path.
 *
 * When the run produced NO report (tests failed; vitest's `reportOnFailure` is false by default, so
 * nothing is written) it removes the stale artifact rather than leaving the previous run's behind —
 * UNLESS a sibling replaced it while we were running.
 *
 * Two properties have to hold at once, and `before` (from snapshotArtifact, taken before the run)
 * is what reconciles them:
 *
 *  - FAIL-CLOSED. While reportsDirectory was `./coverage`, vitest's startup `rm -rf` had already
 *    wiped the old report, so a failed run left no artifact and the gate blocked — the behaviour
 *    docs/decisions/coverage-gate.md exists to protect. Publishing per-run without any clear would
 *    silently convert that gate to fail-OPEN.
 *  - NO CROSS-RUN DESTRUCTION. An artifact that CHANGED during our run belongs to a sibling that
 *    succeeded while we were going. Deleting it would let a failing run destroy a passing run's
 *    result — reintroducing, at the artifact level, the interference this module exists to remove.
 *
 * IDENTITY, NOT WALL-CLOCK. An earlier cut compared the artifact's mtime against the run's start
 * time, which is unsound: `Date.now()` is millisecond-truncated while mtimes carry sub-millisecond
 * precision, so an artifact written in the SAME millisecond the run started reads as "newer" and
 * survives — a fail-open whose likelihood depends on how fast the machine is. Comparing the mtime to
 * the one observed before the run is exact: unchanged means it is the very file we started with.
 *
 * CLAIM FIRST, INSPECT SECOND. `stat` then `unlink` would be a TOCTOU: a sibling can publish in the
 * gap and we would delete the good report it just wrote. `rename` is atomic, so the claim has exactly
 * one winner and nothing arriving afterwards can be destroyed by us.
 */
export function publishCoverage(runDir, cwd, before, failedFiles = []) {
    const fresh = join(runDir, REPORT_NAME);
    const stable = join(cwd, COVERAGE_FILE);
    const coverageDir = join(cwd, COVERAGE_DIR);
    if (existsSync(fresh)) {
        mkdirSync(coverageDir, { recursive: true });
        renameSync(fresh, stable);
        // A fresh report answers every question the marker existed to answer; leaving it would let the
        // gate narrate an old failure over a current pass.
        removeClearMarker(coverageDir);
        return 'published';
    }
    // The claim target sits BESIDE `stable` in coverage/, never inside runDir. vitest's
    // `cleanAfterRun()` removes the reports directory whenever it ends up empty — precisely what a
    // failed run leaves behind, the case this clear exists for. Renaming into a directory vitest just
    // deleted throws ENOENT, the catch swallows it, and the stale artifact survives. Beside it, the
    // directory is guaranteed to exist (it holds `stable`) and stays on one filesystem, so the rename
    // is still atomic.
    const claimed = join(cwd, COVERAGE_DIR, `.cleared-${basename(runDir)}-${REPORT_NAME}`);
    try {
        renameSync(stable, claimed);
    }
    catch {
        return 'kept'; // nothing to clear, or a sibling claimed it first
    }
    try {
        // Appeared from nothing, or changed under us ⇒ a sibling's successful report ⇒ put it back.
        if (before === null || statSync(claimed).mtimeMs !== before) {
            renameSync(claimed, stable);
            return 'kept';
        }
    }
    catch {
        // Unreadable/unrestorable — fall through and drop it; an artifact we cannot vouch for must not
        // be left where the gate would trust it.
    }
    // BEFORE the removal, and only on this branch. 'kept' means a sibling's good report survived, so a
    // marker there would tell the next reader an artifact was discarded when one was deliberately
    // preserved — a lie about the exact non-interference property sc-1214 spent three cuts securing.
    // Writing it first also means the artifact can never be gone with nothing explaining why.
    writeClearMarker(coverageDir, {
        clearedAt: new Date().toISOString(),
        previousMtime: before,
        head: headSha(cwd),
        failedFiles,
    });
    rmSync(claimed, { force: true });
    return 'cleared';
}
/** The consumer's vitest binary, or null when this repo doesn't have one. */
export function resolveVitest(cwd) {
    const bin = join(cwd, 'node_modules', '.bin', 'vitest');
    return existsSync(bin) ? bin : null;
}
/**
 * Run vitest to completion and return the code the caller should exit with.
 *
 * Shared with cli/lib/baseline-status/produce.mts, devkit's other vitest runner.
 */
export async function runVitest(bin, args, cwd) {
    const child = spawn(bin, args, { cwd, stdio: 'inherit' });
    // A Ctrl-C'd run must not leave a run directory behind, nor a stale report the gate would trust.
    // Removed in `finally` because a caller can outlive the run (sc-2228): Node suppresses default
    // terminate-on-signal while a listener exists, so a leaked one stops the HOST answering SIGTERM.
    const forwarders = INTERRUPT_SIGNALS.map((signal) => [signal, () => void child.kill(signal)]);
    for (const [signal, forward] of forwarders)
        process.on(signal, forward);
    try {
        return await new Promise((done) => {
            child.on('error', (err) => {
                console.error(`🚫 could not start vitest: ${err.message}`);
                done(1);
            });
            // `signal ? 1` matters: a killed child reports exitCode null, which `?? 1` alone would keep,
            // but an explicit 0 from a child that was ALSO signalled must not read as success.
            child.on('close', (exitCode, signal) => done(signal ? 1 : (exitCode ?? 1)));
        });
    }
    finally {
        for (const [signal, forward] of forwarders)
            process.off(signal, forward);
    }
}
/** The flag this runner owns — passing it too is what isolation MEANS, so it cannot be delegated. */
export const RESERVED_FLAG = '--coverage.reportsDirectory';
/** True when the forwarded args try to set the one option this runner must control. */
export function reservesCoverageDir(argv) {
    return argv.some((arg) => arg === RESERVED_FLAG || arg.startsWith(`${RESERVED_FLAG}=`));
}
/**
 * ANY mention of retry means the consumer owns it and we inject nothing — `--retry=0` is therefore
 * the opt-out, `--retry.count=3` an override. Both spellings have to count: vitest 4.1.10 CRASHES on
 * `--retry=1` together with `--retry.condition`, so a half-measure here would break the very people
 * who configured retry deliberately.
 */
export function ownsRetry(argv) {
    return argv.some((arg) => /^--(?:no-)?retry(?:[.=]|$)/.test(arg));
}
/** Same courtesy for reporters: a consumer who chose their own output does not get ours bolted on. */
export function ownsReporter(argv) {
    return argv.some((arg) => /^--(?:reporter|outputFile)(?:[.=]|$)/.test(arg));
}
/** The lowest vitest that understands `--retry.condition`. Below it we retry NOTHING — see below. */
export const RETRY_MIN_VITEST = [4, 1];
/** `vitest/4.1.10 darwin-arm64 node-v22.20.0` → [4, 1]. null when it cannot be read or parsed. */
export function vitestMajorMinor(bin) {
    try {
        const out = execFileSync(bin, ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 30_000,
        });
        const m = /(\d+)\.(\d+)\.\d+/.exec(out);
        return m ? [Number(m[1]), Number(m[2])] : null;
    }
    catch {
        return null;
    }
}
/**
 * Whether it is safe to inject the selective retry.
 *
 * FEATURE-DETECT, DO NOT GUESS. devkit ships inside a consumer's node_modules and runs against
 * whatever vitest is there — `^4.1.10` in devkit's own package.json binds devkit's devDependency, not
 * theirs. vitest silently IGNORES an unknown dotted sub-option, so on an older vitest
 * `--retry.condition` would evaporate while `--retry.count=1` survived, quietly turning the narrow
 * timeout retry into the blanket retry it exists to avoid. That is the worst outcome and it would be
 * invisible, so a version we cannot read is treated as unsupported.
 */
export function supportsRetryCondition(version) {
    if (!version)
        return false;
    const [major, minor] = version;
    return (major > RETRY_MIN_VITEST[0] || (major === RETRY_MIN_VITEST[0] && minor >= RETRY_MIN_VITEST[1]));
}
/** Set to skip the json reporter (and therefore all post-run diagnosis) without touching retry. */
export const NO_DIAGNOSIS_ENV = 'DEVKIT_COVERAGE_NO_DIAGNOSIS';
export function buildInjectedArgs(vitest, argv, resultsFile) {
    const injected = [];
    if (!ownsRetry(argv)) {
        if (supportsRetryCondition(vitestMajorMinor(vitest))) {
            injected.push('--retry.count=1', `--retry.condition=${RETRY_CONDITION}`);
        }
        else {
            console.error(`ℹ️  Skipping the flake retry: this vitest predates --retry.condition (need >=${RETRY_MIN_VITEST.join('.')}).`);
            console.error('   A timeout-shaped flake will discard the coverage artifact as before.');
        }
    }
    if (!ownsReporter(argv) && !process.env[NO_DIAGNOSIS_ENV]) {
        // `default` is kept so console output is byte-for-byte what the consumer already sees; the json
        // reporter is additive and writes only into our run directory.
        injected.push('--reporter=default', '--reporter=json', `--outputFile.json=${resultsFile}`);
    }
    return injected;
}
/**
 * Say what happened, on stderr, and make the flaky rate measurable.
 *
 * `retrying` is the whole reason this takes the outcome rather than predicting it. Whether devkit's
 * json reporter actually ran cannot be decided from argv: a consumer who sets `reporters` in their
 * vitest.config — which is where reporters are normally set — silently WINS over the CLI flag, so the
 * report never appears while the injected retry still fires. Verified against vitest 4.1.10. Deciding
 * from the artifact covers that, an older vitest ignoring the dotted --outputFile.json, an argv
 * --reporter, and the env switch, with one rule instead of four guesses.
 *
 * A retry nobody can see is the silent relaxation of a pass/fail contract that
 * gate-opt-out-is-visible-and-detectable rules out, so it is disclosed rather than assumed harmless.
 */
export function reportDiagnosis(diagnosis, cwd, retrying) {
    if (!diagnosis) {
        if (retrying) {
            console.error('\u2139\uFE0F  Retrying timed-out tests, but the rescue cannot be reported: no devkit json');
            console.error('   report was produced (your vitest.config sets `reporters`, you passed');
            console.error(`   --reporter, or ${NO_DIAGNOSIS_ENV} is set). A test that only passes on the`);
            console.error('   retry will look plainly green. Use --retry=0 to turn the retry off instead.');
        }
        return;
    }
    for (const line of formatDiagnosis(diagnosis, cwd, stagedFiles(cwd)))
        console.error(line);
    if (diagnosis.flaky.length > 0) {
        // Its OWN type, not a `status` on gate_result: docs/decisions/gate-telemetry-self-describing.md
        // Ruling (3). A status the collector does not know settles a run as CLEAN and inflates
        // gate_result's fail-rate denominator — the reasoning sc-1366 used for gate_infra_failure.
        // A rescued flake is not a gate verdict at all: this is the producer, and the run exited 0.
        emitGateEvent({
            type: 'test_flaky',
            gate: 'coverage-run',
            flaky_count: diagnosis.flaky.length,
            detail: `${diagnosis.flaky.length} test(s) passed only on retry`,
        });
    }
}
/**
 * Run the consumer's vitest suite with coverage in an isolated reports directory, publish the report,
 * and return vitest's exit code.
 */
export async function produceCoverage(cwd = process.cwd(), argv = []) {
    const vitest = resolveVitest(cwd);
    if (!vitest) {
        console.error('🚫 devkit coverage-run needs vitest — node_modules/.bin/vitest not found.');
        console.error(`   This runner is vitest-only. The coverage GATE is not: it reads any`);
        console.error(`   istanbul-shaped ${COVERAGE_FILE}, so produce one with your own runner`);
        console.error('   and keep using `guard-coverage` as normal.');
        return 1;
    }
    // Passing this through would collide with the flag we add below. vitest rejects the duplicate
    // itself, but with a raw stack trace that names our internal run directory — useless to whoever
    // typed it. Say what is actually wrong instead.
    if (reservesCoverageDir(argv)) {
        console.error(`🚫 ${RESERVED_FLAG} is owned by \`devkit coverage-run\`.`);
        console.error('   Giving every run its own reports directory IS this command; pointing it back');
        console.error(`   at a shared one restores the race. The report is published to ${COVERAGE_FILE}`);
        console.error('   regardless — drop the flag and read it there.');
        return 1;
    }
    pruneStaleRuns(cwd);
    const runDir = resolveRunDir(cwd);
    mkdirSync(runDir, { recursive: true });
    // Captured BEFORE vitest starts: if the artifact changes from this, a sibling published it while
    // we were running and a failure of ours must not delete it. See publishCoverage.
    const before = snapshotArtifact(cwd);
    // Both live INSIDE runDir, which only this run may touch. results.json also keeps the directory
    // non-empty, so vitest's `cleanAfterRun()` — which removes the reports directory once it ends up
    // empty, the case that produced the v0.43.1 fail-open — has nothing to sweep.
    const resultsFile = join(runDir, RESULTS_NAME);
    const injected = buildInjectedArgs(vitest, argv, resultsFile);
    const retrying = injected.some((arg) => arg.startsWith('--retry.'));
    let settled = null;
    const settle = () => {
        if (settled)
            return settled;
        let result = { outcome: 'kept', diagnosis: null };
        // `finally`: a throw while publishing must not strand the run directory for the pruner to find
        // hours later.
        try {
            const diagnosis = readDiagnosis(resultsFile);
            result = {
                outcome: publishCoverage(runDir, cwd, before, diagnosis?.failedFiles ?? []),
                diagnosis,
            };
        }
        finally {
            rmSync(runDir, { recursive: true, force: true });
            settled = result;
        }
        return result;
    };
    // The CLI flag beats the consumer's vitest.config reportsDirectory — no config edit downstream.
    const code = await runVitest(vitest, ['run', '--coverage', `--coverage.reportsDirectory=${runDir}`, ...injected, ...argv], cwd);
    const { outcome, diagnosis } = settle();
    reportDiagnosis(diagnosis, cwd, retrying);
    // Green tests but no report means the suite never emitted one — most often because `json` is
    // missing from coverage.reporter. The gate still fails CLOSED on the absent artifact, so this is
    // not a correctness hole; it is a diagnosis. Reporting success here sends the developer to a
    // commit-time block whose cause is three steps upstream, so name it at the point it happened.
    if (code === 0 && outcome !== 'published') {
        console.error(`🚫 vitest passed but produced no ${REPORT_NAME}.`);
        console.error("   The coverage gate reads that file — add 'json' to coverage.reporter in your");
        console.error('   vitest config, then re-run. Exiting non-zero so a run that verified nothing');
        console.error('   is not mistaken for a run that verified coverage.');
        return 1;
    }
    return code;
}
