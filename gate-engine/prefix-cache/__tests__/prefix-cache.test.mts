import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPrefix, clearPrefix, computeKey, recordPrefix } from '../prefix-cache.mts';

const CLI = fileURLToPath(new URL('../cli.mts', import.meta.url));

const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'guard-prefix-'));
  dirs.push(d);
  return d;
};
const gitRepo = () => {
  const d = tempDir();
  execSync('git init -q', { cwd: d });
  writeFileSync(join(d, 'a.txt'), 'one');
  execSync('git add .', { cwd: d });
  return d;
};

let savedShip: string | undefined;
beforeEach(() => {
  savedShip = process.env.DEVKIT_SHIP;
  process.env.DEVKIT_SHIP = '1';
});
afterEach(() => {
  if (savedShip === undefined) delete process.env.DEVKIT_SHIP;
  else process.env.DEVKIT_SHIP = savedShip;
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('computeKey', () => {
  it('same staged tree → same key; touched staged file → different key', () => {
    const repo = gitRepo();
    const k1 = computeKey(repo);
    expect(computeKey(repo)).toBe(k1);
    writeFileSync(join(repo, 'a.txt'), 'two');
    execSync('git add .', { cwd: repo });
    expect(computeKey(repo)).not.toBe(k1);
  });
  it('version salt, hook bytes, and scope each change the key', () => {
    const repo = gitRepo();
    const base = computeKey(repo, { versionSalt: 'v1' });
    expect(computeKey(repo, { versionSalt: 'v2' })).not.toBe(base);
    expect(computeKey(repo, { versionSalt: 'v1', scope: 'other' })).not.toBe(base);
    writeFileSync(join(repo, 'hook.sh'), 'gates v1');
    const withHook = computeKey(repo, { versionSalt: 'v1', hookPath: 'hook.sh' });
    expect(withHook).not.toBe(base);
    writeFileSync(join(repo, 'hook.sh'), 'gates v2');
    expect(computeKey(repo, { versionSalt: 'v1', hookPath: 'hook.sh' })).not.toBe(withHook);
  });
  it('non-repo or unreadable hook → null (run the gates)', () => {
    expect(computeKey(tempDir())).toBeNull();
    expect(computeKey(gitRepo(), { hookPath: 'no-such-hook' })).toBeNull();
  });
});

describe('checkPrefix / recordPrefix', () => {
  it('record → check hits for the identical tree, misses after a staged change', () => {
    const repo = gitRepo();
    expect(checkPrefix(repo)).toBe(false);
    recordPrefix(repo);
    expect(checkPrefix(repo)).toBe(true);
    writeFileSync(join(repo, 'a.txt'), 'two');
    execSync('git add .', { cwd: repo });
    expect(checkPrefix(repo)).toBe(false);
  });
  it('no-ops without DEVKIT_SHIP (non-ship commits neither trust nor write keys)', () => {
    const repo = gitRepo();
    recordPrefix(repo);
    delete process.env.DEVKIT_SHIP;
    recordPrefix(repo);
    expect(checkPrefix(repo)).toBe(false);
    process.env.DEVKIT_SHIP = '1';
    // only the ship-scoped record above landed
    expect(checkPrefix(repo)).toBe(true);
  });
  it('a linked worktree shares the main checkout store (retry from a fresh ship worktree hits)', () => {
    const repo = gitRepo();
    execSync('git -c user.email=t@t -c user.name=t commit -qm i', { cwd: repo });
    const wt = join(repo, '.worktrees', 'ship-x');
    execSync(`git worktree add -q ${JSON.stringify(wt)} -b tmp-branch`, { cwd: repo });
    writeFileSync(join(wt, 'a.txt'), 'staged-in-worktree');
    execSync('git add .', { cwd: wt });
    recordPrefix(wt);
    expect(checkPrefix(wt)).toBe(true);
    // a SECOND worktree with the same staged tree hits the shared entry
    const wt2 = join(repo, '.worktrees', 'ship-y');
    execSync(`git worktree add -q ${JSON.stringify(wt2)} -b tmp-branch-2`, { cwd: repo });
    writeFileSync(join(wt2, 'a.txt'), 'staged-in-worktree');
    execSync('git add .', { cwd: wt2 });
    expect(checkPrefix(wt2)).toBe(true);
  });
  it('repo dir and hook path containing SPACES round-trip (devkit itself lives in one)', () => {
    const parent = tempDir();
    const repo = join(parent, 'my repo dir');
    mkdirSync(repo, { recursive: true });
    execSync('git init -q', { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one');
    writeFileSync(join(repo, 'pre commit hook.sh'), 'gates');
    execSync('git add a.txt', { cwd: repo });
    const opts = { hookPath: 'pre commit hook.sh' };
    expect(computeKey(repo, opts)).toBeTruthy();
    recordPrefix(repo, opts);
    expect(checkPrefix(repo, opts)).toBe(true);
  });

  it('corrupt store → miss (run the gates); clearPrefix drops keys', () => {
    const repo = gitRepo();
    recordPrefix(repo);
    mkdirSync(join(repo, '.devkit'), { recursive: true });
    writeFileSync(join(repo, '.devkit', 'prefix-cache.json'), '{nope');
    expect(checkPrefix(repo)).toBe(false);
    recordPrefix(repo);
    expect(checkPrefix(repo)).toBe(true);
    clearPrefix(repo);
    expect(checkPrefix(repo)).toBe(false);
  });
});

// The bin contract the hooks script against: exit codes are the API (a wrong code silently
// skips gates or re-runs them forever), so pin them at the spawned-CLI level.
describe('guard-prefix CLI (spawned)', () => {
  const run = (args, cwd, env = {}) =>
    spawnSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, DEVKIT_SHIP: '1', ...env },
    });

  it('check misses (1) → record (0) → check hits (0) with the skip line on stderr; clear re-misses', () => {
    const repo = gitRepo();
    expect(run(['check'], repo).status).toBe(1);
    expect(run(['record'], repo).status).toBe(0);
    const hit = run(['check'], repo);
    expect(hit.status).toBe(0);
    expect(hit.stderr).toContain('skipping deterministic gates');
    expect(run(['clear'], repo).status).toBe(0);
    expect(run(['check'], repo).status).toBe(1);
  });

  it('outside a ship (no DEVKIT_SHIP) check always misses and record writes nothing', () => {
    const repo = gitRepo();
    const noShip = { DEVKIT_SHIP: '' };
    expect(run(['record'], repo, noShip).status).toBe(0); // best-effort, still exit 0
    expect(run(['check'], repo, noShip).status).toBe(1);
    expect(run(['check'], repo).status).toBe(1); // nothing leaked into the ship-scoped view
  });

  it('unreadable --hook and unknown usage both fail toward running the gates (1)', () => {
    const repo = gitRepo();
    expect(run(['check', '--hook', 'no-such-hook'], repo).status).toBe(1);
    expect(run(['bogus-cmd'], repo).status).toBe(1);
    expect(run([], repo).status).toBe(1);
  });
});
