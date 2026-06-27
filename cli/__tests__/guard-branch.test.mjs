import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { decide } from '../lib/guard/protected-branch-guard.mjs';

// The protected-branch guard: a direct `git commit` on a protected branch (main / X.Y.Z) is DENIED
// with a copy-paste-ready `devkit ship …` (auto branch + the agent's -m title + the staged paths);
// `--pr` becomes a re-push; un-translatable commits (-a/-am, no -m, empty index) deny with a fix-it.
// Everything else (feature branch, detached, not-a-commit) is allowed (decide → null). Hermetic —
// real throwaway repos for branch resolution; decide() called directly.

vi.setConfig({ testTimeout: 30_000 });

const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A throwaway repo on `branch` (HEAD born), with `staged` files added to the index. */
function repoOn(branch, { staged = [], config } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  dirs.push(dir);
  const g = (...a) =>
    execFileSync('git', ['-C', dir, ...a], { env: GENV, stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', branch);
  g('config', 'user.email', 'a@b.c');
  g('config', 'user.name', 'a');
  g('config', 'commit.gpgsign', 'false');
  g('commit', '-q', '--allow-empty', '-m', 'base'); // born HEAD so symbolic-ref resolves
  for (const f of staged) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), 'x\n');
    g('add', f);
  }
  if (config) {
    mkdirSync(join(dir, '.devkit'), { recursive: true });
    writeFileSync(join(dir, '.devkit', 'config.json'), JSON.stringify(config));
  }
  return dir;
}

/** decide() on a command running in `dir`. */
const run = (command, dir, rand = 'r4nd') => decide({ tool_input: { command } }, dir, rand);

describe('protected-branch-guard — allows', () => {
  it('a feature branch → null (no deny)', () => {
    const dir = repoOn('feat/x', { staged: ['a.ts'] });
    expect(run('git commit -m "x"', dir)).toBeNull();
  });
  it('a detached HEAD → null', () => {
    const dir = repoOn('main', { staged: ['a.ts'] });
    execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach'], { env: GENV, stdio: 'ignore' });
    expect(run('git commit -m "x"', dir)).toBeNull();
  });
  it('a non-commit command → null', () => {
    const dir = repoOn('main', { staged: ['a.ts'] });
    expect(run('git status', dir)).toBeNull();
    expect(run('echo "git commit -m x"', dir)).toBeNull(); // quoted text, not a real commit
  });
});

describe('protected-branch-guard — denies on a protected branch', () => {
  it('hands a ready-to-run `devkit ship` with auto branch + title + staged paths', () => {
    const dir = repoOn('main', { staged: ['src/a.ts', 'src/b.ts'] });
    const r = run('git commit -m "fix the bug"', dir, 'abc123');
    expect(r).toContain("devkit ship 'agent/fix-the-bug-abc123' 'fix the bug'");
    expect(r).toContain("-- 'src/a.ts' 'src/b.ts'");
    expect(r).toMatch(/protected branch "main"/);
  });

  it('treats an X.Y.Z release branch as protected', () => {
    const dir = repoOn('1.2.3', { staged: ['a.ts'] });
    expect(run('git commit -m "x"', dir)).toContain('devkit ship');
  });

  it('resolves the target repo via an explicit `git -C <dir>`', () => {
    const dir = repoOn('main', { staged: ['a.ts'] });
    // cwd is elsewhere; the -C dir is the protected repo → still denies.
    const r = run(`git -C "${dir}" commit -m "y"`, tmpdir());
    expect(r).toContain('devkit ship');
  });

  it('--pr <branch> becomes a re-push command (--pr, ff, the existing branch)', () => {
    const dir = repoOn('0.0.9', { staged: ['a.ts'] });
    const r = run('git commit --pr feat/open -m "more"', dir);
    expect(r).toContain("devkit ship 'feat/open' 'more' --pr -- 'a.ts'");
    expect(r).toMatch(/fast-forward, never --force/);
  });

  it('single-quotes the title safely (copy-paste-proof)', () => {
    const dir = repoOn('main', { staged: ['a.ts'] });
    const r = run(`git commit -m "it's broken"`, dir, 'z');
    expect(r).toContain(`'it'\\''s broken'`); // POSIX single-quote escape
  });

  it('captures an escaped \\"…\\" title in full (nested-shell commit), not the first token', () => {
    const dir = repoOn('main', { staged: ['a.ts'] });
    // A commit built inside a nested shell arrives backslash-escaped — the title must survive whole.
    const r = run('git commit -m \\"feat(x): add the thing\\"', dir, 'z');
    expect(r).toContain("devkit ship 'agent/feat-x-add-the-thing-z' 'feat(x): add the thing'");
  });

  it('bakes a multi-`-m` body into a `printf %s … |` prefix (one copy-paste, body on the PR)', () => {
    const dir = repoOn('main', { staged: ['a.ts'] });
    const r = run('git commit -m "the title" -m "the body"', dir, 'z');
    expect(r).toContain("printf %s 'the body' | devkit ship 'agent/the-title-z' 'the title'");
  });

  it('no body (single -m) → no printf prefix', () => {
    const dir = repoOn('main', { staged: ['a.ts'] });
    const r = run('git commit -m "solo"', dir, 'z');
    expect(r).toContain("Run this instead:\n  devkit ship 'agent/solo-z' 'solo'");
    expect(r).not.toContain('printf');
  });

  it('uses the repo .devkit/config.json ship command + extraArgs', () => {
    const dir = repoOn('main', {
      staged: ['a.ts'],
      config: {
        ship: { command: 'scripts/git/ship-branch.sh', extraArgs: ['--link', '.search-code'] },
      },
    });
    const r = run('git commit -m "t"', dir, 'q');
    expect(r).toContain("scripts/git/ship-branch.sh 'agent/t-q' 't' --link .search-code -- 'a.ts'");
  });
});

describe('protected-branch-guard — fix-it denies (un-translatable commits)', () => {
  it('rejects -a / -am (shared-tree sweep) without handing a ship command', () => {
    const dir = repoOn('main', { staged: ['a.ts'] });
    const r = run('git commit -am "x"', dir);
    expect(r).toMatch(/stages all tracked changes/);
    expect(r).not.toContain('devkit ship ');
  });
  it('rejects a bare commit (no -m → editor)', () => {
    const dir = repoOn('main', { staged: ['a.ts'] });
    expect(run('git commit', dir)).toMatch(/commit with `-m/);
  });
  it('rejects --amend', () => {
    const dir = repoOn('main', { staged: ['a.ts'] });
    expect(run('git commit --amend -m "x"', dir)).toMatch(/--amend/);
  });
  it('asks to stage when the index is empty', () => {
    const dir = repoOn('main'); // nothing staged
    expect(run('git commit -m "x"', dir)).toMatch(/Stage the files you mean first/);
  });
});
