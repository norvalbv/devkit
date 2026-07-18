import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { recordShip } from '../lib/ship/reconcile-manifest-write.mts';

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
    expect(r.stderr).toMatch(/list its tracked files: git ls-files -- "sub"/);
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

describe('reship — merges the re-pushed paths into the branch reconcile entry', () => {
  it('on a real push, extends branches[$BR] with this commit content (tip blob) + new paths', () => {
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
      ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], // GitHub-shaped so REPO resolves
    ])
      g(a, { stdio: 'ignore' });
    g(['remote', 'set-url', 'origin', bare], { stdio: 'ignore' }); // ...but push/fetch the local bare
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    // First ship: a.ts=v1 on origin/feat/pr, and seed its manifest entry (what the initial `devkit ship` does).
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    const prTip = g(['rev-parse', 'HEAD']).trim();
    expect(
      recordShip(
        {
          root: dir,
          branch: 'feat/pr',
          repo: 'acme/app',
          baseRef: 'work',
          baseSha: prTip,
          pr: '7',
        },
        ['a.ts'],
      ),
    ).toBe(0);

    // The agent edits a.ts and adds b.ts, then `devkit ship --pr feat/pr`.
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    writeFileSync(join(dir, 'b.ts'), 'B\n');

    // Stub `gh` (clears reship's `command -v gh` check + the final `gh pr view`); keep node on PATH.
    const stubBin = mkdtempSync(join(tmpdir(), 'reship-bin-'));
    dirs.push(stubBin);
    writeFileSync(join(stubBin, 'gh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(stubBin, 'gh'), 0o755);

    const r = run(['feat/pr', 'add v2 + b', '--pr', '--', 'a.ts', 'b.ts'], dir, {
      PATH: `${stubBin}:${process.env.PATH}`,
    });
    expect(r.status, r.stderr).toBe(0);

    const m = JSON.parse(readFileSync(join(dir, '.devkit', 'reconcile-manifest.json'), 'utf8'));
    const e = m.branches['feat/pr'];
    const by = Object.fromEntries(e.paths.map((p) => [p.path, p]));
    expect(e.paths).toHaveLength(2);
    expect(by['a.ts'].blobSha).toBe(g(['hash-object', '--', 'a.ts']).trim()); // the v2 TIP blob, not v1
    expect(by['b.ts']).toMatchObject({ op: 'add' });
    // PR metadata preserved from the seeded (initial-ship) entry.
    expect(e.prNumber).toBe(7);
    expect(e.repo).toBe('acme/app');
    expect(e.baseRef).toBe('work');
  });
});

describe('reship — untracked gate configs are linked into the re-ship worktree', () => {
  it('links an untracked guard.config.json so the gate sees it (not defaults), with a notice', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
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
    // Hook cwd = the worktree, so it proves the untracked config was linked in.
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\n[ -e guard.config.json ] && echo CONFIG_SEEN || echo CONFIG_MISSING\nexit 0\n',
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    // Seed the open PR branch, then edit + re-push with an untracked guard.config.json present.
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    writeFileSync(join(dir, 'guard.config.json'), '{"scanRoots":["src"]}\n'); // untracked

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/guard\.config\.json .*commit it/);
      expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-pr.log'), 'utf8')).toMatch(
        /CONFIG_SEEN/,
      );
    } finally {
      if (wt) g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    }
  });
});

// DK-5: reship's worktree is cut from the fetched PR-branch tip — in-chain gates (fallow) need that
// SAME commit to scope their own audit, not their own main-autodetect.
describe('reship — exports DEVKIT_SHIP_BASE_SHA (DK-5)', () => {
  it('is the fetched PR-branch tip, not a stale local ref', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
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
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\necho "HOOK_BASE=$DEVKIT_SHIP_BASE_SHA"\nexit 0\n',
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    const prTip = execFileSync('git', ['-C', bare, 'rev-parse', 'feat/pr'], {
      env,
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-pr.log'), 'utf8')).toContain(
        `HOOK_BASE=${prTip}`,
      );
    } finally {
      if (wt) g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    }
  });
});

