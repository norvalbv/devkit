/** The shared hook-file contract: atomic 0755 publish, a single-fd read, and mode-aware drift. */
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookDrift, readHook, writeHookAtomic } from '../lib/husky/overlay/hook-file.mts';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const tmpRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'dk-hook-file-'));
  homes.push(root);
  return root;
};

const existingHook = () => {
  const path = join(tmpRoot(), 'commit-msg');
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
};

describe('writeHookAtomic', () => {
  it('publishes a new inode, so a hard link to the old hook keeps its old bytes', () => {
    const path = existingHook();
    const held = `${path}.held`;
    linkSync(path, held);
    writeHookAtomic(path, '#!/bin/sh\necho new\n');
    expect(readFileSync(held, 'utf8')).toBe('#!/bin/sh\n');
    expect(readFileSync(path, 'utf8')).toBe('#!/bin/sh\necho new\n');
    expect(statSync(path).ino).not.toBe(statSync(held).ino);
  });

  it('creates missing parent dirs and publishes exactly 0755 under a restrictive umask', () => {
    const path = join(tmpRoot(), '.devkit', 'hooks', 'pre-commit');
    const previous = process.umask(0o077);
    try {
      writeHookAtomic(path, '#!/bin/sh\n');
    } finally {
      process.umask(previous);
    }
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it('a failed publish rethrows and leaves no temp file beside the hook', () => {
    const root = tmpRoot();
    const path = join(root, 'pre-commit');
    mkdirSync(path);
    writeFileSync(join(path, 'occupied'), ''); // a non-empty dir: rename over it fails
    expect(() => writeHookAtomic(path, '#!/bin/sh\n')).toThrow();
    expect(readdirSync(root)).toEqual(['pre-commit']);
  });
});

describe('hookDrift', () => {
  it('flags differing bytes, a non-0755 mode and an unreadable hook; a wanted-absent hook is clean', () => {
    expect(hookDrift({ content: 'a', mode: 0o755 }, 'a')).toBe(false);
    expect(hookDrift({ content: 'a', mode: 0o755 }, 'b')).toBe(true);
    expect(hookDrift({ content: 'a', mode: 0o644 }, 'a')).toBe(true);
    expect(hookDrift({ content: null, mode: 0o100 }, 'a')).toBe(true);
    expect(hookDrift(null, 'a')).toBe(true);
    expect(hookDrift(null, null)).toBe(false);
  });
});

// Concurrent actors can delete or chmod the hook while it is read: a vanished hook reads as missing
// (never an ENOENT crash), a +x lost mid-read is observed, and other read failures still surface.
describe('readHook — hook changing under the read', () => {
  it('a hook deleted before the read reads as missing', () => {
    const path = existingHook();
    rmSync(path);
    expect(readHook(path)).toBeNull();
  });

  it('an executable bit removed while the content is read is observed', () => {
    const path = existingHook();
    const r = readHook(path, (fd) => {
      chmodSync(path, 0o644);
      return readFileSync(fd, 'utf8');
    });
    expect(r).toEqual({ content: '#!/bin/sh\n', mode: 0o644 });
  });

  it('a hook the owner cannot read is reported unreadable (drift), not missing and not a crash', () => {
    const path = existingHook();
    chmodSync(path, 0o100);
    expect(readHook(path)).toEqual({ content: null, mode: 0o100 });
  });

  it('a hook in a directory without search permission reads as missing, not a crash', () => {
    const path = existingHook();
    const dir = join(path, '..');
    chmodSync(dir, 0o600);
    try {
      expect(readHook(path)).toBeNull();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('any other read failure is not swallowed as missing', () => {
    const eio = () => {
      throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
    };
    expect(() => readHook(existingHook(), eio)).toThrow(/EIO/);
  });
});
