/** Stable Git-index/ref locking for baseline writes derived from inspected trees. */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const MAX_GIT_OUTPUT = 128 * 1024 * 1024;
const GIT_LOCK_WAIT_MS = 5_000;
const GIT_LOCK_RETRY_MS = 25;
const GIT_LOCK_RELEASE_ATTEMPTS = 3;
const GIT_LOCK_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export interface GitLayout {
  root: string;
  prefix: string;
}

interface HeldGitLock {
  path: string;
  tokenPath: string;
}

export interface GitLockReleaseOperations {
  removeToken(path: string): void;
  removeDirectory(path: string): void;
}

const GIT_LOCK_RELEASE_OPERATIONS: GitLockReleaseOperations = {
  removeToken: (path) => rmSync(path, { force: true }),
  removeDirectory: (path) => rmdirSync(path),
};

export interface GitHeadIdentity {
  oid: string | null;
  symbolicRef: string | null;
}

export interface GitBaseIdentity {
  expression: string;
  oid: string | null;
  symbolicRef: string | null;
}

export function git(cwd: string, args: readonly string[]): string {
  const output = execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

export function layout(cwd: string): GitLayout {
  return {
    root: git(cwd, ['rev-parse', '--show-toplevel']),
    prefix: git(cwd, ['rev-parse', '--show-prefix']),
  };
}

function throwGitProbeFailure(
  message: string,
  result: { error?: Error; status: number | null; stderr: string },
): never {
  const detail =
    result.error?.message || result.stderr.trim() || `exit status ${String(result.status)}`;
  throw new Error(`anti-slop: ${message}: ${detail}`);
}

export function resolveRef(root: string, ref: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 1) return null;
  return throwGitProbeFailure(`could not resolve Git ref ${ref} safely`, result);
}

export function symbolicHead(root: string): string | null {
  const result = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 1) return null;
  return throwGitProbeFailure('could not determine symbolic Git HEAD safely', result);
}

const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function bestEffort(action: () => void): void {
  try {
    action();
  } catch {
    return;
  }
}

function acquireGitLock(path: string): HeldGitLock {
  mkdirSync(dirname(path), { recursive: true });
  const stamp = `${process.pid}-${randomUUID()}`;
  const tokenPath = join(path, stamp);
  const deadline = Date.now() + GIT_LOCK_WAIT_MS;
  let held = false;
  while (Date.now() <= deadline) {
    try {
      mkdirSync(path, { mode: 0o700 });
      held = true;
      break;
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      sleepSync(GIT_LOCK_RETRY_MS);
    }
  }
  if (!held) {
    throw new Error(
      `anti-slop: Git lock is busy at ${path}; baseline unchanged; retry after the Git operation finishes or remove a proven-stale lock`,
    );
  }
  try {
    writeFileSync(tokenPath, stamp, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error: unknown) {
    bestEffort(() => rmSync(tokenPath, { force: true }));
    bestEffort(() => rmdirSync(path));
    throw error;
  }
  return { path, tokenPath };
}

function releaseGitLock(lock: HeldGitLock, operations: GitLockReleaseOperations): void {
  try {
    operations.removeToken(lock.tokenPath);
  } catch (error: unknown) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'ENOTDIR'].includes(String(error.code))
      )
    ) {
      throw error;
    }
  }
  try {
    operations.removeDirectory(lock.path);
  } catch (error: unknown) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'ENOTDIR', 'ENOTEMPTY'].includes(String(error.code))
      )
    ) {
      throw error;
    }
  }
}

/** Stabilize Git's HEAD, active ref, and index while applying a write derived from their trees. */
export function withStableGitIndex<T>(
  cwd: string,
  expectedHead: GitHeadIdentity,
  expectedBase: GitBaseIdentity | null,
  expectedCandidateTree: string,
  action: () => T,
  releaseOperations: GitLockReleaseOperations = GIT_LOCK_RELEASE_OPERATIONS,
): T {
  const repo = layout(cwd);
  const gitPath = (path: string) =>
    git(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', path]);
  const lockPaths = [
    ...new Set([
      `${gitPath('HEAD')}.lock`,
      ...(expectedHead.symbolicRef ? [`${gitPath(expectedHead.symbolicRef)}.lock`] : []),
      ...(expectedBase?.symbolicRef ? [`${gitPath(expectedBase.symbolicRef)}.lock`] : []),
      `${gitPath('index')}.lock`,
    ]),
  ];
  const held: HeldGitLock[] = [];
  const releaseHeld = (suppressErrors = false) => {
    let firstError: unknown;
    for (let index = held.length - 1; index >= 0; index -= 1) {
      const lock = held[index];
      for (let attempt = 1; attempt <= GIT_LOCK_RELEASE_ATTEMPTS; attempt += 1) {
        try {
          releaseGitLock(lock, releaseOperations);
          held.splice(index, 1);
          break;
        } catch (error: unknown) {
          if (attempt === GIT_LOCK_RELEASE_ATTEMPTS) {
            firstError ??= error;
          } else {
            sleepSync(GIT_LOCK_RETRY_MS);
          }
        }
      }
    }
    if (firstError && !suppressErrors) throw firstError;
  };
  const exitHandler = () => releaseHeld(true);
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let pendingSignal: NodeJS.Signals | null = null;
  process.once('exit', exitHandler);
  for (const signal of GIT_LOCK_SIGNALS) {
    const handler = () => {
      pendingSignal ??= signal;
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  let temp: string | null = null;
  try {
    for (const path of lockPaths) held.push(acquireGitLock(path));
    const currentHead = {
      oid: resolveRef(repo.root, 'HEAD'),
      symbolicRef: symbolicHead(repo.root),
    };
    if (
      currentHead.oid !== expectedHead.oid ||
      currentHead.symbolicRef !== expectedHead.symbolicRef
    ) {
      throw new Error(
        'anti-slop: Git HEAD changed while staged renames were being read; baseline unchanged; retry',
      );
    }
    if (expectedBase && resolveRef(repo.root, expectedBase.expression) !== expectedBase.oid) {
      throw new Error(
        'anti-slop: Git base changed while rename evidence was being read; baseline unchanged; retry',
      );
    }
    temp = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-index-lock-'));
    const snapshotIndex = join(temp, 'index');
    copyFileSync(gitPath('index'), snapshotIndex);
    const currentTree = execFileSync('git', ['write-tree'], {
      cwd: repo.root,
      encoding: 'utf8',
      env: { ...process.env, GIT_INDEX_FILE: snapshotIndex },
      maxBuffer: MAX_GIT_OUTPUT,
    }).trim();
    if (currentTree !== expectedCandidateTree) {
      throw new Error(
        'anti-slop: Git index changed while staged renames were being read; baseline unchanged; retry',
      );
    }
    return action();
  } finally {
    try {
      if (temp) rmSync(temp, { recursive: true, force: true });
    } finally {
      try {
        releaseHeld();
      } finally {
        for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
        if (held.length === 0) process.removeListener('exit', exitHandler);
        if (pendingSignal) process.kill(process.pid, pendingSignal);
      }
    }
  }
}
