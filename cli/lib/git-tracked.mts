/**
 * Is a path already TRACKED by git? The overlay install hides its files via `.git/info/exclude`,
 * which only ignores UNtracked files — a modification to a tracked file still shows in `git status`
 * and can't be hidden. So before overlay writes into a shared tree (`.claude/`, `.cursor/`), it
 * must skip anything git already tracks, or it would dirty the repo it promised not to touch.
 *
 * `git ls-files --error-unmatch <path>` exits 0 iff git tracks <path> (for a directory, iff it
 * tracks ≥1 file under it), and non-zero otherwise — the authoritative "does git track this" probe.
 */

import { execFileSync } from 'node:child_process';

const TRAILING_SLASH_RE = /\/$/;

/**
 * @param gitRoot the dir holding `.git`
 * @param relPath git-root-relative POSIX path (file or dir)
 * @returns true iff git tracks relPath (or, for a dir, any file under it)
 */
export function isTracked(gitRoot: string, relPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relPath], {
      cwd: gitRoot,
      stdio: 'pipe',
    });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

/** Snapshot tracked files and their parent directories for repeated lifecycle checks. */
export function trackedPathPredicate(gitRoot: string): (relPath: string) => boolean {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: gitRoot, encoding: 'utf8' });
  const tracked = new Set<string>();
  for (const file of files.split('\0').filter(Boolean)) {
    let path = '';
    for (const part of file.split('/')) {
      path = path ? `${path}/${part}` : part;
      tracked.add(path);
    }
  }
  return (relPath) => tracked.has(relPath.replace(TRAILING_SLASH_RE, ''));
}
