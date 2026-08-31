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

  it('preserves alternate-index semantics for shared tracked-path callers', () => {
    const cwd = root();
    execFileSync('git', ['init', '-q'], { cwd });
    writeFileSync(join(cwd, 'real.txt'), 'real');
    writeFileSync(join(cwd, 'alternate.txt'), 'alternate');
    execFileSync('git', ['add', 'real.txt'], { cwd });
    const alternateIndex = join(cwd, 'alternate-index');
    const env = { ...process.env, GIT_INDEX_FILE: alternateIndex };
    execFileSync('git', ['read-tree', '--empty'], { cwd, env });
    execFileSync('git', ['add', 'alternate.txt'], { cwd, env });
    const previousIndex = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = alternateIndex;
    try {
      const snapshot = trackedPathPredicate(cwd);
      expect(snapshot('alternate.txt')).toBe(true);
      expect(snapshot('real.txt')).toBe(false);
    } finally {
      if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousIndex;
    }
  });
});
