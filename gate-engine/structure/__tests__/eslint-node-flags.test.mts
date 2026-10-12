import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eslintNodeFlags, linkedIsolatedStore } from '../eslint-node-flags.mts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      unlinkSync(join(dir, 'node_modules'));
    } catch {
      // not a link (or absent) — rmSync below handles it
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'eslint-node-flags-'));
  dirs.push(dir);
  return dir;
};

describe('eslintNodeFlags', () => {
  it('preserves symlinks when node_modules links a hoisted install (gate worktree shape)', () => {
    const donor = scratch();
    const cwd = scratch();
    mkdirSync(join(donor, 'node_modules', 'eslint', 'bin'), { recursive: true });
    writeFileSync(join(donor, 'node_modules', 'eslint', 'bin', 'eslint.js'), '');
    symlinkSync(join(donor, 'node_modules'), join(cwd, 'node_modules'), 'dir');
    expect(eslintNodeFlags(cwd)).toEqual(['--preserve-symlinks']);
    expect(linkedIsolatedStore(cwd)).toBe(false);
  });

  it('adds nothing when node_modules links an isolated store (eslint itself a link)', () => {
    const donor = scratch();
    const cwd = scratch();
    const store = join(donor, 'node_modules', '.bun', 'eslint@9', 'node_modules', 'eslint');
    mkdirSync(join(store, 'bin'), { recursive: true });
    writeFileSync(join(store, 'bin', 'eslint.js'), '');
    symlinkSync(store, join(donor, 'node_modules', 'eslint'), 'dir');
    symlinkSync(join(donor, 'node_modules'), join(cwd, 'node_modules'), 'dir');
    expect(eslintNodeFlags(cwd)).toEqual([]);
    expect(linkedIsolatedStore(cwd)).toBe(true);
  });

  it('adds nothing for a physical node_modules (npm/bun hoisted, and pnpm isolated)', () => {
    const cwd = scratch();
    mkdirSync(join(cwd, 'node_modules', '.pnpm'), { recursive: true });
    symlinkSync(join(cwd, 'node_modules', '.pnpm'), join(cwd, 'node_modules', 'eslint'), 'dir');
    expect(eslintNodeFlags(cwd)).toEqual([]);
  });

  it('adds nothing when there is no node_modules', () => {
    expect(eslintNodeFlags(scratch())).toEqual([]);
  });

  it('adds nothing for a DANGLING node_modules symlink (no eslint to preserve)', () => {
    const cwd = scratch();
    symlinkSync(join(cwd, 'gone'), join(cwd, 'node_modules'), 'dir');
    expect(eslintNodeFlags(cwd)).toEqual([]);
  });

  it('adds nothing when node_modules is a plain file', () => {
    const cwd = scratch();
    writeFileSync(join(cwd, 'node_modules'), '');
    expect(eslintNodeFlags(cwd)).toEqual([]);
  });
});
