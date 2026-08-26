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
  // -z: NUL-separated RAW names. Without it git C-quotes paths containing tabs/unicode/quotes,
  // and every byte-keyed consumer (chunk packing, evidence budgeting) silently misses them.
  return execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/**
 * Content hash of the staged INDEX (`git write-tree`), or null when the index cannot form a tree
 * (unmerged paths) — callers must treat null as "cannot verify", never as "verified". sc-2054:
 * codex judges run workspace-write (the checklist state file needs cwd writes and codex cannot
 * confine cwd), so the gate snapshots the staged tree before the judge wave and refuses to pass
 * if ANY judge changed what would be committed — tamper DETECTION where prevention is impossible.
 */
export function stagedTreeHash(cwd: string): string | null {
  try {
    return execFileSync('git', ['write-tree'], { cwd, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** HEAD identity, `unborn:<ref>` before the first commit (a determinate state carrying the
 * symbolic target, so even switching unborn branches reads as movement), or null when HEAD is
 * UNREADABLE — callers must fail closed on null, never fold it into a determinate state, or two
 * broken reads would compare equal and wave tampering through. Paired with stagedTreeHash: a
 * nested `git commit` moves HEAD while leaving `git write-tree` identical. */
export function headHash(cwd: string): string | null {
  const read = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  const sha = read(['rev-parse', '--verify', 'HEAD']);
  if (sha !== null) return sha;
  const ref = read(['symbolic-ref', '-q', 'HEAD']);
  return ref !== null ? `unborn:${ref}` : null;
}
