/**
 * stagedTouchedSet — the attribution counterpart to stagedSet.
 *
 * stagedSet answers "which files should I re-check", so it filters to ACMR. This one answers "what
 * did this commit change", so a deletion and a regular-file/symlink swap both count. Every case
 * below is a status an allowlist has already been observed to drop.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBaselineTrackable,
  freezeIndex,
  frozenTouchedSet,
  indexFiles,
  stagedTouchedSet,
  treeFilesAtRef,
} from '../git-index.mts';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-staged-touched-'));
  cleanup.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'kept.txt'), 'kept\n');
  writeFileSync(join(root, 'doomed.txt'), 'doomed\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'seed');
  return root;
}

describe('stagedTouchedSet', () => {
  it('includes a staged DELETION, which stagedSet drops', () => {
    const root = seed();
    git(root, 'rm', '-q', 'doomed.txt');
    expect(stagedTouchedSet(root)).toEqual(new Set(['doomed.txt']));
  });

  it('includes a regular-file to symlink TYPE change', () => {
    const root = seed();
    unlinkSync(join(root, 'doomed.txt'));
    symlinkSync('kept.txt', join(root, 'doomed.txt'));
    git(root, 'add', '-A');
    expect(stagedTouchedSet(root)).toContain('doomed.txt');
  });

  it('is empty — not null — when a repo has nothing staged', () => {
    expect(stagedTouchedSet(seed())).toEqual(new Set());
  });

  it('returns null when git cannot answer, so callers stand down instead of blaming the tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-staged-touched-nogit-'));
    cleanup.push(root);
    expect(stagedTouchedSet(root)).toBeNull();
  });

  // Rename detection reports only the destination. A governed file moved OUT of its governed path
  // would then be invisible to a caller matching on the source, and the drift the move caused would
  // read as pre-existing.
  it('reports BOTH sides of a rename, not just the destination', () => {
    const root = seed();
    git(root, 'mv', 'doomed.txt', 'moved.txt');
    const touched = stagedTouchedSet(root);
    expect(touched).toContain('doomed.txt');
    expect(touched).toContain('moved.txt');
  });

  // A merge's first-parent diff also lists everything inherited unchanged from the second parent.
  // Blaming those on the merge would fail a gate for work the merge did not author.
  it('during a merge, reports only paths that differ from BOTH parents', () => {
    const root = seed();
    git(root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(root, 'side-only.txt'), 'from the side branch\n');
    writeFileSync(join(root, 'kept.txt'), 'side edit\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'side');
    git(root, 'checkout', '-q', 'main');
    writeFileSync(join(root, 'kept.txt'), 'main edit\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'main');

    // Conflicts on kept.txt; side-only.txt merges in cleanly from MERGE_HEAD.
    try {
      git(root, 'merge', '--no-commit', 'side');
    } catch {
      /* a conflicting merge exits non-zero and leaves MERGE_HEAD in place — that is the state under test */
    }
    writeFileSync(join(root, 'kept.txt'), 'resolved\n');
    git(root, 'add', '-A');

    const touched = stagedTouchedSet(root);
    expect(touched).not.toBeNull();
    // The resolution differs from both parents; the cleanly-inherited file differs only from HEAD.
    expect(touched).toContain('kept.txt');
    expect(touched).not.toContain('side-only.txt');
  });
});

/**
 * sc-2478 — the frozen counterpart. One `write-tree` pins the pending commit, so every later read is
 * against an immutable object and a concurrent `git add` cannot split the judged snapshot.
 */
