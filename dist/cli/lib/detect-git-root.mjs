/**
 * Git-root detection for monorepo support. `devkit init` can run INSIDE a package subdir
 * (e.g. a monorepo's services/webapp) — configs/baselines stay in cwd (the package), but the
 * husky hook + repo-wide skills must target the GIT ROOT, with the gate lines scoped into the
 * package via `cd <pkgRel>`. This module finds that root.
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
/**
 * Walk up from `cwd` for a `.git` entry (a directory for a normal repo, or a FILE for a git
 * worktree/submodule). Returns the git root and the POSIX-relative path from it to `cwd`.
 * `pkgRel` is '' when cwd IS the git root, or when no `.git` is found anywhere up the tree
 * (then `gitRoot` falls back to `cwd` — a non-git dir behaves exactly as a single-package root).
 *
 * @param {string} cwd
 * @returns {{ gitRoot: string, pkgRel: string }}
 */
export function detectGitRoot(cwd = process.cwd()) {
    let dir = cwd;
    // Bounded walk up to the filesystem root (the 64 cap is a safety net far beyond any real
    // path depth; the parent === dir break ends it at the root first).
    for (let i = 0; i < 64; i++) {
        if (existsSync(join(dir, '.git'))) {
            return { gitRoot: dir, pkgRel: relative(dir, cwd).split(sep).join('/') };
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return { gitRoot: cwd, pkgRel: '' };
}
