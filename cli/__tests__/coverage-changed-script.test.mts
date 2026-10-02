import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

const ignored = (path: string): boolean =>
  testSpawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: ROOT }).status === 0;

describe('test:run:coverage:changed', () => {
  it('passes --changed once, taking the base from COVERAGE_BASE', () => {
    // vitest refuses to start on a second --changed, so the base cannot be overridden by appending one.
    expect(script.match(/--changed\b/g)).toHaveLength(1);
    expect(script).toContain('--changed=${COVERAGE_BASE:-origin/main}');
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

  it('leaves its report gitignored without ignoring the gate-engine/coverage source dir', () => {
    expect(ignored(`${reportsDir()}/coverage-final.json`)).toBe(true);
    expect(ignored('gate-engine/coverage/new-module.mts')).toBe(false);
  });
});
