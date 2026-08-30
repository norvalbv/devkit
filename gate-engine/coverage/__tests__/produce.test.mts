/**
 * The coverage PRODUCER (`devkit coverage-run`, gate-engine/coverage/produce.mts). Three load-bearing
 * properties: concurrent runs never touch each other's reports directory (sc-1214), a run that
 * produced no report REMOVES the stable artifact so the gate stays fail-CLOSED, and the report lands
 * on exactly the path the gate reads.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI, testSpawnSync, waitForPath } from '../../../cli/__tests__/_helpers.mts';
import { CLEAR_MARKER_NAME, readClearMarker } from '../failures.mts';
import {
  buildInjectedArgs,
  COVERAGE_DIR,
  COVERAGE_FILE,
  ownsReporter,
  ownsRetry,
  produceCoverage,
  pruneStaleRuns,
  publishCoverage,
  REPORT_NAME,
  reportDiagnosis,
  RUNS_DIR,
  reservesCoverageDir,
  resolveRunDir,
  resolveVitest,
  STALE_RUN_MS,
  snapshotArtifact,
  supportsRetryCondition,
  vitestMajorMinor,
} from '../produce.mts';

const DEVKIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-produce-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const silentStubVitest = (root: string, silentBody: string) => {
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'vitest');
  // Extensionless + shebang ⇒ Node treats it as CommonJS, hence `require` rather than `import`.
  // The version probe runs BEFORE the real invocation (vitestMajorMinor), and its stdio is piped, so
  // answering it here neither breaks the silence contract nor lets a fixture mistake the probe for
  // the run it is waiting on.
  writeFileSync(
    path,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('vitest/4.1.10 darwin-arm64 node-v22.20.0\\n');
  process.exit(0);
}
${silentBody}
`,
  );
  chmodSync(path, 0o755);
  return path;
};

const HONOURS_REPORTS_DIR_FLAG_SILENTLY = `const fs = require('node:fs');
const flag = process.argv.find((a) => a.startsWith('--coverage.reportsDirectory='));
const dir = flag.slice('--coverage.reportsDirectory='.length);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/coverage-final.json', JSON.stringify({ 'lib.mjs': { fresh: true } }));`;

/** Blocks the stub for `ms` without spawning a grandchild that could outlive it. */
const blockFor = (ms: number) =>
  `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});`;

const runDirWith = (root: string, name: string, ...files: string[]) => {
  const dir = join(root, RUNS_DIR, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), '{}');
  }
  return dir;
};

describe('per-run reports directories', () => {
  // THE REGRESSION (sc-1214). vitest removes the shared `.tmp` twice — `clean()` takes the whole
  // reportsDirectory at startup, `cleanAfterRun()` takes `.tmp` again at the end. While two runs
  // shared `coverage/`, either sweep could land inside the other's lifetime and kill it. Giving each
  // run its own directory makes both sweeps a no-op for everybody else.
  it('one run wiping its own directory leaves a concurrent run untouched', () => {
    const root = makeRoot();
    const a = runDirWith(root, 'runA', '.tmp/coverage-1.json');
    const b = runDirWith(root, 'runB', '.tmp/coverage-2.json');

    rmSync(b, { recursive: true, force: true }); // exactly what vitest's clean() does

    expect(existsSync(join(a, '.tmp', 'coverage-1.json'))).toBe(true);
    expect(existsSync(b)).toBe(false);
  });

  it('never hands two runs the same directory', () => {
    const root = makeRoot();
    const dirs = new Set(Array.from({ length: 50 }, () => resolveRunDir(root)));
    expect(dirs.size).toBe(50);
  });

  it('keeps run directories under coverage/, which consumers already gitignore', () => {
    const root = makeRoot();
    expect(resolveRunDir(root, 1234, 5678)).toMatch(new RegExp(`^${root}/${RUNS_DIR}/1234-5678-`));
  });
});

