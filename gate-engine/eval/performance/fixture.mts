import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadChangedSet } from '../../co-occurrence/changed-files.mts';
import type { ExperimentSpec, InputSpec, PerformanceScope } from './model.mts';
import { digest } from './model.mts';

const DOUBLE_STAR = '__DEVKIT_PERF_DOUBLE_STAR__';
const DOUBLE_STAR_DIRECTORY = '__DEVKIT_PERF_DOUBLE_STAR_DIRECTORY__';
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export interface PreparedSource {
  sourceRoot: string;
  sourceCommit: string;
  archivePath: string;
  dependencyRoot: string;
}

export interface PerformanceFixture {
  root: string;
  scope: PerformanceScope;
  changedFiles: string[];
  cleanup(): void;
}

function command(cwd: string, executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed (${String(result.status)}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function git(cwd: string, args: string[]): string {
  return command(cwd, 'git', args);
}

function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    throw new Error(`Fixture path escapes its root: ${path}`);
  return absolute;
}

function globPattern(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, DOUBLE_STAR_DIRECTORY)
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, '[^/]*')
    .replaceAll(DOUBLE_STAR_DIRECTORY, '(?:.*/)?')
    .replaceAll(DOUBLE_STAR, '.*');
  return new RegExp(`^${escaped}$`);
}

function matches(path: string, globs: string[]): boolean {
  return globs.some((glob) => globPattern(glob).test(path));
}

export function prepareSource(
  sourceRoot: string,
  sourceTree: string,
  experimentRoot: string,
): PreparedSource {
  const canonicalRoot = realpathSync(resolve(sourceRoot));
  const sourceCommit = git(canonicalRoot, ['rev-parse', `${sourceTree}^{commit}`]).trim();
  if (!COMMIT_PATTERN.test(sourceCommit))
    throw new Error('Source tree did not resolve to a commit');
  const archivePath = join(experimentRoot, 'source.tar');
  command(canonicalRoot, 'git', ['archive', '--format=tar', '--output', archivePath, sourceCommit]);
  const dependencyRoot = join(canonicalRoot, 'node_modules');
  if (!existsSync(dependencyRoot))
    throw new Error('Benchmark source has no installed node_modules');
  return { sourceRoot: canonicalRoot, sourceCommit, archivePath, dependencyRoot };
}

export function materializeFixture(
  prepared: PreparedSource,
  spec: ExperimentSpec,
  root: string,
  scope: PerformanceScope,
): PerformanceFixture {
  mkdirSync(root, { recursive: true });
  command(root, '/usr/bin/tar', ['-xf', prepared.archivePath, '-C', root]);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'benchmark@invalid.example']);
  git(root, ['config', 'user.name', 'Devkit benchmark']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.hooksPath', '/dev/null']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'benchmark base']);
  symlinkSync(prepared.dependencyRoot, join(root, 'node_modules'), 'dir');

  let changedFiles: string[] = [];
  if (scope === 'local-staged') {
    if (process.env.MATCHER_CHANGED_FILES !== undefined)
      throw new Error('MATCHER_CHANGED_FILES must be unset for a benchmark fixture');
    appendFileSync(inside(root, spec.localPatch.path), spec.localPatch.append);
    git(root, ['add', '--', spec.localPatch.path]);
    changedFiles = [...loadChangedSet(root)].sort();
    if (!changedFiles.includes(spec.localPatch.path))
      throw new Error('Local benchmark patch was not selected by the staged-file policy');
  }
  verifyFixture({ root, scope, changedFiles, cleanup: () => undefined });
  return { root, scope, changedFiles, cleanup: () => undefined };
}

export function fixtureManifest(fixture: PerformanceFixture, inputs: InputSpec): string[] {
  const candidates =
    inputs.mode === 'changed'
      ? fixture.changedFiles
      : git(fixture.root, ['ls-files']).split('\n').filter(Boolean);
  return candidates.filter((path) => matches(path, inputs.include)).sort();
}

export function verifyFixture(fixture: PerformanceFixture): void {
  const unstaged = git(fixture.root, ['diff', '--name-only']).trim();
  if (unstaged) throw new Error(`Benchmark contender mutated tracked files: ${unstaged}`);
  const staged = git(fixture.root, ['diff', '--cached', '--name-only'])
    .split('\n')
    .filter(Boolean)
    .sort();
  const expected = fixture.scope === 'local-staged' ? fixture.changedFiles : [];
  if (JSON.stringify(staged) !== JSON.stringify(expected))
    throw new Error('Benchmark fixture staged set changed during execution');
}

export function localPatchDigest(spec: ExperimentSpec): string {
  return digest(`${spec.localPatch.path}\0${spec.localPatch.append}`);
}
