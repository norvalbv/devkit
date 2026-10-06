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
import { CLEAR_MARKER_NAME, readClearMarker, UNHANDLED_REPORTER } from '../failures.mts';
import {
  buildInjectedArgs,
  COVERAGE_DIR,
  COVERAGE_FILE,
  NO_RERUN_ENV,
  type RerunInput,
  shouldRerun,
  produceCoverage,
  pruneStaleRuns,
  publishCoverage,
  REPORT_NAME,
  reportDiagnosis,
  RUNS_DIR,
  reservesCoverageDir,
  resolveRunDir,
  STALE_RUN_MS,
  snapshotArtifact,
} from '../produce.mts';
import {
  ownsReporter,
  ownsRetry,
  ownsTimeoutBudget,
  resolveVitest,
  runVitestDetailed,
} from '../vitest-cli.mts';
import {
  detectVitestVersion,
  supportsRetryCondition,
  vitestMajorMinorOf,
} from '../vitest-version.mts';

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
  // Extensionless + shebang ⇒ CommonJS. No vitest package.json here, so the piped `--version`
  // fallback probe runs first; answering it keeps the fixture silent.
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
      const args = buildInjectedArgs(VITEST, [arg], '/tmp/results.json', DEVKIT_ROOT);
      expect(args.some((a) => a.startsWith('--retry'))).toBe(false);
    },
  );

  it('injects the timeout-scoped retry when the consumer said nothing', () => {
    const args = buildInjectedArgs(VITEST, [], '/tmp/results.json', DEVKIT_ROOT);
    expect(args).toContain('--retry.count=1');
    expect(args).toContain('--retry.condition=(Test|Hook) timed out');
  });

  it('leaves the consumer reporters alone when they chose their own', () => {
    for (const arg of ['--reporter=verbose', '--reporter', '--outputFile.json=x.json']) {
      const args = buildInjectedArgs(VITEST, [arg], '/tmp/results.json', DEVKIT_ROOT);
      expect(args.some((a) => a.startsWith('--reporter') || a.startsWith('--outputFile'))).toBe(
        false,
      );
    }
  });

  it('keeps the default reporter so console output is unchanged', () => {
    const args = buildInjectedArgs(VITEST, [], '/tmp/results.json', DEVKIT_ROOT);
    expect(args).toContain('--reporter=default');
    expect(args).toContain('--reporter=json');
    expect(args).toContain('--outputFile.json=/tmp/results.json');
    expect(args).toContain(`--reporter=${UNHANDLED_REPORTER}`);
    expect(existsSync(UNHANDLED_REPORTER)).toBe(true);
  });

  it('reads the version of the vitest installed beside the binary it will actually run', () => {
    const detected = detectVitestVersion(DEVKIT_ROOT, VITEST);
    expect(detected.kind).toBe('known');
    const installed = JSON.parse(
      readFileSync(join(DEVKIT_ROOT, 'node_modules/vitest/package.json'), 'utf8'),
    );
    expect(detected.kind === 'known' && detected.version).toBe(installed.version);
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

  // sc-3731's acceptance table. 4.10 is the one a string or single-digit compare gets wrong, and a
  // prerelease is safe to retry on: retry.condition shipped in 4.1.0-beta.1 (vitest#8812).
  it.each([
    ['3.9.0', false],
    ['4.0.0', false],
    ['4.0.9', false],
    ['4.1.0', true],
    ['4.1.9', true],
    ['4.1.0-beta.1', true],
    ['4.1.0-beta.12', true],
    ['4.1.0-rc.0', true],
    ['4.1.0-alpha.3', false],
    ['4.1.0-beta.0', false],
    ['4.1.0-beta', false],
    ['4.1.0-next.1', false],
    ['4.2.0-beta.0', true],
    ['4.10.0', true],
    ['5.0.0', true],
  ])('vitest %s → retry %s', (version, expected) => {
    expect(supportsRetryCondition(vitestMajorMinorOf(version))).toBe(expected);
  });

  it.each([[''], ['latest'], ['workspace:*'], ['v4.1.9'], ['4.1']])(
    'refuses to guess a version from %j',
    (version) => {
      expect(vitestMajorMinorOf(version)).toBeNull();
    },
  );

  it('recognises every retry and reporter spelling', () => {
    expect(ownsRetry(['--retry.condition=x'])).toBe(true);
    expect(ownsRetry(['--retries=3'])).toBe(false); // not a vitest flag; must not swallow the retry
    expect(ownsReporter(['--outputFile=x'])).toBe(true);
    expect(ownsReporter(['--reporters=x'])).toBe(false);
  });
});

