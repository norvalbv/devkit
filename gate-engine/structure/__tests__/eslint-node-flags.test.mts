import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eslintNodeFlags } from '../eslint-node-flags.mts';

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
  it('preserves symlinks when node_modules is a symlink (gate worktree shape)', () => {
    const donor = scratch();
    const cwd = scratch();
    mkdirSync(join(donor, 'node_modules'));
    symlinkSync(join(donor, 'node_modules'), join(cwd, 'node_modules'), 'dir');
    expect(eslintNodeFlags(cwd)).toEqual(['--preserve-symlinks']);
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

  it('still preserves a DANGLING node_modules symlink (the link, not its target, decides)', () => {
    const cwd = scratch();
    symlinkSync(join(cwd, 'gone'), join(cwd, 'node_modules'), 'dir');
    expect(eslintNodeFlags(cwd)).toEqual(['--preserve-symlinks']);
  });

  it('adds nothing when node_modules is a plain file', () => {
    const cwd = scratch();
    writeFileSync(join(cwd, 'node_modules'), '');
    expect(eslintNodeFlags(cwd)).toEqual([]);
  });
});
