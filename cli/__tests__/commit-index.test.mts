import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitIndexEnv,
  commitIndexFile,
  commitIndexKind,
  commitIndexTree,
  resetCommitIndexCache,
} from '../../gate-engine/ratchets/commit-index.mts';
import { computeKey } from '../../gate-engine/prefix-cache/prefix-cache.mts';
import {
  partialCommitRemedy,
  stageBaseline,
  stageBaselineMigration,
  stagedSet,
} from '../../gate-engine/ratchets/git-index.mts';
import {
  resolveRef,
  symbolicHead,
  withStableGitIndex,
} from '../lib/install/anti-slop/git-index-lock.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
const CARRIER_VARS = ['DEVKIT_COMMIT_INDEX_FILE', 'DEVKIT_COMMIT_GIT_DIR'] as const;

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function seedRepo(prefix = 'commit-index-'): string {
  const root = realpathSync(mkTmp(prefix));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@t.t']);
  git(root, ['config', 'user.name', 't']);
  writeFileSync(join(root, 'f.txt'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base']);
  return root;
}

// Reproduce what git hands a hook: a copy of the index under `name` holding extra staged content.
function commitIndex(root: string, name: string, file = 'f.txt', body = 'committed\n'): string {
  const path = join(root, '.git', name);
  copyFileSync(join(root, '.git', 'index'), path);
  writeFileSync(join(root, file), body);
  git(root, ['add', '--', file], { ...process.env, GIT_INDEX_FILE: path });
  writeFileSync(join(root, file), 'base\n');
  return path;
}

const carrier = (index: string, gitDir: string) => ({
  ...process.env,
  DEVKIT_COMMIT_INDEX_FILE: index,
  DEVKIT_COMMIT_GIT_DIR: gitDir,
});

function withCarrier<T>(index: string, gitDir: string, action: () => T): T {
  Object.assign(process.env, { DEVKIT_COMMIT_INDEX_FILE: index, DEVKIT_COMMIT_GIT_DIR: gitDir });
  try {
    return action();
  } finally {
    for (const name of CARRIER_VARS) delete process.env[name];
  }
}

beforeEach(resetCommitIndexCache);
afterEach(() => {
  for (const name of CARRIER_VARS) delete process.env[name];
  cleanup();
});

describe('commitIndexEnv', () => {
  it('returns the caller env untouched when no carrier is exported', () => {
    const root = seedRepo();
    const base = { ...process.env };
    expect(commitIndexEnv(root, base)).toBe(base);
    expect(commitIndexKind(root, base)).toBe('default');
  });

  it("points git at the commit's index when the carrier belongs to this repository", () => {
    const root = seedRepo();
    const lock = commitIndex(root, 'index.lock');
    const env = commitIndexEnv(root, carrier(lock, join(root, '.git')));
    expect(env.GIT_INDEX_FILE).toBe(lock);
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(git(root, ['diff', '--cached', '--name-only'], env).trim()).toBe('f.txt');
  });

  it('ignores a carrier exported by a different repository (never touches a foreign index)', () => {
    const owner = seedRepo('commit-index-owner-');
    const other = seedRepo('commit-index-other-');
    const lock = commitIndex(owner, 'index.lock');
    const base = carrier(lock, join(owner, '.git'));
    expect(commitIndexEnv(other, base)).toBe(base);
    expect(commitIndexFile(other, base)).toBeNull();
  });

  it('never overrides a GIT_INDEX_FILE the caller already chose', () => {
    const root = seedRepo();
    const lock = commitIndex(root, 'index.lock');
    const base = { ...carrier(lock, join(root, '.git')), GIT_INDEX_FILE: '/scratch/index' };
    expect(commitIndexEnv(root, base).GIT_INDEX_FILE).toBe('/scratch/index');
  });

  it('matches the git dir canonically, so a symlinked path to the same repo still applies', () => {
    const root = seedRepo();
    const link = join(mkTmp('commit-index-link-'), 'repo');
    symlinkSync(root, link);
    const lock = commitIndex(root, 'index.lock');
    expect(commitIndexFile(link, carrier(lock, join(link, '.git')))).toBe(lock);
  });

  it("scopes a linked worktree's carrier to that worktree, not the main checkout", () => {
    const main = seedRepo();
    const wt = join(realpathSync(mkTmp('commit-index-wt-')), 'wt');
    git(main, ['worktree', 'add', '-q', wt]);
    const wtGitDir = git(wt, ['rev-parse', '--absolute-git-dir']).trim();
    const base = carrier(join(wtGitDir, 'index.lock'), wtGitDir);
    expect(commitIndexFile(wt, base)).toBe(join(wtGitDir, 'index.lock'));
    expect(commitIndexFile(main, base)).toBeNull();
  });

  it.each([
    ['index.lock', 'lock'],
    ['next-index-4242.lock', 'partial'],
    ['alt-index', 'alternate'],
  ] as const)('classifies %s as %s', (name, kind) => {
    const root = seedRepo();
    const index = commitIndex(root, name);
    expect(commitIndexKind(root, carrier(index, join(root, '.git')))).toBe(kind);
  });
});

describe('commitIndexKind', () => {
  it('treats a caller-chosen GIT_INDEX_FILE as the default, whatever the carrier says', () => {
    const root = seedRepo();
    const partial = commitIndex(root, 'next-index-4242.lock');
    const base = { ...carrier(partial, join(root, '.git')), GIT_INDEX_FILE: '/chosen/index' };
    expect(commitIndexKind(root, base)).toBe('default');
  });

  it("classifies a lock-named index outside the repository's git dir as alternate", () => {
    const root = seedRepo();
    const outside = join(realpathSync(mkTmp('commit-index-outside-')), 'next-index-7.lock');
    copyFileSync(join(root, '.git', 'index'), outside);
    expect(commitIndexKind(root, carrier(outside, join(root, '.git')))).toBe('alternate');
  });
});

describe('ratchet staging under a non-default commit index', () => {
  it('reads the merge resolution from the commit index during `commit -a` of a merge', () => {
    const root = seedRepo();
    git(root, ['checkout', '-qb', 'side']);
    writeFileSync(join(root, 'f.txt'), 'side\n');
    git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'side']);
    git(root, ['checkout', '-q', '-']);
    writeFileSync(join(root, 'f.txt'), 'main\n');
    git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'main']);
    expect(() => git(root, ['merge', '-q', 'side'])).toThrow();
    const lock = join(root, '.git', 'index.lock');
    copyFileSync(join(root, '.git', 'index'), lock);
    writeFileSync(join(root, 'f.txt'), 'resolved\n');
    git(root, ['add', 'f.txt'], { ...process.env, GIT_INDEX_FILE: lock });
    expect(stagedSet(root)).toEqual(new Set());
    expect(withCarrier(lock, join(root, '.git'), () => stagedSet(root))).toEqual(
      new Set(['f.txt']),
    );
  });

  it('stages a lowered baseline into the `commit -a` index, leaving the default index alone', () => {
    const root = seedRepo();
    const lock = commitIndex(root, 'index.lock');
    const before = readFileSync(join(root, '.git', 'index'));
    writeFileSync(join(root, 'baseline.json'), '{}\n');
    withCarrier(lock, join(root, '.git'), () => stageBaseline(root, 'baseline.json'));
    const env = { ...process.env, GIT_INDEX_FILE: lock };
    expect(git(root, ['ls-files', '--', 'baseline.json'], env).trim()).toBe('baseline.json');
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(before);
  });

  it('never writes a partial-commit index: best-effort staging skips, strict staging refuses', () => {
    const root = seedRepo();
    const partial = commitIndex(root, 'next-index-4242.lock');
    const snapshot = () => [readFileSync(partial), readFileSync(join(root, '.git', 'index'))];
    const before = snapshot();
    writeFileSync(join(root, 'baseline.json'), '{}\n');
    withCarrier(partial, join(root, '.git'), () => {
      stageBaseline(root, 'baseline.json');
      expect(() => stageBaselineMigration(root, 'legacy.json', 'baseline.json')).toThrow(
        partialCommitRemedy('baseline.json'),
      );
    });
    expect(snapshot()).toEqual(before);
  });
});

