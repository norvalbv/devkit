// The index the pending commit is built from (`commit -a`, `commit -- <path>`, an alternate index).
// Why a carrier instead of GIT_INDEX_FILE: docs/decisions/gates-judge-commit-index.md.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { withoutGitEnv } from '../judge/judge-isolation.mts';

export const COMMIT_INDEX_FILE_VAR = 'DEVKIT_COMMIT_INDEX_FILE';
export const COMMIT_GIT_DIR_VAR = 'DEVKIT_COMMIT_GIT_DIR';

// lock: `commit -a`/`-i`, writes land; partial: `commit -- <path>`, writes are lost from the index.
export type CommitIndexKind = 'default' | 'lock' | 'partial' | 'alternate';

const PARTIAL_INDEX_RE = /^next-index-\d+\.lock$/;
const gitDirs = new Map<string, string | null>();

function canonical(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function gitDirOf(root: string): string | null {
  const key = resolve(root);
  const cached = gitDirs.get(key);
  if (cached !== undefined) return cached;
  let gitDir: string | null = null;
  try {
    gitDir = canonical(
      execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
        cwd: key,
        encoding: 'utf8',
        env: withoutGitEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
      }).replace(/\n$/, ''),
    );
  } catch {
    gitDir = null;
  }
  gitDirs.set(key, gitDir);
  return gitDir;
}

/** The commit's index path when the carrier was exported by `root`'s own repository, else null. */
export function commitIndexFile(
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): string | null {
  const carrier = base[COMMIT_INDEX_FILE_VAR];
  const carrierGitDir = base[COMMIT_GIT_DIR_VAR];
  if (!carrier || !carrierGitDir) return null;
  const own = gitDirOf(root);
  if (!own || own !== canonical(carrierGitDir)) return null;
  return carrier;
}

/** `base` with GIT_INDEX_FILE aimed at the commit's index; an explicit GIT_INDEX_FILE always wins. */
export function commitIndexEnv(
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (base.GIT_INDEX_FILE) return base;
  const index = commitIndexFile(root, base);
  return index ? { ...base, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' } : base;
}

export type CommitIndexTree = { tree: string } | { tree: null; error: string };

type GitRun = { ok: true; out: string } | { ok: false; error: string };

function runGit(root: string, args: string[], env: NodeJS.ProcessEnv): GitRun {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  if (result.status === 0) return { ok: true, out: result.stdout.replace(/\n$/, '') };
  const reason = result.stderr.trim() || result.error?.message || `exit ${result.status}`;
  return { ok: false, error: `git ${args[0]}: ${reason}` };
}

/** The commit index's tree, hashed from a private copy: write-tree locks its index, and parallel gates
 * racing that lock failed (sc-3312, gates-judge-commit-index). */
export function commitIndexTree(
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): CommitIndexTree {
  const env = commitIndexEnv(root, base);
  let temp: string | null = null;
  try {
    const located = runGit(root, ['rev-parse', '--git-path', 'index'], env);
    if (!located.ok) return { tree: null, error: located.error };
    const index = resolve(root, located.out);
    temp = mkdtempSync(join(tmpdir(), 'devkit-tree-index-'));
    const copy = join(temp, 'index');
    const configs = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
    const slot = Number.isSafeInteger(configs) && configs > 0 ? configs : 0;
    // Unsplit, so the write lands in the copy alone and never adds a sharedindex.* to the git dir.
    // Env, not `-c`: argv stays `write-tree`, the shape wrappers and shims match on.
    const copyEnv = {
      ...env,
      GIT_INDEX_FILE: copy,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_COUNT: String(slot + 1),
      [`GIT_CONFIG_KEY_${slot}`]: 'core.splitIndex',
      [`GIT_CONFIG_VALUE_${slot}`]: 'false',
    };
    if (existsSync(index)) copyFileSync(index, copy);
    else {
      const empty = runGit(root, ['read-tree', '--empty'], copyEnv);
      if (!empty.ok) return { tree: null, error: empty.error };
    }
    const written = runGit(root, ['write-tree'], copyEnv);
    if (!written.ok) return { tree: null, error: written.error };
    return written.out ? { tree: written.out } : { tree: null, error: 'git write-tree: no tree' };
  } catch (error) {
    // mkdtemp/copy only: every git failure above returns its own stderr.
    return { tree: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      if (temp) rmSync(temp, { recursive: true, force: true });
    } catch {
      // A leaked scratch dir costs disk, never the verdict: callers rely on this never throwing.
    }
  }
}

// Classifies the index commitIndexEnv resolves to: a caller-chosen GIT_INDEX_FILE is theirs, not git's.
export function commitIndexKind(
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): CommitIndexKind {
  if (base.GIT_INDEX_FILE) return 'default';
  const index = commitIndexFile(root, base);
  if (!index) return 'default';
  if (canonical(dirname(index)) !== gitDirOf(root)) return 'alternate';
  const name = basename(index);
  if (name === 'index.lock') return 'lock';
  if (PARTIAL_INDEX_RE.test(name)) return 'partial';
  return 'alternate';
}

/** Test seam: forget memoized git dirs (a test re-initialises a repository at the same path). */
export function resetCommitIndexCache(): void {
  gitDirs.clear();
}
