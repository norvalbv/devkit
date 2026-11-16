// codex injects $CODEX_HOME/AGENTS.md into every prompt and no flag turns that off, so a judge runs
// in a devkit-owned home that shares only the owner's auth.json.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Absolute and symlink-free, as codex canonicalizes CODEX_HOME; a missing path is only resolved. */
function canonical(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * Persistent, not per-spawn: a tmpdir home is writable from a workspace-write judge's shell.
 *
 * auth.json is a symlink because codex rewrites it in place; a copy forks the refresh token.
 */
export function ensureCodexJudgeHome(env: NodeJS.ProcessEnv): string {
  const home = join(homedir(), '.devkit', 'codex-judge-home');
  mkdirSync(home, { recursive: true });
  const owner = canonical(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'));
  if (owner === canonical(home)) return home;
  const link = join(home, 'auth.json');
  const target = join(owner, 'auth.json');
  const stat = lstatSync(link, { throwIfNoEntry: false });
  // A regular file here came from a `codex login` run in this home: it may hold the freshest token.
  if (stat && (!stat.isSymbolicLink() || readlinkSync(link) === target)) return home;
  const tmp = `${link}.${randomUUID()}`;
  symlinkSync(target, tmp);
  renameSync(tmp, link);
  return home;
}