describe('freezeIndex + frozenTouchedSet', () => {
  it('reports what the index held at the freeze, not what it holds now', () => {
    const root = seed();
    writeFileSync(join(root, 'kept.txt'), 'staged before the freeze\n');
    git(root, 'add', 'kept.txt');
    const frozen = freezeIndex(root);
    writeFileSync(join(root, 'late.txt'), 'staged after the freeze\n');
    git(root, 'add', 'late.txt');
    expect(frozen).not.toBeNull();
    expect(frozenTouchedSet(root, frozen!)).toEqual(new Set(['kept.txt']));
    expect(stagedTouchedSet(root)).toEqual(new Set(['kept.txt', 'late.txt']));
  });

  it('pins the base too: a commit landing after the freeze does not shrink the set', () => {
    const root = seed();
    writeFileSync(join(root, 'kept.txt'), 'edit\n');
    git(root, 'add', 'kept.txt');
    const frozen = freezeIndex(root)!;
    git(root, 'commit', '-qm', 'someone else commits the same change');
    expect(frozenTouchedSet(root, frozen)).toEqual(new Set(['kept.txt']));
  });

  it('agrees with stagedTouchedSet on deletions and both sides of a rename', () => {
    const root = seed();
    git(root, 'mv', 'doomed.txt', 'moved.txt');
    git(root, 'rm', '-q', 'kept.txt');
    expect(frozenTouchedSet(root, freezeIndex(root)!)).toEqual(stagedTouchedSet(root));
  });

  it('is empty — not null — when nothing is staged', () => {
    const root = seed();
    expect(frozenTouchedSet(root, freezeIndex(root)!)).toEqual(new Set());
  });

  it('freezes an unborn HEAD against the empty tree, so every staged path is touched', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-frozen-unborn-'));
    cleanup.push(root);
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'first.txt'), 'first\n');
    git(root, 'add', 'first.txt');
    const frozen = freezeIndex(root);
    expect(frozen?.base).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    expect(frozenTouchedSet(root, frozen!)).toEqual(new Set(['first.txt']));
  });

  it('returns null — never a live fallback — while another git process holds index.lock', () => {
    const root = seed();
    writeFileSync(join(root, '.git', 'index.lock'), '');
    expect(freezeIndex(root)).toBeNull();
  });

  it('returns null outside a repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-frozen-nogit-'));
    cleanup.push(root);
    expect(freezeIndex(root)).toBeNull();
  });

  // Agents stage with `git add -N`. write-tree omits an intent-to-add entry rather than failing, so
  // the gate keeps running instead of silently going inert on every such commit.
  it('freezes an index carrying an intent-to-add entry, which the commit would not include either', () => {
    const root = seed();
    writeFileSync(join(root, 'intent.txt'), 'not yet added\n');
    git(root, 'add', '-N', 'intent.txt');
    const frozen = freezeIndex(root);
    expect(frozen).not.toBeNull();
    expect(frozenTouchedSet(root, frozen!)).not.toContain('intent.txt');
  });

  it('during a merge, intersects with the MERGE_HEAD captured at the freeze', () => {
    const root = seed();
    git(root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(root, 'side-only.txt'), 'from the side branch\n');
    writeFileSync(join(root, 'kept.txt'), 'side edit\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'side');
    git(root, 'checkout', '-q', 'main');
    writeFileSync(join(root, 'kept.txt'), 'main edit\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'main');
    try {
      git(root, 'merge', '--no-commit', 'side');
    } catch {
      /* the conflicting merge leaves MERGE_HEAD in place — the state under test */
    }
    writeFileSync(join(root, 'kept.txt'), 'resolved\n');
    git(root, 'add', '-A');

    const frozen = freezeIndex(root)!;
    expect(frozen.mergeHead).toBe(git(root, 'rev-parse', 'side'));
    // Aborting after the freeze must not widen the set to every path inherited from `side`.
    git(root, 'merge', '--abort');
    const touched = frozenTouchedSet(root, frozen);
    expect(touched).toContain('kept.txt');
    expect(touched).not.toContain('side-only.txt');
  });

  it('refuses to freeze an index with unmerged paths', () => {
    const root = seed();
    git(root, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(root, 'kept.txt'), 'side edit\n');
    git(root, 'commit', '-qam', 'side');
    git(root, 'checkout', '-q', 'main');
    writeFileSync(join(root, 'kept.txt'), 'main edit\n');
    git(root, 'commit', '-qam', 'main');
    try {
      git(root, 'merge', '--no-commit', 'side');
    } catch {
      /* unresolved conflict: kept.txt is unmerged */
    }
    expect(freezeIndex(root)).toBeNull();
  });
});

/**
 * sc-2357 — inside a ship gate the tree is the PR BASE, so a base predating the .gitignore baseline
 * exceptions throws this for a file the caller's own checkout tracks, and the plain remedy misleads.
 */
