/** The one contract for a devkit-written git hook file: atomic 0755 publish and a single-fd read. */

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mts';

export const HOOK_MODE = 0o755;

type HookState = { content: string | null; mode: number } | null;

// One descriptor, content THEN mode: no check-then-use gap, and a chmod during the read is seen.
export function readHook(
  path: string,
  readFile: (fd: number) => string = (fd) => readFileSync(fd, 'utf8'),
): HookState {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? e.code : undefined;
    // ELOOP: a self-referencing link is no hook git can run, and the atomic rename replaces it.
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    // Unreadable devkit hook (e.g. mode 0100): content unknown, so it can only be drift, never clean.
    if (code === 'EACCES') return unreadableHook(path);
    throw e;
  }
  try {
    const content = readFile(fd);
    return { content, mode: fstatSync(fd).mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

function unreadableHook(path: string): { content: null; mode: number } | null {
  try {
    return { content: null, mode: statSync(path).mode & 0o777 };
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Publish a hook atomically: git may exec it mid-write, so never truncate the live file in place. */
export function writeHookAtomic(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, content, HOOK_MODE);
}

// Devkit writes exactly 0755; any other mode (0644, owner-less 0001, …) may leave git skipping the
// hook silently, so it is drift even when the bytes match.
export function hookDrift(current: HookState, expected: string | null): boolean {
  return (
    (current?.content ?? null) !== expected || (current !== null && current.mode !== HOOK_MODE)
  );
}
