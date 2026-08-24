import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommitTerminalFragment } from '../lib/husky/commit-terminal.mts';

const HELPER = resolve(import.meta.dirname, '../lib/ship/repo-identity.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function identityOf(root: string): string {
  return execSync(`. "${HELPER}" && devkit_repo_identity "${root}"`, {
    encoding: 'utf8',
    shell: '/bin/bash',
  }).trim();
}

function gitRepo(name: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'repo-id-'));
  dirs.push(parent);
  const repo = join(parent, name);
  execSync(`git init -q "${repo}"`);
  execSync('git config user.email t@t.t && git config user.name t', {
    cwd: repo,
    shell: '/bin/bash',
  });
  execSync('git commit -qm init --allow-empty', { cwd: repo });
  return repo;
}

describe('devkit_repo_identity (sc-2000)', () => {
  it('prefers the origin remote name over the directory basename', () => {
    const repo = gitRepo('some-local-dirname');
    execSync('git remote add origin git@github.com:acme/actual-product.git', { cwd: repo });
    expect(identityOf(repo)).toBe('actual-product');
  });

  it('strips .git and trailing slashes from https remotes', () => {
    const repo = gitRepo('x');
    execSync('git remote add origin https://github.com/acme/my-repo.git/', { cwd: repo });
    expect(identityOf(repo)).toBe('my-repo');
  });

  it('falls back to the MAIN checkout dirname from a linked worktree with no remote', () => {
    const repo = gitRepo('the-real-repo');
    const wt = join(repo, '..', 'wts', 'worktree'); // the exact bucket 350/3,317 attempts hit
    execSync(`git worktree add -q "${wt}" HEAD`, { cwd: repo });
    expect(identityOf(wt)).toBe('the-real-repo');
  });

  it('falls back to the plain basename outside any git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-git-'));
    dirs.push(dir);
    expect(identityOf(dir)).toBe(dir.split('/').pop());
  });
});

describe('commit-terminal fragment (sc-2000)', () => {
  it('stamps repo from the remote-first helper, never the raw toplevel basename', () => {
    const fragment = buildCommitTerminalFragment();
    expect(fragment).toContain('__dk_repo()');
    expect(fragment).toContain('remote get-url origin');
    expect(fragment).toContain('--git-common-dir');
    // The repo printf arg must route through the helper.
    expect(fragment).toContain('"$(__dk_esc "$(__dk_repo)")"');
  });
});