describe('publishCoverage', () => {
  it('moves a fresh report to the exact path the coverage gate reads', () => {
    const root = makeRoot();
    const dir = runDirWith(root, 'runA');
    writeFileSync(join(dir, REPORT_NAME), '{"a.ts":{}}');

    expect(publishCoverage(dir, root, null)).toBe('published');
    expect(JSON.parse(readFileSync(join(root, COVERAGE_FILE), 'utf8'))).toEqual({ 'a.ts': {} });
    expect(existsSync(join(dir, REPORT_NAME))).toBe(false);
  });

  // Fail-CLOSED. While reportsDirectory was './coverage', vitest's startup `rm -rf` meant a run that
  // produced no report left NO artifact, so the gate blocked. Publishing per-run must not leave the
  // previous run's report behind — that would turn a fail-closed gate into a fail-open one.
  it('removes the stale artifact when the run produced no report', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"stale.ts":{}}');
    const dir = runDirWith(root, 'runA');
    // Unchanged since we snapshotted it ⇒ it is the very file this run started with ⇒ stale.
    const before = snapshotArtifact(root);

    expect(publishCoverage(dir, root, before)).toBe('cleared');
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  });

  // ...but a FAILING run must not destroy a SUCCEEDING sibling's result either. An artifact that
  // CHANGED since our snapshot was republished by a sibling while we ran, and deleting it would
  // reintroduce — at the artifact level — the cross-run interference this module exists to remove.
  it('keeps an artifact a sibling replaced while this run was going', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"sibling.ts":{}}');
    const dir = runDirWith(root, 'runA');
    // The artifact was just written, so it HAS an mtime — asserted rather than assumed, because a
    // null here would silently read as mtime 0 and make the -5s below meaningless.
    const mtimeNow = snapshotArtifact(root);
    if (mtimeNow === null) throw new Error('the artifact written above must have an mtime');
    const aDifferentFileThanTheOneThereNow = mtimeNow - 5_000;

    expect(publishCoverage(dir, root, aDifferentFileThanTheOneThereNow)).toBe('kept');
    expect(JSON.parse(readFileSync(join(root, COVERAGE_FILE), 'utf8'))).toEqual({
      'sibling.ts': {},
    });
  });

  // A run whose artifact appeared from nothing never owned it — a sibling created it mid-run.
  it('keeps an artifact that appeared during the run', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"sibling.ts":{}}');
    const dir = runDirWith(root, 'runA');

    expect(publishCoverage(dir, root, null)).toBe('kept'); // null = nothing there when we started
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(true);
  });

  // THE FAIL-OPEN (found in v0.43.1, in the field). On a failed run vitest's `cleanAfterRun()` deletes
  // the reports directory once it is empty — so by the time we clear, runDir is GONE. While the claim
  // file was written inside runDir, the rename threw ENOENT, the catch swallowed it, and the previous
  // run's report survived for the gate to trust. Every other test here created runDir by hand, so the
  // one arrangement that actually occurs in production was the one never exercised.
  it('still clears the stale artifact when vitest deleted the run directory', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"stale.ts":{}}');
    const dir = runDirWith(root, 'runA');
    const before = snapshotArtifact(root);
    rmSync(dir, { recursive: true, force: true }); // exactly what cleanAfterRun() does

    expect(publishCoverage(dir, root, before)).toBe('cleared');
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  });

  it('leaves no claim file behind in coverage/', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"stale.ts":{}}');
    const dir = runDirWith(root, 'runA');
    const before = snapshotArtifact(root);
    rmSync(dir, { recursive: true, force: true });

    publishCoverage(dir, root, before);
    expect(readdirSync(join(root, COVERAGE_DIR)).filter((f) => f.includes('cleared'))).toEqual([]);
  });

  it('is a no-op when there is neither a fresh nor a stale report', () => {
    const root = makeRoot();
    const dir = runDirWith(root, 'runA');
    expect(() => publishCoverage(dir, root, null)).not.toThrow();
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  });

  it('creates coverage/ when this is the first run in a clean checkout', () => {
    const root = makeRoot();
    const dir = runDirWith(root, 'runA');
    writeFileSync(join(dir, REPORT_NAME), '{}');
    expect(publishCoverage(dir, root, null)).toBe('published');
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(true);
  });
});

