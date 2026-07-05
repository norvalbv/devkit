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
  } catch {
    return false;
  }
}
