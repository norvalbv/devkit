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
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { emitGateEvent } from '../judge/gate-events.mts';
import {
  formatDiagnosis,
  formatRerunNotice,
  formatRerunRescue,
  headSha,
  raisedTimeoutMs,
  readClearMarker,
  readDiagnosis,
  removeClearMarker,
  RESULTS_NAME,
  RETRY_CONDITION,
  type RunDiagnosis,
  stagedFiles,
  writeClearMarker,
} from './failures.mts';
import {
  ownsReporter,
  ownsRetry,
  ownsTimeoutBudget,
  resolveVitest,
  runVitestDetailed,
  type VitestRun,
} from './vitest-cli.mts';
import {
  detectVitestVersion,
  RETRY_MIN_VITEST,
  supportsRetryCondition,
} from './vitest-version.mts';
import {
  markTouchedDuringRun,
  publishManifest,
  type SourceSnapshot,
  snapshotSource,
  stageManifest,
} from './provenance.mts';

export const COVERAGE_DIR = 'coverage';
export const REPORT_NAME = 'coverage-final.json';
/** The artifact path the coverage GATE reads. Single source of truth for both sides. */
export const COVERAGE_FILE = `${COVERAGE_DIR}/${REPORT_NAME}`;
export const RUNS_DIR = `${COVERAGE_DIR}/.runs`;
/** Long enough it can never catch a live run; short enough that killed runs don't pile up. */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000;

/**
 * What publishCoverage did. `kept` = a sibling's report survived us; `cleared` = ours was removed.
 * Distinct on purpose — see the doc on publishCoverage.
 */
export type PublishOutcome = 'published' | 'cleared' | 'kept';

/**
 * This run's reports directory, absolute. pid alone is not enough — pids are recycled and two runs
 * can start in the same millisecond — hence the random suffix.
 */
export function resolveRunDir(cwd: string, pid = process.pid, now = Date.now()): string {
  return join(cwd, RUNS_DIR, `${pid}-${now}-${Math.random().toString(36).slice(2, 8)}`);
}

/**
 * Drop run directories left behind by killed runs. Best-effort: a live sibling may delete a directory
 * between our readdir and our stat, and losing that race is not a reason to fail somebody's tests.
 */
export function pruneStaleRuns(cwd: string, now = Date.now(), maxAgeMs = STALE_RUN_MS): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(cwd, RUNS_DIR), { withFileTypes: true });
  } catch {
    return 0; // no .runs/ yet
  }
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(cwd, RUNS_DIR, entry.name);
    try {
      if (now - statSync(dir).mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      pruned++;
    } catch {
      // raced with a sibling, or not ours to remove
    }
  }
  return pruned;
}

