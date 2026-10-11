import { spawnSync } from 'node:child_process';

export function git(...args) {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`${args[0]} failed: ${run.stderr?.trim()}`);
  return run.stdout.trim();
}