// sc-3731: a failed `vitest --version` spawn (load timeout, Windows sh-shim) used to read as
// "this vitest predates --retry.condition", so 4.1.9 lost its retry.
describe('learning the consumer vitest version', () => {
  // `.bin/vitest` is a plain-file shim (as pnpm writes). On `--version` it leaves a marker, so a test
  // can prove no spawn, and exits 1 unless shimVersion is given.
  const consumer = (opts: { installed?: string | null; shimVersion?: string } = {}) => {
    const root = makeRoot();
    const bin = join(root, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    const probed = join(root, 'probed');
    const shim = join(bin, 'vitest');
    writeFileSync(
      shim,
      `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  require('node:fs').writeFileSync(${JSON.stringify(probed)}, '');
  ${opts.shimVersion ? `process.stdout.write('vitest/${opts.shimVersion} linux-x64 node-v22.0.0\\n'); process.exit(0);` : 'process.exit(1);'}
}
process.exit(0);
`,
    );
    chmodSync(shim, 0o755);
    if (opts.installed !== null && opts.installed !== undefined) {
      mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'vitest', 'package.json'), opts.installed);
    }
    return { root, shim, probed };
  };
  const pkg = (version: string) => JSON.stringify({ name: 'vitest', version });

  const noticesFrom = (fn: () => void) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fn();
      return spy.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      spy.mockRestore();
    }
  };

  it('reads 4.1.9 off disk and injects the retry without spawning vitest', () => {
    const { root, shim, probed } = consumer({ installed: pkg('4.1.9') });

    expect(detectVitestVersion(root, shim)).toEqual({
      kind: 'known',
      version: '4.1.9',
      majorMinor: [4, 1],
    });
    let args: string[] = [];
    const notices = noticesFrom(() => {
      args = buildInjectedArgs(shim, [], '/tmp/results.json', root);
    });
    expect(args).toContain('--retry.count=1');
    expect(notices).not.toContain('Skipping the flake retry');
    // THE REGRESSION: a probe that spawns can time out under load. This one must not spawn at all.
    expect(existsSync(probed)).toBe(false);
  });

  // bun and pnpm link node_modules/vitest into a store; the read has to follow that link.
  it('follows a symlinked package directory (pnpm/bun store layout)', () => {
    const { root, shim } = consumer();
    const store = join(root, '.store', 'vitest@4.1.9');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'package.json'), pkg('4.1.9'));
    symlinkSync(store, join(root, 'node_modules', 'vitest'), 'dir');

    expect(detectVitestVersion(root, shim)).toMatchObject({ kind: 'known', version: '4.1.9' });
  });

  // A symlinked .bin names its package exactly; a stale sibling package.json must not outvote it.
  it('reads the version of the package a symlinked .bin/vitest actually runs', () => {
    const { root, shim } = consumer({ installed: pkg('4.1.9') });
    const old = join(root, '.store', 'vitest@4.0.3');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'package.json'), pkg('4.0.3'));
    writeFileSync(join(old, 'vitest.mjs'), '#!/usr/bin/env node\nprocess.exit(1);\n');
    chmodSync(join(old, 'vitest.mjs'), 0o755);
    rmSync(shim);
    symlinkSync(join(old, 'vitest.mjs'), shim);

    expect(detectVitestVersion(root, shim)).toMatchObject({ kind: 'known', version: '4.0.3' });
    const notices = noticesFrom(() => {
      expect(buildInjectedArgs(shim, [], '/tmp/results.json', root)).not.toContain(
        '--retry.count=1',
      );
    });
    expect(notices).toContain('detected vitest 4.0.3');
  });

  it('ignores the sibling package.json when a symlinked .bin leads to no vitest package', () => {
    const { root, shim } = consumer({ installed: pkg('4.1.9') });
    const elsewhere = join(root, 'tools');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'vitest'), '#!/usr/bin/env node\nprocess.exit(1);\n');
    chmodSync(join(elsewhere, 'vitest'), 0o755);
    rmSync(shim);
    symlinkSync(join(elsewhere, 'vitest'), shim);

    expect(detectVitestVersion(root, shim).kind).toBe('unknown');
  });

  // The binary that runs is <cwd>/node_modules/.bin/vitest (resolveVitest). A vitest resolved from an
  // ANCESTOR node_modules may be a different copy, so its version says nothing about this one.
  it('does not borrow the version of a vitest installed in a parent directory', () => {
    const parent = makeRoot();
    mkdirSync(join(parent, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(parent, 'node_modules', 'vitest', 'package.json'), pkg('4.1.9'));
    const root = join(parent, 'app');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    const shim = join(root, 'node_modules', '.bin', 'vitest');
    writeFileSync(shim, '#!/usr/bin/env node\nprocess.exit(1);\n');
    chmodSync(shim, 0o755);

    expect(detectVitestVersion(root, shim).kind).toBe('unknown');
  });

  it.each([
    ['not JSON', '{ nope'],
    ['no version field', JSON.stringify({ name: 'vitest' })],
    ['a non-semver version', pkg('workspace:*')],
    ['a JSON array', '[]'],
  ])('falls back to asking the binary when package.json has %s', (_label, installed) => {
    const { root, shim, probed } = consumer({ installed, shimVersion: '4.1.10' });

    expect(detectVitestVersion(root, shim)).toMatchObject({ kind: 'known', version: '4.1.10' });
    expect(existsSync(probed)).toBe(true);
  });

  it('falls back to asking the binary when no package.json is installed', () => {
    const { root, shim } = consumer({ shimVersion: '4.1.10' });
    expect(detectVitestVersion(root, shim)).toMatchObject({ kind: 'known', majorMinor: [4, 1] });
  });

  // Fail-CLOSED stays: an unknown version still gets no retry. What changes is the notice — it must
  // not claim the vitest is old when devkit simply could not tell.
  it('says it could not tell, not that vitest is old, when neither source answers', () => {
    const { root, shim } = consumer();

    const detected = detectVitestVersion(root, shim);
    expect(detected.kind).toBe('unknown');
    let args: string[] = [];
    const notices = noticesFrom(() => {
      args = buildInjectedArgs(shim, [], '/tmp/results.json', root);
    });
    expect(args.some((a) => a.startsWith('--retry'))).toBe(false);
    expect(notices).toContain('could not determine the vitest version');
    expect(notices).toContain(detected.kind === 'unknown' ? detected.reason : '<no reason>');
    expect(notices).not.toContain('predates');
  });

  it('names the detected version when vitest really is too old', () => {
    const { root, shim } = consumer({ installed: pkg('4.0.3') });

    let args: string[] = [];
    const notices = noticesFrom(() => {
      args = buildInjectedArgs(shim, [], '/tmp/results.json', root);
    });
    expect(args.some((a) => a.startsWith('--retry'))).toBe(false);
    expect(notices).toContain('detected vitest 4.0.3');
    expect(notices).toContain('>=4.1');
  });

  it('does not probe at all when the consumer owns retry', () => {
    const { root, shim, probed } = consumer();
    const notices = noticesFrom(() => {
      buildInjectedArgs(shim, ['--retry=0'], '/tmp/results.json', root);
    });
    expect(notices).toBe('');
    expect(existsSync(probed)).toBe(false);
  });

  // Wiring: every unit above passes a cwd by hand. produceCoverage must hand over the CONSUMER's,
  // or the disk read looks in the wrong place and the fix is inert end to end.
  it('produceCoverage injects the retry into the real invocation from the on-disk version', async () => {
    const { root, shim, probed } = consumer({ installed: pkg('4.1.9') });
    const argvFile = join(root, 'argv.json');
    writeFileSync(
      shim,
      `#!/usr/bin/env node
const probeFs = require('node:fs');
if (process.argv.includes('--version')) { probeFs.writeFileSync(${JSON.stringify(probed)}, ''); process.exit(1); }
probeFs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
${HONOURS_REPORTS_DIR_FLAG_SILENTLY}
`,
    );

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let code: number;
    let notices: string;
    try {
      code = await produceCoverage(root);
    } finally {
      notices = spy.mock.calls.flat().join('\n');
      spy.mockRestore();
    }

    expect(code).toBe(0);
    expect(notices).not.toContain('Skipping the flake retry');
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(
      expect.arrayContaining(['--retry.count=1', '--retry.condition=(Test|Hook) timed out']),
    );
    expect(existsSync(probed)).toBe(false);
  });
});

