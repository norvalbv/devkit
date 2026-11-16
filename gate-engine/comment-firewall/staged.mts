/** Staged-diff git plumbing shared by the comment detector and the moved-comment pool. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { commitIndexEnv } from '../ratchets/commit-index.mts';
import {
  gitPrefix,
  nameStatusRecords,
  type Renames,
  renamesFrom,
  splitNul,
} from '../ratchets/git-index.mts';

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    env: commitIndexEnv(cwd),
    encoding: 'utf8',
    input,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

export function stagedPaths(cwd: string, ref?: string): Set<string> {
  const args = [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--relative',
    '--diff-filter=ACMR',
    '--no-ext-diff',
  ];
  if (ref) args.push(ref);
  return new Set(splitNul(git(cwd, args)));
}

/** Staged renames keyed by cwd-relative new path. `--relative` would drop a source outside the cwd
 * before git pairs it, so pairing runs repo-wide and `from` comes back cwd-relative (maybe `../`). */
export function stagedRenames(cwd: string, ref?: string): Renames {
  const args = [
    'diff',
    '--cached',
    '--name-status',
    '-z',
    '--no-relative',
    '--find-renames',
    '--diff-filter=R',
    '--no-ext-diff',
  ];
  if (ref) args.push(ref);
  const prefix = gitPrefix(cwd);
  const renamed: Renames = new Map();
  for (const [newPath, { from, pure }] of renamesFrom(nameStatusRecords(git(cwd, args)))) {
    if (!newPath.startsWith(prefix)) continue;
    renamed.set(newPath.slice(prefix.length), { from: path.posix.relative(prefix, from), pure });
  }
  return renamed;
}

export function patch(cwd: string, file: string, ref?: string, from?: string): string {
  const args = [
    '--literal-pathspecs',
    'diff',
    '--cached',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    '--unified=4',
    '--no-relative',
    '--diff-filter=ACMR',
  ];
  if (ref) args.push(ref);
  args.push('--', ...(from ? [from, file] : [file]));
  return git(cwd, args);
}