describe('pruneStaleRuns', () => {
  it('drops abandoned run directories but keeps recent ones', () => {
    const root = makeRoot();
    const old = runDirWith(root, 'crashed');
    const fresh = runDirWith(root, 'live');
    const t = (Date.now() - (STALE_RUN_MS + 60_000)) / 1000;
    utimesSync(old, t, t);

    expect(pruneStaleRuns(root)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('does nothing when no run has ever executed here', () => {
    expect(pruneStaleRuns(makeRoot())).toBe(0);
  });
});

describe('reservesCoverageDir', () => {
  // vitest rejects a duplicated --coverage.reportsDirectory itself, but with a raw stack trace
  // naming our internal run directory. Catching it first is about the message, not correctness.
  it.each([['--coverage.reportsDirectory=/tmp/elsewhere'], ['--coverage.reportsDirectory']])(
    'spots the reserved flag in %s',
    (arg) => {
      expect(reservesCoverageDir(['run', arg])).toBe(true);
    },
  );

  it('lets every other vitest argument through', () => {
    expect(reservesCoverageDir(['src/foo.test.ts', '--coverage.reporter=json', '--bail=1'])).toBe(
      false,
    );
  });
});

describe('resolveVitest', () => {
  // The gate accepts any istanbul-shaped report; only this RUNNER is vitest-specific, so it has to be
  // able to tell that it cannot help rather than guessing at another runner's CLI.
  it('returns null when the consumer has no vitest', () => {
    expect(resolveVitest(makeRoot())).toBeNull();
  });

  it('finds the consumer-local vitest binary', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'vitest'), '');
    expect(resolveVitest(root)).toBe(join(root, 'node_modules', '.bin', 'vitest'));
  });
});

/**
 * NOT `await produceCoverage(root)` (sc-2228). tinypool forks workers with stdio:'pipe' and pipes
 * them into the parent's stdout, so a grandchild inheriting that fd replays its whole reporter
 * stream — FAIL blocks, ANSI cursor control — through the run reporting on itself.
 *
 * testSpawnSync over a bare spawn for the kill path: 90s, then SIGTERM to the process group, then
 * SIGKILL, reported as 124.
 */
const coverageRun = (root: string) =>
  testSpawnSync(process.execPath, [CLI, 'coverage-run'], { cwd: root, encoding: 'utf8' });

