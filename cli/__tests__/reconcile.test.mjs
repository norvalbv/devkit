/**
 * devkit reconcile (manual lane) — hermetic suite. Builds throwaway repos with a BARE LOCAL origin
 * (no network, no gh: the merge state is injected via DEVKIT_RECONCILE_MERGED_OVERRIDE, mirroring
 * ship-branch.sh's SHIP_RESOLVE_ONLY seam). The headline assertion is the real payoff: after
 * `--apply`, a `git merge --ff-only` that the stale tree BLOCKED now SUCCEEDS — proving reconcile
 * makes the tree pullable without moving the shared HEAD.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadManifest, reconcileBranch } from '../lib/reconcile.mjs';

// Each test drives a real bare-origin repo through ~10 git subprocesses (init/commit/push/fetch/
// merge/checkout); under full-suite parallel load that exceeds vitest's 5s default. Give the file
// generous wall-clock — the tests still assert everything, they're just subprocess-bound.
vi.setConfig({ testTimeout: 30_000 });

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');
const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const roots = [];
const mkTmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  roots.push(d);
  return d;
};
const G =
  (dir) =>
  (...a) =>
    execFileSync('git', ['-C', dir, ...a], {
      encoding: 'utf8',
      env: GENV,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

/** Fresh work repo on 0.0.9 with a bare local origin; `OLD` seeded into every file in `files`. */
function makeRepo(files) {
  const origin = mkTmp('reco-origin-');
  execFileSync('git', ['init', '-q', '--bare', origin], { env: GENV });
  const root = mkTmp('reco-work-');
  const g = G(root);
  g('init', '-q', '-b', '0.0.9');
  g('config', 'user.email', 'a@b.c');
  g('config', 'user.name', 'a');
  g('config', 'commit.gpgsign', 'false');
  g('remote', 'add', 'origin', origin);
  for (const [n, c] of Object.entries(files)) writeFileSync(join(root, n), c);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD');
  g('push', '-q', '-u', 'origin', '0.0.9');
  return { root, g, base };
}

/** Simulate a merged PR: apply `changes` (value=content, null=delete) and push to origin/0.0.9, then pin local back to BASE. */
function mergeUpstream(root, g, base, changes) {
  g('checkout', '-q', '-b', 'feat/up');
  for (const [n, c] of Object.entries(changes)) {
    if (c === null) g('rm', '-q', '--', n);
    else {
      writeFileSync(join(root, n), c);
      g('add', '--', n);
    }
  }
  g('commit', '-q', '-m', 'upstream change');
  g('checkout', '-q', '0.0.9');
  g('merge', '-q', '--no-ff', 'feat/up', '-m', 'merge PR');
  g('push', '-q', 'origin', '0.0.9');
  g('reset', '-q', '--hard', base);
  g('branch', '-q', '-D', 'feat/up');
}

/** Build a manifest entry the way ship-branch.sh's writer would (blobSha from the SHIPPED worktree). */
function entryFor(_root, g, base, paths, { prNumber = 1 } = {}) {
  return {
    prNumber,
    repo: 'o/r',
    baseRef: '0.0.9',
    baseSha: base,
    shippedAt: '2026-06-27T00:00:00.000Z',
    paths: paths.map(({ path, op = 'modify' }) => ({
      path,
      op,
      mode: '100644',
      blobSha: op === 'delete' ? g('rev-parse', `${base}:${path}`) : g('hash-object', '--', path),
    })),
  };
}

/** Does `git merge --ff-only FETCH_HEAD` succeed after a fresh fetch? (the user's actual goal) */
function ffPullSucceeds(root, g) {
  g('fetch', '-q', 'origin', '0.0.9');
  const r = spawnSync('git', ['-C', root, 'merge', '--ff-only', 'FETCH_HEAD'], {
    env: GENV,
    encoding: 'utf8',
  });
  return r.status === 0;
}

beforeEach(() => {
  process.env.DEVKIT_RECONCILE_MERGED_OVERRIDE = 'MERGED';
});
afterEach(() => {
  delete process.env.DEVKIT_RECONCILE_MERGED_OVERRIDE;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

describe('reconcile — the core payoff: stale tree becomes ff-pullable', () => {
  it('restores a pristine shipped edit (case 2) and the previously-blocked ff pull now succeeds', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n', 'bar.ts': 'other\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n'); // my stale shipped edit (== merged), uncommitted
    writeFileSync(join(root, 'bar.ts'), 'agentB-wip\n'); // an unrelated parallel-agent edit

    expect(ffPullSucceeds(root, g), 'baseline: stale tree must BLOCK the ff pull').toBe(false);
    g('reset', '-q', '--hard', base); // undo the failed-merge side effects, restore the dirty state
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    writeFileSync(join(root, 'bar.ts'), 'agentB-wip\n');

    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);
    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });

    expect(res.restored).toEqual(['foo.ts']);
    expect(res.warnings).toEqual([]);
    expect(res.action).toBe('prune');
    expect(g('diff', '--cached', '--name-only')).toContain('foo.ts'); // staged into the index
    expect(ffPullSucceeds(root, g), 'after reconcile the ff pull must SUCCEED').toBe(true);
    expect(readFileSync(join(root, 'bar.ts'), 'utf8')).toBe('agentB-wip\n'); // parallel work preserved
  });

  it('dry-run reports the plan but mutates nothing (tree still blocked)', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);

    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: false });
    expect(res.restored).toEqual(['foo.ts']);
    expect(res.action).toBe('prune');
    expect(g('diff', '--cached', '--name-only')).toBe(''); // nothing staged under dry-run
  });
});

