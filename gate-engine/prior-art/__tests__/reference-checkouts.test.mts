import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReferenceCheckouts } from '../reference-checkouts.mts';

let root: string;
let main: string;
let linked: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });

/** Write guard.config.json declaring these patterns into each given checkout. */
function declare(patterns: string[], ...dirs: string[]): void {
  for (const dir of dirs)
    writeFileSync(
      path.join(dir, 'guard.config.json'),
      JSON.stringify({ research: { referenceCheckouts: patterns } }),
    );
}

const sibling = (name: string) => path.join(root, name);

// The main checkout's directory name carries a space, as the reported checkout's did.
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ref checkouts-')));
  main = path.join(root, 'main repo');
  linked = path.join(root, 'elsewhere', 'wt');
  mkdirSync(main);
  mkdirSync(path.dirname(linked));
  git(main, 'init', '-q');
  git(
    main,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x',
  );
  git(main, 'worktree', 'add', '-q', linked);
  for (const name of ['sib-a', 'sib-b']) mkdirSync(sibling(name));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveReferenceCheckouts', () => {
  it('resolves siblings of the main checkout from a linked worktree', () => {
    declare(['../sib-a', '../sib-b'], linked);
    expect(resolveReferenceCheckouts(linked)).toEqual({
      declared: ['../sib-a', '../sib-b'],
      resolved: [sibling('sib-a'), sibling('sib-b')],
    });
  });

  it('resolves from the config directory itself without any retry', () => {
    declare(['../sib-a'], main);
    expect(resolveReferenceCheckouts(main).resolved).toEqual([sibling('sib-a')]);
  });

  it('counts a pattern matching from neither base as declared only', () => {
    declare(['../sib-a', '../absent'], linked);
    const { declared, resolved } = resolveReferenceCheckouts(linked);
    expect(declared).toHaveLength(2);
    expect(resolved).toEqual([sibling('sib-a')]);
  });

  it('expands one glob to several directories, never to a file or the repository itself', () => {
    writeFileSync(sibling('sib-file'), '');
    declare(['../*'], main);
    expect(resolveReferenceCheckouts(main).resolved.sort()).toEqual([
      path.join(root, 'elsewhere'),
      sibling('sib-a'),
      sibling('sib-b'),
    ]);
  });

  it('counts a symlinked checkout once, under its real path', () => {
    symlinkSync(sibling('sib-a'), sibling('sib-link'));
    declare(['../sib-a', '../sib-link'], main);
    expect(resolveReferenceCheckouts(main).resolved).toEqual([sibling('sib-a')]);
  });

  it('retries against the same subdirectory of the main worktree', () => {
    mkdirSync(path.join(main, 'pkg', 'vendor'), { recursive: true });
    mkdirSync(path.join(linked, 'pkg'));
    declare(['vendor'], path.join(linked, 'pkg'));
    expect(resolveReferenceCheckouts(path.join(linked, 'pkg')).resolved).toEqual([
      path.join(main, 'pkg', 'vendor'),
    ]);
  });

  it('does not retry when the main worktree is bare', () => {
    const bare = path.join(root, 'bare.git');
    const fromBare = path.join(root, 'deep', 'wt');
    mkdirSync(path.dirname(fromBare));
    git(root, 'clone', '-q', '--bare', main, bare);
    git(bare, 'worktree', 'add', '-q', fromBare);
    declare(['../sib-a'], fromBare);
    expect(resolveReferenceCheckouts(fromBare)).toEqual({ declared: ['../sib-a'], resolved: [] });
  });

  it('resolves outside a git repository, and reads no config as nothing declared', () => {
    const plain = path.join(root, 'plain');
    mkdirSync(plain);
    expect(resolveReferenceCheckouts(plain)).toEqual({ declared: [], resolved: [] });
    declare(['../sib-b'], plain);
    expect(resolveReferenceCheckouts(plain).resolved).toEqual([sibling('sib-b')]);
  });

  it('throws on an unreadable config rather than reporting nothing declared', () => {
    writeFileSync(path.join(main, 'guard.config.json'), '{"research": ');
    expect(() => resolveReferenceCheckouts(main)).toThrow();
  });
});