describe('the marker a cleared artifact leaves behind', () => {
  const failed = (...failedFiles: string[]) => ({ failedFiles, flaky: [] });

  it('records the unhandled error that ended a run with no failed test', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"stale.ts":{}}');
    const unhandled = [{ file: '/repo/late.test.ts', message: 'Error: boom' }];

    const diagnosis = { failedFiles: [], flaky: [], unhandled };
    expect(publishCoverage(runDirWith(root, 'runA'), root, snapshotArtifact(root), diagnosis)).toBe(
      'cleared',
    );
    const marker = readClearMarker(join(root, COVERAGE_DIR));
    expect(marker?.failedFiles).toEqual([]);
    expect(marker?.unhandledErrors).toEqual(unhandled);
  });

  it('is not written when a sibling report was preserved', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"sibling.ts":{}}');
    const dir = runDirWith(root, 'runA');
    const mtimeNow = snapshotArtifact(root);
    if (mtimeNow === null) throw new Error('the artifact written above must have an mtime');

    expect(publishCoverage(dir, root, mtimeNow - 5_000, failed('a.test.ts'))).toBe('kept');
    expect(readClearMarker(join(root, COVERAGE_DIR))).toBeNull();
  });

  it('records what failed when the artifact really was discarded', () => {
    const root = makeRoot();
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"stale.ts":{}}');
    const dir = runDirWith(root, 'runA');
    const before = snapshotArtifact(root);

    expect(publishCoverage(dir, root, before, failed('/repo/a.test.ts'))).toBe('cleared');
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
    publishCoverage(runDirWith(root, 'runA'), root, snapshotArtifact(root), failed('a.test.ts'));
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
    // A real failure is never a reason to spend a second full run (sc-3473).
    expect(result.stderr).not.toMatch(/re-running the whole suite/);
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

  // vitest traps SIGTERM and exits 143 with no report: the interruption, not reporter config, is why.
  it.each([
    [143, false],
    [1, true],
  ])(
    'a retrying run whose vitest exits %i without a report: blames reporters = %s',
    (code, blames) => {
      const root = makeRoot();
      silentStubVitest(root, `process.exit(${code});`);
      mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
      writeFileSync(join(root, COVERAGE_FILE), '{"from-an-earlier-green-run.ts":{}}');

      const result = coverageRun(root);

      expect(result.status).toBe(code);
      expect(/cannot be reported/.test(result.stderr)).toBe(blames);
      // Fail-CLOSED either way: the earlier run's artifact is gone and so is the run directory.
      expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
      expect(readdirSync(join(root, RUNS_DIR))).toEqual([]);
    },
  );
});

