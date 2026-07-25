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
import { spawn } from 'node:child_process';
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

export const COVERAGE_DIR = 'coverage';
export const REPORT_NAME = 'coverage-final.json';
/** The artifact path the coverage GATE reads. Single source of truth for both sides. */
export const COVERAGE_FILE = `${COVERAGE_DIR}/${REPORT_NAME}`;
export const RUNS_DIR = `${COVERAGE_DIR}/.runs`;
/** Long enough it can never catch a live run; short enough that killed runs don't pile up. */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000;

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
 * Returns true when a fresh report was published. When the run produced NO report (tests failed;
 * vitest's `reportOnFailure` is false by default, so nothing is written) it removes the stale
 * artifact rather than leaving the previous run's behind — UNLESS a sibling replaced it while we
 * were running.
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
export function publishCoverage(runDir: string, cwd: string, before: number | null): boolean {
  const fresh = join(runDir, REPORT_NAME);
  const stable = join(cwd, COVERAGE_FILE);
  if (existsSync(fresh)) {
    mkdirSync(join(cwd, COVERAGE_DIR), { recursive: true });
    renameSync(fresh, stable);
    return true;
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
    return false; // nothing to clear, or a sibling claimed it first
  }
  try {
    // Appeared from nothing, or changed under us ⇒ a sibling's successful report ⇒ put it back.
    if (before === null || statSync(claimed).mtimeMs !== before) {
      renameSync(claimed, stable);
      return false;
    }
  } catch {
    // Unreadable/unrestorable — fall through and drop it; an artifact we cannot vouch for must not
    // be left where the gate would trust it.
  }
  rmSync(claimed, { force: true });
  return false;
}

/** The consumer's vitest binary, or null when this repo doesn't have one. */
export function resolveVitest(cwd: string): string | null {
  const bin = join(cwd, 'node_modules', '.bin', 'vitest');
  return existsSync(bin) ? bin : null;
}

/** The flag this runner owns — passing it too is what isolation MEANS, so it cannot be delegated. */
export const RESERVED_FLAG = '--coverage.reportsDirectory';

/** True when the forwarded args try to set the one option this runner must control. */
export function reservesCoverageDir(argv: string[]): boolean {
  return argv.some((arg) => arg === RESERVED_FLAG || arg.startsWith(`${RESERVED_FLAG}=`));
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

  pruneStaleRuns(cwd);
  const runDir = resolveRunDir(cwd);
  mkdirSync(runDir, { recursive: true });
  // Captured BEFORE vitest starts: if the artifact changes from this, a sibling published it while
  // we were running and a failure of ours must not delete it. See publishCoverage.
  const before = snapshotArtifact(cwd);

  let settled = false;
  let published = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    // `finally`: a throw while publishing must not strand the run directory for the pruner to find
    // hours later.
    try {
      published = publishCoverage(runDir, cwd, before);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  };

  // The CLI flag beats the consumer's vitest.config reportsDirectory — that is what lets this fix
  // ship entirely from devkit, with no config edit in the consuming repo.
  const child = spawn(
    vitest,
    ['run', '--coverage', `--coverage.reportsDirectory=${runDir}`, ...argv],
    { cwd, stdio: 'inherit' },
  );

  // A Ctrl-C'd run must not leave a run directory behind, nor a stale report the gate would trust.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => child.kill(signal));
  }

  const code = await new Promise<number>((done) => {
    child.on('error', (err) => {
      console.error(`🚫 could not start vitest: ${err.message}`);
      done(1);
    });
    child.on('close', (exitCode, signal) => done(signal ? 1 : (exitCode ?? 1)));
  });
  settle();

  // Green tests but no report means the suite never emitted one — most often because `json` is
  // missing from coverage.reporter. The gate still fails CLOSED on the absent artifact, so this is
  // not a correctness hole; it is a diagnosis. Reporting success here sends the developer to a
  // commit-time block whose cause is three steps upstream, so name it at the point it happened.
  if (code === 0 && !published) {
    console.error(`🚫 vitest passed but produced no ${REPORT_NAME}.`);
    console.error("   The coverage gate reads that file — add 'json' to coverage.reporter in your");
    console.error('   vitest config, then re-run. Exiting non-zero so a run that verified nothing');
    console.error('   is not mistaken for a run that verified coverage.');
    return 1;
  }
  return code;
}
