import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  parseArgs,
  readManifest as readManifestFn,
  recordShip,
} from '../lib/ship/reconcile-manifest-write.mts';

// Verifies the WRITE side of the ship↔reconcile contract: ship-branch.sh shells out to
// reconcile-manifest-write.mts after `gh pr create` to record what shipped, so `devkit reconcile`
// can later restore the merged-upstream version. Hermetic — throwaway repos, no gh, no network.

vi.setConfig({ testTimeout: 30_000 }); // git-subprocess-heavy; generous under parallel load

const WRITER = fileURLToPath(new URL('../lib/ship/reconcile-manifest-write.mts', import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(new URL('../lib/ship/reconcile-manifest.v1.json', import.meta.url), 'utf8'),
);
const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T.*Z$/; // shippedAt is an ISO-8601 UTC timestamp
const dirs = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repo with foo.ts + old.ts committed; returns {root, g, base}. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'recowrite-'));
  dirs.push(root);
  const g = (...a) =>
    execFileSync('git', ['-C', root, ...a], {
      encoding: 'utf8',
      env: GENV,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  g('init', '-q', '-b', 'release');
  g('config', 'user.email', 'a@b.c');
  g('config', 'user.name', 'a');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'foo.ts'), 'OLD\n');
  writeFileSync(join(root, 'old.ts'), 'goner\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  return { root, g, base: g('rev-parse', 'HEAD') };
}

const write = (root, base, args) =>
  spawnSync(
    process.execPath,
    [
      WRITER,
      '--root',
      root,
      '--branch',
      'feat/x',
      '--repo',
      'acme/app',
      '--base-ref',
      'release',
      '--base-sha',
      base,
      ...args,
    ],
    {
      encoding: 'utf8',
      env: GENV,
    },
  );

const readManifest = (root) =>
  JSON.parse(readFileSync(join(root, '.devkit', 'reconcile-manifest.json'), 'utf8'));

describe('reconcile-manifest-write — classifies shipped paths', () => {
  it('records modify / add(+exec) / delete with the right op, blobSha, and mode', () => {
    const { root, g, base } = repo();
    writeFileSync(join(root, 'foo.ts'), 'NEW\n'); // modify
    writeFileSync(join(root, 'new.sh'), '#!/bin/sh\n'); // add
    chmodSync(join(root, 'new.sh'), 0o755); // executable
    rmSync(join(root, 'old.ts')); // delete

    const r = write(root, base, ['--pr', '7', '--', 'foo.ts', 'new.sh', 'old.ts']);
    expect(r.status, r.stderr).toBe(0);

    const m = readManifest(root);
    expect(m.version).toBe(1);
    const e = m.branches['feat/x'];
    expect(e.prNumber).toBe(7);
    expect(e.repo).toBe('acme/app');
    expect(e.baseRef).toBe('release');
    expect(e.baseSha).toBe(base);
    expect(e.shippedAt).toMatch(ISO_UTC);

    const by = Object.fromEntries(e.paths.map((p) => [p.path, p]));
    expect(by['foo.ts']).toMatchObject({
      op: 'modify',
      mode: '100644',
      blobSha: g('hash-object', '--', 'foo.ts'),
    });
    expect(by['new.sh']).toMatchObject({
      op: 'add',
      mode: '100755',
      blobSha: g('hash-object', '--', 'new.sh'),
    });
    // delete records the PRE-deletion committed blob (so reconcile can prove still-deleted-as-shipped)
    expect(by['old.ts']).toMatchObject({
      op: 'delete',
      mode: '100644',
      blobSha: g('rev-parse', `${base}:old.ts`),
    });
  });

  it('an empty --pr records prNumber: null', () => {
    const { root, base } = repo();
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    expect(write(root, base, ['--pr', '', '--', 'foo.ts']).status).toBe(0);
    expect(readManifest(root).branches['feat/x'].prNumber).toBeNull();
  });

  it('merges into an existing v1 manifest, preserving other branches (N parallel PRs)', () => {
    const { root, base } = repo();
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    write(root, base, ['--pr', '1', '--', 'foo.ts']);
    // a second ship on a different branch
    const r2 = spawnSync(
      process.execPath,
      [
        WRITER,
        '--root',
        root,
        '--branch',
        'feat/y',
        '--repo',
        'acme/app',
        '--base-ref',
        'release',
        '--base-sha',
        base,
        '--pr',
        '2',
        '--',
        'foo.ts',
      ],
      { encoding: 'utf8', env: GENV },
    );
    expect(r2.status).toBe(0);
    const m = readManifest(root);
    expect(Object.keys(m.branches).sort()).toEqual(['feat/x', 'feat/y']);
  });

  it('produces the v1 contract schema (keys match the shared fixture both repos pin)', () => {
    const { root, base } = repo();
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    write(root, base, ['--pr', '7', '--', 'foo.ts']);
    const got = readManifest(root).branches['feat/x'];
    const want = FIXTURE.branches['feat/example'];
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    expect(Object.keys(got.paths[0]).sort()).toEqual(Object.keys(want.paths[0]).sort());
  });

  it('exits non-zero with no paths (never silently records nothing)', () => {
    const { root, base } = repo();
    expect(write(root, base, ['--pr', '7', '--']).status).not.toBe(0);
  });
});

