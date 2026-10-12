import { spawnSync } from 'node:child_process';

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' }).stdout?.trim() ?? '';

/** Paths changed on this branch since it left the base. */
export function branchPaths(base = 'main') {
  return git('diff', '--name-only', `origin/${base}...HEAD`).split('\n').filter(Boolean);
}

/** Has origin/<base> moved, and does what moved overlap `paths`? */
export function baseStatus(paths, base = 'main') {
  const mergeBase = git('merge-base', 'HEAD', `origin/${base}`);
  const moved = git('diff', '--name-only', mergeBase, `origin/${base}`).split('\n').filter(Boolean);
  const overlap = moved.filter((p) => paths.includes(p));
  return { base, baseSha: git('rev-parse', `origin/${base}`), moved: moved.length, overlap };
}
