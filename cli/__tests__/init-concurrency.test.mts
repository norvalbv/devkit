// sc-2429: init/upgrade serialize on <gitRoot>/.devkit/init.lock. Planted locks carry this runner's
// live pid, so they are never reaped and every refusal is deterministic.
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLockPath, initLockWaitMs, withInitLock } from '../lib/install/init/init-lock.mts';
import { sha256 } from '../lib/fs-helpers.mts';
import { CLI, readConfig, supervisedCommand, testSpawnSync, tmpRepos } from './_helpers.mts';

const { tmpRepo, cleanup } = tmpRepos('init-lock-');
afterEach(cleanup);

const FAST = { ...process.env, DEVKIT_INIT_LOCK_WAIT_MS: '100' };
const REFUSED = /another devkit init\/upgrade is running/;

const devkit = (cwd: string, ...args: string[]) =>
  testSpawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: FAST });

// Inside a git repo the lock lives in the git admin dir (never stageable); elsewhere under .devkit.
const lockDir = (root: string) =>
  existsSync(join(root, '.git'))
    ? join(root, '.git', 'devkit-init.lock')
    : join(root, '.devkit', 'init.lock');

/** Plant a held init lock. Default holder = this test process (alive → never reaped). */
function plantInitLock(
  gitRoot: string,
  {
    pid = process.pid,
    ageMs = 0,
    stamped = true,
  }: { pid?: number; ageMs?: number; stamped?: boolean } = {},
) {
  const dir = lockDir(gitRoot);
  mkdirSync(dir, { recursive: true });
  if (stamped) writeFileSync(join(dir, 'holder'), `${pid}:planted-uuid`, 'utf8');
  const when = new Date(Date.now() - ageMs);
  utimesSync(dir, when, when);
}

function hookSnapshot(root: string): Record<string, string> {
  const files: Array<[string, string]> = [];
  for (const provider of ['claude', 'codex', 'cursor']) {
    const dir = join(root, `.${provider}`, 'hooks');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort())
      files.push([`${provider}/${name}`, sha256(join(dir, name))]);
  }
  return Object.fromEntries(files);
}

/** A generic-stack package install with agent-hook scripts on disk. */
function installedWithHooks(): string {
  const root = tmpRepo();
  const first = devkit(root, 'init', '--stack', 'generic', '--yes', '--agent-hooks');
  expect(first.status, first.stderr).toBe(0);
  expect(Object.keys(hookSnapshot(root)).length).toBeGreaterThan(0);
  return root;
}

const configBytes = (root: string) => readFileSync(join(root, '.devkit', 'config.json'), 'utf8');