describe('a run that verified nothing', () => {
  // The gate already fails CLOSED on an absent artifact, so this is diagnosis rather than a
  // correctness hole: without it, a consumer missing the `json` reporter gets a green
  // test:run:coverage and then a commit-time block whose cause is three steps upstream.
  it('exits non-zero when vitest passes but emits no report', () => {
    const root = makeRoot();
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default {
        test: {
          include: ['*.test.mjs'],
          coverage: { provider: 'v8', reporter: ['text'] },
        },
      };\n`,
    );
    writeFileSync(
      join(root, 'ok.test.mjs'),
      `import { expect, it } from 'vitest';
      it('passes', () => { expect(1).toBe(1); });\n`,
    );

    // No per-test timeout: 120_000 was exactly the supervisor's own ceiling (90s + 30s reap), so a
    // wedge raced the two and surfaced as an opaque worker timeout instead of a clean 124.
    expect(coverageRun(root).status).toBe(1);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  });

  // The fail-closed guarantee, end to end against real vitest — the arrangement the unit tests could
  // not reproduce, because it depends on vitest deleting its own reports directory.
  it('clears a previous report when the suite actually fails', () => {
    const root = makeRoot();
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default {
        test: {
          include: ['*.test.mjs'],
          coverage: { provider: 'v8', reporter: ['json'], reportsDirectory: './coverage' },
        },
      };\n`,
    );
    writeFileSync(
      join(root, 'boom.test.mjs'),
      `import { expect, it } from 'vitest';
      it('fails', () => { expect(1).toBe(2); });\n`,
    );
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"from-an-earlier-green-run.ts":{}}');

    const result = coverageRun(root);

    // 124 is the supervisor's timeout status. Asserting only `not 0` would let a WEDGED nested run
    // masquerade as "the suite failed", which is the exact claim this test makes.
    expect(result.status).not.toBe(124);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('boom.test.mjs');
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  });

  it('refuses to forward the reports-directory flag it owns', async () => {
    const root = makeRoot();
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    const before = process.listenerCount('SIGTERM');
    expect(await produceCoverage(root, ['--coverage.reportsDirectory=/tmp/elsewhere'])).toBe(1);
    // Rejected before anything ran, so no run directory was ever created.
    expect(existsSync(join(root, RUNS_DIR))).toBe(false);
    // …and nothing was registered either: the forwarders are downstream of this early return.
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('registers nothing when the consumer has no vitest to run', async () => {
    const before = process.listenerCount('SIGTERM');
    expect(await produceCoverage(makeRoot())).toBe(1);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

describe('two concurrent coverage runs in one working tree', () => {
  // Runs the REAL command against REAL vitest in a throwaway consumer project.
  //
  // The SHAPE is the regression and it is fussy — verified by reproducing the original failure with a
  // fixed reportsDirectory: the run that breaks is the one that started SECOND, and what breaks it is
  // the first run FINISHING (cleanAfterRun deletes the shared `.tmp` out from under it). Two identical
  // simultaneous runs finish together and pass even on the broken setup, so a test written that way
  // would pass whether or not the bug is present. Hence a fast file (coverage lands in `.tmp` early),
  // a slow one to hold run A open, and run B launched partway in.
  const START_OFFSET_MS = 1500;

  const scaffold = () => {
    const root = makeRoot();
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    // Deliberately pins the shared directory the bug needs. The runner must override it on the
    // command line — that override is what makes this a devkit-owned fix needing no consumer edit.
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default {
        test: {
          include: ['*.test.mjs'],
          coverage: { provider: 'v8', reporter: ['json'], reportsDirectory: './coverage' },
        },
      };\n`,
    );
    writeFileSync(join(root, 'lib.mjs'), 'export const add = (a, b) => a + b;\n');
    writeFileSync(
      join(root, 'fast.test.mjs'),
      `import { expect, it } from 'vitest';
      import { add } from './lib.mjs';
      it('finishes early, so its coverage is sitting in .tmp', () => { expect(add(1, 2)).toBe(3); });\n`,
    );
    writeFileSync(
      join(root, 'slow.test.mjs'),
      `import { expect, it } from 'vitest';
      import { add } from './lib.mjs';
      it('holds the run open for a sibling', async () => {
        await new Promise((r) => setTimeout(r, 4000));
        expect(add(1, 1)).toBe(2);
      });\n`,
    );
    return root;
  };

  const run = (root: string) =>
    new Promise<{ code: number | null; output: string }>((resolve) => {
      let output = '';
      const child = spawn(
        process.execPath,
        [join(DEVKIT_ROOT, 'cli', 'index.mts'), 'coverage-run'],
        { cwd: root },
      );
      child.stdout.on('data', (d) => {
        output += d;
      });
      child.stderr.on('data', (d) => {
        output += d;
      });
      child.on('close', (code) => resolve({ code, output }));
    });

  it('both complete, neither destroys the other, and the artifact lands where the gate looks', async () => {
    const root = scaffold();

    const first = run(root);
    await new Promise((r) => setTimeout(r, START_OFFSET_MS));
    const [a, b] = await Promise.all([first, run(root)]);

    for (const result of [a, b]) {
      expect(result.output).not.toContain('Something removed the coverage directory');
      expect(result.code).toBe(0);
    }
    const report = JSON.parse(readFileSync(join(root, COVERAGE_FILE), 'utf8'));
    expect(Object.keys(report).some((f) => f.endsWith('lib.mjs'))).toBe(true);
    expect(readdirSync(join(root, RUNS_DIR))).toEqual([]);
  }, 120_000);
});

describe('the flags devkit adds on the consumer behalf', () => {
  const VITEST = join(DEVKIT_ROOT, 'node_modules', '.bin', 'vitest');

  // ANY spelling of retry means the consumer owns it. This is not politeness: vitest 4.1.10 CRASHES
  // on `--retry=1` together with `--retry.condition`, so injecting alongside a consumer's own retry
  // would break the run of whoever had configured retry most deliberately.
  it.each([['--retry=0'], ['--retry=3'], ['--retry.count=0'], ['--retry.delay=100'], ['--retry']])(
    'injects no retry when the consumer passed %s',
    (arg) => {
      const args = buildInjectedArgs(VITEST, [arg], '/tmp/results.json');
      expect(args.some((a) => a.startsWith('--retry'))).toBe(false);
    },
  );

  it('injects the timeout-scoped retry when the consumer said nothing', () => {
    const args = buildInjectedArgs(VITEST, [], '/tmp/results.json');
    expect(args).toContain('--retry.count=1');
    expect(args).toContain('--retry.condition=(Test|Hook) timed out');
  });

  it('leaves the consumer reporters alone when they chose their own', () => {
    for (const arg of ['--reporter=verbose', '--reporter', '--outputFile.json=x.json']) {
      const args = buildInjectedArgs(VITEST, [arg], '/tmp/results.json');
      expect(args.some((a) => a.startsWith('--reporter') || a.startsWith('--outputFile'))).toBe(
        false,
      );
    }
  });

  it('keeps the default reporter so console output is unchanged', () => {
    const args = buildInjectedArgs(VITEST, [], '/tmp/results.json');
    expect(args).toContain('--reporter=default');
    expect(args).toContain('--reporter=json');
    expect(args).toContain('--outputFile.json=/tmp/results.json');
  });

  it('reads the version off the binary it will actually run', () => {
    expect(vitestMajorMinor(VITEST)).toEqual([4, 1]);
    expect(vitestMajorMinor(join(DEVKIT_ROOT, 'node_modules', '.bin', 'not-a-binary'))).toBeNull();
  });

  // FEATURE-DETECT, DO NOT GUESS. vitest silently IGNORES an unknown dotted sub-option, so on an
  // older vitest `--retry.condition` would evaporate while `--retry.count=1` survived — quietly
  // turning the narrow timeout retry into the blanket retry it exists to avoid. A version we cannot
  // read is therefore unsupported, not assumed-good.
  it('treats an unreadable or too-old vitest as unable to retry safely', () => {
    expect(supportsRetryCondition(null)).toBe(false);
    expect(supportsRetryCondition([4, 0])).toBe(false);
    expect(supportsRetryCondition([3, 9])).toBe(false);
    expect(supportsRetryCondition([4, 1])).toBe(true);
    expect(supportsRetryCondition([5, 0])).toBe(true);
  });

  it('recognises every retry and reporter spelling', () => {
    expect(ownsRetry(['--retry.condition=x'])).toBe(true);
    expect(ownsRetry(['--retries=3'])).toBe(false); // not a vitest flag; must not swallow the retry
    expect(ownsReporter(['--outputFile=x'])).toBe(true);
    expect(ownsReporter(['--reporters=x'])).toBe(false);
  });
});

describe('the marker a cleared artifact leaves behind', () => {
  it('is not written when a sibling report was preserved', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"sibling.ts":{}}');
    const dir = runDirWith(root, 'runA');
    const mtimeNow = snapshotArtifact(root);
    if (mtimeNow === null) throw new Error('the artifact written above must have an mtime');

    expect(publishCoverage(dir, root, mtimeNow - 5_000, ['a.test.ts'])).toBe('kept');
    expect(readClearMarker(join(root, COVERAGE_DIR))).toBeNull();
  });

  it('records what failed when the artifact really was discarded', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"stale.ts":{}}');
    const dir = runDirWith(root, 'runA');
    const before = snapshotArtifact(root);

    expect(publishCoverage(dir, root, before, ['/repo/a.test.ts'])).toBe('cleared');
    const marker = readClearMarker(join(root, COVERAGE_DIR));
    expect(marker?.failedFiles).toEqual(['/repo/a.test.ts']);
    expect(marker?.previousMtime).toBe(before);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  });

  // A fresh report answers everything the marker existed to answer. Leaving it would let the gate
  // narrate an old failure over a current pass.
  it('is cleaned up by the next successful publish', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"stale.ts":{}}');
    publishCoverage(runDirWith(root, 'runA'), root, snapshotArtifact(root), ['a.test.ts']);
    expect(readClearMarker(join(root, COVERAGE_DIR))).not.toBeNull();

    const good = runDirWith(root, 'runB');
    writeFileSync(join(good, REPORT_NAME), '{"a.ts":{}}');
    expect(publishCoverage(good, root, null)).toBe('published');
    expect(readClearMarker(join(root, COVERAGE_DIR))).toBeNull();
    expect(existsSync(join(root, COVERAGE_DIR, CLEAR_MARKER_NAME))).toBe(false);
  });
});

describe('a suite that flakes under load', () => {
  const consumerRepo = (root: string, testTimeout: number) => {
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default {
        test: {
          include: ['*.test.mjs'],
          testTimeout: ${testTimeout},
          coverage: { provider: 'v8', reporter: ['json'], reportsDirectory: './coverage' },
        },
      };\n`,
    );
  };

  it('rescues a timeout flake instead of discarding the run', async () => {
    const root = makeRoot();
    consumerRepo(root, 300);
    // Times out on the first attempt only — the shape the field report describes, where every
    // failing test passed when re-run alone.
    writeFileSync(
      join(root, 'flake.test.mjs'),
      `import { expect, it } from 'vitest';
      let attempts = 0;
      it('slow under load', async () => {
        attempts++;
        if (attempts === 1) await new Promise((r) => setTimeout(r, 5000));
        expect(1).toBe(1);
      });\n`,
    );
    // Out of process (sc-2228): produceCoverage spawns vitest with stdio:'inherit', so an
    // in-process call hands the nested run THIS worker's fd 1. The child's stderr carries the same
    // diagnosis a console spy would have captured, and reading it there tests the real CLI.
    const result = coverageRun(root);
    const errors = result.stderr;

    expect(result.status).toBe(0);
    // Coverage survived a run that would previously have deleted it and cost a full recompute.
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(true);
    expect(readClearMarker(join(root, COVERAGE_DIR))).toBeNull();
    // ...and the rescue is REPORTED. A retry that passed in silence would be the fail-open this
    // feature must not become: green is not the same fact as green-on-the-second-try.
    expect(errors).toMatch(/passed only on retry/);
    expect(errors).toMatch(/slow under load/);
  });

  it('does not retry a real failure, and records what discarded the artifact', async () => {
    const root = makeRoot();
    consumerRepo(root, 5_000);
    writeFileSync(
      join(root, 'bug.test.mjs'),
      `import { expect, it } from 'vitest';
      it('real bug', () => { expect(2).toBe(99); });\n`,
    );
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"from-an-earlier-green-run.ts":{}}');
    const result = coverageRun(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toMatch(/passed only on retry/);
    // Fail-CLOSED is unchanged — the artifact is gone. What is new is that the gate can now say WHY.
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
    const marker = readClearMarker(join(root, COVERAGE_DIR));
    expect(marker?.failedFiles.some((f) => f.endsWith('bug.test.mjs'))).toBe(true);
  });
});

describe('a retry devkit cannot report on', () => {
  const said = (diagnosis: Parameters<typeof reportDiagnosis>[0], retrying: boolean) => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    try {
      reportDiagnosis(diagnosis, '/repo', retrying);
      return lines.join('\n');
    } finally {
      spy.mockRestore();
    }
  };

  // Whether the json report ran cannot be predicted from argv: a consumer who sets `reporters` in
  // vitest.config silently WINS over the CLI flag (verified against vitest 4.1.10), so the report
  // never appears while the injected retry still fires — a rescue nobody can see. Deciding from the
  // artifact covers that case, an older vitest, an argv --reporter and the env switch at once.
  it('discloses a retry whose rescue produced no report', () => {
    const out = said(null, true);
    expect(out).toMatch(/cannot be reported/);
    expect(out).toMatch(/--retry=0/);
  });

  it('says nothing when it did not retry', () => {
    expect(said(null, false)).toBe('');
  });

  it('says nothing about reportability once a report exists', () => {
    const out = said({ failedFiles: [], flaky: [] }, true);
    expect(out).not.toMatch(/cannot be reported/);
  });
});

describe('a failing run with nothing of its own to discard', () => {
  it('writes no marker when there was no artifact to begin with', () => {
    const root = makeRoot();
    const dir = runDirWith(root, 'runA');

    expect(publishCoverage(dir, root, null, ['/repo/a.test.ts'])).toBe('kept');
    expect(readClearMarker(join(root, COVERAGE_DIR))).toBeNull();
  });

  // A sibling created the artifact WHILE we ran (`before` is null but one is there now). It is not
  // ours to describe, and publishCoverage restores it — so there must be no marker either.
  it('writes no marker for an artifact that appeared under it', () => {
    const root = makeRoot();
    const dir = runDirWith(root, 'runA');
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"sibling.ts":{}}');

    expect(publishCoverage(dir, root, null, ['/repo/a.test.ts'])).toBe('kept');
    expect(readClearMarker(join(root, COVERAGE_DIR))).toBeNull();
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(true);
  });
});

describe('the interrupt forwarders around the vitest child', () => {
  // Measured cost of a leaked listener, against tinypool's teardown (plain kill(), SIGKILL 1000ms
  // later): 305ms via SIGTERM without one, 1307ms via SIGKILL with one.
  const PROBE = `import { writeFileSync } from 'node:fs';
import { produceCoverage } from ${JSON.stringify(join(DEVKIT_ROOT, 'gate-engine', 'coverage', 'produce.mts'))};
const count = () => process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
const before = count();
let peak = before;
const sampler = setInterval(() => { peak = Math.max(peak, count()); }, 25);
const code = await produceCoverage(process.argv[2]);
clearInterval(sampler);
writeFileSync(process.argv[3], JSON.stringify({ before, peak, after: count(), code }));
`;

  it('installs them while the child runs and removes every one afterwards', () => {
    const root = makeRoot();
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    // One trivial test with the `json` reporter: the cheapest arrangement that still REACHES the
    // spawn, which is where the forwarders are registered.
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default {
        test: {
          include: ['*.test.mjs'],
          coverage: { provider: 'v8', reporter: ['json'] },
        },
      };\n`,
    );
    writeFileSync(
      join(root, 'one.test.mjs'),
      `import { expect, it } from 'vitest';
      it('passes', () => { expect(1).toBe(1); });\n`,
    );
    const probe = join(root, 'probe.mjs');
    const observed = join(root, 'observed.json');
    writeFileSync(probe, PROBE);

    const run = testSpawnSync(process.execPath, [probe, root, observed], { encoding: 'utf8' });
    expect(run.status).toBe(0);

    const { before, peak, after, code } = JSON.parse(readFileSync(observed, 'utf8'));
    expect(code).toBe(0); // it really reached, and completed, the spawn
    // Without this the test passes just as well on a version that deleted the Ctrl-C forwarding
    // outright — a different regression, and one this file is also responsible for not shipping.
    expect(peak).toBeGreaterThan(before);
    expect(after).toBe(before);
  });
});

describe('a nested coverage run stays inside its own process', () => {
  // A test cannot read its own worker's fd 1 — Node exposes no dup2, and spying on
  // process.stdout.write never sees a spawned grandchild — so the observation happens one level up.
  // Swap the fixture's spawnSync for an in-process produceCoverage and this goes red.
  const SENTINEL = 'devkit-sc2228-nested-fixture-marker';

  it("never puts a nested run's output on the test runner's stdout", () => {
    const root = makeRoot();
    const target = join(root, 'target');
    mkdirSync(target, { recursive: true });
    for (const dir of [root, target]) {
      symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(dir, 'node_modules'));
    }

    // The sentinel is a FAILING test's name because a reporter always prints that, whereas a
    // passing test's console.log is swallowed by vitest's console interception.
    writeFileSync(
      join(target, 'vitest.config.mjs'),
      `export default {
        test: {
          include: ['*.test.mjs'],
          coverage: { provider: 'v8', reporter: ['json'] },
        },
      };\n`,
    );
    writeFileSync(
      join(target, 'loud.test.mjs'),
      `import { expect, it } from 'vitest';
      it(${JSON.stringify(SENTINEL)}, () => { expect(1).toBe(2); });\n`,
    );

    // `include: ['*.test.mjs']` is root-level only, so target/ is not collected.
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default { test: { include: ['*.test.mjs'] } };\n`,
    );
    writeFileSync(
      join(root, 'observed.test.mjs'),
      `import { spawnSync } from 'node:child_process';
      import { expect, it } from 'vitest';
      it('runs the producer out of process', () => {
        const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'coverage-run'], {
          cwd: ${JSON.stringify(target)}, encoding: 'utf8',
        });
        // Non-zero: the nested suite fails on purpose. What matters is WHERE its output landed.
        expect(r.status).not.toBe(0);
        expect(r.stdout + r.stderr).toContain(${JSON.stringify(SENTINEL)});
      });\n`,
    );

    const observer = testSpawnSync(
      join(DEVKIT_ROOT, 'node_modules', '.bin', 'vitest'),
      ['run', '--root', root],
      { cwd: root, encoding: 'utf8' },
    );

    // Green proves the nested producer really ran and really printed the sentinel INSIDE the child.
    expect(observer.status).toBe(0);
    // …and it never surfaced on the runner's own streams. This is the assertion no exit code of a
    // coverage-run can make.
    expect(`${observer.stdout}${observer.stderr}`).not.toContain(SENTINEL);
  });
});