describe('recordShip — direct (unit coverage of the core)', () => {
  it('writes the manifest entry and returns 0', () => {
    const { root, g, base } = repo();
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    const rc = recordShip(
      {
        root,
        branch: 'feat/z',
        repo: 'acme/app',
        baseRef: 'release',
        baseSha: base,
        pr: '9',
      },
      ['foo.ts'],
    );
    expect(rc).toBe(0);
    const e = readManifest(root).branches['feat/z'];
    expect(e.prNumber).toBe(9);
    expect(e.paths[0]).toMatchObject({
      path: 'foo.ts',
      op: 'modify',
      blobSha: g('hash-object', '--', 'foo.ts'),
    });
  });

  it('returns 1 on a missing required arg', () => {
    const { root, base } = repo();
    expect(
      recordShip({ root, branch: '', repo: 'o/r', baseRef: 'release', baseSha: base, pr: null }, [
        'foo.ts',
      ]),
    ).toBe(1);
  });

  it('returns 1 when a path resolves to nothing recordable', () => {
    const { root, base } = repo();
    expect(
      recordShip(
        { root, branch: 'feat/z', repo: 'o/r', baseRef: 'release', baseSha: base, pr: null },
        ['ghost.ts'],
      ),
    ).toBe(1);
  });

  it('refuses to overwrite an incompatible-version manifest (returns 1, leaves it untouched)', () => {
    const { root, base } = repo();
    writeFileSync(join(root, 'foo.ts'), 'NEW\n');
    mkdirSync(join(root, '.devkit'), { recursive: true });
    const mf = join(root, '.devkit', 'reconcile-manifest.json');
    const future = JSON.stringify({ version: 2, branches: { 'feat/keep': { x: 1 } } });
    writeFileSync(mf, future);
    const rc = recordShip(
      { root, branch: 'feat/z', repo: 'o/r', baseRef: 'release', baseSha: base, pr: '1' },
      ['foo.ts'],
    );
    expect(rc).toBe(1);
    expect(readFileSync(mf, 'utf8')).toBe(future); // a newer schema is preserved, never clobbered
  });

  it('readManifest: absent/torn → fresh v1; valid v1 → returned; incompatible version → throws', () => {
    const { root } = repo();
    mkdirSync(join(root, '.devkit'), { recursive: true });
    const mf = join(root, '.devkit', 'reconcile-manifest.json');
    expect(readManifestFn(mf)).toEqual({ version: 1, branches: {} }); // absent
    writeFileSync(mf, '{ not json');
    expect(readManifestFn(mf)).toEqual({ version: 1, branches: {} }); // torn
    writeFileSync(mf, JSON.stringify({ version: 1, branches: { a: { prNumber: 1 } } }));
    expect(readManifestFn(mf).branches.a.prNumber).toBe(1); // valid v1
    writeFileSync(mf, JSON.stringify({ version: 2, branches: {} }));
    expect(() => readManifestFn(mf)).toThrow('incompatible'); // newer schema → never clobbered
  });

  it('hashes blobs from --git-root (the commit worktree), not a parallel edit in --root', () => {
    const { root, g, base } = repo(); // root committed foo.ts = OLD
    const wt = mkdtempSync(join(tmpdir(), 'recowt-'));
    dirs.push(wt);
    g('worktree', 'add', '--detach', wt, base); // a separate "commit" worktree at BASE
    const gWt = (...a) =>
      execFileSync('git', ['-C', wt, ...a], {
        encoding: 'utf8',
        env: GENV,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    writeFileSync(join(wt, 'foo.ts'), 'SHIPPED\n'); // what the PR committed
    writeFileSync(join(root, 'foo.ts'), 'PARALLEL-EDIT\n'); // a parallel agent edits the shared tree

    const rc = recordShip(
      {
        root,
        gitRoot: wt,
        branch: 'feat/z',
        repo: 'o/r',
        baseRef: 'release',
        baseSha: base,
        pr: '1',
      },
      ['foo.ts'],
    );
    expect(rc).toBe(0);
    const e = readManifest(root).branches['feat/z']; // manifest written to root, not wt
    expect(e.paths[0].blobSha).toBe(gWt('hash-object', '--', 'foo.ts')); // = the shipped blob
    expect(e.paths[0].blobSha).not.toBe(g('hash-object', '--', 'foo.ts')); // NOT the parallel edit
    g('worktree', 'remove', '--force', wt);
  });
});

describe('parseArgs — --merge is a valueless boolean', () => {
  it('does not consume the trailing -- as its value (paths survive)', () => {
    const { flags, paths } = parseArgs(['--branch', 'b', '--merge', '--', 'a.ts', 'b.ts']);
    expect(flags.merge).toBe(true);
    expect(flags.branch).toBe('b');
    expect(paths).toEqual(['a.ts', 'b.ts']);
  });
  it('absent --merge leaves flags.merge undefined', () => {
    const { flags } = parseArgs(['--branch', 'b', '--', 'a.ts']);
    expect(flags.merge).toBeUndefined();
  });
});

describe('recordShip --merge — a `devkit ship --pr` re-push extends the branch entry', () => {
  /** Seed branch `feat/x` with foo.ts (modify) + full PR metadata; returns the seeded entry. */
  function seed(root, base, pr = '7') {
    writeFileSync(join(root, 'foo.ts'), 'V1\n');
    const rc = recordShip(
      { root, branch: 'feat/x', repo: 'acme/app', baseRef: 'release', baseSha: base, pr },
      ['foo.ts'],
    );
    expect(rc).toBe(0);
    return readManifest(root).branches['feat/x'];
  }

  it('updates a re-shipped path to its tip blob, adds new paths, preserves PR metadata (EC1)', () => {
    const { root, g, base } = repo();
    const before = seed(root, base);
    const v1 = before.paths[0].blobSha;

    writeFileSync(join(root, 'foo.ts'), 'V2\n'); // re-ship the same path with new content
    writeFileSync(join(root, 'bar.ts'), 'B\n'); // + a brand-new path
    expect(
      recordShip({ root, branch: 'feat/x', baseSha: base, merge: true }, ['foo.ts', 'bar.ts']),
    ).toBe(0);

    const e = readManifest(root).branches['feat/x'];
    const by = Object.fromEntries(e.paths.map((p) => [p.path, p]));
    expect(e.paths).toHaveLength(2);
    expect(by['foo.ts'].blobSha).toBe(g('hash-object', '--', 'foo.ts')); // the V2 TIP blob
    expect(by['foo.ts'].blobSha).not.toBe(v1);
    expect(by['bar.ts']).toMatchObject({ op: 'add', blobSha: g('hash-object', '--', 'bar.ts') });
    // PR metadata kept from the existing entry; shippedAt refreshed (never goes backwards).
    expect(e.prNumber).toBe(7);
    expect(e.repo).toBe('acme/app');
    expect(e.baseRef).toBe('release');
    expect(e.baseSha).toBe(base);
    expect(e.shippedAt >= before.shippedAt).toBe(true);
  });

  it('a renamed-away old path supersedes its stale modify entry with a delete (EC2)', () => {
    const { root, g, base } = repo();
    // Seed feat/x with old.ts (committed at base = a modify), alongside foo.ts.
    recordShip(
      { root, branch: 'feat/x', repo: 'acme/app', baseRef: 'release', baseSha: base, pr: '7' },
      ['old.ts'],
    );
    rmSync(join(root, 'old.ts')); // the rename's source: gone from the worktree
    writeFileSync(join(root, 'new.ts'), 'N\n'); // the rename's target

    expect(
      recordShip({ root, branch: 'feat/x', baseSha: base, merge: true }, ['old.ts', 'new.ts']),
    ).toBe(0);

    const e = readManifest(root).branches['feat/x'];
    const by = Object.fromEntries(e.paths.map((p) => [p.path, p]));
    expect(e.paths.filter((p) => p.path === 'old.ts')).toHaveLength(1); // not duplicated
    expect(by['old.ts']).toMatchObject({ op: 'delete', blobSha: g('rev-parse', `${base}:old.ts`) });
    expect(by['new.ts']).toMatchObject({ op: 'add' });
  });

  it('a path added in commit-1 then deleted later supersedes the add with a delete (EC3)', () => {
    const { root, g } = repo();
    // commit-1 adds tmp.ts and the manifest records it as `add` (base has no tmp.ts).
    const base1 = g('rev-parse', 'HEAD');
    writeFileSync(join(root, 'tmp.ts'), 'T\n');
    recordShip(
      { root, branch: 'feat/x', repo: 'acme/app', baseRef: 'release', baseSha: base1, pr: '7' },
      ['tmp.ts'],
    );
    expect(readManifest(root).branches['feat/x'].paths[0].op).toBe('add');
    // tmp.ts now lives on the PR tip (commit it); commit-2 deletes it.
    g('add', 'tmp.ts');
    g('commit', '-q', '-m', 'add tmp');
    const prTip = g('rev-parse', 'HEAD');
    rmSync(join(root, 'tmp.ts'));

    expect(recordShip({ root, branch: 'feat/x', baseSha: prTip, merge: true }, ['tmp.ts'])).toBe(0);

    const e = readManifest(root).branches['feat/x'];
    expect(e.paths).toHaveLength(1);
    expect(e.paths[0]).toMatchObject({ op: 'delete', blobSha: g('rev-parse', `${prTip}:tmp.ts`) });
  });

  it('merge with NO existing entry → returns 1, writes nothing (EC7)', () => {
    const { root, base } = repo();
    writeFileSync(join(root, 'foo.ts'), 'V\n');
    expect(
      recordShip({ root, branch: 'feat/absent', baseSha: base, merge: true }, ['foo.ts']),
    ).toBe(1);
    expect(existsSync(join(root, '.devkit', 'reconcile-manifest.json'))).toBe(false);
  });

  it('all-unresolvable merge fails before the no-entry throw, leaving the manifest untouched (EC6)', () => {
    const { root, base } = repo();
    const before = seed(root, base);
    const raw = readFileSync(join(root, '.devkit', 'reconcile-manifest.json'), 'utf8');
    // existing entry + only ghost paths → entries.length===0 short-circuits to a benign return 1.
    expect(recordShip({ root, branch: 'feat/x', baseSha: base, merge: true }, ['ghost.ts'])).toBe(
      1,
    );
    expect(readFileSync(join(root, '.devkit', 'reconcile-manifest.json'), 'utf8')).toBe(raw); // byte-for-byte
    expect(readManifest(root).branches['feat/x'].shippedAt).toBe(before.shippedAt);
  });

  it('preserves sibling branches (merges only the targeted entry)', () => {
    const { root, base } = repo();
    seed(root, base); // feat/x
    writeFileSync(join(root, 'foo.ts'), 'Y\n');
    recordShip(
      { root, branch: 'feat/y', repo: 'acme/app', baseRef: 'release', baseSha: base, pr: '8' },
      ['foo.ts'],
    );
    const yBefore = readManifest(root).branches['feat/y'];

    writeFileSync(join(root, 'bar.ts'), 'B\n');
    expect(recordShip({ root, branch: 'feat/x', baseSha: base, merge: true }, ['bar.ts'])).toBe(0);

    const m = readManifest(root);
    expect(Object.keys(m.branches).sort()).toEqual(['feat/x', 'feat/y']);
    expect(m.branches['feat/y']).toEqual(yBefore); // untouched
  });
});
