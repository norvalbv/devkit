/** Staged-diff git plumbing shared by the comment detector and the moved-comment pool. */
import { execFileSync } from 'node:child_process';
import { commitIndexEnv } from '../ratchets/commit-index.mts';

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: commitIndexEnv(cwd),
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function splitNul(value: string): string[] {
  return value.split('\0').filter(Boolean);
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

export type Renames = Map<string, { from: string; pure: boolean }>;

/** Staged renames keyed by new path, so a moved file is diffed against its pre-move blob. */
export function stagedRenames(cwd: string, ref?: string): Renames {
  const args = [
    'diff',
    '--cached',
    '--name-status',
    '-z',
    '--relative',
    '--find-renames',
    '--diff-filter=R',
    '--no-ext-diff',
  ];
  if (ref) args.push(ref);
  const fields = splitNul(git(cwd, args));
  const renamed: Renames = new Map();
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    const from = fields[i++];
    const newPath = fields[i++];
    if (from && newPath) renamed.set(newPath, { from, pure: status === 'R100' });
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
    '--relative',
    '--diff-filter=ACMR',
  ];
  if (ref) args.push(ref);
  args.push('--', ...(from ? [from, file] : [file]));
  return git(cwd, args);
}
