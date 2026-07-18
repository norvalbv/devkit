import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repositorySource } from '../source.mts';

const roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-source-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tracker@example.invalid');
  git(root, 'config', 'user.name', 'Tracker Test');
  writeFileSync(join(root, 'value.txt'), 'base\n');
  git(root, 'add', 'value.txt');
  git(root, 'commit', '-qm', 'base');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository source modes', () => {
  it('reads the staged index independently of unrelated unstaged edits', () => {
    const root = repo();
    writeFileSync(join(root, 'value.txt'), 'staged\n');
    git(root, 'add', 'value.txt');
    writeFileSync(join(root, 'value.txt'), 'unstaged\n');

    expect(repositorySource(root, 'working').read('value.txt')).toBe('unstaged\n');
    expect(repositorySource(root, 'staged').read('value.txt')).toBe('staged\n');
    expect(repositorySource(root, 'tree', 'HEAD').read('value.txt')).toBe('base\n');
  });

  it('observes staged additions and deletions precisely', () => {
    const root = repo();
    writeFileSync(join(root, 'new.txt'), 'new\n');
    git(root, 'add', 'new.txt');
    git(root, 'rm', '-q', 'value.txt');
    const staged = repositorySource(root, 'staged');
    expect(staged.read('new.txt')).toBe('new\n');
    expect(staged.read('value.txt')).toBeNull();
    expect(staged.listFiles()).toContain('new.txt');
    expect(staged.listFiles()).not.toContain('value.txt');
  });

  it('refuses baseline and evidence paths outside the repository', () => {
    const root = repo();
    expect(() => repositorySource(root, 'working').read('../private.json')).toThrow(
      /Path escapes repository/,
    );
    expect(() => repositorySource(root, 'staged').read('../private.json')).toThrow(
      /Path escapes repository/,
    );
  });
});
