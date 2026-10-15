import { join } from 'node:path';
import { testExecFileSync } from './_helpers.mts';

/**
 * A main checkout plus a linked worktree of it: the project-config-root layout, where a hook gets
 * CLAUDE_PROJECT_DIR = `main` while its stdin `cwd` is the `worktree` the agent is working in.
 */
export function mainWithWorktree(mkTmp: (prefix: string) => string) {
  const main = mkTmp('cfg-root-main-');
  const worktree = join(mkTmp('cfg-root-wt-'), 'wt');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...args: string[]) =>
    testExecFileSync('git', ['-C', main, ...args], { env, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('worktree', 'add', '-q', '--detach', worktree);
  return { main, worktree };
}
