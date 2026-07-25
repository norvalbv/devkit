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
import { ffBlockers, loadManifest, reconcileBranch } from '../lib/reconcile.mts';

// Each test drives a real bare-origin repo through ~10 git subprocesses (init/commit/push/fetch/
// merge/checkout); under full-suite parallel load that exceeds vitest's 5s default. Give the file
// generous wall-clock — the tests still assert everything, they're just subprocess-bound.
vi.setConfig({ testTimeout: 30_000 });

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mts');
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

/** Persist a manifest where the CLI will read it. `branches` maps branch name → entry. */
function writeManifest(root, branches) {
  execFileSync('mkdir', ['-p', join(root, '.devkit')]);
  writeFileSync(
    join(root, '.devkit', 'reconcile-manifest.json'),
    `${JSON.stringify({ version: 1, branches }, null, 2)}\n`,
  );
}

/** Run the real CLI against `root` with the merge state stubbed MERGED. */
const runCli = (root, ...args) =>
  spawnSync(process.execPath, [CLI, 'reconcile', '--main-repo', root, ...args], {
    encoding: 'utf8',
    env: { ...GENV, DEVKIT_RECONCILE_MERGED_OVERRIDE: 'MERGED' },
  });

/**
 * What a `git pull --ff-only` of this branch's base would hit, measured the way the CLI does — once,
 * after the run, against the sha the branch resolved. Under a dry run nothing is staged yet, so the
 * would-restore paths are subtracted, exactly as `measureBases` does.
 */
const blockersAfter = (root, res, { apply = true } = {}) =>
  ffBlockers(root, res.upstreamSha, apply ? new Set() : new Set(res.restored));

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
    expect(blockersAfter(root, res)).toEqual([]); // measured all-clear, not an assumption
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
    // The path is absent from `restored` on a re-run (it returns {done}), so only the index==upstream
    // probe can exempt it — this is the assertion that would fail if that probe were dropped.
    expect(blockersAfter(root, again)).toEqual([]);
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

/**
 * sc-1235 — reconcile used to CLAIM "the tree is now ff-pullable" unconditionally, then hand back a
 * `git pull --ff-only` that the files it had just warned it left edited went on to block. git answers
 * that abort with "commit your changes or stash them", so the claim steered agents straight at the one
 * recovery that destroys the concurrent work reconcile exists to protect. Every test here cross-checks
 * the computed list against the REAL ff oracle, which is the arbiter — assert on `res` FIRST, because
 * ffPullSucceeds() merges the repo on success and leaves failed-merge state on failure.
 */
