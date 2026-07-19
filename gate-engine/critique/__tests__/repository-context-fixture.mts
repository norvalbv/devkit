import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import {
  getPlanCritiqueRepositoryContext,
  type PlanCritiqueRepositoryContext,
} from '../repository-context.mts';

export const temporaryPaths: string[] = [];

afterEach(() => {
  for (const value of temporaryPaths.splice(0).reverse())
    rmSync(value, { force: true, recursive: true });
});

export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function createRepository(origin?: string): string {
  const repository = temporaryDirectory('critique-binding-repo-');
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.name', 'Binding Test');
  git(repository, 'config', 'user.email', 'binding@example.test');
  if (origin) git(repository, 'remote', 'add', 'origin', origin);
  writeFileSync(path.join(repository, 'state.txt'), 'initial\n');
  git(repository, 'add', 'state.txt');
  git(repository, 'commit', '-q', '-m', 'initial');
  return repository;
}

export function commit(repository: string, value: string): void {
  writeFileSync(path.join(repository, 'state.txt'), `${value}\n`);
  git(repository, 'add', 'state.txt');
  git(repository, 'commit', '-q', '-m', value);
}

export function context(
  repository: string,
  platform?: NodeJS.Platform,
): PlanCritiqueRepositoryContext {
  const result = getPlanCritiqueRepositoryContext(repository, platform);
  if (result.status !== 'available') throw new Error(`repository context: ${result.reason}`);
  return result.context;
}

export function withGitRace<T>(
  repository: string,
  trigger: 'first_status' | 'merge_base',
  operation: () => T,
): T {
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const wrapperDirectory = temporaryDirectory('critique-binding-git-wrapper-');
  const wrapper = path.join(wrapperDirectory, 'git');
  writeFileSync(
    wrapper,
    `#!/bin/sh\n` +
      `if [ "$PCR_TRIGGER" = first_status ] && [ "\${3-}" = status ] && [ ! -d "$PCR_MARKER" ]; then\n` +
      `  "$PCR_GIT" "$@"\n` +
      `  code=$?\n` +
      `  mkdir "$PCR_MARKER"\n` +
      `  "$PCR_GIT" -C "$PCR_REPO" checkout -q context-changed\n` +
      `  exit "$code"\n` +
      `fi\n` +
      `if [ "$PCR_TRIGGER" = merge_base ] && [ "\${3-}" = merge-base ]; then\n` +
      `  "$PCR_GIT" "$@"\n` +
      `  code=$?\n` +
      `  "$PCR_GIT" -C "$PCR_REPO" checkout -q context-changed\n` +
      `  exit "$code"\n` +
      `fi\n` +
      `exec "$PCR_GIT" "$@"\n`,
  );
  chmodSync(wrapper, 0o700);
  const names = ['PATH', 'PCR_GIT', 'PCR_MARKER', 'PCR_REPO', 'PCR_TRIGGER'] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.PATH = `${wrapperDirectory}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.PCR_GIT = realGit;
  process.env.PCR_MARKER = path.join(wrapperDirectory, 'fired');
  process.env.PCR_REPO = repository;
  process.env.PCR_TRIGGER = trigger;
  try {
    return operation();
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