describe('devkit init — concurrent-run lock (sc-2429)', () => {
  it('refuses while another run holds the lock, touching neither config nor installed hooks', () => {
    const root = installedWithHooks();
    const beforeConfig = configBytes(root);
    const beforeHooks = hookSnapshot(root);
    plantInitLock(root);

    const refused = devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');

    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(REFUSED);
    expect(refused.stderr).toContain(`pid ${process.pid}`);
    expect(configBytes(root)).toBe(beforeConfig);
    expect(hookSnapshot(root)).toEqual(beforeHooks);
  });

  it('a rerun after the holder finishes keeps BOTH explicit updates and the installed hooks', () => {
    const root = installedWithHooks();
    const beforeHooks = hookSnapshot(root);
    plantInitLock(root);
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code').status).toBe(1);

    rmSync(lockDir(root), { recursive: true, force: true });
    const rerun = devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');

    expect(rerun.status, rerun.stderr).toBe(0);
    expect(readConfig(root).components).toMatchObject({ searchCode: true, agentHooks: true });
    expect(hookSnapshot(root)).toEqual(beforeHooks);
    expect(existsSync(lockDir(root))).toBe(false); // released — never left for `git add` to stage
  });

  it('two genuinely concurrent reruns both land: each explicit update is recorded and installed', async () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    // A long wait so the loser queues behind the winner instead of failing fast.
    const env = { ...process.env, DEVKIT_INIT_LOCK_WAIT_MS: '120000' };
    const run = (flag: string) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        // Bounded at the spawn site like every other CLI subprocess in the suite.
        const supervised = supervisedCommand(
          process.execPath,
          [CLI, 'init', '--stack', 'generic', '--yes', flag],
          { cwd: root, env },
        );
        const child = spawn(process.execPath, supervised.args, supervised.options);
        let stderr = '';
        child.stderr.on('data', (d) => {
          stderr += d;
        });
        child.on('close', (code) => resolve({ code, stderr }));
      });

    const [a, b] = await Promise.all([run('--search-code'), run('--agent-hooks')]);

    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect(readConfig(root).components).toMatchObject({ searchCode: true, agentHooks: true });
    expect(Object.keys(hookSnapshot(root)).length).toBeGreaterThan(0);
    expect(existsSync(lockDir(root))).toBe(false);
  }, 150_000);

  it('recovers from a crashed holder (stale lock, dead pid)', () => {
    const root = tmpRepo();
    const dead = 4_194_305; // above every kernel's pid ceiling: provably not running
    plantInitLock(root, { pid: dead, ageMs: 90_000 });

    const run = devkit(root, 'init', '--stack', 'generic', '--yes');

    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(lockDir(root))).toBe(false);
  });

  it('names an unknown holder (not NaN) for a fresh unstamped lock', () => {
    const root = tmpRepo();
    plantInitLock(root, { stamped: false });

    const refused = devkit(root, 'init', '--stack', 'generic', '--yes');

    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(REFUSED);
    expect(refused.stderr).not.toContain('NaN');
    expect(refused.stderr).toContain('pid unknown');
  });

  it('releases the lock when the run fails after acquiring it', () => {
    const root = tmpRepo();
    // --review without husky is rejected after selection resolution, i.e. inside the lock.
    const failed = devkit(root, 'init', '--stack', 'generic', '--yes', '--review', '--no-husky');

    expect(failed.status).toBe(1);
    expect(existsSync(lockDir(root))).toBe(false);
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
  });

  it('an uninitialized repo is left untouched by a refused upgrade or failed init', () => {
    const root = tmpRepo();
    expect(devkit(root, 'upgrade').status).toBe(2);
    expect(
      devkit(root, 'init', '--stack', 'generic', '--yes', '--review', '--no-husky').status,
    ).toBe(1);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
  });

  it('dry-run takes no lock, for init and upgrade', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    plantInitLock(root);

    const init = devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code', '--dry-run');
    const upgrade = devkit(root, 'upgrade', '--dry-run');

    expect(init.status, init.stderr).toBe(0);
    expect(init.stderr).not.toMatch(REFUSED);
    expect(upgrade.stderr).not.toMatch(REFUSED);
  });

  it('serializes devkit upgrade against a running init', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    const before = configBytes(root);
    plantInitLock(root);

    const upgrade = devkit(root, 'upgrade');

    expect(upgrade.status).toBe(1);
    expect(upgrade.stderr).toMatch(/devkit upgrade: another devkit init\/upgrade is running/);
    expect(configBytes(root)).toBe(before);
  });

  it('serializes overlay-mode init (its own config write path)', () => {
    const root = tmpRepo();
    execFileSync('git', ['init', '-q'], { cwd: root });
    plantInitLock(root);

    const refused = devkit(root, 'init', '--stack', 'generic', '--overlay', '--yes');

    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(REFUSED);
    expect(existsSync(join(root, '.devkit', 'config.json'))).toBe(false);
  });

  it('locks at the git root, so a monorepo package run waits on a root-level holder', () => {
    const root = tmpRepo();
    execFileSync('git', ['init', '-q'], { cwd: root });
    const pkg = join(root, 'packages', 'web');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'web', version: '0.0.0' }));
    plantInitLock(root);

    const refused = devkit(pkg, 'init', '--stack', 'generic', '--yes');

    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(REFUSED);
    expect(existsSync(join(pkg, '.devkit', 'config.json'))).toBe(false);
    expect(existsSync(lockDir(pkg))).toBe(false);
  });
});