describe('reconcile — the three-way gate', () => {
  it('idempotent re-run: a second apply restores nothing (already reconciled)', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);
    reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    const again = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(again.restored).toEqual([]);
    expect(again.warnings).toEqual([]);
    expect(again.action).toBe('prune');
  });

  it('a concurrent human edit after ship is skipped+warned, never clobbered', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]); // blobSha = pristine shipped (NEW)
    writeFileSync(join(root, 'foo.ts'), 'HUMAN-EDIT\n'); // a human then re-edited it

    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(res.restored).toEqual([]);
    expect(res.warnings[0]).toMatch(/edited after ship/);
    expect(res.action).toBe('keep');
    expect(readFileSync(join(root, 'foo.ts'), 'utf8')).toBe('HUMAN-EDIT\n'); // untouched
  });

  it('divergence (local baseRef not an ancestor of upstream) is strictly hands-off', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    g('add', 'foo.ts');
    g('commit', '-q', '-m', 'a divergent local commit'); // local 0.0.9 now NOT an ancestor of upstream
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);

    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(res.restored).toEqual([]);
    expect(res.warnings[0]).toMatch(/diverged/);
    expect(res.action).toBe('keep');
  });

  it('a shipped DELETE merged upstream stages the deletion and stays pullable', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n', 'old.ts': 'goner\n' });
    mergeUpstream(root, g, base, { 'old.ts': null });
    rmSync(join(root, 'old.ts')); // my stale uncommitted deletion
    const entry = entryFor(root, g, base, [{ path: 'old.ts', op: 'delete' }]);

    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(res.restored).toEqual(['old.ts']);
    expect(res.action).toBe('prune');
    expect(ffPullSucceeds(root, g)).toBe(true);
    expect(existsSync(join(root, 'old.ts'))).toBe(false);
  });

  it('warns when upstream merged a DIFFERENT shape (the shipped path was dropped upstream)', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n', 'drop.ts': 'mine\n' });
    mergeUpstream(root, g, base, { 'drop.ts': null }); // upstream deleted drop.ts
    writeFileSync(join(root, 'drop.ts'), 'SHIPPED\n'); // but I shipped a MODIFY of it
    const entry = entryFor(root, g, base, [{ path: 'drop.ts', op: 'modify' }]);
    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(res.restored).toEqual([]);
    expect(res.warnings[0]).toMatch(/different shape/);
    expect(res.action).toBe('keep');
    expect(readFileSync(join(root, 'drop.ts'), 'utf8')).toBe('SHIPPED\n'); // untouched
  });
});

describe('reconcile — merge state + manifest', () => {
  it('an un-merged PR keeps the entry, touches nothing', () => {
    process.env.DEVKIT_RECONCILE_MERGED_OVERRIDE = 'OPEN';
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);
    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(res.merged).toBe(false);
    expect(res.action).toBe('keep');
    expect(res.restored).toEqual([]);
  });

  it('gh unavailable → merged:unknown, keep (fail-open)', () => {
    process.env.DEVKIT_RECONCILE_MERGED_OVERRIDE = 'UNKNOWN';
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);
    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(res.merged).toBe('unknown');
    expect(res.action).toBe('keep');
  });

  it('missing manifest = no debt; a version≠1 manifest is treated as no debt (contract guard)', () => {
    const { root } = makeRepo({ 'foo.ts': 'OLD\n' });
    expect(loadManifest(root)).toEqual({ version: 1, branches: {} }); // absent → no debt
    execFileSync('mkdir', ['-p', join(root, '.devkit')]);
    const mf = join(root, '.devkit', 'reconcile-manifest.json');
    writeFileSync(mf, JSON.stringify({ version: 2, branches: { 'feat/x': {} } }));
    expect(loadManifest(root)).toEqual({ version: 1, branches: {} }); // future version → no debt, never trusted
    writeFileSync(mf, '{ this is not json');
    expect(loadManifest(root)).toEqual({ version: 1, branches: {} }); // torn file → no debt
  });
});

describe('reconcile — CLI surface', () => {
  it('--mode auto is rejected (manual-only v1)', () => {
    const r = spawnSync(process.execPath, [CLI, 'reconcile', '--mode', 'auto'], {
      encoding: 'utf8',
      env: GENV,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not implemented in v1/);
  });

  it('--main-repo that is not a git top-level is refused (root-assert)', () => {
    const notRepo = mkTmp('reco-notrepo-');
    const r = spawnSync(process.execPath, [CLI, 'reconcile', '--main-repo', notRepo], {
      encoding: 'utf8',
      env: GENV,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/git top-level/);
  });

  it('dry-run on a real manifest prints the plan and exits 0', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);
    const manifest = { version: 1, branches: { 'feat/x': entry } };
    execFileSync('mkdir', ['-p', join(root, '.devkit')]);
    writeFileSync(
      join(root, '.devkit', 'reconcile-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const r = spawnSync(process.execPath, [CLI, 'reconcile', '--main-repo', root, '--json'], {
      encoding: 'utf8',
      env: { ...GENV, DEVKIT_RECONCILE_MERGED_OVERRIDE: 'MERGED' },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.branches[0].branch).toBe('feat/x');
    expect(out.branches[0].restored).toEqual(['foo.ts']);
    expect(g('diff', '--cached', '--name-only')).toBe(''); // dry-run mutated nothing
  });
});
