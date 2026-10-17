import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { COVERAGE_DIR, RUNS_DIR } from '../../gate-engine/coverage/produce.mts';
import { testSpawnSync } from './_helpers.mts';

// devkit's own `test:run:coverage:changed` script: per-file coverage for a diff, via vitest --changed.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg: { scripts: Record<string, string> } = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
);
const script = pkg.scripts['test:run:coverage:changed'];

const reportsDir = (): string => {
  const match = /--coverage\.reportsDirectory=(\S+)/.exec(script);
  if (!match) throw new Error('script sets no --coverage.reportsDirectory');
  return match[1];
};

// A fresh process per env: other test files import vitest.config.mjs, so setting it here is too late.
type CoverageBlock = { reporter?: [string, { maxCols: number; skipFull: boolean }][] };
const coverageBlock = (marker?: string): CoverageBlock => {
  const env = { ...process.env };
  delete env.DEVKIT_COVERAGE_CHANGED;
  if (marker) env.DEVKIT_COVERAGE_CHANGED = marker;
  const code = "import c from './vitest.config.mjs'; console.log(JSON.stringify(c.test.coverage));";
  const run = testSpawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`config import failed: ${run.stderr}`);
  const block: CoverageBlock = JSON.parse(run.stdout);
  return block;
};

// Records its argv and the reports dir, leaves vitest's leftovers (tmp/<uuid>, .tmp) there, then fails.
const FAKE_VITEST = `#!/bin/sh
echo "$@" > argv
for a; do case $a in --coverage.reportsDirectory=*) d=\${a#*=};; esac; done
echo "$d" > reports-dir
mkdir -p "$d/tmp/uuid" "$d/.tmp" && touch "$d/tmp/uuid/x" "$d/.tmp/y"
exit 3
`;

// Runs the real script text in `root`, with FAKE_VITEST first on PATH and a test file appended.
const runScript = (root: string) => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'vitest'), FAKE_VITEST, { mode: 0o755 });
  return testSpawnSync('/bin/sh', ['-c', `${script} a.test.mts`], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
};
// 2^22 + 1: above Linux's PID_MAX_LIMIT and macOS's pid ceiling, so no process can ever hold it.
const DEAD_PID = '4194305';

const ignored = (path: string): boolean =>
  testSpawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: ROOT }).status === 0;

describe('test:run:coverage:changed', () => {
  it('passes --changed once, taking the base from COVERAGE_BASE', () => {
    // vitest refuses to start on a second --changed, so the base cannot be overridden by appending one.
    expect(script.match(/--changed\b/g)).toHaveLength(1);
    expect(script).toContain('--changed=${COVERAGE_BASE:-origin/main}');
  });

  it('still prints the table when a test in the changed set fails', () => {
    // vitest skips the coverage report on a failed run unless this is set.
    expect(script).toContain('--coverage.reportOnFailure');
  });

  it("writes its report outside the coverage gate's artifact dir and coverage-run's run dirs", () => {
    // vitest cleans its reports directory at startup; the default would delete coverage-final.json.
    const dir = reportsDir();
    expect(dir).not.toBe(COVERAGE_DIR);
    expect(dir.startsWith(`${RUNS_DIR}/`) || dir === RUNS_DIR).toBe(false);
    expect(dir.startsWith(`${COVERAGE_DIR}/`)).toBe(true);
  });

  it('gives each run its own reports dir, so concurrent runs cannot delete each other’s .tmp', () => {
    // vitest removes <reportsDirectory>/.tmp when a run finishes; a shared dir lets the first run to
    // finish delete a sibling's in-flight coverage files. `$$` is the script shell's PID.
    expect(reportsDir().endsWith('/$$')).toBe(true);
  });

  it('leaves the reporter to the config, which only this script switches on', () => {
    // A CLI --coverage.reporter replaces the config tuple, and the CLI cannot carry its options.
    expect(script).toContain('; DEVKIT_COVERAGE_CHANGED=1 vitest run ');
    expect(script).not.toContain('--coverage.reporter');
  });

  it('prints full file names when piped, and a row for a fully covered file under an agent', () => {
    expect(coverageBlock('1').reporter).toEqual([['text', { maxCols: 200, skipFull: false }]]);
  });

  it("leaves vitest's default reporters, including the gate's json, to every other run", () => {
    expect(coverageBlock()).not.toHaveProperty('reporter');
  });

  it('leaves its report gitignored without ignoring the gate-engine/coverage source dir', () => {
    expect(ignored(`${reportsDir()}/coverage-final.json`)).toBe(true);
    expect(ignored('gate-engine/coverage/new-module.mts')).toBe(false);
  });

  describe('cleanup', () => {
    let root = '';
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("removes its own reports dir and a dead run's, keeps a live run's, and passes args and status through", () => {
      root = mkdtempSync(join(tmpdir(), 'coverage-changed-'));
      const changed = join(root, 'coverage', '.changed');
      for (const pid of [String(process.pid), DEAD_PID]) {
        mkdirSync(join(changed, pid, '.tmp'), { recursive: true });
        writeFileSync(join(changed, pid, '.tmp', 'f'), '');
      }

      const run = runScript(root);

      expect(run.status, run.stderr).toBe(3);
      expect(readFileSync(join(root, 'argv'), 'utf8')).toContain('a.test.mts');
      const own = readFileSync(join(root, 'reports-dir'), 'utf8').trim();
      expect(own.startsWith('coverage/.changed/')).toBe(true);
      expect(existsSync(join(root, own))).toBe(false);
      expect(readdirSync(changed)).toEqual([String(process.pid)]);
      expect(existsSync(join(changed, String(process.pid), '.tmp', 'f'))).toBe(true);
    });

    it('removes a dead-PID symlink without deleting the directory it points at', () => {
      // `rm -rf link/` resolves the link, so a trailing slash would delete the target instead.
      root = mkdtempSync(join(tmpdir(), 'coverage-changed-'));
      mkdirSync(join(root, 'outside'));
      writeFileSync(join(root, 'outside', 'keep'), '');
      mkdirSync(join(root, 'coverage', '.changed'), { recursive: true });
      symlinkSync(join(root, 'outside'), join(root, 'coverage', '.changed', DEAD_PID));

      expect(runScript(root).status).toBe(3);
      expect(existsSync(join(root, 'outside', 'keep'))).toBe(true);
      expect(readdirSync(join(root, 'coverage', '.changed'))).toEqual([]);
    });
  });
});
