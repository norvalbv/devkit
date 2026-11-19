import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rewriteRepo, runReship as run } from './_reship-rewrite-fixture.mts';

// A stacked PR carries its squash-merged parent's commits, so the merge-base scope lists paths main
// holds; a parent-deleted one exists nowhere, so neither briefing nor omitting it could pass.

/** Commits `edit` on main, publishes it, and makes it an ancestor of the caller's checkout; `-s ours`
 * keeps the checkout's tree, which matters only for the one briefed path. */
function landOnMain(repo, edit) {
  const { dir, g } = repo;
  g(['checkout', '-q', 'main']);
  edit(dir);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'parent PR lands']);
  g(['push', '-q', 'origin', 'main']);
  const newMain = g(['rev-parse', 'HEAD']);
  g(['checkout', '-q', 'prepared']);
  g(['merge', '-q', '-s', 'ours', '--no-edit', 'main']);
  return newMain;
}

function landRename(dir) {
  rmSync(join(dir, 'old.txt'));
  writeFileSync(join(dir, 'new.txt'), 'renamed\n');
}

const BRIEF_OWN_PATH = [
  'feat/pr',
  'rewrite onto main',
  '--pr',
  '--base',
  'main',
  '--',
  'conflict.txt',
];

describe('reship --base — old-PR paths the base already carries identically', () => {
  it('publishes with only its own path when the parent deletion, rename and add already landed', () => {
    const repo = rewriteRepo({ rename: true, extraPath: true });
    const newMain = landOnMain(repo, (dir) => {
      landRename(dir);
      writeFileSync(join(dir, 'extra.txt'), 'feature extra\n');
    });
    const r = run(BRIEF_OWN_PATH, repo.dir, repo.env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('rewrite brief omits paths');
    const { bare, g } = repo;
    const replacement = g(['--git-dir', bare, 'rev-parse', 'refs/heads/feat/pr']);
    expect(g(['--git-dir', bare, 'rev-parse', `${replacement}^`])).toBe(newMain);
    expect(g(['--git-dir', bare, 'diff-tree', '--name-only', '-r', newMain, replacement])).toBe(
      'conflict.txt',
    );
  });

  it('omits a landed nested path even when the PR changes a sibling in its directory', () => {
    const repo = rewriteRepo();
    const { dir, g } = repo;
    g(['checkout', '-q', 'feature']);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/landed.txt'), 'landed\n');
    writeFileSync(join(dir, 'src/own.txt'), 'own\n');
    g(['add', 'src']);
    g(['commit', '-q', '-m', 'nested paths']);
    g(['push', '-q', 'origin', 'HEAD:feat/pr']);
    const prHead = g(['rev-parse', 'HEAD']);
    landOnMain(repo, (d) => {
      mkdirSync(join(d, 'src'));
      writeFileSync(join(d, 'src/landed.txt'), 'landed\n');
    });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/own.txt'), 'own\n');
    const r = run([...BRIEF_OWN_PATH, 'src/own.txt'], dir, {
      ...repo.env,
      PR_HEAD_OID: prHead,
      SHIP_DRY_RUN: '1',
    });
    expect(r.stderr).not.toContain('rewrite brief omits paths');
    expect(r.status, r.stderr).toBe(0);
  });

  it('still requires the half of a rename the base does not carry', () => {
    const repo = rewriteRepo({ rename: true });
    landOnMain(repo, (dir) => writeFileSync(join(dir, 'new.txt'), 'renamed\n'));
    const r = run(BRIEF_OWN_PATH, repo.dir, { ...repo.env, SHIP_DRY_RUN: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      'rewrite brief omits paths from the existing PR:\n  old.txt\n  to ADD',
    );
  });

  it('still requires a gitlink the old PR added when the consumer ignores submodules in diffs', () => {
    const repo = rewriteRepo();
    const { g } = repo;
    g(['checkout', '-q', 'feature']);
    g(['update-index', '--add', '--cacheinfo', `160000,${repo.oldBase},lib`]);
    g(['commit', '-q', '-m', 'add submodule']);
    g(['push', '-q', 'origin', 'HEAD:feat/pr']);
    const prHead = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'prepared']);
    g(['config', 'diff.ignoreSubmodules', 'all']);
    const r = run(BRIEF_OWN_PATH, repo.dir, {
      ...repo.env,
      PR_HEAD_OID: prHead,
      SHIP_DRY_RUN: '1',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('rewrite brief omits paths from the existing PR:\n  lib\n');
  });

  it('still requires a path whose base copy differs from the old PR only by mode', () => {
    const repo = rewriteRepo({ extraPath: true });
    landOnMain(repo, (dir) => {
      writeFileSync(join(dir, 'extra.txt'), 'feature extra\n');
      chmodSync(join(dir, 'extra.txt'), 0o755);
    });
    const r = run(BRIEF_OWN_PATH, repo.dir, { ...repo.env, SHIP_DRY_RUN: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('rewrite brief omits paths from the existing PR:\n  extra.txt\n');
  });
});
