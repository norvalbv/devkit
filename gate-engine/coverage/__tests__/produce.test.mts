/**
 * The coverage PRODUCER (`devkit coverage-run`, gate-engine/coverage/produce.mts). Three load-bearing
 * properties: concurrent runs never touch each other's reports directory (sc-1214), a run that
 * produced no report REMOVES the stable artifact so the gate stays fail-CLOSED, and the report lands
 * on exactly the path the gate reads.
 */
import { spawn } from 'node:child_process';
import {
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
import { afterEach, describe, expect, it } from 'vitest';
import {
  COVERAGE_DIR,
  COVERAGE_FILE,
  produceCoverage,
  pruneStaleRuns,
  publishCoverage,
  REPORT_NAME,
  RUNS_DIR,
  reservesCoverageDir,
  resolveRunDir,
  resolveVitest,
  STALE_RUN_MS,
  snapshotArtifact,
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

    expect(publishCoverage(dir, root, null)).toBe(true);
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

    expect(publishCoverage(dir, root, before)).toBe(false);
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
    const aDifferentFileThanTheOneThereNow = snapshotArtifact(root)! - 5_000;

    expect(publishCoverage(dir, root, aDifferentFileThanTheOneThereNow)).toBe(false);
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

    expect(publishCoverage(dir, root, null)).toBe(false); // null = nothing there when we started
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

    expect(publishCoverage(dir, root, before)).toBe(false);
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
    expect(publishCoverage(dir, root, null)).toBe(true);
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

describe('a run that verified nothing', () => {
  // The gate already fails CLOSED on an absent artifact, so this is diagnosis rather than a
  // correctness hole: without it, a consumer missing the `json` reporter gets a green
  // test:run:coverage and then a commit-time block whose cause is three steps upstream.
  it('exits non-zero when vitest passes but emits no report', async () => {
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

    expect(await produceCoverage(root)).toBe(1);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  }, 120_000);

  // The fail-closed guarantee, end to end against real vitest — the arrangement the unit tests could
  // not reproduce, because it depends on vitest deleting its own reports directory.
  it('clears a previous report when the suite actually fails', async () => {
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

    expect(await produceCoverage(root)).not.toBe(0);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  }, 120_000);

  it('refuses to forward the reports-directory flag it owns', async () => {
    const root = makeRoot();
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'));
    expect(await produceCoverage(root, ['--coverage.reportsDirectory=/tmp/elsewhere'])).toBe(1);
    // Rejected before anything ran, so no run directory was ever created.
    expect(existsSync(join(root, RUNS_DIR))).toBe(false);
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
