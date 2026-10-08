import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relatedPaths, runRelatedTests } from '../lib/husky/gate-policy/related-tests.mts';

function fakeExec(status: number | null) {
  return vi.fn((_cmd: string, _args: string[], _opts: { cwd: string; stdio: 'inherit' }) => ({
    status,
  }));
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('relatedPaths', () => {
  it('drops the full-suite triggers and sorts the rest', () => {
    expect(
      relatedPaths([
        'src/b.mts',
        'package.json',
        'vitest.config.mjs',
        'src/a.mts',
        'vitest.setup.mjs',
      ]),
    ).toEqual(['src/a.mts', 'src/b.mts']);
  });
});

describe('runRelatedTests', () => {
  it('passes without running vitest when nothing is staged', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(0);
    expect(runRelatedTests('/repo', { staged: null, exec })).toBe(0);
    expect(runRelatedTests('/repo', { staged: ['package.json'], exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('related-tests: none selected');
  });

  it('runs vitest related on the staged paths and propagates a failure', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(1);
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec })).toBe(1);
    expect(exec).toHaveBeenCalledWith(
      join('/repo', 'node_modules', '.bin', 'vitest'),
      ['related', '--run', '--reporter=dot', 'cli/a.mts'],
      { cwd: '/repo', stdio: 'inherit' },
    );
  });

  it('blocks when vitest is killed or cannot spawn', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(null);
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec })).toBe(1);
  });

  it('selects from the index, never from unstaged edits', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = mkdtempSync(join(tmpdir(), 'related-tests-'));
    dirs.push(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.mts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'b.mts'), 'export const b = 1;\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    writeFileSync(join(repo, 'a.mts'), 'export const a = 2;\n');
    writeFileSync(join(repo, 'b.mts'), 'export const b = 2;\n');
    git(repo, 'add', 'a.mts');
    const exec = fakeExec(0);
    runRelatedTests(repo, { exec });
    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      ['related', '--run', '--reporter=dot', 'a.mts'],
      expect.anything(),
    );
  });
});
