/**
 * Runtime tests for ship_assert_staged_objects_readable — the sc-1420 probe.
 *
 * A ship died ten minutes into the gate chain because `git diff --cached` could not read a staged
 * object, and every invariant in assert-staged-set.sh passed straight through it. These tests pin
 * the two properties that make the probe worth having, and — just as importantly — the two cheaper
 * primitives it deliberately does NOT use, so a later "simplification" back to either one fails here
 * instead of silently restoring the blind spot:
 *
 *   - `git write-tree` is blind to it. ship_record_staged_state PERSISTS a cache-tree, and
 *     write_index_as_tree short-circuits on cache_tree_fully_valid(), which verifies only that the
 *     cached TREE objects exist. Every later write-tree re-reads a cached oid.
 *   - `git rev-list --objects` aborts on the FIRST missing object, so it cannot enumerate what is
 *     gone; with --missing=allow-any it silently omits them instead, which is worse.
 *
 * The probe must also stay quiet about gitlinks: a submodule's commit lives in the SUBMODULE's
 * object database and is absent from the superproject's by design.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from './_helpers.mts';

const HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'lib',
  'ship',
  'assert-staged-set.sh',
);

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const git = (cwd: string, args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '' } });

/**
 * A repo with two staged files whose cache-tree has already been persisted — i.e. the exact state
 * ship is in the instant ship_record_staged_state returns.
 */
function stagedRepo(dir: string) {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', 'base.txt']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);

  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'one.txt'), 'one\n');
  writeFileSync(join(dir, 'nested', 'two.txt'), 'two\n');
  git(dir, ['add', 'one.txt', 'nested/two.txt']);
  // Persist the cache-tree, exactly as ship_record_staged_state does. Without this the controls
  // below would not reproduce the short-circuit that made the original failure invisible.
  git(dir, ['write-tree']);
  return {
    oidOf: (path: string) => git(dir, ['rev-parse', `:${path}`]).stdout.trim(),
    deleteObject: (oid: string) =>
      rmSync(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true }),
  };
}

/** Invoke the probe the way ship does: source the helper, call the function against the worktree. */
function probe(worktree: string) {
  return spawnSync(
    'bash',
    ['-c', `. "${HELPER}"; ship_assert_staged_objects_readable "${worktree}" "test-label"`],
    { encoding: 'utf8' },
  );
}

describe('ship_assert_staged_objects_readable', () => {
  it('passes when every staged object is readable', () => {
    const dir = mkTmp('probe-clean-');
    stagedRepo(dir);

    const result = probe(dir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('fails and names the missing oid and its path', () => {
    const dir = mkTmp('probe-missing-');
    const repo = stagedRepo(dir);
    const oid = repo.oidOf('nested/two.txt');
    repo.deleteObject(oid);

    const result = probe(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(oid);
    expect(result.stderr).toContain('nested/two.txt');
    // The label tells the operator WHICH checkpoint caught it — staging vs the pre-commit preflight
    // bound the window the object went missing in, which is the whole diagnostic value.
    expect(result.stderr).toContain('test-label');
  });

  it('enumerates EVERY missing object, not just the first', () => {
    const dir = mkTmp('probe-multi-');
    const repo = stagedRepo(dir);
    const first = repo.oidOf('one.txt');
    const second = repo.oidOf('nested/two.txt');
    repo.deleteObject(first);
    repo.deleteObject(second);

    const result = probe(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(first);
    expect(result.stderr).toContain(second);
  });

  it('reports the object-database evidence that tells deletion apart from an ODB split', () => {
    const dir = mkTmp('probe-evidence-');
    const repo = stagedRepo(dir);
    repo.deleteObject(repo.oidOf('one.txt'));

    const { stderr } = probe(dir);

    // Whether ship itself was pointed at a non-default object database is the fact that
    // distinguishes "the object was deleted" from "ship and the gates read different databases".
    expect(stderr).toContain('GIT_OBJECT_DIRECTORY=');
    expect(stderr).toContain('GIT_ALTERNATE_OBJECT_DIRECTORIES=');
    expect(stderr).toContain('worktrees still registered');
    expect(stderr).toContain('gc.auto=');
  });

  it('does not report a submodule gitlink as missing', () => {
    const outer = mkTmp('probe-super-');
    const sub = mkTmp('probe-sub-');
    git(sub, ['init', '-q', '-b', 'main']);
    git(sub, ['config', 'user.email', 't@t.t']);
    git(sub, ['config', 'user.name', 't']);
    writeFileSync(join(sub, 's.txt'), 's\n');
    git(sub, ['add', 's.txt']);
    git(sub, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 's']);

    stagedRepo(outer);
    git(outer, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'mod']);

    // The gitlink's commit object is genuinely absent from the superproject's database.
    const gitlink = git(outer, ['ls-files', '-s', 'mod']).stdout.trim().split(/\s+/)[1];
    expect(git(outer, ['cat-file', '-t', gitlink]).status).not.toBe(0);

    const result = probe(outer);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});

describe('the primitives the probe deliberately avoids', () => {
  it('git write-tree does NOT notice a missing staged blob once its cache-tree is persisted', () => {
    const dir = mkTmp('control-write-tree-');
    const repo = stagedRepo(dir);
    const before = git(dir, ['write-tree']).stdout.trim();
    repo.deleteObject(repo.oidOf('nested/two.txt'));

    const after = git(dir, ['write-tree']);

    // Same oid, exit 0 — this is precisely why ship_assert_staged_unchanged passed during the
    // sc-1420 failure, and why the probe cannot be rewritten in terms of write-tree.
    expect(after.status).toBe(0);
    expect(after.stdout.trim()).toBe(before);
    // ...while the probe catches the very same state.
    expect(probe(dir).status).toBe(1);
  });

  it('git rev-list --objects cannot enumerate the missing objects', () => {
    const dir = mkTmp('control-rev-list-');
    const repo = stagedRepo(dir);
    const tree = git(dir, ['write-tree']).stdout.trim();
    const first = repo.oidOf('one.txt');
    const second = repo.oidOf('nested/two.txt');
    repo.deleteObject(first);
    repo.deleteObject(second);

    // Bare: aborts on whichever it reaches first in traversal order, so it can only ever name one
    // of the two. Which one depends on tree order, so assert the property, not the winner.
    const bare = git(dir, ['rev-list', '--objects', tree]);
    const bareOutput = [bare.stdout, bare.stderr].join('');
    expect(bare.status).not.toBe(0);
    expect([first, second].filter((oid) => bareOutput.includes(oid))).toHaveLength(1);

    // --missing=allow-any: exits clean and simply OMITS them, naming neither.
    const tolerant = git(dir, ['rev-list', '--objects', '--missing=allow-any', tree]);
    expect(tolerant.stdout).not.toContain(first);
    expect(tolerant.stdout).not.toContain(second);

    // The probe names both.
    const { stderr } = probe(dir);
    expect(stderr).toContain(first);
    expect(stderr).toContain(second);
  });
});
