/** Coverage's exit 2 (NOT MEASURED) is a visible skip only under `devkit review`, and a review that
 * skipped a gate never records a prefix key that would let a later review skip it silently. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDeterministic } from '../run.mts';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-det-review-cov-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  vi.stubEnv('GUARD_DETERMINISTIC_STRICT', '');
  vi.stubEnv('FRINK_DETERMINISTIC_STRICT', '');
  vi.stubEnv('DEVKIT_GATE_EVENTS', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake gate runner where only the coverage module exits with `code`. */
const coverageExits = (code: number) =>
  vi.fn((_node: string, argv: string[]) => {
    if (code !== 0 && argv[0]?.includes('coverage/run')) {
      throw Object.assign(new Error(`exit ${code}`), { status: code });
    }
  });

const coverageRuns = (exec: ReturnType<typeof coverageExits>) =>
  exec.mock.calls.filter(([, argv]) => argv[0]?.includes('coverage/run')).length;

function review(): void {
  vi.stubEnv('DEVKIT_SHIP', '1'); // run-gates-with-capture.sh arms the prefix cache under review too
  vi.stubEnv('DEVKIT_RUN_MODE', 'review');
  vi.stubEnv('DEVKIT_REVIEW_GUARDS', 'coverage');
}

describe('coverage exit 2 under review', () => {
  it('is a visible skip, and the skipped run records no prefix key', () => {
    review();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = coverageExits(2);
    expect(runDeterministic(dir, { exec })).toBe(0);
    expect(runDeterministic(dir, { exec })).toBe(0);
    expect(coverageRuns(exec)).toBe(2); // the second review ran coverage again
    expect(err.mock.calls.flat().join('\n')).toContain('guard-coverage');
  });

  it('a measured, green review still records its key, and the hit re-judges coverage', () => {
    review();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = coverageExits(0);
    expect(runDeterministic(dir, { exec })).toBe(0);
    expect(runDeterministic(dir, { exec })).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('passed for this exact staged tree');
    expect(coverageRuns(exec)).toBe(2);
  });
});

describe('coverage exit 2 outside review', () => {
  it('blocks as (unexpected:2) — ship and commit never read it as a skip', () => {
    vi.stubEnv('DEVKIT_RUN_MODE', '');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = coverageExits(2);
    expect(runDeterministic(dir, { exec, only: ['coverage'] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('guard-coverage(unexpected:2)');
  });
});