// A PR branch based on a NON-default branch (frink ships release branches this way: PR base 0.0.9,
// origin/HEAD -> main). reship must cut its worktree from the fetched PR-branch tip; anything that
// reached for origin/HEAD instead would parent the commit on main and lose the base branch's history.
describe('reship — PR branch based on a non-default branch', () => {
  it('parents the new commit on the PR-branch tip, not on origin/HEAD (main)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
      ['push', '-q', 'origin', 'main'],
    ])
      g(a, { stdio: 'ignore' });
    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    // origin/HEAD -> main, so a wrong implementation has something plausible to grab.
    g(['remote', 'set-head', 'origin', 'main'], { stdio: 'ignore' });
    const mainTip = g(['rev-parse', 'main']).trim();

    // Release branch off main, then the PR branch off the RELEASE branch (never off main).
    g(['checkout', '-q', '-b', 'rel/0.0.9'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'rel.ts'), 'release-only\n');
    g(['add', 'rel.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'release-only change'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'rel/0.0.9'], { stdio: 'ignore' });
    const relTip = g(['rev-parse', 'rel/0.0.9']).trim();

    g(['checkout', '-q', '-b', 'feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'feat/pr'], { stdio: 'ignore' });
    const prTip = g(['rev-parse', 'feat/pr']).trim();

    // The agent edits a.ts and re-ships onto the open PR.
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    try {
      expect(r.status, r.stderr).toBe(0);
      const gwt = (a) => execFileSync('git', ['-C', wt, ...a], { env, encoding: 'utf8' }).trim();
      expect(gwt(['rev-parse', 'HEAD~1'])).toBe(prTip); // parented on the PR tip...
      expect(gwt(['rev-parse', 'HEAD~1'])).not.toBe(mainTip); // ...not on origin/HEAD
      expect(gwt(['show', 'HEAD:a.ts'])).toBe('v2');
      // The release branch's own commit survives — proof the base branch's history was not dropped.
      expect(gwt(['show', 'HEAD:rel.ts'])).toBe('release-only');
      expect(gwt(['merge-base', '--is-ancestor', relTip, 'HEAD']) === '').toBe(true);
    } finally {
      if (wt) g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    }
  });
});

// A gate chain runs for MINUTES inside the ship worktree, so another process can move that worktree's
// HEAD before git finalises the commit — git then aborts with `cannot lock ref 'HEAD'` AFTER every gate
// passed. (Real cause: fallow < 3.4.2 registered its audit base-snapshot as a worktree and its cleanup
// was not scoped to its own entry.) This must be attributed, not swallowed into blocked_gate "unknown".
describe('reship — HEAD clobbered mid-commit is attributed, not reported as "unknown"', () => {
  it('classifies the ref-lock failure and names the cause on stderr', () => {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
      ['push', '-q', 'origin', 'main'],
    ])
      g(a, { stdio: 'ignore' });
    const mainTip = g(['rev-parse', 'main']).trim();
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    // The clobber, reproduced: the gate chain PASSES (exit 0) but leaves the worktree's detached HEAD
    // pointing somewhere else, exactly as an out-of-scope worktree cleanup would. git's finalize
    // ref-update is a compare-and-swap, so the commit then dies with `cannot lock ref 'HEAD'`.
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      `#!/bin/sh\necho "gate: all clear"\ngit update-ref --no-deref HEAD ${mainTip}\nexit 0\n`,
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    const events = join(mkdtempSync(join(tmpdir(), 'reship-tel-')), 'gate-events.jsonl');
    dirs.push(events);
    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, {
      SHIP_DRY_RUN: '1',
      DEVKIT_GATE_EVENTS: events,
    });

    expect(r.status).not.toBe(0); // nothing was committed, nothing pushed
    expect(r.stderr).toMatch(/cannot lock ref 'HEAD'/); // git's own fatal reached the operator
    expect(r.stderr).toMatch(/HEAD was moved by ANOTHER process mid-commit/); // ...with the diagnosis
    expect(r.stderr).toMatch(/fallow/); // ...and the known cause to check

    const result = readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'ship_result');
    expect(result.blocked_gate).toBe('worktree_head_clobbered'); // NOT "unknown"
    expect(result.timed_out).toBe(false);
  });

  it('still attributes the clobber when a fail-open reviewer line sits in the same log', () => {
    // guard-review INCONCLUSIVE is fail-OPEN (exit 2 — the chain continues), so it can coexist with a
    // later clobber. Grepping the gate arms first would blame the reviewer for a failure it did not
    // cause; this locks the ordering of the attribution chain.
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
      ['push', '-q', 'origin', 'main'],
    ])
      g(a, { stdio: 'ignore' });
    const mainTip = g(['rev-parse', 'main']).trim();
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      `#!/bin/sh\necho "guard-review: api-security-reviewer INCONCLUSIVE"\ngit update-ref --no-deref HEAD ${mainTip}\nexit 0\n`,
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    const events = join(mkdtempSync(join(tmpdir(), 'reship-tel-')), 'gate-events.jsonl');
    dirs.push(events);
    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, {
      SHIP_DRY_RUN: '1',
      DEVKIT_GATE_EVENTS: events,
    });
    expect(r.status).not.toBe(0);
    const result = readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'ship_result');
    expect(result.blocked_gate).toBe('worktree_head_clobbered'); // not "review"
  });

  it('does NOT claim a clobber when a GATE merely prints the same git error and fails', () => {
    // The captured log folds hook output in with git's own (`2>&1 | tee`), so the phrase alone proves
    // nothing — and devkit's suite emits this exact string, so a gate running the tests would forge it.
    // Here a gate PRINTS the fatal and exits non-zero WITHOUT touching HEAD. Attributing that to a
    // clobber would tell the operator "every gate PASSED, re-running is safe" about a real gate block.
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    const dir = mkdtempSync(join(tmpdir(), 'reshipwt-'));
    dirs.push(dir);
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', bare],
      ['push', '-q', 'origin', 'main'],
    ])
      g(a, { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    // Prints the fatal verbatim (as a nested ship's test output would), then blocks. HEAD never moves.
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\n' +
        'echo "✗ deterministic gates failed"\n' +
        'echo "fatal: cannot lock ref \'HEAD\': is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222"\n' +
        'exit 1\n',
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    const events = join(mkdtempSync(join(tmpdir(), 'reship-tel-')), 'gate-events.jsonl');
    dirs.push(events);
    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, {
      SHIP_DRY_RUN: '1',
      DEVKIT_GATE_EVENTS: events,
    });

    expect(r.status).not.toBe(0);
    const result = readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'ship_result');
    expect(result.blocked_gate).toBe('deterministic'); // the real cause, NOT the forged phrase
    expect(r.stderr).not.toMatch(/HEAD was moved by ANOTHER process mid-commit/); // no false all-clear
  });
});

