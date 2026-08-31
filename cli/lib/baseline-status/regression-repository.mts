import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digest } from '../fs-helpers.mts';
import { reviewRepositoryConfigFingerprint } from '../ship/review/repository/state.mts';
import { gitEnvironment } from '../ship/review/shared/common.mts';

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_FINGERPRINT_FILE_BYTES = 8 * 1024 * 1024;
const regressionGitEnvironment = (): NodeJS.ProcessEnv =>
  gitEnvironment({ GIT_LITERAL_PATHSPECS: '1' });

export interface RegressionCaptureArgs {
  red: string;
  green: string;
  vitestReport: string | null;
  command: string[];
}

export interface PreparedRegressionRepository {
  args: RegressionCaptureArgs;
  root: string;
  prefix: string;
  redSha: string;
  greenSha: string;
  dependencySource: string | null;
  callerBefore: string;
}

export interface RegressionReportArtifact {
  path: string;
  bytes: Buffer;
}

export class RegressionUsageError extends Error {}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8',
    env: regressionGitEnvironment(),
    maxBuffer: MAX_GIT_OUTPUT,
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return String(result.stdout);
}

function gitBytes(root: string, args: string[]): Buffer {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'buffer',
    env: regressionGitEnvironment(),
    maxBuffer: MAX_GIT_OUTPUT,
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout;
}

function resolveRef(root: string, ref: string): string {
  const oid = git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`ref did not resolve to a commit: ${ref}`);
  return oid;
}

function safeRepoPath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('//') ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
  ) {
    throw new RegressionUsageError(`unsafe repository path: ${JSON.stringify(path)}`);
  }
  return path;
}

export function parseRegressionCaptureArgs(raw: string[]): RegressionCaptureArgs {
  const separator = raw.indexOf('--');
  if (separator < 0) {
    throw new RegressionUsageError('separate the exact test command with --');
  }
  const options = raw.slice(0, separator);
  const command = raw.slice(separator + 1);
  const result: RegressionCaptureArgs = { red: '', green: '', vitestReport: null, command };
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = options[index + 1];
    if (!value) throw new RegressionUsageError(`${flag ?? 'argument'} needs a value`);
    if (flag === '--red') {
      if (result.red) throw new RegressionUsageError('--red given more than once');
      result.red = value;
    } else if (flag === '--green') {
      if (result.green) throw new RegressionUsageError('--green given more than once');
      result.green = value;
    } else if (flag === '--vitest-report') {
      if (result.vitestReport) {
        throw new RegressionUsageError('--vitest-report given more than once');
      }
      result.vitestReport = safeRepoPath(value);
    } else {
      throw new RegressionUsageError(`unknown option ${flag ?? ''}`);
    }
  }
  if (!result.red || !result.green || result.command.length === 0 || !result.command[0]) {
    throw new RegressionUsageError('--red, --green, and a command after -- are required');
  }
  if (result.command.some((arg) => arg.includes('\0'))) {
    throw new RegressionUsageError('command arguments cannot contain NUL bytes');
  }
  return result;
}

function callerPrefix(root: string, cwd: string): string {
  const prefix = relative(root, cwd).split(sep).join('/');
  if (prefix === '..' || prefix.startsWith('../'))
    throw new Error('caller cwd is outside Git root');
  return prefix;
}

function dependencySource(root: string, cwd: string): string | null {
  for (const candidate of [...new Set([join(cwd, 'node_modules'), join(root, 'node_modules')])]) {
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return null;
}

export function splitNulPathBytes(output: Buffer): Buffer[] {
  const paths: Buffer[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) throw new Error('Git path output was not NUL terminated');
    if (end > start) paths.push(output.subarray(start, end));
    start = end + 1;
  }
  return paths;
}

function hasRawPathComponent(path: Buffer, component: Buffer): boolean {
  let start = 0;
  while (start <= path.length) {
    const separator = path.indexOf(0x2f, start);
    const end = separator < 0 ? path.length : separator;
    if (path.subarray(start, end).equals(component)) return true;
    if (separator < 0) return false;
    start = separator + 1;
  }
  return false;
}

function uniqueSortedPaths(paths: Buffer[]): Buffer[] {
  const unique = new Map<string, Buffer>();
  for (const path of paths) unique.set(path.toString('base64'), path);
  return [...unique.values()].sort(Buffer.compare);
}