describe('withInitLock', () => {
  it('leaves no .devkit behind when a run into an uninitialized repo writes nothing', async () => {
    const root = tmpRepo();
    const code = await withInitLock(root, 'upgrade', async () => 2);
    expect(code).toBe(2);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
  });

  it('tidies an empty .devkit another contender created before this run took the lock', async () => {
    // B saw A's .devkit (so B did not create it); A then left. Only B's own lock is inside when
    // B acquires, so B's no-write refusal must still leave the tree empty.
    const root = tmpRepo();
    mkdirSync(join(root, '.devkit'));
    const code = await withInitLock(root, 'upgrade', async () => 2);
    expect(code).toBe(2);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
  });

  it('keeps a .devkit the run created once something was written into it', async () => {
    const root = tmpRepo();
    await withInitLock(root, 'init', async () => {
      writeFileSync(join(root, '.devkit', 'config.json'), '{}');
      return 0;
    });
    expect(existsSync(join(root, '.devkit', 'config.json'))).toBe(true);
  });

  it('serializes two overlapping calls in the same process (no in-process bypass)', async () => {
    const root = tmpRepo();
    const prior = process.env.DEVKIT_INIT_LOCK_WAIT_MS;
    process.env.DEVKIT_INIT_LOCK_WAIT_MS = '5000';
    const order: string[] = [];
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    try {
      const first = withInitLock(root, 'init', async () => {
        order.push('first:start');
        await gate;
        order.push('first:end');
        return 0;
      });
      const second = withInitLock(root, 'upgrade', async () => {
        order.push('second');
        return 0;
      });
      setImmediate(open);
      expect(await Promise.all([first, second])).toEqual([0, 0]);
    } finally {
      if (prior === undefined) delete process.env.DEVKIT_INIT_LOCK_WAIT_MS;
      else process.env.DEVKIT_INIT_LOCK_WAIT_MS = prior;
    }
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(existsSync(lockDir(root))).toBe(false);
  });
});

describe('initLockWaitMs', () => {
  it.each([
    [undefined, 5000],
    ['', 5000],
    ['   ', 5000],
    ['soon', 5000],
    ['-1', 5000],
    ['Infinity', 5000],
    ['9'.repeat(400), 5000],
    ['9007199254740993', 5000],
    ['0', 0],
    [' 250 ', 250],
  ])('DEVKIT_INIT_LOCK_WAIT_MS=%j waits %i ms', (raw, expected) => {
    expect(initLockWaitMs(raw)).toBe(expected);
  });
});

describe('initLockPath', () => {
  it('uses the git admin dir, so the lock can never be staged', () => {
    const root = tmpRepo();
    execFileSync('git', ['init', '-q'], { cwd: root });
    expect(initLockPath(root)).toBe(join(root, '.git', 'devkit-init.lock'));
  });

  it('follows a gitdir file (linked worktree / submodule), relative or absolute', () => {
    const root = tmpRepo();
    writeFileSync(join(root, '.git'), 'gitdir: ../admin/worktrees/wt\n');
    expect(initLockPath(root)).toBe(
      join(root, '..', 'admin', 'worktrees', 'wt', 'devkit-init.lock'),
    );
    writeFileSync(join(root, '.git'), `gitdir: ${join(root, 'abs-admin')}\n`);
    expect(initLockPath(root)).toBe(join(root, 'abs-admin', 'devkit-init.lock'));
  });

  it('falls back to .devkit outside git', () => {
    const root = tmpRepo();
    expect(initLockPath(root)).toBe(join(root, '.devkit', 'init.lock'));
  });

  it('a refused upgrade in an uninitialized git repo leaves the working tree clean', () => {
    const root = tmpRepo();
    execFileSync('git', ['init', '-q'], { cwd: root });
    expect(devkit(root, 'upgrade').status).toBe(2);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
    expect(existsSync(lockDir(root))).toBe(false);
  });
});
