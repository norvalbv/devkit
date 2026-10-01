// sc-2429: init/upgrade read the selection, install from it, then record it — so the whole run is
// serialized, once per repository (monorepo packages share it). Contention fails fast with the pid.
import { readdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { LockHeldError, withLockAsync } from '../../atomic-write.mts';
import { detectGitRoot } from '../../detect-git-root.mts';

const DEFAULT_WAIT_MS = 5_000;

const GITDIR_RE = /^gitdir:\s*(.+)$/m;

/**
 * Where the init lock lives: the git admin dir, like git's own index.lock, so a concurrent
 * `git add -A` can never stage it. A `.git` FILE (linked worktree, submodule) names that dir.
 */
export function initLockPath(gitRoot: string): string {
  const dotGit = join(gitRoot, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, 'devkit-init.lock');
    const gitdir = GITDIR_RE.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (gitdir) return join(resolve(gitRoot, gitdir), 'devkit-init.lock');
  } catch {
    // no .git at all: not a repository, so nothing could stage the fallback below
  }
  return join(gitRoot, '.devkit', 'init.lock');
}

/** DEVKIT_INIT_LOCK_WAIT_MS as whole safe-integer ms; unset, blank or malformed keeps the default. */
export function initLockWaitMs(raw: string | undefined): number {
  const value = raw?.trim() ?? '';
  const ms = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(ms) ? ms : DEFAULT_WAIT_MS; // an overflowed digit run is not a wait
}

/** Run `fn` holding the init lock; on contention print the holder and return exit code 1. */
export async function withInitLock(
  cwd: string,
  command: 'init' | 'upgrade',
  fn: () => Promise<number>,
): Promise<number> {
  const { gitRoot } = detectGitRoot(cwd);
  const lock = initLockPath(gitRoot);
  const lockParent = dirname(lock);
  let heldOnlyOurLock = false;
  try {
    return await withLockAsync(
      lock,
      async () => {
        // Judged once held: a pre-lock existence check goes stale when a contender removes the dir.
        heldOnlyOurLock = readdirSync(lockParent).every((entry) => entry === basename(lock));
        return fn();
      },
      { waitMs: initLockWaitMs(process.env.DEVKIT_INIT_LOCK_WAIT_MS) },
    );
  } catch (e: unknown) {
    if (!(e instanceof LockHeldError)) throw e;
    console.error(
      `devkit ${command}: another devkit init/upgrade is running in ${gitRoot} (pid ${e.holderPid ?? 'unknown'}) — rerun after it finishes. If that process is gone, delete ${lock}.`,
    );
    return 1;
  } finally {
    // Outside git the lock's parent is .devkit: a run that wrote nothing leaves no empty one behind.
    if (heldOnlyOurLock) removeIfEmpty(lockParent);
  }
}

/** rmdir, not rm -r: succeeds only while the directory is still empty. */
function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // written into, or already gone — either way nothing to undo
  }
}

/**
 * Wrap a command entry point in the init lock. `--dry-run` writes nothing, so it never contends:
 * previewing a change while another run applies one stays possible.
 */
export function lockedCommand(
  command: 'init' | 'upgrade',
  run: (args: string[], cwd: string) => Promise<number>,
): (args: string[], cwd: string) => Promise<number> {
  return (args, cwd) =>
    args.includes('--dry-run') ? run(args, cwd) : withInitLock(cwd, command, () => run(args, cwd));
}
