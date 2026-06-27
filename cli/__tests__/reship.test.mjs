import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

// `devkit ship --pr <branch>` (re-push): adds the current changes to an EXISTING PR's branch as a
// new commit on top of origin/<branch> (copy-not-patch), fast-forward push (never --force). Hermetic
// — bare local origin, no gh/network; the headline assert is that the new commit sits on the fetched
// PR-branch tip with the current file content.

vi.setConfig({ testTimeout: 30_000 });

const scriptPath = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const GENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const BR_RE = /BR=(.*)/;
const REPO_RE = /REPO=(.*)/;
const WT_RE = /worktree kept at (.+?)\. Remove/;
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function run(args, dir, env = {}) {
  return spawnSync('/bin/bash', [scriptPath, ...args], {
    cwd: dir,
    input: 'body\n',
    encoding: 'utf8',
    env: { ...process.env, ...GENV, ...env },
  });
}

/** A repo with `origin` set (GitHub-shaped by default) on branch `work`. */
function repo(origin = 'git@github.com:acme/app.git') {
  const dir = mkdtempSync(join(tmpdir(), 'reship-'));
  dirs.push(dir);
  const g = (a) =>
    execFileSync('git', ['-C', dir, ...a], { env: { ...process.env, ...GENV }, stdio: 'ignore' });
  g(['init', '-q', '-b', 'work']);
  g(['config', 'user.email', 'a@b.c']);
  g(['config', 'user.name', 'a']);
  g(['commit', '-q', '--allow-empty', '-m', 'base']);
  g(['remote', 'add', 'origin', origin]);
  return { dir, g };
}

describe('reship — resolve + arg guards', () => {
  it('resolve seam prints BR + REPO from a GitHub origin (before any fetch)', () => {
    const { dir } = repo('git@github.com-personal:acme/app.git');
    const r = run(['feat/open', 'title', '--pr', '--', 'a.ts'], dir, { SHIP_RESOLVE_ONLY: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(BR_RE.exec(r.stdout)?.[1]).toBe('feat/open');
    expect(REPO_RE.exec(r.stdout)?.[1]).toBe('acme/app');
  });
  it('rejects no paths', () => {
    const { dir } = repo();
    expect(run(['feat/open', 't', '--pr', '--'], dir).status).not.toBe(0);
  });
  it('rejects a directory path', () => {
    const { dir } = repo();
    mkdirSync(join(dir, 'sub'));
    const r = run(['feat/open', 't', '--pr', '--', 'sub'], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/directory path not allowed/);
  });
  it('fails clearly when the PR branch does not exist on the remote', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const { dir } = repo(bare); // bare origin, no feat/open branch on it
    writeFileSync(join(dir, 'a.ts'), 'x\n');
    const r = run(['feat/open', 't', '--pr', '--', 'a.ts'], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no remote branch origin\/feat\/open/);
  });
});

describe('reship — re-push commits onto the PR-branch tip', () => {
  it('dry-run stacks the current content as a new commit on origin/<branch>', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'work'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
    ])
      g(a, { stdio: 'ignore' });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    // First ship: push a.ts=v1 to origin/feat/pr.
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    const prTip = g(['rev-parse', 'origin/feat/pr']).trim();
    // Now the agent edits a.ts in the working tree and re-pushes.
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    expect(r.status, r.stderr).toBe(0);
    expect(wt, 'dry-run should keep + name the worktree').toBeTruthy();

    const gwt = (a) => execFileSync('git', ['-C', wt, ...a], { env, encoding: 'utf8' }).trim();
    expect(gwt(['show', 'HEAD:a.ts'])).toBe('v2'); // the new commit carries the current content
    expect(gwt(['rev-parse', 'HEAD~1'])).toBe(prTip); // parented on the PR-branch tip (a real ff)
    g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
  });
});