describe('reconcile — ff-pullability is measured, not claimed', () => {
  /** Upstream changed BOTH files; only foo.ts was shipped, bar.ts is a peer agent's live edit. */
  const peerDirtyRepo = () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n', 'bar.ts': 'other\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n', 'bar.ts': 'UPSTREAM-BAR\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n'); // pristine shipped → reconciles cleanly
    writeFileSync(join(root, 'bar.ts'), 'agentB-wip\n'); // never shipped by anyone
    return { root, g, entry: entryFor(root, g, base, [{ path: 'foo.ts' }]) };
  };

  it('names a warned path as an ff blocker, and the oracle agrees the pull fails', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);
    writeFileSync(join(root, 'foo.ts'), 'HUMAN-EDIT\n'); // the peer edit reconcile must not touch

    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(res.warnings[0]).toMatch(/edited after ship/);
    expect(blockersAfter(root, res)).toEqual(['foo.ts']); // the exact state that used to print "ff-pullable"
    expect(ffPullSucceeds(root, g), 'a named blocker must mean the ff really fails').toBe(false);
  });

  it("a peer's dirty file that no ship ever recorded blocks the ff, with zero warnings", () => {
    const { root, g, entry } = peerDirtyRepo();
    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(res.restored).toEqual(['foo.ts']);
    expect(res.warnings).toEqual([]); // nothing to warn about — bar.ts was never shipped
    expect(res.action).toBe('prune');
    expect(blockersAfter(root, res)).toEqual(['bar.ts']); // unreachable by any warning-derived check
    expect(ffPullSucceeds(root, g)).toBe(false);
  });

  it('dry-run predicts exactly what --apply reports, and still stages nothing', () => {
    const { root, g, entry } = peerDirtyRepo();
    const dry = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: false });
    const predicted = blockersAfter(root, dry, { apply: false }); // measure BEFORE anything is staged
    expect(g('diff', '--cached', '--name-only')).toBe('');
    const applied = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(predicted).toEqual(blockersAfter(root, applied));
  });

  it('index==upstream exempts a path even when the worktree later diverges', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);
    reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true }); // stages upstream
    writeFileSync(join(root, 'foo.ts'), 'LATER-EDIT\n'); // someone edits it again afterwards

    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(blockersAfter(root, res)).toEqual([]); // twoway_merge takes keep_entry and never reads the worktree
    expect(ffPullSucceeds(root, g)).toBe(true);
    expect(readFileSync(join(root, 'foo.ts'), 'utf8')).toBe('LATER-EDIT\n'); // and it survives the ff
  });

  it('a staged-then-reverted worktree blocks, though `git diff HEAD` shows nothing for it', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n', 'bar.ts': 'other\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n', 'bar.ts': 'UPSTREAM-BAR\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    writeFileSync(join(root, 'bar.ts'), 'STAGED\n');
    g('add', '--', 'bar.ts');
    writeFileSync(join(root, 'bar.ts'), 'other\n'); // worktree back to HEAD, index holds a third blob
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);

    // Documents why the dirty set is the union of BOTH status columns, not `git diff --name-only HEAD`.
    expect(g('diff', '--name-only', 'HEAD')).not.toContain('bar.ts');
    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(blockersAfter(root, res)).toEqual(['bar.ts']); // I != H and I != U → reject_merge
    expect(ffPullSucceeds(root, g)).toBe(false);
  });

  it('an untracked file sitting where upstream ADDS one is a blocker', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n', 'new.ts': 'UPSTREAM-ADD\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    writeFileSync(join(root, 'new.ts'), 'peer-wip\n'); // untracked, in the way of the add
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);

    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(blockersAfter(root, res)).toEqual(['new.ts']); // verify_absent → untracked files would be overwritten
    expect(ffPullSucceeds(root, g)).toBe(false);
  });

  it('measures against the resolved sha, not the moving FETCH_HEAD ref', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n', 'bar.ts': 'other\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n', 'bar.ts': 'UPSTREAM-BAR\n' });
    writeFileSync(join(root, 'bar.ts'), 'agentB-wip\n');
    g('fetch', '-q', 'origin', '0.0.9');
    const merged = g('rev-parse', 'FETCH_HEAD');

    // A peer agent's `git fetch` lands mid-measurement — .git/FETCH_HEAD is a mutable file, and N
    // agents share this tree. Pointing it back at `base` makes `diff HEAD FETCH_HEAD` empty, so an
    // implementation that re-read the ref instead of the passed sha would report a bare all-clear.
    writeFileSync(join(root, '.git', 'FETCH_HEAD'), `${base}\t\tbranch '0.0.9' of origin\n`);
    expect(ffBlockers(root, merged, new Set())).toEqual(['bar.ts']);
  });

  it('an UNSTAGED worktree deletion is not reported (false alarms read as "reconcile failed")', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n', 'bar.ts': 'other\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n', 'bar.ts': 'UPSTREAM-BAR\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    rmSync(join(root, 'bar.ts')); // deleted, never staged → verify_uptodate's ENOENT branch allows it
    const entry = entryFor(root, g, base, [{ path: 'foo.ts' }]);

    const res = reconcileBranch({ mainRepo: root, branch: 'feat/x', entry, apply: true });
    expect(blockersAfter(root, res)).toEqual([]);
    expect(ffPullSucceeds(root, g), 'an unstaged deletion must NOT be called a blocker').toBe(true);
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
    expect(res.upstreamSha).toBeNull(); // never fetched ⇒ nothing to measure this base ref against
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
    writeManifest(root, { 'feat/x': entryFor(root, g, base, [{ path: 'foo.ts' }]) });

    const r = runCli(root, '--json');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.branches[0].branch).toBe('feat/x');
    expect(out.branches[0].restored).toEqual(['foo.ts']);
    expect(g('diff', '--cached', '--name-only')).toBe(''); // dry-run mutated nothing
  });

  /** Upstream changed both files; only foo.ts was shipped, bar.ts is a peer agent's live edit. */
  const peerDirtyCliRepo = () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n', 'bar.ts': 'other\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n', 'bar.ts': 'UPSTREAM-BAR\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    writeFileSync(join(root, 'bar.ts'), 'agentB-wip\n');
    writeManifest(root, { 'feat/x': entryFor(root, g, base, [{ path: 'foo.ts' }]) });
    return root;
  };

  it('--apply names the blockers, drops the ff-pullable claim, and never suggests stash/restore', () => {
    const r = runCli(peerDirtyCliRepo(), '--apply');
    expect(r.status).toBe(0); // advisory: callers chaining `reconcile --apply && …` must not break
    expect(r.stdout).toMatch(/✗ bar\.ts/);
    expect(r.stdout).toMatch(/still block `git pull --ff-only`/);
    expect(r.stdout).not.toMatch(/ff-pullable/); // the claim that caused the incident
    expect(r.stdout).not.toMatch(/Finalize with/); // nor the command that would abort
    // The one recovery that destroys a peer's uncommitted work must never be suggested.
    expect(r.stdout).not.toMatch(/\bgit stash\b|\bgit restore\b|\bgit checkout\b/);
  });

  it("the unblocked run's guidance is byte-for-byte what it has always been", () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    writeManifest(root, { 'feat/x': entryFor(root, g, base, [{ path: 'foo.ts' }]) });

    const r = runCli(root, '--apply');
    expect(r.stdout).toContain(
      'Shipped files restored to merged-upstream content; the tree is now ff-pullable.',
    );
    expect(r.stdout).toContain(
      'Finalize with `git pull --ff-only` — HEAD is intentionally not advanced (shared-tree invariant).',
    );
  });

  it('a file a LATER branch restores is not reported as blocking (measured after the whole run)', () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n', 'bar.ts': 'other\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n', 'bar.ts': 'NEW-BAR\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n'); // feat/x's shipped edit
    writeFileSync(join(root, 'bar.ts'), 'NEW-BAR\n'); // feat/y's — restored only on the SECOND pass
    writeManifest(root, {
      'feat/x': entryFor(root, g, base, [{ path: 'foo.ts' }]),
      'feat/y': entryFor(root, g, base, [{ path: 'bar.ts' }]),
    });

    const r = runCli(root, '--apply');
    expect(r.status).toBe(0);
    // A measurement taken right after feat/x would still see bar.ts dirty and call it a blocker,
    // even though feat/y restores it moments later in the same run.
    expect(r.stdout).not.toMatch(/✗ bar\.ts/);
    expect(r.stdout).toMatch(/the tree is now ff-pullable/);
    expect(ffPullSucceeds(root, g), 'and the ff really does succeed').toBe(true);
  });

  it("an unmeasurable base ref withholds the all-clear instead of inheriting another branch's", () => {
    const { root, g, base } = makeRepo({ 'foo.ts': 'OLD\n' });
    mergeUpstream(root, g, base, { 'foo.ts': 'NEW\n' });
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    const ok = entryFor(root, g, base, [{ path: 'foo.ts' }]);
    // A second branch on a base that cannot be fetched: nothing about ITS upstream is known, so an
    // empty blocker list is ignorance. The first branch measuring clean must not speak for it.
    writeManifest(root, { 'feat/x': ok, 'feat/y': { ...ok, baseRef: 'no-such-ref' } });

    const r = runCli(root, '--apply');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/the tree is now ff-pullable/);
    expect(r.stdout).toMatch(/NOT verified: no-such-ref could not be checked/);
    const out = JSON.parse(runCli(root, '--json').stdout);
    expect(out.ffPullable).toBeNull(); // don't-know, never a machine-readable all-clear
    expect(out.ffUnverifiedBases).toEqual(['no-such-ref']);
  });

  it('--json carries ffPullable:false and the blockers keyed by base ref', () => {
    const out = JSON.parse(runCli(peerDirtyCliRepo(), '--apply', '--json').stdout);
    expect(out.ffPullable).toBe(false);
    expect(out.ffBlockersByBase).toEqual({ '0.0.9': ['bar.ts'] }); // never pooled across bases
    expect(out.ffUnverifiedBases).toEqual([]);
  });
});
