import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitIndexEnv,
  commitIndexFile,
  commitIndexKind,
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