describe('what the forwarders leave behind on each way out', () => {
  // A throw out of settle() and a child that never started are the two exits a `process.off` placed
  // after the await would silently miss.
  const forwarderCount = () => process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');

  it('publishes the report, drops the run directory, and restores the listener count', async () => {
    const root = makeRoot();
    silentStubVitest(root, HONOURS_REPORTS_DIR_FLAG_SILENTLY);

    const before = forwarderCount();
    expect(await produceCoverage(root)).toBe(0);

    expect(forwarderCount()).toBe(before);
    expect(JSON.parse(readFileSync(join(root, COVERAGE_FILE), 'utf8'))).toEqual({
      'lib.mjs': { fresh: true },
    });
    expect(readdirSync(join(root, RUNS_DIR))).toEqual([]);
  });

  it('restores the listener count even when publishing throws', async () => {
    const root = makeRoot();
    silentStubVitest(root, HONOURS_REPORTS_DIR_FLAG_SILENTLY);
    // A non-empty directory at the artifact path makes publishCoverage's rename fail at the OS —
    // the only way to reach settle() throwing after the forwarders are registered.
    mkdirSync(join(root, COVERAGE_FILE), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE, 'occupant'), 'x');

    const before = forwarderCount();
    await expect(produceCoverage(root)).rejects.toThrow();

    // The throw escapes — callers must still see it — but it does not take the listeners with it.
    expect(forwarderCount()).toBe(before);
  });

  it('restores the listener count when the vitest binary cannot be executed', async () => {
    const root = makeRoot();
    // resolveVitest only tests for EXISTENCE, so a directory at that path gets past it and fails at
    // spawn instead — the `child.on('error')` branch, which resolves without a 'close' event.
    mkdirSync(join(root, 'node_modules', '.bin', 'vitest'), { recursive: true });

    const before = forwarderCount();
    expect(await produceCoverage(root)).toBe(1);

    expect(forwarderCount()).toBe(before);
    expect(readdirSync(join(root, RUNS_DIR))).toEqual([]);
  });

  it('exits non-zero and clears the artifact when the suite fails', async () => {
    const root = makeRoot();
    silentStubVitest(root, 'process.exit(1);');
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"from-an-earlier-green-run.ts":{}}');

    const before = forwarderCount();
    expect(await produceCoverage(root)).toBe(1);

    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
    expect(forwarderCount()).toBe(before);
  });

  // The child said 0, so a runner that only forwarded exit codes would call this a pass.
  it('refuses to call a run that emitted no report a success', async () => {
    const root = makeRoot();
    silentStubVitest(root, 'process.exit(0);');

    const before = forwarderCount();
    expect(await produceCoverage(root)).toBe(1);

    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
    expect(forwarderCount()).toBe(before);
  });

  // The forwarders are per-call closures, so the first run to settle must remove only its own pair.
  // Over-eager removal disarms every run still in flight, with no symptom until someone interrupts.
  it("keeps a live run's forwarders when a sibling run settles first", async () => {
    const slowRoot = makeRoot();
    const fastRoot = makeRoot();
    silentStubVitest(slowRoot, `${HONOURS_REPORTS_DIR_FLAG_SILENTLY}\n${blockFor(4000)}`);
    silentStubVitest(fastRoot, HONOURS_REPORTS_DIR_FLAG_SILENTLY);

    const before = forwarderCount();
    const slow = produceCoverage(slowRoot);
    const fast = produceCoverage(fastRoot);

    expect(await fast).toBe(0);
    // The slow run is still awaiting its child, so its own pair must have survived its sibling's
    // settle. `>=` not `===`: this file's other tests may hold none, but never fewer than these two.
    expect(forwarderCount() - before).toBeGreaterThanOrEqual(2);

    expect(await slow).toBe(0);
    expect(forwarderCount()).toBe(before);
  });
});

