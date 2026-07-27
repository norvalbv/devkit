import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTracked, trackedPathPredicate } from './git-tracked.mts';

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'git-tracked-'));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('tracked path checks', () => {
  it('distinguishes tracked files and directories from untracked paths', () => {
    const cwd = root();
    execFileSync('git', ['init', '-q'], { cwd });
    writeFileSync(join(cwd, 'tracked.txt'), 'tracked');
    execFileSync('git', ['add', 'tracked.txt'], { cwd });

    expect(isTracked(cwd, 'tracked.txt')).toBe(true);
    expect(isTracked(cwd, 'missing.txt')).toBe(false);
    const snapshot = trackedPathPredicate(cwd);
    expect(snapshot('tracked.txt')).toBe(true);
    expect(snapshot('missing.txt')).toBe(false);
  });

  it('propagates Git probe failures instead of authorizing destructive fallback', () => {
    const cwd = root();
    expect(() => isTracked(cwd, 'anything')).toThrow();
    expect(() => trackedPathPredicate(cwd)).toThrow();
  });
});
