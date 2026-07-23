import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BACKSLASH = /\\/g;
const LEADING_SLASHES = /^\/+/;
const TRAILING_SLASHES = /\/+$/;
const SCP_REMOTE = /^(?:[^/@:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const WINDOWS_UNC_PATH = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;
const BRANCH_OID_HEADER = '# branch.oid ';
const BRANCH_HEAD_HEADER = '# branch.head ';

export interface PlanCritiqueRepositoryContext {
  fingerprint: string;
  fingerprintSource: 'canonical_remote' | 'local_path';
  branch: string;
  head: string;
  gitDir: string;
  gitCommonDir: string;
}

export type PlanCritiqueRepositoryContextResult =
  | { status: 'available'; context: PlanCritiqueRepositoryContext }
  | {
      status: 'unavailable';
      reason: 'not_a_repository' | 'detached_worktree';
    };

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
}

function gitOutput(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: gitEnvironment(),
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

function absoluteGitPath(cwd: string, value: string): string {
  return realpathSync(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function withoutGitSuffix(value: string): string {
  return value.toLowerCase().endsWith('.git') ? value.slice(0, -4) : value;
}

function canonicalRepositoryPath(value: string): string | null {
  const normalized = value
    .replace(BACKSLASH, '/')
    .replace(LEADING_SLASHES, '')
    .replace(TRAILING_SLASHES, '');
  if (!normalized) return null;
  return withoutGitSuffix(normalized);
}

const isWindowsPath = (value: string, platform: NodeJS.Platform): boolean =>
  platform === 'win32' && (WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value));

function localRemoteIdentity(
  value: string,
  repositoryCwd: string,
  platform: NodeJS.Platform,
): string | null {
  if (isWindowsPath(value, platform)) {
    const windowsPath = withoutGitSuffix(path.win32.normalize(value)).replace(BACKSLASH, '/');
    return JSON.stringify(['local_remote', 'windows', windowsPath]);
  }
  const absolute = withoutGitSuffix(path.normalize(path.resolve(repositoryCwd, value)));
  return absolute ? JSON.stringify(['local_remote', 'posix', pathToFileURL(absolute).href]) : null;
}

function networkRemoteIdentity(
  host: string,
  pathKind: 'absolute' | 'home_relative',
  repositoryPath: string,
): string {
  return JSON.stringify(['network_remote', host.toLowerCase(), pathKind, repositoryPath]);
}

function remoteIdentity(
  value: string,
  repositoryCwd: string,
  platform: NodeJS.Platform,
): string | null {
  const remote = value.trim();
  if (!remote || [...remote].some((character) => character.charCodeAt(0) < 0x20)) return null;
  if (isWindowsPath(remote, platform)) return localRemoteIdentity(remote, repositoryCwd, platform);
  const scp = SCP_REMOTE.exec(remote);
  if (scp && !remote.includes('://')) {
    const repositoryPath = canonicalRepositoryPath(scp[2]);
    const pathKind = scp[2].startsWith('/') ? 'absolute' : 'home_relative';
    return repositoryPath ? networkRemoteIdentity(scp[1], pathKind, repositoryPath) : null;
  }
  try {
    const remoteUrl = new URL(remote);
    if (remoteUrl.protocol === 'file:') {
      try {
        return localRemoteIdentity(fileURLToPath(remoteUrl), repositoryCwd, platform);
      } catch {
        return null;
      }
    }
    if (!remoteUrl.hostname) return null;
    remoteUrl.username = '';
    remoteUrl.password = '';
    remoteUrl.search = '';
    remoteUrl.hash = '';
    const repositoryPath = canonicalRepositoryPath(remoteUrl.pathname);
    return repositoryPath
      ? networkRemoteIdentity(remoteUrl.host, 'absolute', repositoryPath)
      : null;
  } catch {
    if (remote.includes('@')) return null;
    return localRemoteIdentity(remote, repositoryCwd, platform);
  }
}

type BranchSnapshot = { branch: string | null; head: string };

function branchSnapshot(cwd: string): BranchSnapshot | null {
  const status = gitOutput(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=no']);
  if (status === null) return null;
  const lines = status.split('\n');
  const oid = lines
    .find((line) => line.startsWith(BRANCH_OID_HEADER))
    ?.slice(BRANCH_OID_HEADER.length);
  const branchHead = lines
    .find((line) => line.startsWith(BRANCH_HEAD_HEADER))
    ?.slice(BRANCH_HEAD_HEADER.length);
  if (!oid || !GIT_OBJECT_ID.test(oid) || !branchHead) return null;
  const symbolicBranch = gitOutput(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branchHead === '(detached)' && symbolicBranch === null) return { branch: null, head: oid };
  return symbolicBranch === branchHead ? { branch: branchHead, head: oid } : null;
}

function sameBranchSnapshot(left: BranchSnapshot, right: BranchSnapshot): boolean {
  return left.branch === right.branch && left.head === right.head;
}

export function getPlanCritiqueRepositoryContext(
  cwd = process.cwd(),
  runtimePlatform: NodeJS.Platform = process.platform,
): PlanCritiqueRepositoryContextResult {
  try {
    const resolvedCwd = path.resolve(cwd);
    if (gitOutput(resolvedCwd, ['rev-parse', '--is-inside-work-tree']) !== 'true')
      return { status: 'unavailable', reason: 'not_a_repository' };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = branchSnapshot(resolvedCwd);
      if (!before) continue;
      const gitDirValue = gitOutput(resolvedCwd, ['rev-parse', '--absolute-git-dir']);
      const commonDirValue = gitOutput(resolvedCwd, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      const repositoryCwdValue = gitOutput(resolvedCwd, ['rev-parse', '--show-toplevel']);
      if (!gitDirValue || !commonDirValue || !repositoryCwdValue)
        return { status: 'unavailable', reason: 'not_a_repository' };
      const gitDir = absoluteGitPath(resolvedCwd, gitDirValue);
      const gitCommonDir = absoluteGitPath(resolvedCwd, commonDirValue);
      const repositoryCwd = absoluteGitPath(resolvedCwd, repositoryCwdValue);
      const remote = gitOutput(resolvedCwd, ['config', '--get', 'remote.origin.url']);
      const canonicalRemote = remote
        ? remoteIdentity(remote, repositoryCwd, runtimePlatform)
        : null;
      const after = branchSnapshot(resolvedCwd);
      if (!after || !sameBranchSnapshot(before, after)) continue;
      if (!after.branch) return { status: 'unavailable', reason: 'detached_worktree' };
      return {
        status: 'available',
        context: {
          fingerprint: sha256(canonicalRemote ?? gitCommonDir),
          fingerprintSource: canonicalRemote ? 'canonical_remote' : 'local_path',
          branch: after.branch,
          head: after.head,
          gitDir,
          gitCommonDir,
        },
      };
    }
    return { status: 'unavailable', reason: 'not_a_repository' };
  } catch {
    return { status: 'unavailable', reason: 'not_a_repository' };
  }
}

export function isPlanCritiqueAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync(
    'git',
    ['-C', cwd, 'merge-base', '--is-ancestor', ancestor, descendant],
    {
      env: gitEnvironment(),
      stdio: 'ignore',
      timeout: 5_000,
    },
  );
  return result.status === 0;
}
