/** `bun run build:new` writes only the named new dist artifacts and never touches tracked dist. */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { distArtifact, inspectDistIntegrity } from '../lib/ship/dist-integrity.mts';
import { writeNewDist } from '../lib/ship/preflight/stale-new-dist.mts';
import { treeBlobsAtRef } from '../../gate-engine/ratchets/tree-blobs.mts';
import { buildableFixture, rootRegistry } from './_helpers.mts';

const SCRIPT = fileURLToPath(new URL('../../scripts/build-new-dist.mts', import.meta.url));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function write(root: string, file: string, body: string): void {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

/** A devkit-shaped repo whose base tracks one compiled source and its dist twin. */
function repo({ buildable = true } = {}) {
  const root = mkTmp('build-new-dist-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  write(root, 'package.json', `${JSON.stringify({ name: '@norvalbv/devkit' })}\n`);
  write(root, '.gitignore', 'dist/\nnode_modules\n');
  write(root, 'cli/old.mts', 'export const old = 1;\n');
  write(root, 'dist/cli/old.mjs', 'export const old = 1;\n');
  git(root, 'add', 'package.json', '.gitignore', 'cli/old.mts');
  git(root, 'add', '-f', 'dist/cli/old.mjs');
  git(root, 'commit', '-q', '-m', 'base');
  if (buildable) buildableFixture(root);
  const base = git(root, 'rev-parse', 'HEAD');
  return { atBase: treeBlobsAtRef(root, base, ['dist'])!, base, root };
}

describe('writeNewDist', () => {
  it("writes only the missing remedy's mixed list, which then passes the preflight", async () => {
    const { atBase, base, root } = repo();
    write(root, 'cli/old.mts', 'export const old = 2;\n');
    write(root, 'cli/new.mts', 'export const value: number = 2;\n');
    write(root, 'templates/new.md', 'new\n');
    const sources = ['cli/new.mts', 'templates/new.md'];
    const { missing } = await inspectDistIntegrity(root, base, sources);

    writeNewDist(root, missing, atBase, distArtifact);

    expect(missing).toEqual(['dist/cli/new.mjs', 'dist/templates/new.md']);
    expect(readFileSync(join(root, 'dist/cli/old.mjs'), 'utf8')).toBe('export const old = 1;\n');
    expect(git(root, 'status', '--porcelain', '--ignored', '--', 'dist').split('\n')).toEqual([
      '!! dist/cli/new.mjs',
      '!! dist/templates/',
    ]);
    const report = await inspectDistIntegrity(root, base, [...sources, ...missing]);
    expect(report.stale).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it('refuses tracked, non-canonical and sourceless paths before writing anything', () => {
    const { atBase, root } = repo();
    write(root, 'cli/new.mts', 'export const value = 2;\n');
    write(root, 'cli/__tests__/a.test.mts', 'export {};\n');
    const refused = [
      'dist/cli/old.mjs',
      'dist/templates/../cli/old.mjs',
      './dist/cli/new.mjs',
      join(root, 'dist/cli/new.mjs'),
      'cli/new.mts',
      'dist/cli/orphan.mjs',
      'dist/cli/__tests__/a.test.mjs',
    ];

    const run = () => writeNewDist(root, ['dist/cli/new.mjs', ...refused], atBase, distArtifact);

    expect(run).toThrow(`tracked dist is release-only): ${refused.join(', ')}`);
    expect(existsSync(join(root, 'dist/cli/new.mjs'))).toBe(false);
    expect(readFileSync(join(root, 'dist/cli/old.mjs'), 'utf8')).toBe('export const old = 1;\n');
  });

  it('copies a mirrored artifact with its mode, without a compiler', () => {
    const { atBase, root } = repo({ buildable: false });
    write(root, 'cli/lib/new.sh', '#!/bin/sh\necho hi\n');
    chmodSync(join(root, 'cli/lib/new.sh'), 0o755);

    writeNewDist(root, ['dist/cli/lib/new.sh'], atBase, distArtifact);

    const written = join(root, 'dist/cli/lib/new.sh');
    expect(readFileSync(written, 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(statSync(written).mode & 0o777).toBe(0o755);
  });

  it('writes nothing when tsc emits nothing for the artifact', () => {
    const { atBase, root } = repo();
    write(root, 'tsconfig.build.json', '{ "include": [] }\n');
    write(root, 'cli/new.mts', 'export const value = 2;\n');

    expect(() => writeNewDist(root, ['dist/cli/new.mjs'], atBase, distArtifact)).toThrow(
      'tsc emitted nothing for: dist/cli/new.mjs',
    );
    expect(existsSync(join(root, 'dist/cli/new.mjs'))).toBe(false);
  });

  it('names a missing compiler for a compiled artifact', () => {
    const { atBase, root } = repo({ buildable: false });
    write(root, 'cli/new.mts', 'export const value = 2;\n');

    expect(() => writeNewDist(root, ['dist/cli/new.mjs'], atBase, distArtifact)).toThrow(
      'no TypeScript compiler in',
    );
  });
});

describe('build:new script', () => {
  it('judges tracked dist at the fork point from origin/main', () => {
    const { root } = repo();
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    write(root, 'cli/new.mts', 'export const value = 2;\n');
    write(root, 'dist/cli/new.mjs', 'stale\n');
    git(root, 'add', 'cli/new.mts');
    git(root, 'add', '-f', 'dist/cli/new.mjs');
    git(root, 'commit', '-q', '-m', 'pr adds an artifact');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });

    const added = run('--', 'dist/cli/new.mjs');
    const tracked = run('dist/cli/old.mjs');

    expect(added.status).toBe(0);
    expect(readFileSync(join(root, 'dist/cli/new.mjs'), 'utf8')).toBe('export const value = 2;\n');
    expect(tracked.status).toBe(1);
    expect(tracked.stderr).toContain('dist/cli/old.mjs');
    expect(run('--base', 'main').stderr).toContain('usage: build:new');
  });

  it('fails closed when the fork point cannot be resolved', () => {
    const { root } = repo();
    write(root, 'cli/old.mts', 'export const old = 2;\n');
    write(root, 'cli/new.mts', 'export const value = 2;\n');

    const result = spawnSync(process.execPath, [SCRIPT, 'dist/cli/new.mjs', 'dist/cli/old.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('✗ build:new:');
    expect(existsSync(join(root, 'dist/cli/new.mjs'))).toBe(false);
    expect(readFileSync(join(root, 'dist/cli/old.mjs'), 'utf8')).toBe('export const old = 1;\n');
  });
});
