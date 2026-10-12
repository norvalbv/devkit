import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// A committed a.mts + b.mts, both then edited on disk, with nothing staged yet.
function editedRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'related-tests-')));
  dirs.push(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.mts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'b.mts'), 'export const b = 1;\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(join(repo, 'a.mts'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'b.mts'), 'export const b = 2;\n');
  return repo;
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

  // vitest's triggers are `**/package.json` and `**/{vitest,vite}.config.*`; every release stages dist/package.json.
  it('drops nested trigger files too, keeping look-alikes', () => {
    expect(
      relatedPaths([
        'dist/package.json',
        'templates/app/vite.config.ts',
        'vitest.e2e.config.mjs',
        'cli/package-json.mts',
      ]),
    ).toEqual(['cli/package-json.mts', 'vitest.e2e.config.mjs']);
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
    const repo = editedRepo();
    git(repo, 'add', 'a.mts');
    const exec = fakeExec(0);
    runRelatedTests(repo, { exec });
    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      ['related', '--run', '--reporter=dot', 'a.mts'],
      expect.anything(),
    );
  });

  // `commit -a` / `commit <path>` stage into an alternate index the hook hands over via the carrier.
  it('selects from the commit index the hook carries, not the default index', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = editedRepo();
    git(repo, 'add', 'a.mts');
    const alt = join(repo, '.git', 'next-index');
    execFileSync('git', ['read-tree', 'HEAD'], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: alt },
    });
    execFileSync('git', ['add', 'b.mts'], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: alt },
    });
    vi.stubEnv('DEVKIT_COMMIT_INDEX_FILE', alt);
    vi.stubEnv('DEVKIT_COMMIT_GIT_DIR', join(repo, '.git'));
    const exec = fakeExec(0);
    runRelatedTests(repo, { exec });
    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      ['related', '--run', '--reporter=dot', 'b.mts'],
      expect.anything(),
    );
  });
});
