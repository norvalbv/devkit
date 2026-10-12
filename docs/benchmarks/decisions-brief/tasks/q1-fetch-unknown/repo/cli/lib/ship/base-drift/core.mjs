import { git as realGit } from './git.mjs';

/**
 * Has origin/<base> moved, and does what moved overlap `paths`?
 *
 * @param {string[]} paths  the caller's working set
 * @param {{ base?: string, git?: (...args: string[]) => string }} [options]
 * @returns {{ freshness: 'fresh' | 'stale', overlap: string[] }}
 *   'fresh' — origin/<base> has not moved past our merge-base; 'stale' — it has.
 */
export function baseStatus(paths, { base = 'main', git = realGit } = {}) {
  git('fetch', 'origin', base);
  const mergeBase = git('merge-base', 'HEAD', `origin/${base}`);
  const moved = git('diff', '--name-only', mergeBase, `origin/${base}`).split('\n').filter(Boolean);
  return {
    freshness: moved.length ? 'stale' : 'fresh',
    overlap: moved.filter((p) => paths.includes(p)),
  };
}
