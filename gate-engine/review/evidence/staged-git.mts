/**
 * Staged-tree git plumbing for the review gate (extracted from run-review.mts, sc-1442).
 *
 * argv-based on purpose: staged FILENAMES ride these calls, and a shell string (even
 * JSON.stringify-quoted) lets a crafted path like `$(cmd).ts` expand before git runs.
 */

import { execFileSync } from 'node:child_process';

export function gitCached(cwd: string, args: string[], files: string[]): string {
  return execFileSync('git', ['diff', '--cached', ...args, '--', ...files], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function stagedFiles(cwd: string): string[] {
  return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