function filesystemPath(root: string, path: Buffer): string | Buffer {
  if (process.platform === 'win32') return join(root, ...path.toString('utf8').split('/'));
  return Buffer.concat([Buffer.from(root), Buffer.from('/'), path]);
}

export function snapshotRegressionCaller(root: string): string {
  const paths = [
    gitBytes(root, ['ls-files', '-co', '--exclude-standard', '-z']),
    gitBytes(root, ['ls-files', '-oi', '--exclude-standard', '-z']),
  ]
    .flatMap(splitNulPathBytes)
    .filter((path) => !hasRawPathComponent(path, Buffer.from('node_modules')));
  const content = createHash('sha256');
  for (const path of uniqueSortedPaths(paths)) {
    const full = filesystemPath(root, path);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (!stat) {
      content.update(path).update('\0missing\0');
      continue;
    }
    const bytes = stat.isSymbolicLink()
      ? readlinkSync(full, { encoding: 'buffer' })
      : stat.isFile()
        ? stat.size <= MAX_FINGERPRINT_FILE_BYTES
          ? readFileSync(full)
          : Buffer.from(`metadata\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`)
        : Buffer.alloc(0);
    content
      .update(path)
      .update(
        `\0${stat.mode}\0${stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'link' : 'other'}\0`,
      );
    content.update(digest(bytes));
  }
  return digest(
    JSON.stringify({
      head: git(root, ['rev-parse', '--verify', 'HEAD']).trim(),
      refs: gitBytes(root, ['for-each-ref', '--format=%(refname)%00%(objectname)']).toString(
        'base64',
      ),
      status: gitBytes(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).toString(
        'base64',
      ),
      worktrees: gitBytes(root, ['worktree', 'list', '--porcelain']).toString('base64'),
      config: reviewRepositoryConfigFingerprint(root),
      content: content.digest('hex'),
    }),
  );
}

export function prepareRegressionRepository(
  rawArgs: string[],
  requestedCwd: string,
): PreparedRegressionRepository {
  const args = parseRegressionCaptureArgs(rawArgs);
  const cwd = realpathSync(requestedCwd);
  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  const callerBefore = snapshotRegressionCaller(root);
  const prefix = callerPrefix(root, cwd);
  const redSha = resolveRef(root, args.red);
  const greenSha = resolveRef(root, args.green);
  if (redSha === greenSha)
    throw new RegressionUsageError('red and green resolve to the same commit');
  return {
    args,
    root,
    prefix,
    redSha,
    greenSha,
    dependencySource: dependencySource(root, cwd),
    callerBefore,
  };
}

export function createRegressionClone(source: string, destination: string, sha: string): void {
  const cloned = spawnSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      'clone',
      '--no-hardlinks',
      '--no-checkout',
      '--quiet',
      '--',
      source,
      destination,
    ],
    { encoding: 'utf8', env: regressionGitEnvironment(), maxBuffer: MAX_GIT_OUTPUT },
  );
  if (cloned.status !== 0) throw new Error(cloned.stderr.trim() || 'could not create proof clone');
  git(destination, ['checkout', '--quiet', '--detach', sha]);
  git(destination, ['remote', 'remove', 'origin']);
}

/** Resolve the historical caller directory without following a file or symlink out of the clone. */
export function regressionCloneCwd(clone: string, prefix: string): string {
  let current = clone;
  for (const part of prefix ? prefix.split('/') : []) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`caller directory is not a real directory at this ref: ${prefix}`);
    }
  }
  return current;
}

