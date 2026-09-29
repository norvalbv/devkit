/** Hook-free, bounded git spawns for the repository-state capture; failures name what was read. */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { errorMessage, fail, gitEnvironment } from '../shared/common.mts';

export const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export function spawnGit(root: string, args: string[]): SpawnSyncReturns<Buffer> {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    env: gitEnvironment(),
    maxBuffer: MAX_GIT_OUTPUT,
  });
}

export function gitFailure(label: string, result: SpawnSyncReturns<Buffer>): never {
  if (result.error) fail(`could not ${label} (${errorMessage(result.error)}).`);
  const detail = result.stderr.toString().trim();
  fail(`could not ${label} (git exited ${String(result.status)}${detail ? `: ${detail}` : ''}).`);
}

export function gitRaw(root: string, args: string[], label: string): Buffer {
  const result = spawnGit(root, args);
  if (result.status !== 0) gitFailure(label, result);
  return result.stdout;
}

export function gitOptionalRaw(root: string, args: string[], label: string): Buffer {
  const result = spawnGit(root, args);
  if (result.status === 0) return result.stdout;
  if (result.status === 1 && result.stdout.length === 0 && result.stderr.length === 0)
    return Buffer.alloc(0);
  return gitFailure(label, result);
}

export function gitLine(root: string, args: string[], label: string): Buffer {
  const raw = gitRaw(root, args, label);
  if (raw.length === 0 || raw[raw.length - 1] !== 0x0a) fail(`${label} returned malformed output.`);
  return raw.subarray(0, -1);
}