describe('a run interrupted mid-flight', () => {
  // Out of process because the signal must reach the HOST, which in-process is a live vitest worker.
  const PROBE = `import { writeFileSync } from 'node:fs';
import { produceCoverage } from ${JSON.stringify(join(DEVKIT_ROOT, 'gate-engine', 'coverage', 'produce.mts'))};
const code = await produceCoverage(process.argv[3]);
writeFileSync(process.argv[2], JSON.stringify({ code }));
`;

  it('kills the child, clears the stale artifact, and leaves no run directory', async () => {
    const root = makeRoot();
    const ready = join(root, 'ready.flag');
    silentStubVitest(
      root,
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'x');\n${blockFor(60_000)}`,
    );
    // Seeded, untouched by this run, and therefore ours to clear: an interrupted run verified
    // nothing, so leaving the previous run's report where the gate reads it would be a fail-OPEN.
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"from-an-earlier-green-run.ts":{}}');

    const probe = join(root, 'probe.mjs');
    const observed = join(root, 'observed.json');
    writeFileSync(probe, PROBE);

    const child = spawn(process.execPath, [probe, observed, root], { cwd: root, stdio: 'pipe' });
    const guard = setTimeout(() => child.kill('SIGKILL'), 60_000);
    try {
      await waitForPath(ready, 30_000);
      child.kill('SIGINT');
      expect(await new Promise((r) => child.on('close', r))).toBe(0);
    } finally {
      clearTimeout(guard);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    // A child that died on a signal reports 1, not the 0 an untouched stub would have exited with.
    expect(JSON.parse(readFileSync(observed, 'utf8')).code).toBe(1);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
    expect(readdirSync(join(root, RUNS_DIR))).toEqual([]);
  });
});