export function linkRegressionDependencies(
  clone: string,
  prefix: string,
  source: string | null,
): string | null {
  if (!source) return null;
  const cwd = regressionCloneCwd(clone, prefix);
  const destinations = [...new Set([join(clone, 'node_modules'), join(cwd, 'node_modules')])];
  for (const destination of destinations) {
    if (lstatSync(destination, { throwIfNoEntry: false })) {
      throw new Error(`proof clone already contains ${relative(clone, destination)}`);
    }
  }
  const isolated = destinations[0];
  if (!isolated) throw new Error('proof clone has no dependency destination');
  try {
    cpSync(source, isolated, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      mode: fsConstants.COPYFILE_FICLONE,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    localizeAndValidateDependencyLinks(source, isolated);
    const packageDestination = destinations[1];
    if (packageDestination) {
      const canonicalDestination = join(
        realpathSync(dirname(packageDestination)),
        basename(packageDestination),
      );
      const replacement = localizedDependencyLink(
        canonicalDestination,
        realpathSync(isolated),
        true,
      );
      symlinkSync(replacement.target, canonicalDestination, replacement.type);
    }
    return isolated;
  } catch (error) {
    rmSync(isolated, { recursive: true, force: true });
    throw error;
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function dependencySymlinks(root: string, directory = root): string[] {
  const links: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      links.push(...dependencySymlinks(root, path));
      continue;
    }
    if (entry.isSymbolicLink()) links.push(path);
  }
  return links;
}

export interface LocalizedDependencyLink {
  target: string;
  type: 'dir' | 'file' | 'junction';
}

export function localizedDependencyLink(
  link: string,
  localizedTarget: string,
  directory: boolean,
  platform: NodeJS.Platform = process.platform,
): LocalizedDependencyLink {
  if (directory && platform === 'win32') return { target: localizedTarget, type: 'junction' };
  return {
    target: relative(dirname(link), localizedTarget),
    type: directory ? 'dir' : 'file',
  };
}

function localizeAndValidateDependencyLinks(source: string, isolated: string): void {
  const sourceRoot = realpathSync(source);
  const isolatedRoot = realpathSync(isolated);
  for (const link of dependencySymlinks(isolatedRoot)) {
    const target = readlinkSync(link);
    if (!isAbsolute(target)) continue;
    let resolvedTarget: string;
    let directory: boolean;
    try {
      resolvedTarget = realpathSync(target);
      directory = statSync(resolvedTarget).isDirectory();
    } catch {
      throw new Error(
        `dependency store contains an unreadable symlink: ${relative(isolatedRoot, link)}`,
      );
    }
    if (!pathIsInside(sourceRoot, resolvedTarget)) {
      throw new Error(`dependency store symlink escapes its root: ${relative(isolatedRoot, link)}`);
    }
    const localizedTarget = join(isolatedRoot, relative(sourceRoot, resolvedTarget));
    const replacement = localizedDependencyLink(link, localizedTarget, directory);
    unlinkSync(link);
    symlinkSync(replacement.target, link, replacement.type);
  }
  for (const link of dependencySymlinks(isolatedRoot)) {
    let target: string;
    try {
      target = realpathSync(link);
    } catch {
      throw new Error(
        `dependency store contains an unreadable symlink: ${relative(isolatedRoot, link)}`,
      );
    }
    if (!pathIsInside(isolatedRoot, target)) {
      throw new Error(`dependency store symlink escapes its root: ${relative(isolatedRoot, link)}`);
    }
  }
}

function reportPath(clone: string, prefix: string, path: string): string {
  const root = resolve(clone);
  const destination = resolve(clone, prefix, ...path.split('/'));
  if (destination === root || !destination.startsWith(`${root}${sep}`)) {
    throw new Error(`report path escapes proof clone: ${path}`);
  }
  return destination;
}

function assertSafeParents(clone: string, destination: string): void {
  const rel = relative(clone, destination);
  let current = clone;
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Vitest report path has a non-directory or symlink ancestor');
    }
  }
}

/** Refuse a pre-existing report so a command that never writes cannot inherit stale evidence. */
export function prepareRegressionReportPath(clone: string, prefix: string, path: string): string {
  const destination = reportPath(clone, prefix, path);
  assertSafeParents(clone, destination);
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    throw new Error(`Vitest report path already exists at this ref: ${path}`);
  }
  return destination;
}

export function readRegressionReport(
  clone: string,
  prefix: string,
  path: string,
): RegressionReportArtifact {
  const destination = reportPath(clone, prefix, path);
  assertSafeParents(clone, destination);
  const stat = lstatSync(destination, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`command did not write a regular Vitest report: ${path}`);
  }
  if (stat.size > MAX_REPORT_BYTES) throw new Error('Vitest report exceeds 64 MiB');
  return { path: destination, bytes: readFileSync(destination) };
}
