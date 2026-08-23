import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectDistIntegrity } from '../lib/ship/dist-integrity.mts';
import { rootRegistry } from './_helpers.mts';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const shipScript = fileURLToPath(new URL('../lib/ship/ship-branch.sh', import.meta.url));
const reshipScript = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { dependencies: Record<string, string> };
const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function repo(name = '@norvalbv/devkit'): { base: string; root: string } {
  const root = mkTmp('dist-integrity-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name })}\n`);
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/index.mjs'), 'export const ready = true;\n');
  git(root, 'add', 'package.json', '.gitignore');
  git(root, 'add', '-f', 'dist/index.mjs');
  git(root, 'commit', '-q', '-m', 'base');
  return { base: git(root, 'rev-parse', 'HEAD'), root };
}

describe('inspectDistIntegrity', () => {
  it('is inert when package identity is malformed', async () => {
    const { root } = repo();
    writeFileSync(join(root, 'package.json'), '{ merge conflict');

    await expect(inspectDistIntegrity(root, 'HEAD', [])).resolves.toEqual({
      active: false,
      unresolved: [],
      unbriefed: [],
      untracked: [],
    });
  });

  it('declares its dynamic parser as a runtime dependency', () => {
    expect(packageJson.dependencies['es-module-lexer']).toBeDefined();
  });

  it('reports an ignored generated artifact missing from the Git index', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), 'export const value = 1;\n');

    const report = await inspectDistIntegrity(root, base, ['cli/new.mts']);

    expect(report.untracked).toEqual(['dist/cli/new.mjs']);
  });

  it('reports a force-added artifact omitted from the explicit ship paths', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), 'export const value = 1;\n');
    git(root, 'add', '-f', 'dist/cli/new.mjs');

    const report = await inspectDistIntegrity(root, base, ['cli/new.mts']);

    expect(report.unbriefed).toEqual(['dist/cli/new.mjs']);
  });

  it('passes once the new artifact is tracked and explicitly briefed', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), 'export const value = 1;\n');
    git(root, 'add', '-f', 'dist/cli/new.mjs');

    const report = await inspectDistIntegrity(root, base, ['cli/new.mts', 'dist/cli/new.mjs']);

    expect(report).toEqual({ active: true, unresolved: [], unbriefed: [], untracked: [] });
  });

  it("ignores another agent's unrelated dist artifacts", async () => {
    const { base, root } = repo();
    writeFileSync(join(root, 'dist/unrelated-untracked.mjs'), 'export {};\n');
    writeFileSync(join(root, 'dist/unrelated-added.mjs'), 'export {};\n');
    git(root, 'add', '-f', 'dist/unrelated-added.mjs');

    const report = await inspectDistIntegrity(root, base, ['dist/index.mjs']);

    expect(report).toEqual({ active: true, unresolved: [], unbriefed: [], untracked: [] });
  });

  it('finds missing static and string-literal dynamic imports but skips templates', async () => {
    const { base, root } = repo();
    writeFileSync(
      join(root, 'dist/index.mjs'),
      [
        "import './missing-static.mjs';",
        "import('./missing-dynamic.mjs');",
        ['import(`./$', '{runtimeName}.mjs`);'].join(''),
      ].join('\n'),
    );

    const report = await inspectDistIntegrity(root, base, ['dist/index.mjs']);

    expect(report.unresolved.map(({ specifier }) => specifier)).toEqual([
      './missing-dynamic.mjs',
      './missing-static.mjs',
    ]);
  });

  it('does not affect consumer repositories', async () => {
    const { base, root } = repo('consumer');
    writeFileSync(join(root, 'dist/new.mjs'), 'export const value = 1;\n');

    await expect(inspectDistIntegrity(root, base, [])).resolves.toEqual({
      active: false,
      unresolved: [],
      unbriefed: [],
      untracked: [],
    });
  });
});

function seedShipRepo(): { base: string; root: string } {
  const fixture = repo();
  mkdirSync(join(fixture.root, 'cli'));
  mkdirSync(join(fixture.root, 'dist/cli'));
  writeFileSync(join(fixture.root, 'cli/new.mts'), 'export const value = 1;\n');
  writeFileSync(join(fixture.root, 'dist/cli/new.mjs'), 'export const value = 1;\n');
  return fixture;
}

describe('ship dist-integrity preflight', () => {
  it('blocks a new ship before creating its worktree', () => {
    const { root } = seedShipRepo();
    git(root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    const result = spawnSync(
      '/bin/bash',
      [shipScript, 'feat/dist-check', 'test', '--', 'cli/new.mts'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, SHIP_DRY_RUN: '1' },
      },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('dist/cli/new.mjs');
    expect(result.stderr).toContain("git add -f -- 'dist/cli/new.mjs'");
    expect(result.stderr).toContain("Include after -- in the next devkit ship: 'dist/cli/new.mjs'");
    expect(git(root, 'branch', '--list', 'feat/dist-check')).toBe('');
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('devkit-ship-');
  });

  it('blocks a reship before creating its worktree', () => {
    const { root } = seedShipRepo();
    const bare = mkTmp('dist-integrity-origin-');
    execFileSync('git', ['init', '-q', '--bare', bare], {
      env: { ...process.env, ...GIT_ENV },
    });
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', 'origin', 'HEAD:feat/open');

    const result = spawnSync(
      '/bin/bash',
      [reshipScript, 'feat/open', 'test', '--pr', '--', 'cli/new.mts'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, SHIP_DRY_RUN: '1' },
      },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('dist/cli/new.mjs');
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('devkit-reship-');
  });
});
