import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { HashSet, TrackerMode } from './types.mts';

const DOUBLE_STAR_TOKEN = '___DEVKIT_DOUBLE_STAR___';

function git(cwd: string, args: string[], allowFailure = false): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.status === 0 ? result.stdout : '';
}

function gitExists(cwd: string, spec: string): boolean {
  return spawnSync('git', ['cat-file', '-e', spec], { cwd, encoding: 'utf8' }).status === 0;
}

export interface RepositorySource {
  mode: TrackerMode;
  ref?: string;
  listFiles(): string[];
  read(path: string): string | null;
}

function repositoryPath(root: string, path: string): { absolute: string; relative: string } {
  const absolute = resolve(root, path);
  const repoPath = relative(root, absolute).replaceAll('\\', '/');
  if (!repoPath || repoPath === '..' || repoPath.startsWith('../'))
    throw new Error(`Path escapes repository: ${path}`);
  return { absolute, relative: repoPath };
}

export function repositorySource(cwd: string, mode: TrackerMode, ref?: string): RepositorySource {
  const root = realpathSync(resolve(cwd));
  if (mode === 'working') {
    let files: string[] | undefined;
    return {
      mode,
      listFiles: () => {
        files ??= git(root, ['ls-files', '--cached', '--others', '--exclude-standard'])
          .split('\n')
          .filter(Boolean)
          .sort();
        return files;
      },
      read: (path) => {
        const { absolute } = repositoryPath(root, path);
        if (!existsSync(absolute)) return null;
        const real = repositoryPath(root, realpathSync(absolute)).absolute;
        return readFileSync(real, 'utf8');
      },
    };
  }

  if (mode === 'staged') {
    let files: string[] | undefined;
    return {
      mode,
      listFiles: () => {
        files ??= git(root, ['ls-files', '--cached']).split('\n').filter(Boolean).sort();
        return files;
      },
      read: (path) => {
        const spec = `:${repositoryPath(root, path).relative}`;
        return gitExists(root, spec) ? git(root, ['show', spec]) : null;
      },
    };
  }

  const tree = ref ?? 'HEAD';
  let files: string[] | undefined;
  return {
    mode,
    ref: tree,
    listFiles: () => {
      files ??= git(root, ['ls-tree', '-r', '--name-only', tree])
        .split('\n')
        .filter(Boolean)
        .sort();
      return files;
    },
    read: (path) => {
      const spec = `${tree}:${repositoryPath(root, path).relative}`;
      return gitExists(root, spec) ? git(root, ['show', spec]) : null;
    },
  };
}

function matchGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, DOUBLE_STAR_TOKEN)
    .replace(/\*/g, '[^/]*')
    .replaceAll(DOUBLE_STAR_TOKEN, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

export function hashPaths(source: RepositorySource, globs: string[]): string {
  const paths = source
    .listFiles()
    .filter((path) => globs.some((glob) => matchGlob(path, glob)))
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    const content = source.read(path);
    if (content === null) continue;
    hash.update(path);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function suiteHashes(
  source: RepositorySource,
  hashes: { implementation: string[]; corpus: string[]; scorer: string[]; runner: string[] },
): HashSet {
  return {
    implementation: hashPaths(source, hashes.implementation),
    corpus: hashPaths(source, hashes.corpus),
    scorer: hashPaths(source, hashes.scorer),
    runner: hashPaths(source, hashes.runner),
  };
}

export function repoRelative(cwd: string, path: string): string {
  return relative(resolve(cwd), resolve(cwd, path)).replaceAll('\\', '/');
}

export function gitOutput(cwd: string, args: string[], allowFailure = false): string {
  return git(cwd, args, allowFailure);
}