describe('index snapshots read the commit index', () => {
  it('keys the prefix cache on the commit index, which git holds locked during `commit -a`', () => {
    const root = seedRepo();
    const lock = commitIndex(root, 'index.lock');
    expect(computeKey(root)).toBeNull();
    const committed = withCarrier(lock, join(root, '.git'), () => computeKey(root));
    expect(committed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keys an alternate index apart from the default index', () => {
    const root = seedRepo();
    const alt = commitIndex(root, 'alt-index');
    const plain = computeKey(root);
    const committed = withCarrier(alt, join(root, '.git'), () => computeKey(root));
    expect(plain).not.toBeNull();
    expect(committed).not.toBe(plain);
  });

  it('anti-slop stabilises the commit index without contending for the lock git holds', () => {
    const root = seedRepo();
    const lock = commitIndex(root, 'index.lock');
    const tree = git(root, ['write-tree'], { ...process.env, GIT_INDEX_FILE: lock }).trim();
    const head = { oid: resolveRef(root, 'HEAD'), symbolicRef: symbolicHead(root) };
    const result = withCarrier(lock, join(root, '.git'), () =>
      withStableGitIndex(root, head, null, tree, () => 'applied'),
    );
    expect(result).toBe('applied');
    expect(existsSync(lock)).toBe(true);
  });
});

// The tree `index` describes, read from a scratch copy so the expectation never locks the original.
function treeOf(root: string, index: string): string {
  const scratch = join(mkTmp('commit-index-expect-'), 'index');
  copyFileSync(index, scratch);
  return git(root, ['write-tree'], {
    ...process.env,
    GIT_INDEX_FILE: scratch,
  }).trim();
}

describe('commitIndexTree (sc-3312: lock-free staged tree identity)', () => {
  it('hashes the default index while another process holds index.lock, leaving the lock alone', () => {
    const root = seedRepo();
    writeFileSync(join(root, 'f.txt'), 'staged\n');
    git(root, ['add', 'f.txt']);
    const expected = treeOf(root, join(root, '.git', 'index'));
    const lock = join(root, '.git', 'index.lock');
    writeFileSync(lock, 'held by a concurrent git');
    expect(commitIndexTree(root)).toEqual({ tree: expected });
    expect(readFileSync(lock, 'utf8')).toBe('held by a concurrent git');
  });

  it('never rewrites the index it hashes (write-tree on the original would store a cache-tree)', () => {
    const root = seedRepo();
    writeFileSync(join(root, 'f.txt'), 'staged\n');
    git(root, ['add', 'f.txt']);
    const index = join(root, '.git', 'index');
    const before = readFileSync(index);
    expect(commitIndexTree(root).tree).toMatch(/^[0-9a-f]{40,64}$/);
    expect(readFileSync(index).equals(before)).toBe(true);
  });

  it.each([
    ['lock', 'index.lock'],
    ['partial', 'next-index-4242.lock'],
  ])(
    'hashes the %s carrier, not the default index, and leaves the carrier untouched',
    (_kind, name) => {
      const root = seedRepo();
      const index = commitIndex(root, name);
      const before = readFileSync(index);
      const expected = treeOf(root, index);
      expect(expected).not.toBe(treeOf(root, join(root, '.git', 'index')));
      const result = commitIndexTree(root, carrier(index, join(root, '.git')));
      expect(result).toEqual({ tree: expected });
      expect(readFileSync(index).equals(before)).toBe(true);
    },
  );

  it('hashes an alternate carrier that lives outside the git dir', () => {
    const root = seedRepo();
    const outside = join(mkTmp('commit-index-alt-'), 'idx');
    copyFileSync(commitIndex(root, 'alt-src'), outside);
    const base = carrier(outside, join(root, '.git'));
    expect(commitIndexKind(root, base)).toBe('alternate');
    expect(commitIndexTree(root, base)).toEqual({
      tree: treeOf(root, outside),
    });
  });

  it('honours a caller-chosen relative GIT_INDEX_FILE from a package subdirectory', () => {
    // git resolves a relative GIT_INDEX_FILE against the top level, not the caller's cwd.
    const root = seedRepo();
    const alt = commitIndex(root, 'alt-rel');
    mkdirSync(join(root, 'pkg'));
    const base = { ...process.env, GIT_INDEX_FILE: '.git/alt-rel' };
    expect(commitIndexTree(join(root, 'pkg'), base)).toEqual({
      tree: treeOf(root, alt),
    });
  });

  it("hashes a linked worktree's own index (the ship gate worktree shape), not the main one", () => {
    const main = seedRepo();
    const wt = join(mkTmp('commit-index-wt-'), 'gate wt');
    git(main, ['worktree', 'add', '-q', '--detach', wt]);
    writeFileSync(join(wt, 'f.txt'), 'worktree only\n');
    git(wt, ['add', 'f.txt']);
    const wtIndex = join(git(wt, ['rev-parse', '--absolute-git-dir']).trim(), 'index');
    writeFileSync(`${wtIndex}.lock`, '');
    const expected = treeOf(wt, wtIndex);
    expect(expected).not.toBe(treeOf(main, join(main, '.git', 'index')));
    expect(commitIndexTree(wt)).toEqual({ tree: expected });
  });

  it('reads a split index through its shared index without leaving a new one behind', () => {
    const root = seedRepo();
    git(root, ['config', 'core.splitIndex', 'true']);
    git(root, ['update-index', '--split-index']);
    writeFileSync(join(root, 'f.txt'), 'split\n');
    git(root, ['add', 'f.txt']);
    const shared = () =>
      readdirSync(join(root, '.git')).filter((n) => n.startsWith('sharedindex.'));
    const before = shared();
    const expected = git(root, ['write-tree']).trim();
    expect(commitIndexTree(root)).toEqual({ tree: expected });
    expect(shared()).toEqual(before);
  });

  it('returns the empty tree for a fresh repository that has no index file yet', () => {
    const root = realpathSync(mkTmp('commit-index-fresh-'));
    git(root, ['init', '-q']);
    expect(existsSync(join(root, '.git', 'index'))).toBe(false);
    expect(commitIndexTree(root)).toEqual({
      tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    });
  });

  it('reports unmerged paths as an error naming git’s reason, never as a tree', () => {
    const root = seedRepo();
    git(root, ['checkout', '-qb', 'side']);
    writeFileSync(join(root, 'f.txt'), 'side\n');
    git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'side']);
    git(root, ['checkout', '-q', '-']);
    writeFileSync(join(root, 'f.txt'), 'main\n');
    git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'main']);
    expect(() => git(root, ['merge', '-q', 'side'])).toThrow();
    const result = commitIndexTree(root);
    expect(result.tree).toBeNull();
    expect('error' in result && result.error).toMatch(/unmerged|write-tree/i);
  });

  it('outside a repository returns an error instead of throwing', () => {
    const plain = mkTmp('commit-index-plain-');
    const result = commitIndexTree(plain, {
      ...process.env,
      GIT_CEILING_DIRECTORIES: tmpdir(),
    });
    expect(result.tree).toBeNull();
  });

  it('removes its private index copy on success and on failure', () => {
    const root = seedRepo();
    const corrupt = seedRepo();
    writeFileSync(join(corrupt, '.git', 'index'), 'not an index');
    // A private TMPDIR: parallel test files create scratch copies in the shared one.
    const scratch = mkTmp('commit-index-scratch-');
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      expect(commitIndexTree(root).tree).not.toBeNull();
      // Fails at write-tree, after the copy exists.
      expect(commitIndexTree(corrupt)).toMatchObject({ tree: null, error: /write-tree/ });
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    // Only devkit's own copies: macOS's git shim writes xcrun_db into TMPDIR too.
    expect(readdirSync(scratch).filter((name) => name.startsWith('devkit-tree-index-'))).toEqual(
      [],
    );
  });
});
