import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detectGitRoot } from '../detect-git-root.mts';
import { packageDir } from '../fs-helpers.mts';
import { shellQuote } from './dist-integrity.mts';

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

function git(root: string, args: string[], input?: string): GitResult {
  // --no-optional-locks: status must not rewrite the index in a checkout other agents share.
  const result = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8',
    input,
  });
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

// Explicit-path ships commit working-tree bytes. `status` + blob hashes, because `git diff <rev>`
// rewrites the shared index even under --no-optional-locks.
function uncommittedShipChanges(root: string, release: string): boolean | undefined {
  const status = git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
    '--',
    ...PACKAGED_SHIP_PATHS,
  ]);
  if (status.status !== 0) return undefined;
  const entries = status.stdout.split('\0').filter(Boolean);
  if (entries.some((entry) => entry.startsWith('??'))) return true;
  const paths = entries.map((entry) => entry.slice(3));
  if (paths.length === 0) return false;

  const tree = git(root, ['ls-tree', '-r', '-z', release, '--', ...paths]);
  if (tree.status !== 0) return undefined;
  const releaseBlobs = new Map<string, string>();
  for (const record of tree.stdout.split('\0').filter(Boolean)) {
    const [meta, path] = record.split('\t');
    releaseBlobs.set(path, meta.split(' ')[2]);
  }
  const present: string[] = [];
  for (const path of paths) {
    if (existsSync(join(root, path))) present.push(path);
    else if (releaseBlobs.has(path)) return true;
  }
  if (present.length === 0) return false;
  const hashed = git(root, ['hash-object', '--stdin-paths'], `${present.join('\n')}\n`);
  if (hashed.status !== 0) return undefined;
  const hashes = hashed.stdout.split('\n').filter(Boolean);
  return present.some((path, index) => releaseBlobs.get(path) !== hashes[index]);
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

  const readHead = (): string | undefined => {
    const result = git(repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      'HEAD^{commit}',
    ]);
    const head = result.stdout.trim();
    return result.status === 0 && head ? head : undefined;
  };

  try {
    let head = readHead();
    if (!head) {
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

    // Explicit-path ships commit working-tree bytes, so an uncommitted ship edit is skew too — but only
    // when it differs from the release, not merely from HEAD.
    const uncommitted = uncommittedShipChanges(repoRoot, release);
    if (uncommitted === undefined) {
      unavailable(`could not compare the packaged ship working tree with ${tagName}`);
      return;
    }

    // Re-read after that live status: a concurrent commit in this shared checkout must surface as
    // committed skew, never disappear from both halves.
    head = readHead();
    if (!head) {
      unavailable('repository HEAD is unavailable');
      return;
    }

    let commits: string[] = [];
    if (release !== head) {
      const releaseBeforeHead = git(repoRoot, ['merge-base', '--is-ancestor', release, head]);
      if (releaseBeforeHead.status !== 0) {
        const headBeforeRelease = git(repoRoot, ['merge-base', '--is-ancestor', head, release]);
        if (headBeforeRelease.status !== 0) {
          if (releaseBeforeHead.status === 1 && headBeforeRelease.status === 1) {
            unavailable(`release tag ${tagName} and committed HEAD have divergent histories`);
          } else {
            unavailable(`could not compare release tag ${tagName} with committed HEAD`);
          }
          return;
        }
        write(
          `devkit ship: committed HEAD ${head.slice(0, 8)} is behind installed ${tagName}; no newer packaged ship runtime to report`,
        );
      } else {
        const diff = git(repoRoot, [
          'diff',
          '--quiet',
          release,
          head,
          '--',
          ...PACKAGED_SHIP_PATHS,
        ]);
        if (diff.status !== 0 && diff.status !== 1) {
          unavailable(`could not compare packaged ship runtime with ${tagName}`);
          return;
        }
        if (diff.status === 1) {
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
          commits = shortlogLines(log.stdout);
        }
      }
    }
    if (commits.length === 0 && !uncommitted) return;

    if (commits.length > 0) {
      const noun = commits.length === 1 ? 'commit' : 'commits';
      write(
        `⚠️  devkit ship: committed HEAD has ${commits.length} packaged ship ${noun} not in installed ${tagName}:`,
      );
      for (const line of commits.slice(0, SHORTLOG_LIMIT)) write(`   ${line}`);
      if (commits.length > SHORTLOG_LIMIT) {
        write(`   … and ${commits.length - SHORTLOG_LIMIT} more`);
      }
    }
    if (uncommitted) {
      write(
        `⚠️  devkit ship: working tree has uncommitted packaged ship changes not in installed ${tagName}`,
      );
    }
    write(
      `   the packaged ship orchestration and preflights below are the installed build's, not this working tree's; self-host commit gates still execute from the prepared worktree`,
    );
    write(
      `   to run this checkout's ship instead, re-run with the same arguments: node ${shellQuote(printable(join(repoRoot, 'cli', 'index.mts')))} ship …`,
    );
    write(
      `   (run bun install first and re-pipe any stdin body; it executes the checkout's on-disk scripts, so concurrent edits there change the run)`,
    );
  } catch (cause) {
    const detail = cause instanceof Error ? printable(cause.message) : 'unexpected local Git error';
    unavailable(detail);
  }
}