describe('assertBaselineTrackable — naming base selection, but only inside a ship', () => {
  function ignoredBaselineRepo(): string {
    const root = seed();
    writeFileSync(join(root, '.gitignore'), '.devkit/\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'ignore .devkit, as a base predating the exceptions does');
    return root;
  }

  const throwing = (root: string): string => {
    try {
      assertBaselineTrackable(root, '.devkit/baselines/size-lines.json');
    } catch (error) {
      // Narrowed rather than asserted: a non-Error throw would otherwise read as an empty message
      // and every assertion below would pass against nothing.
      return error instanceof Error ? error.message : String(error);
    }
    return '';
  };

  it('keeps the plain wording when no ship exported a base', () => {
    delete process.env.DEVKIT_SHIP_BASE_SHA;
    const message = throwing(ignoredBaselineRepo());

    expect(message).toContain('is ignored by Git. Run devkit init/upgrade');
    expect(message).not.toContain('--base');
  });

  it('names both ship-only causes when a ship exported a base', () => {
    process.env.DEVKIT_SHIP_BASE_SHA = 'a'.repeat(40);
    try {
      const message = throwing(ignoredBaselineRepo());

      expect(message).toContain('This gate tree is the PR base, not your checkout');
      expect(message).toContain('--base names the line your work is built on');
      expect(message).toContain('.git/info/exclude'); // the overlay cause, which a base change cannot fix
    } finally {
      delete process.env.DEVKIT_SHIP_BASE_SHA;
    }
  });
});

// sc-2772: a stand-down probe must not also print git's failure. Asserted from a child process,
// because an inherited fd 2 never passes through this process's stderr stream.
describe('stand-down probes write nothing to stderr (sc-2772)', () => {
  const MODULE = new URL('../git-index.mts', import.meta.url).href;

  // GIT_* stripped and a ceiling set, so a hook or ship environment (GIT_INDEX_FILE, GIT_DIR)
  // cannot resolve the probes into the real repository.
  function probe(cwd: string, body: string) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    const script = `const m = await import(${JSON.stringify(MODULE)});\nconst cwd = process.cwd();\n${body}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd,
      encoding: 'utf8',
      env: { ...env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
    });
    return {
      status: result.status,
      out: result.stdout.trim() ? JSON.parse(result.stdout) : undefined,
      stderr: result.stderr,
    };
  }

  const ALL_PROBES = `console.log(JSON.stringify([
  m.stagedTouchedSet(cwd), m.stagedSet(cwd), m.hasStagedFiles(cwd), m.gitPrefix(cwd), m.indexFiles(cwd),
]));`;

  it('outside a repository: every probe stands down, silently', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-quiet-nogit-'));
    cleanup.push(root);
    const result = probe(root, ALL_PROBES);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.out).toEqual([null, null, false, '', null]);
  });

  // An interrupted write or a disk fault leaves .git/index unreadable inside a real repository —
  // the in-repo failure shape, where git prints "index file corrupt" instead of usage text.
  it('with a corrupt index: the index readers stand down, silently', () => {
    const root = seed();
    writeFileSync(join(root, '.git', 'index'), 'not an index\n');
    const result = probe(
      root,
      `console.log(JSON.stringify([m.stagedTouchedSet(cwd), m.stagedSet(cwd), m.hasStagedFiles(cwd), m.indexFiles(cwd)]));`,
    );
    expect(result.stderr).toBe('');
    expect(result.out).toEqual([null, null, false, null]);
  });

  // The frozen reader shares touchedPaths, whose primary call was the noisy one. A snapshot whose
  // objects no longer resolve (pruned, or a stale freeze replayed elsewhere) must stand down quietly.
  it('frozenTouchedSet over objects that no longer resolve: null, silently', () => {
    const root = seed();
    const missing = 'f'.repeat(40);
    const result = probe(
      root,
      `console.log(JSON.stringify(m.frozenTouchedSet(cwd, { base: '${missing}', mergeHead: null, tree: '${missing}' })));`,
    );
    expect(result.stderr).toBe('');
    expect(result.out).toBeNull();
  });

  // Deliberate carve-out (sc-1959): this failure is pullRequestScope's exit 2, and git's reason is
  // the only cause it shows — a shallow or unrelated PR checkout has no merge base.
  it("changedSetSince keeps git's reason visible when the three-dot diff fails", () => {
    const root = seed();
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '--orphan', 'unrelated');
    git(root, 'commit', '-qm', 'unrelated root');
    const result = probe(root, `console.log(JSON.stringify(m.changedSetSince(cwd, '${base}')));`);
    expect(result.out).toBeNull();
    expect(result.stderr).toMatch(/no merge base/i);
  });
});

describe('indexFiles / treeFilesAtRef on a path list larger than 1 MiB', () => {
  it('returns every path instead of null (no ENOBUFS)', () => {
    const root = mkdtempSync(join(tmpdir(), 'devkit-big-index-'));
    cleanup.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '' })
      .toString()
      .trim();
    const dir = 'd'.repeat(180);
    const paths = Array.from({ length: 6000 }, (_, i) => `${dir}/file-${i}.txt`);
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: root,
      input: paths.map((p) => `100644 ${blob}\t${p}`).join('\n'),
    });
    git(root, 'commit', '-q', '-m', 'big');
    expect(paths.join('\0').length).toBeGreaterThan(1024 * 1024);

    expect(indexFiles(root)?.length).toBe(paths.length);
    expect(treeFilesAtRef(root, 'HEAD')?.length).toBe(paths.length);
  });
});
