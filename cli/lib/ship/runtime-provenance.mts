import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detectGitRoot } from '../detect-git-root.mts';
import { packageDir } from '../fs-helpers.mts';

const DEVKIT_PACKAGE = '@norvalbv/devkit';
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const PACKAGED_SHIP_PATHS = ['cli/commands/ship.mts', 'cli/lib/ship'] as const;
const SHORTLOG_LIMIT = 5;

export interface ShipRuntimeIdentity {
  packageRoot: string;
  version?: string;
}

interface GitResult {
  status: number;
  stdout: string;
}

type JsonValue = JsonObject | JsonValue[] | boolean | number | string | null;

interface JsonObject {
  [key: string]: JsonValue;
}

interface PackageManifest {
  name?: JsonValue;
  version?: string;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === '[object String]';
}

function parsePackageManifest(raw: string): PackageManifest | null {
  const value: JsonValue = JSON.parse(raw);
  if (!isJsonObject(value)) return null;
  return {
    name: value.name,
    version: isJsonString(value.version) ? value.version : undefined,
  };
}

function printable(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159) ? '?' : character;
    })
    .join('');
}

export function readShipRuntimeIdentity(packageRoot = packageDir()): ShipRuntimeIdentity {
  try {
    const manifest = parsePackageManifest(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    return {
      packageRoot,
      version: manifest?.version,
    };
  } catch {
    return { packageRoot };
  }
}

function git(root: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status ?? 2, stdout: result.stdout ?? '' };
}

function committedDevkitSelfHost(root: string, head: string): boolean | undefined {
  const entry = git(root, ['ls-tree', '--name-only', head, '--', 'package.json']);
  if (entry.status !== 0) return undefined;
  if (entry.stdout.trim() !== 'package.json') return false;
  const manifest = git(root, ['show', `${head}:package.json`]);
  if (manifest.status !== 0) return undefined;
  try {
    const parsed = parsePackageManifest(manifest.stdout);
    return parsed?.name === DEVKIT_PACKAGE;
  } catch {
    return undefined;
  }
}

function shortlogLines(raw: string): string[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, ...subject] = line.split('\t');
      return `${printable(hash)} ${printable(subject.join(' '))}`.trim();
    });
}

export function reportShipRuntimeProvenance(
  cwd: string,
  identity: ShipRuntimeIdentity = readShipRuntimeIdentity(),
  write: (line: string) => void = (line) => console.error(line),
): void {
  const packageRoot = canonicalPath(identity.packageRoot);
  const versionLabel = identity.version ? `v${printable(identity.version)}` : 'version unknown';
  write(`devkit ship: executing ${DEVKIT_PACKAGE} ${versionLabel} from ${printable(packageRoot)}`);

  const { gitRoot } = detectGitRoot(cwd);
  const repoRoot = canonicalPath(gitRoot);
  if (repoRoot === packageRoot) return;

  const unavailable = (reason: string): void => {
    write(
      `⚠️  devkit ship: skew check unavailable: ${reason}; continuing with the installed build`,
    );
  };

  try {
    const headResult = git(repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'HEAD^{commit}',
    ]);
    const head = headResult.stdout.trim();
    if (headResult.status !== 0 || !head) {
      unavailable('repository HEAD is unavailable');
      return;
    }

    const selfHost = committedDevkitSelfHost(repoRoot, head);
    if (selfHost === false) return;
    if (selfHost === undefined) {
      unavailable('could not determine whether committed HEAD is Devkit self-host');
      return;
    }

    const version = identity.version;
    if (!version || !RELEASE_VERSION.test(version)) {
      unavailable('running package version is unavailable');
      return;
    }

    const tagName = `v${version}`;
    const tagResult = git(repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `refs/tags/${tagName}^{commit}`,
    ]);
    const release = tagResult.stdout.trim();
    if (tagResult.status !== 0 || !release) {
      unavailable(`release tag ${tagName} is unavailable`);
      return;
    }

    if (release === head) return;
    const releaseBeforeHead = git(repoRoot, ['merge-base', '--is-ancestor', release, head]);
    if (releaseBeforeHead.status !== 0) {
      const headBeforeRelease = git(repoRoot, ['merge-base', '--is-ancestor', head, release]);
      if (headBeforeRelease.status === 0) {
        write(
          `devkit ship: committed HEAD ${head.slice(0, 8)} is behind installed ${tagName}; no newer packaged ship runtime to report`,
        );
        return;
      }
      if (releaseBeforeHead.status === 1 && headBeforeRelease.status === 1) {
        unavailable(`release tag ${tagName} and committed HEAD have divergent histories`);
      } else {
        unavailable(`could not compare release tag ${tagName} with committed HEAD`);
      }
      return;
    }

    const diff = git(repoRoot, ['diff', '--quiet', release, head, '--', ...PACKAGED_SHIP_PATHS]);
    if (diff.status === 0) return;
    if (diff.status !== 1) {
      unavailable(`could not compare packaged ship runtime with ${tagName}`);
      return;
    }

    const log = git(repoRoot, [
      'log',
      '--format=%h%x09%s',
      `${release}..${head}`,
      '--',
      ...PACKAGED_SHIP_PATHS,
    ]);
    if (log.status !== 0) {
      unavailable(`could not read packaged ship history after ${tagName}`);
      return;
    }
    const commits = shortlogLines(log.stdout);
    const noun = commits.length === 1 ? 'commit' : 'commits';
    write(
      `⚠️  devkit ship: committed HEAD has ${commits.length} packaged ship ${noun} not in installed ${tagName}:`,
    );
    for (const line of commits.slice(0, SHORTLOG_LIMIT)) write(`   ${line}`);
    if (commits.length > SHORTLOG_LIMIT) {
      write(`   … and ${commits.length - SHORTLOG_LIMIT} more`);
    }
    write(
      `   the packaged ship orchestration and preflights below are the installed build's, not this working tree's; self-host commit gates still execute from the prepared worktree`,
    );
  } catch (cause) {
    const detail = cause instanceof Error ? printable(cause.message) : 'unexpected local Git error';
    unavailable(detail);
  }
}