/** The stable artifact's mtime, or null when there is none. Snapshot this BEFORE the run starts. */
export function snapshotArtifact(cwd: string): number | null {
  try {
    return statSync(join(cwd, COVERAGE_FILE)).mtimeMs;
  } catch {
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
export function publishCoverage(
  runDir: string,
  cwd: string,
  before: number | null,
  failedFiles: string[] = [],
  source: SourceSnapshot | null = null,
): PublishOutcome {
  const fresh = join(runDir, REPORT_NAME);
  const stable = join(cwd, COVERAGE_FILE);
  const coverageDir = join(cwd, COVERAGE_DIR);
  if (existsSync(fresh)) {
    mkdirSync(coverageDir, { recursive: true });
    // Staged from OUR report before it moves, so its hash matches only this run's file (sc-3225).
    // No snapshot → no manifest; a previous one mismatches this artifact's hash and reads as unknown.
    let manifest: string | null = null;
    try {
      manifest = source ? stageManifest(runDir, fresh, source, basename(runDir)) : null;
    } catch {
      manifest = null;
    }
    renameSync(fresh, stable);
    if (manifest) publishManifest(manifest, coverageDir);
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
  } catch {
    return 'kept'; // nothing to clear, or a sibling claimed it first
  }
  try {
    // Appeared from nothing, or changed under us ⇒ a sibling's successful report ⇒ put it back.
    if (before === null || statSync(claimed).mtimeMs !== before) {
      renameSync(claimed, stable);
      return 'kept';
    }
  } catch {
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

/** The flag this runner owns — passing it too is what isolation MEANS, so it cannot be delegated. */
export const RESERVED_FLAG = '--coverage.reportsDirectory';

/** True when the forwarded args try to set the one option this runner must control. */
export function reservesCoverageDir(argv: string[]): boolean {
  return argv.some((arg) => arg === RESERVED_FLAG || arg.startsWith(`${RESERVED_FLAG}=`));
}

/** Set to keep a timeout-only failure as a failure instead of re-running the suite once. */
export const NO_RERUN_ENV = 'DEVKIT_COVERAGE_NO_RERUN';

/** Everything shouldRerun decides from. Pure, so every refusal is testable without a suite. */
export interface RerunInput {
  code: number;
  interrupted: boolean;
  retrying: boolean;
  diagnosis: RunDiagnosis | null;
  argv: string[];
  env: NodeJS.ProcessEnv;
}

/** Whether a failed run is the load flake one WHOLE re-run at a raised budget can rescue (sc-3473;
 * the reasoning, and why each refusal exists, is in the coverage-gate decision). */
export function shouldRerun(input: RerunInput): boolean {
  const { code, interrupted, retrying, diagnosis, argv, env } = input;
  if (code === 0 || interrupted || !retrying) return false;
  if (!diagnosis?.failures?.allTimedOut) return false;
  if (ownsRetry(argv) || ownsTimeoutBudget(argv)) return false;
  return env[NO_RERUN_ENV] !== '1';
}

/** Set to skip the json reporter (and therefore all post-run diagnosis) without touching retry. */
export const NO_DIAGNOSIS_ENV = 'DEVKIT_COVERAGE_NO_DIAGNOSIS';

export function buildInjectedArgs(
  vitest: string,
  argv: string[],
  resultsFile: string,
  cwd: string,
): string[] {
  const injected: string[] = [];
  if (!ownsRetry(argv)) {
    const detected = detectVitestVersion(cwd, vitest);
    if (supportsRetryCondition(detected.kind === 'known' ? detected.majorMinor : null)) {
      injected.push('--retry.count=1', `--retry.condition=${RETRY_CONDITION}`);
    } else {
      // Two different claims, kept apart: "too old" must be checkable, and "could not tell" must not
      // masquerade as "too old" (sc-3731) — both still inject nothing, see supportsRetryCondition.
      console.error(
        detected.kind === 'known'
          ? `ℹ️  Skipping the flake retry: detected vitest ${detected.version}, but --retry.condition needs >=${RETRY_MIN_VITEST.join('.')}.0-beta.1.`
          : `ℹ️  Skipping the flake retry: could not determine the vitest version (${detected.reason}).`,
      );
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
export function reportDiagnosis(
  diagnosis: RunDiagnosis | null,
  cwd: string,
  retrying: boolean,
): void {
  if (!diagnosis) {
    if (retrying) {
      console.error(
        '\u2139\uFE0F  Retrying timed-out tests, but the rescue cannot be reported: no devkit json',
      );
      console.error('   report was produced (your vitest.config sets `reporters`, you passed');
      console.error(
        `   --reporter, or ${NO_DIAGNOSIS_ENV} is set). A test that only passes on the`,
      );
      console.error(
        '   retry will look plainly green. Use --retry=0 to turn the retry off instead.',
      );
    }
    return;
  }
  for (const line of formatDiagnosis(diagnosis, cwd, stagedFiles(cwd))) console.error(line);
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

/** One complete vitest run, settled: published or cleared, run directory gone. */
interface Pass extends VitestRun {
  outcome: PublishOutcome;
  diagnosis: RunDiagnosis | null;
  retrying: boolean;
}

/** One full, isolated coverage run. All per-run state is made fresh here, so a second pass can never
 * read or clear on the strength of the first one's. */
async function runPass(
  vitest: string,
  cwd: string,
  argv: string[],
  budget: string[],
): Promise<Pass> {
  pruneStaleRuns(cwd);
  const runDir = resolveRunDir(cwd);
  mkdirSync(runDir, { recursive: true });
  // Captured BEFORE vitest starts: if the artifact changes from this, a sibling published it while
  // we were running and a failure of ours must not delete it. See publishCoverage.
  const before = snapshotArtifact(cwd);
  // Also BEFORE vitest (sc-3225); anything whose mtime moves during the run is marked unmeasured
  // after it, which catches an edit-then-restore the start hashes alone cannot see.
  const startedAt = Date.now();
  const source = snapshotSource(cwd);

  // Inside runDir, which only this run may touch; results.json also keeps it non-empty, so vitest's
  // cleanAfterRun() has nothing to sweep (the v0.43.1 fail-open).
  const resultsFile = join(runDir, RESULTS_NAME);
  const injected = buildInjectedArgs(vitest, argv, resultsFile, cwd);
  const retrying = injected.some((arg) => arg.startsWith('--retry.'));

  let run: VitestRun = { code: 1, interrupted: false };
  let outcome: PublishOutcome = 'kept';
  let diagnosis: RunDiagnosis | null = null;
  // `finally` so a throw never strands runDir. The diagnosis is read before it goes, and never
  // changes whether the run publishes or clears.
  try {
    // The CLI flag beats the consumer's vitest.config reportsDirectory — no config edit downstream.
    run = await runVitestDetailed(
      vitest,
      [
        'run',
        '--coverage',
        `--coverage.reportsDirectory=${runDir}`,
        ...injected,
        ...budget,
        ...argv,
      ],
      cwd,
    );
    diagnosis = readDiagnosis(resultsFile);
    // A failed run's report (the consumer's `coverage.reportOnFailure`) is partial: never publish it.
    if (run.code !== 0) rmSync(join(runDir, REPORT_NAME), { force: true });
    const measured =
      source && markTouchedDuringRun(cwd, source, startedAt, join(runDir, REPORT_NAME));
    outcome = publishCoverage(runDir, cwd, before, diagnosis?.failedFiles ?? [], measured);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  return { ...run, outcome, diagnosis, retrying };
}

/** Pass 2 was green: say which pass-1 failures only a bigger budget got through, and count them. */
function reportRerunRescue(first: RunDiagnosis | null, cwd: string, budget: number): void {
  const lines = formatRerunRescue(first, cwd, budget);
  for (const line of lines) console.error(line);
  const count = first?.failures?.tests.length || first?.failedFiles.length || 0;
  if (count === 0) return;
  // The same self-describing type a retry rescue uses: this is a flake, not a gate verdict.
  emitGateEvent({
    type: 'test_flaky',
    gate: 'coverage-run',
    flaky_count: count,
    detail: `${count} test(s) passed only on the raised-timeout re-run`,
  });
}

/** Keep the marker's clearedAt (when the artifact went) but name the failures that ended the run. */
function refreshClearMarker(cwd: string, failedFiles: string[]): void {
  const coverageDir = join(cwd, COVERAGE_DIR);
  if (existsSync(join(cwd, COVERAGE_FILE))) return; // a sibling published in between — not ours
  const marker = readClearMarker(coverageDir);
  if (marker) writeClearMarker(coverageDir, { ...marker, failedFiles });
}

/**
 * Run the consumer's vitest suite with coverage in an isolated reports directory, publish the report,
 * and return vitest's exit code.
 */
export async function produceCoverage(cwd = process.cwd(), argv: string[] = []): Promise<number> {
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
    console.error(
      '   Giving every run its own reports directory IS this command; pointing it back',
    );
    console.error(
      `   at a shared one restores the race. The report is published to ${COVERAGE_FILE}`,
    );
    console.error('   regardless — drop the flag and read it there.');
    return 1;
  }

  const first = await runPass(vitest, cwd, argv, []);
  reportDiagnosis(first.diagnosis, cwd, first.retrying);
  let final = first;

  if (shouldRerun({ ...first, argv, env: process.env })) {
    // Pass 1 has fully settled — artifact cleared, marker written — before pass 2 starts, so a kill
    // anywhere in pass 2 still leaves the gate failing CLOSED with the reason on disk.
    const budget = raisedTimeoutMs(first.diagnosis?.failures);
    for (const line of formatRerunNotice(budget)) console.error(line);
    final = await runPass(vitest, cwd, argv, [
      `--testTimeout=${budget}`,
      `--hookTimeout=${budget}`,
    ]);
    reportDiagnosis(final.diagnosis, cwd, final.retrying);
    if (final.code === 0) {
      reportRerunRescue(first.diagnosis, cwd, budget);
    } else if (first.outcome === 'cleared' && final.outcome === 'kept') {
      // Pass 2 found nothing left to clear because pass 1 already had. The marker still names pass
      // 1's failures; the run that actually ended was pass 2.
      refreshClearMarker(cwd, final.diagnosis?.failedFiles ?? []);
    }
  }
  const { code, outcome } = final;

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