describe('reship — repo path with a space (linked-worktree COMMIT_EDITMSG carries the space)', () => {
  // A linked-worktree commit hands the commit-msg hook the ABSOLUTE $GIT_DIR/COMMIT_EDITMSG path; under
  // a spaced repo root that path contains the space. Devkit forwards it as one intact arg (every ship
  // path is quoted) — the crash that motivated this was a CONSUMER commit-msg hook re-forwarding $1
  // UNQUOTED. (A) proves reship survives a spaced root; (B) proves the failure hint fires on the split.
  function mkRepo(spaced = true) {
    const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GENV } });
    // spaced → the repo root's parent component contains a space (the crash trigger); else space-free.
    const parent = mkdtempSync(join(tmpdir(), spaced ? 'reship space ' : 'reship-nospace-'));
    dirs.push(parent);
    const dir = join(parent, 'repo');
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    const env = { ...process.env, ...GENV };
    const g = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
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
    writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    // First ship: a.ts=v1 on origin/feat/pr, then edit v2 for the re-ship.
    writeFileSync(join(dir, 'a.ts'), 'v1\n');
    g(['add', 'a.ts'], { stdio: 'ignore' });
    g(['commit', '-q', '-m', 'first'], { stdio: 'ignore' });
    g(['push', '-q', 'origin', 'HEAD:feat/pr'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    return { dir, g };
  }

  // Install the commit-msg hook AFTER first-ship setup so it fires only on the re-ship commit.
  const commitMsg = (dir, body) => {
    writeFileSync(join(dir, '.husky/_/commit-msg'), body);
    chmodSync(join(dir, '.husky/_/commit-msg'), 0o755);
  };

  it('A: re-ships through a correctly-quoted commit-msg hook (path arrives intact, with its space)', () => {
    const { dir, g } = mkRepo();
    const recDir = mkdtempSync(join(tmpdir(), 'reship-rec-')); // space-FREE record path (no redirect-quoting subtlety)
    dirs.push(recDir);
    const rec = join(recDir, 'arg');
    commitMsg(dir, `#!/bin/sh\nprintf '%s\\n' "$1" > ${JSON.stringify(rec)}\n`);

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    const wt = WT_RE.exec(r.stderr)?.[1];
    expect(r.status, r.stderr).toBe(0); // reship completes despite the spaced $ROOT
    const arg1 = readFileSync(rec, 'utf8').trimEnd();
    expect(arg1).toMatch(/COMMIT_EDITMSG$/); // git handed the hook the message-file path...
    expect(arg1).toContain(' '); // ...as ONE arg still carrying the space (no split before the hook)
    if (wt) g(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
  });

  it('B: names the space cause when a commit-msg hook forwards $1 unquoted (reproduces the crash)', () => {
    const { dir } = mkRepo();
    // The consumer bug, reproduced: `set -- --edit $1` with an UNQUOTED $1 splits a spaced path into
    // >2 args; echo "$*" keeps the COMMIT_EDITMSG tail in the output (the signature the hint gates on),
    // then exit non-zero fails the commit. Robust to any number of spaces in the temp path.
    commitMsg(
      dir,
      '#!/bin/sh\nset -- --edit $1\n[ "$#" -eq 2 ] && exit 0\necho "Unknown argument: $*"\nexit 9\n',
    );

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    expect(r.status).not.toBe(0); // the split failed the commit
    expect(r.stderr).toMatch(/repo path has a space/); // the diagnostic fired (space + COMMIT_EDITMSG in log)
    // reship's cleanup trap already reclaimed the ephemeral worktree on the failed commit.
  });

  it('C: stays silent on a spaced-path commit failure WITHOUT the COMMIT_EDITMSG signature', () => {
    // Locks the LOG half of the AND-gate. A normal gate rejection under a spaced path (this repo
    // self-dogfoods at one) must not be mis-blamed on an unquoted commit-msg hook. Regressing the gate
    // to space-only would keep test B green but silently reintroduce this false positive.
    const { dir } = mkRepo(true);
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\necho "gate: blocked (no signature here)"\nexit 1\n', // fails BEFORE git writes COMMIT_EDITMSG
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    expect(r.status).not.toBe(0); // the gate failed the commit
    expect(r.stderr).not.toMatch(/repo path has a space/); // …but the split diagnostic stays silent
  });

  it('D: stays silent on a space-FREE path even when COMMIT_EDITMSG is in the log', () => {
    // Locks the SPACE half of the AND-gate. A hook surfacing COMMIT_EDITMSG at a normal (space-free)
    // path is not the spaced-path split, so the space-specific advice must not fire.
    const { dir } = mkRepo(false);
    expect(dir).not.toContain(' '); // premise: the OS temp dir is space-free (as every other test assumes)
    writeFileSync(
      join(dir, '.husky/_/commit-msg'),
      '#!/bin/sh\necho "hook read $PWD/.git/COMMIT_EDITMSG"\nexit 1\n', // COMMIT_EDITMSG in log, but no split
    );
    chmodSync(join(dir, '.husky/_/commit-msg'), 0o755);

    const r = run(['feat/pr', 'add v2', '--pr', '--', 'a.ts'], dir, { SHIP_DRY_RUN: '1' });
    expect(r.status).not.toBe(0); // the hook failed the commit
    expect(r.stderr).not.toMatch(/repo path has a space/); // no space → no hint, despite COMMIT_EDITMSG in log
  });
});