describe('runVitestDetailed', () => {
  // vitest traps SIGINT/SIGTERM and exits 128 + signo, so a child-only stop reports no signal.
  it.each([
    [143, true],
    [130, true],
    [1, false],
    [0, false],
  ])('a child exiting %i reads as interrupted = %s', async (code, interrupted) => {
    const run = await runVitestDetailed(
      process.execPath,
      ['-e', `process.exit(${code})`],
      tmpdir(),
    );
    expect(run).toEqual({ code, interrupted });
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
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
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
    // The retry was injected and no report exists, but the interruption is why, not reporter config.
    expect(stderr).not.toMatch(/cannot be reported/);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
    expect(readdirSync(join(root, RUNS_DIR))).toEqual([]);
  });
});

// sc-3473. vitest cannot raise a timeout for a retry, so a load-starved test fails its retry too.
// When EVERY failure is a timeout, coverage-run spends one whole re-run at a raised budget.
describe('the one re-run a timeout-only failure earns', () => {
  const failing = (): RerunInput => ({
    code: 1,
    interrupted: false,
    retrying: true,
    diagnosis: {
      failedFiles: ['/repo/a.test.ts'],
      flaky: [],
      failures: { tests: [], allTimedOut: true, timeoutMs: 300 },
    },
    argv: [],
    env: {},
  });

  it('re-runs a failure that is nothing but timeouts', () => {
    expect(shouldRerun(failing())).toBe(true);
  });

  // The documented opt-out is `=1`. A falsy-looking value must not silently switch the rescue off.
  it.each(['0', 'false', ''])('still re-runs when the opt-out env is %j', (value) => {
    expect(shouldRerun({ ...failing(), env: { [NO_RERUN_ENV]: value } })).toBe(true);
  });

  it.each<[string, Partial<RerunInput>]>([
    ['a green run', { code: 0 }],
    ['an interrupted run', { interrupted: true }],
    ['a run devkit did not retry', { retrying: false }],
    ['a run with no report', { diagnosis: null }],
    ['a run where nothing failed', { diagnosis: { failedFiles: [], flaky: [] } }],
    [
      'a real failure among the timeouts',
      {
        diagnosis: {
          failedFiles: ['/repo/a.test.ts'],
          flaky: [],
          failures: { tests: [], allTimedOut: false, timeoutMs: 300 },
        },
      },
    ],
    ['the opt-out env', { env: { [NO_RERUN_ENV]: '1' } }],
    ['a consumer-owned retry', { argv: ['--retry=0'] }],
    ['a consumer-owned timeout', { argv: ['--testTimeout=9000'] }],
    ['a consumer-owned worker count', { argv: ['--maxWorkers', '2'] }],
  ])('does not re-run %s', (_label, change) => {
    expect(shouldRerun({ ...failing(), ...change })).toBe(false);
  });

  it('recognises every spelling of a consumer-owned budget, and nothing else', () => {
    for (const arg of [
      '--testTimeout=1',
      '--testTimeout',
      '--test-timeout=1',
      '--hookTimeout=1',
      '--hook-timeout',
      '--maxWorkers=50%',
      '--max-workers=2',
    ]) {
      expect(ownsTimeoutBudget([arg]), arg).toBe(true);
    }
    for (const arg of ['--testNamePattern=x', '-t', '--testTimeouts=1', 'testTimeout']) {
      expect(ownsTimeoutBudget([arg]), arg).toBe(false);
    }
  });

  // A scripted vitest: pass N does plan[N-1]. Every invocation's argv is logged, so the tests can
  // see how many passes ran and exactly what each was given.
  const scriptedVitest = (root: string, plan: string[], extra = '') => {
    const log = join(root, 'invocations.log');
    silentStubVitest(
      root,
      `const fs = require('node:fs');
const arg = (p) => (process.argv.find((a) => a.startsWith(p)) ?? '').slice(p.length);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const n = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;
const step = ${JSON.stringify(plan)}[n - 1] ?? 'unplanned';
const dir = arg('--coverage.reportsDirectory=');
const out = arg('--outputFile.json=');
const timedOut = (name, duration) => ({
  name, status: 'failed', message: '',
  assertionResults: [{ fullName: 'slow', status: 'failed', duration,
    failureMessages: ['Error: STACK_TRACE_ERROR\\n  at task', 'Error: STACK_TRACE_ERROR\\n  at task'] }],
});
const report = (testResults) => fs.writeFileSync(out, JSON.stringify({ testResults }));
const green = () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/coverage-final.json', JSON.stringify({ 'lib.mjs': { fresh: n } }));
  report([{ name: '/repo/a.test.ts', status: 'passed', assertionResults: [] }]);
  process.exit(0);
};
${extra}
if (step === 'timeout') { report([timedOut('/repo/a.test.ts', 612)]); process.exit(1); }
if (step === 'slow-timeout') { report([timedOut('/repo/a.test.ts', 40000)]); process.exit(1); }
if (step === 'other-timeout') { report([timedOut('/repo/b.test.ts', 612)]); process.exit(1); }
if (step === 'bug') {
  report([{ name: '/repo/a.test.ts', status: 'failed',
    assertionResults: [{ fullName: 'bug', status: 'failed', failureMessages: ['AssertionError'] }] }]);
  process.exit(1);
}
if (step === 'green') green();
if (step === 'green-no-report') { report([]); process.exit(0); }
if (step === 'unhandled') {
  report([{ name: '/repo/a.test.ts', status: 'passed', assertionResults: [] }]);
  fs.writeFileSync(out.replace(/[^/]+$/, 'unhandled.json'),
    JSON.stringify([{ file: '/repo/late.test.ts', message: 'Error: boom' }]));
  process.exit(1);
}
process.exit(99);`,
    );
    // SAFETY: every line was written by the stub above as JSON.stringify(process.argv.slice(2)),
    // an array of strings.
    return () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[]);
  };

  const run = (root: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    testSpawnSync(process.execPath, [CLI, 'coverage-run', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  const seedArtifact = (root: string) => {
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"from-an-earlier-green-run.ts":{}}');
  };

  it('publishes from a second pass given a raised budget, and reports the rescue as flaky', () => {
    const root = makeRoot();
    const calls = scriptedVitest(root, ['timeout', 'green']);
    seedArtifact(root);

    const result = run(root);

    expect(result.status).toBe(0);
    const [first, second] = calls();
    expect(calls()).toHaveLength(2);
    // 306ms observed per attempt × 5 is under the floor, so the floor wins.
    expect(second).toContain('--testTimeout=25000');
    expect(second).toContain('--hookTimeout=25000');
    expect(first.some((a) => a.startsWith('--testTimeout'))).toBe(false);
    // Still retrying, still reporting — pass 2 is a normal run with a bigger budget.
    expect(second).toContain('--retry.count=1');
    // Its own run directory: nothing of pass 1's state carries over.
    const dirOf = (argv: string[]) => argv.find((a) => a.startsWith('--coverage.reportsDirectory'));
    expect(dirOf(second)).not.toBe(dirOf(first));
    expect(JSON.parse(readFileSync(join(root, COVERAGE_FILE), 'utf8'))['lib.mjs'].fresh).toBe(2);
    expect(readClearMarker(join(root, COVERAGE_DIR))).toBeNull();
    expect(readdirSync(join(root, RUNS_DIR))).toEqual([]);
    expect(result.stderr).toMatch(/re-running the whole suite ONCE at testTimeout=25000ms/);
    expect(result.stderr).toMatch(/passed only at the raised timeout/);
    expect(result.stderr).toMatch(/a\.test\.ts > slow/);
  });

  it('scales the budget from the observed per-attempt ceiling', () => {
    const root = makeRoot();
    const calls = scriptedVitest(root, ['slow-timeout', 'green']);

    expect(run(root).status).toBe(0);
    // 40000ms summed over two attempts = 20000ms per attempt; × 5.
    expect(calls()[1]).toContain('--testTimeout=100000');
  });

  it('runs at most twice, and a second failure names its own files on the marker', () => {
    const root = makeRoot();
    const calls = scriptedVitest(root, ['timeout', 'other-timeout', 'green']);
    seedArtifact(root);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(calls()).toHaveLength(2);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
    expect(readClearMarker(join(root, COVERAGE_DIR))?.failedFiles).toEqual(['/repo/b.test.ts']);
    expect(result.stderr).not.toMatch(/passed only at the raised timeout/);
  });

  it('does not call a green-but-reportless second pass a success', () => {
    const root = makeRoot();
    scriptedVitest(root, ['timeout', 'green-no-report']);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/vitest passed but produced no coverage-final\.json/);
  });

  // A trapped SIGTERM must refuse the re-run as an interruption, even beside a timeout-only report.
  it('never re-runs a pass whose vitest trapped SIGTERM', () => {
    const root = makeRoot();
    const calls = scriptedVitest(
      root,
      ['timeout-then-143', 'green'],
      `if (step === 'timeout-then-143') { report([timedOut('/repo/a.test.ts', 612)]); process.exit(143); }`,
    );
    seedArtifact(root);

    const result = run(root);

    expect(result.status).toBe(143);
    expect(calls()).toHaveLength(1);
    expect(result.stderr).not.toMatch(/re-running the whole suite/);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  });

  it('does not blame reporters when the second pass is the one stopped', () => {
    const root = makeRoot();
    const calls = scriptedVitest(
      root,
      ['timeout', 'sigterm'],
      `if (step === 'sigterm') process.exit(143);`,
    );
    seedArtifact(root);

    const result = run(root);

    expect(result.status).toBe(143);
    expect(calls()).toHaveLength(2);
    expect(result.stderr).not.toMatch(/cannot be reported/);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
    expect(readdirSync(join(root, RUNS_DIR))).toEqual([]);
  });

  it.each<[string, string[], NodeJS.ProcessEnv]>([
    ['a real failure', [], {}],
    ['the opt-out env', [], { [NO_RERUN_ENV]: '1' }],
    ['a consumer-owned timeout', ['--testTimeout=9000'], {}],
  ])('stays a single failed run for %s', (label, args, env) => {
    const root = makeRoot();
    const calls = scriptedVitest(root, [label === 'a real failure' ? 'bug' : 'timeout', 'green']);
    seedArtifact(root);

    const result = run(root, args, env);

    expect(result.status).toBe(1);
    expect(calls()).toHaveLength(1);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
    expect(result.stderr).not.toMatch(/re-running the whole suite/);
  });

  // In process as well: the scripted stub is silent on stdout (sc-2228), and this is the path the
  // coverage report can actually see.
  it('re-runs, publishes and returns the second pass code in process', async () => {
    const root = makeRoot();
    const calls = scriptedVitest(root, ['timeout', 'green']);
    seedArtifact(root);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await produceCoverage(root)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(calls()).toHaveLength(2);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(true);
  });

  it('refreshes the marker with the second pass failures in process', async () => {
    const root = makeRoot();
    scriptedVitest(root, ['timeout', 'other-timeout']);
    seedArtifact(root);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await produceCoverage(root)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(readClearMarker(join(root, COVERAGE_DIR))?.failedFiles).toEqual(['/repo/b.test.ts']);
  });

  // Pass 1's marker names a.test.ts; pass 2 failed on something else entirely, and only that is true.
  it('refreshes the marker with an unhandled error that ended the second pass', async () => {
    const root = makeRoot();
    scriptedVitest(root, ['timeout', 'unhandled']);
    seedArtifact(root);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await produceCoverage(root)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const marker = readClearMarker(join(root, COVERAGE_DIR));
    expect(marker?.failedFiles).toEqual([]);
    expect(marker?.unhandledErrors).toEqual([
      { file: '/repo/late.test.ts', message: 'Error: boom' },
    ]);
  });

  // `coverage.reportOnFailure` makes a failed run write a report anyway. It is partial, so trusting it
  // — during pass 2, or after pass 2 is killed — would pass the gate on incomplete coverage.
  it('never publishes the report of a failed pass', async () => {
    const root = makeRoot();
    scriptedVitest(
      root,
      ['report-on-failure'],
      `if (step === 'report-on-failure') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/coverage-final.json', JSON.stringify({ 'partial.mjs': {} }));
  report([{ name: '/repo/a.test.ts', status: 'failed',
    assertionResults: [{ fullName: 'bug', status: 'failed', failureMessages: ['AssertionError'] }] }]);
  process.exit(1);
}`,
    );
    seedArtifact(root);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await produceCoverage(root)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
    expect(readClearMarker(join(root, COVERAGE_DIR))?.failedFiles).toEqual(['/repo/a.test.ts']);
  });

  // Between the passes a sibling agent publishes a good report. Pass 2 failing must not destroy it —
  // and must not write a marker claiming it discarded something it did not.
  it('leaves a sibling report published between the passes alone', async () => {
    const root = makeRoot();
    scriptedVitest(
      root,
      ['timeout', 'sibling-then-fail'],
      `if (step === 'sibling-then-fail') {
  fs.mkdirSync(${JSON.stringify(join(root, COVERAGE_DIR))}, { recursive: true });
  fs.writeFileSync(${JSON.stringify(join(root, COVERAGE_FILE))}, '{"sibling.ts":{}}');
  report([timedOut('/repo/b.test.ts', 612)]);
  process.exit(1);
}`,
    );
    seedArtifact(root);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await produceCoverage(root)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(join(root, COVERAGE_FILE), 'utf8')).toContain('sibling.ts');
    // The marker from pass 1's clear is left as it was, not rewritten for a clear pass 2 never made.
    expect(readClearMarker(join(root, COVERAGE_DIR))?.failedFiles).toEqual(['/repo/a.test.ts']);
  });

  // The escape hatch is printed where the failure is, not only after a rescue — the whole point of
  // the story is that the advice used to arrive one full run too late.
  it('prints the exact escape hatch when the re-run is opted out', () => {
    const root = makeRoot();
    scriptedVitest(root, ['timeout']);

    const result = run(root, [], { [NO_RERUN_ENV]: '1' });

    expect(result.stderr).toContain('--testTimeout=25000 --maxWorkers=50%');
  });

  // The stub writes a timeout-shaped report and THEN blocks, so everything shouldRerun reads says
  // "re-run" except the interruption itself. Ctrl-C must end it.
  it('never starts a second pass after a Ctrl-C', async () => {
    const root = makeRoot();
    const ready = join(root, 'ready.flag');
    const calls = scriptedVitest(
      root,
      ['timeout-then-block', 'green'],
      `if (step === 'timeout-then-block') {
  report([timedOut('/repo/a.test.ts', 612)]);
  fs.writeFileSync(${JSON.stringify(ready)}, 'x');
  ${blockFor(60_000)}
}`,
    );

    const child = spawn(process.execPath, [CLI, 'coverage-run'], { cwd: root, stdio: 'pipe' });
    const guard = setTimeout(() => child.kill('SIGKILL'), 60_000);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    try {
      await waitForPath(ready, 30_000);
      child.kill('SIGINT');
      await new Promise((r) => child.on('close', r));
    } finally {
      clearTimeout(guard);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    expect(calls()).toHaveLength(1);
    expect(stderr).not.toMatch(/re-running the whole suite/);
    expect(readdirSync(join(root, RUNS_DIR))).toEqual([]);
  });
});

