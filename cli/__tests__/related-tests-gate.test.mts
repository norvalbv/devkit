import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listRelated,
  relatedPaths,
  runRelatedTests,
} from '../lib/husky/gate-policy/related-tests.mts';

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
  it('passes without listing or running vitest when nothing is staged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const list = vi.fn(async () => ['/repo/a.test.mts']);
    const exec = fakeExec(0);
    expect(await runRelatedTests('/repo', { staged: null, list, exec })).toBe(0);
    expect(await runRelatedTests('/repo', { staged: ['package.json'], list, exec })).toBe(0);
    expect(list).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('related-tests: none selected');
  });

  it('passes without spawning vitest when no test relates to the staged paths', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(0);
    const list = vi.fn(async () => []);
    expect(await runRelatedTests('/repo', { staged: ['guard.config.json'], list, exec })).toBe(0);
    expect(list).toHaveBeenCalledWith('/repo', ['guard.config.json']);
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('related-tests: no test relates to the 1 staged path(s)');
  });

  it('blocks without spawning vitest when the related set cannot be listed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = fakeExec(0);
    const list = vi.fn(async () => {
      throw new Error('Transform failed');
    });
    expect(await runRelatedTests('/repo', { staged: ['cli/a.mts'], list, exec })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(
      '✗ related-tests could not list related tests: Transform failed',
    );
  });

  it('runs exactly the listed test files and propagates a failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(1);
    const list = vi.fn(async () => ['/repo/cli/a.test.mts']);
    expect(await runRelatedTests('/repo', { staged: ['cli/a.mts'], list, exec })).toBe(1);
    expect(exec).toHaveBeenCalledWith(
      join('/repo', 'node_modules', '.bin', 'vitest'),
      ['run', '--reporter=dot', '/repo/cli/a.test.mts'],
      { cwd: '/repo', stdio: 'inherit' },
    );
  });

  it('blocks when vitest is killed or cannot spawn', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const list = vi.fn(async () => ['/repo/cli/a.test.mts']);
    expect(
      await runRelatedTests('/repo', { staged: ['cli/a.mts'], list, exec: fakeExec(null) }),
    ).toBe(1);
  });

  it('selects from the index, never from unstaged edits', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = editedRepo();
    git(repo, 'add', 'a.mts');
    const list = vi.fn(async () => []);
    await runRelatedTests(repo, { list, exec: fakeExec(0) });
    expect(list).toHaveBeenCalledWith(repo, ['a.mts']);
  });

  // `commit -a` / `commit <path>` stage into an alternate index the hook hands over via the carrier.
  it('selects from the commit index the hook carries, not the default index', async () => {
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
    const list = vi.fn(async () => []);
    await runRelatedTests(repo, { list, exec: fakeExec(0) });
    expect(list).toHaveBeenCalledWith(repo, ['b.mts']);
  });
});

// A git repo where only a.test.mts imports a.mts, and nothing imports data.json.
function graphRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'related-list-')));
  dirs.push(root);
  writeFileSync(join(root, 'a.mts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'data.json'), '{}\n');
  writeFileSync(
    join(root, 'a.test.mts'),
    "import { expect, it } from 'vitest';\nimport { a } from './a.mts';\nit('a', () => expect(a).toBe(1));\n",
  );
  git(root, 'init', '-q');
  return root;
}

const GATE = join(import.meta.dirname, '..', 'lib', 'husky', 'gate-policy', 'related-tests.mts');

function runGate(root: string) {
  return spawnSync(process.execPath, [GATE], { cwd: root, encoding: 'utf8', timeout: 90_000 });
}

describe('listRelated', () => {
  it('resolves the import graph: a JSON no test imports selects nothing', async () => {
    const root = graphRepo();
    expect(await listRelated(root, ['data.json'])).toEqual([]);
    expect(await listRelated(root, ['a.mts'])).toEqual([join(root, 'a.test.mts')]);
  }, 60_000);

  // A test-only commit must still run the staged test, as `vitest related` did.
  it('selects a staged test file itself', async () => {
    const root = graphRepo();
    expect(await listRelated(root, ['a.test.mts'])).toEqual([join(root, 'a.test.mts')]);
  }, 60_000);
});

describe('related-tests gate process', () => {
  // The fixture has no node_modules/.bin/vitest, so any spawn would fail and block.
  it('passes a config-only commit without spawning vitest, and exits', () => {
    const root = graphRepo();
    git(root, 'add', 'data.json');
    const r = runGate(root);
    expect(r.stdout).toContain('related-tests: no test relates to the 1 staged path(s)');
    expect(r.status).toBe(0);
  }, 90_000);

  // A listed file vitest run does not select would print "No test files found" and exit 1.
  it('runs the listed test file through vitest run', () => {
    const root = graphRepo();
    symlinkSync(join(import.meta.dirname, '..', '..', 'node_modules'), join(root, 'node_modules'));
    git(root, 'add', 'a.mts');
    const r = runGate(root);
    expect(r.stdout).toContain('related-tests: 1 test file(s) for 1 staged path(s)');
    expect(r.stdout).toMatch(/Tests\s+1 passed/);
    expect(r.status).toBe(0);
  }, 90_000);
});