describe('a load flake the retry cannot rescue, against real vitest', () => {
  // Starves on EVERY attempt at 300ms — the field report's shape, where the retry at the same
  // ceiling failed too. Only a bigger budget gets it through.
  it('goes green on the one re-run and keeps the artifact', () => {
    const root = makeRoot();
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default {
        test: {
          include: ['*.test.mjs'],
          testTimeout: 300,
          coverage: { provider: 'v8', reporter: ['json'], reportsDirectory: './coverage' },
        },
      };\n`,
    );
    writeFileSync(
      join(root, 'starved.test.mjs'),
      `import { expect, it } from 'vitest';
      it('starved under load', async () => {
        await new Promise((r) => setTimeout(r, 600));
        expect(1).toBe(1);
      });\n`,
    );

    const result = coverageRun(root);

    expect(result.status).toBe(0);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(true);
    expect(result.stderr).toMatch(/re-running the whole suite ONCE/);
    expect(result.stderr).toMatch(/starved under load/);
    expect(result.stderr).toMatch(/passed only at the raised timeout/);
  });
});

describe('a run that exits non-zero with no failed test, against real vitest', () => {
  // The shape that discarded an artifact in silence: every test green, one unhandled rejection.
  const consumerRepo = (root: string, thresholds = '') => {
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default {
        test: {
          include: ['*.test.mjs'],
          coverage: { provider: 'v8', reporter: ['json'], reportsDirectory: './coverage'${thresholds} },
        },
      };\n`,
    );
    mkdirSync(join(root, COVERAGE_DIR), { recursive: true });
    writeFileSync(join(root, COVERAGE_FILE), '{"from-an-earlier-green-run.ts":{}}');
    writeFileSync(
      join(root, 'late.test.mjs'),
      `import { expect, it } from 'vitest';
      it('passes but leaks a rejection', () => {
        setTimeout(() => Promise.reject(new Error('boom after the test')), 0);
        expect(1).toBe(1);
      });
      it('outlives the rejection', async () => {
        await new Promise((r) => setTimeout(r, 50));
      });\n`,
    );
  };

  it('names the unhandled error and its test file, and records both in the marker', () => {
    const root = makeRoot();
    consumerRepo(root);

    const result = coverageRun(root);

    expect(result.status).toBe(1);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
    expect(result.stderr).toMatch(/no test failed — the run ended on:/);
    expect(result.stderr).toMatch(/late\.test\.mjs — Error: boom after the test/);
    const marker = readClearMarker(join(root, COVERAGE_DIR));
    expect(marker?.unhandledErrors).toEqual([
      { file: expect.stringMatching(/late\.test\.mjs$/), message: 'Error: boom after the test' },
    ]);
  });

  // No unhandled error to name: vitest exits 1 on a missed coverage threshold with every test green.
  it('gives the generic cause when no error was reported', () => {
    const root = makeRoot();
    consumerRepo(root, ', thresholds: { functions: 100 }');
    writeFileSync(
      join(root, 'late.test.mjs'),
      `import { expect, it } from 'vitest';
      import { used } from './src.mjs';
      it('covers half', () => expect(used()).toBe(1));\n`,
    );
    writeFileSync(
      join(root, 'src.mjs'),
      'export const used = () => 1;\nexport const unused = () => 2;\n',
    );

    const result = coverageRun(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/file unknown — vitest exited 1 with no failed test/);
    expect(readClearMarker(join(root, COVERAGE_DIR))?.unhandledErrors).toHaveLength(1);
  });
});
