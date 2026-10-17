/** A briefed NEW dist artifact must match a fresh build of its source; tracked dist is never compared. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectDistIntegrity, printDistIntegrityFailure } from '../lib/ship/dist-integrity.mts';
import { staleNewDist } from '../lib/ship/preflight/stale-new-dist.mts';
import { buildableFixture, rootRegistry } from './_helpers.mts';

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
  const root = mkTmp('dist-integrity-stale-');
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
  return { base: git(root, 'rev-parse', 'HEAD'), root };
}

const NEW = ['cli/new.mts', 'dist/cli/new.mjs'];

describe('inspectDistIntegrity — stale new artifacts', () => {
  it('blocks a new artifact built before its source was last edited', async () => {
    const { base, root } = repo();
    write(root, 'cli/new.mts', 'export const value = 2;\n');
    write(root, 'dist/cli/new.mjs', 'export const value = 1;\n');

    const report = await inspectDistIntegrity(root, base, NEW);

    expect(report.stale).toEqual(['dist/cli/new.mjs']);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(printDistIntegrityFailure(report)).toBe(1);
    expect(errors.mock.calls.flat().join('\n')).toContain(
      "run `bun run build`, then re-brief these: -- 'dist/cli/new.mjs'",
    );
    errors.mockRestore();
  });

  it('passes a new artifact that matches a fresh build', async () => {
    const { base, root } = repo();
    write(root, 'cli/new.mts', 'export const value: number = 2;\n');
    write(root, 'dist/cli/new.mjs', 'export const value = 2;\n');

    const report = await inspectDistIntegrity(root, base, NEW);

    expect(report.stale).toEqual([]);
  });

  it("is not blocked by another file's type error, since tsc still emits", async () => {
    const { base, root } = repo();
    write(root, 'cli/broken.mts', "export const broken: number = 'x';\n");
    write(root, 'cli/new.mts', 'export const value = 2;\n');
    write(root, 'dist/cli/new.mjs', 'export const value = 2;\n');

    const report = await inspectDistIntegrity(root, base, NEW);

    expect(report.stale).toEqual([]);
  });

  it('checks a new artifact briefed without its source', async () => {
    const { base, root } = repo();
    write(root, 'cli/new.mts', 'export const value = 2;\n');
    write(root, 'dist/cli/new.mjs', 'export const value = 1;\n');

    const report = await inspectDistIntegrity(root, base, ['dist/cli/new.mjs']);

    expect(report.stale).toEqual(['dist/cli/new.mjs']);
  });

  it('maps an anti-slop .js artifact back to its .ts source', async () => {
    const { base, root } = repo();
    write(root, 'anti-slop/src/new.ts', 'export const value = 2;\n');
    write(root, 'dist/anti-slop/src/new.js', 'export const value = 1;\n');

    const report = await inspectDistIntegrity(root, base, ['dist/anti-slop/src/new.js']);

    expect(report.stale).toEqual(['dist/anti-slop/src/new.js']);
  });

  it('fails closed when the fresh build emits nothing for the artifact', async () => {
    const { base, root } = repo();
    write(root, 'tsconfig.build.json', '{ "include": [] }\n');
    write(root, 'cli/new.mts', 'export const value = 2;\n');
    write(root, 'dist/cli/new.mjs', 'export const value = 2;\n');

    const report = await inspectDistIntegrity(root, base, NEW);

    expect(report.stale).toEqual(['dist/cli/new.mjs']);
  });

  it('never compares a tracked artifact, so needs no compiler for it', async () => {
    const { base, root } = repo({ buildable: false });
    write(root, 'cli/old.mts', 'export const old = 2;\n');

    const report = await inspectDistIntegrity(root, base, ['cli/old.mts', 'dist/cli/old.mjs']);

    expect(report.stale).toEqual([]);
  });

  it('compares a new mirrored artifact byte for byte, without a compiler', async () => {
    const { base, root } = repo({ buildable: false });
    write(root, 'templates/new.md', 'new\n');
    write(root, 'dist/templates/new.md', 'old\n');

    const report = await inspectDistIntegrity(root, base, [
      'templates/new.md',
      'dist/templates/new.md',
    ]);

    expect(report.stale).toEqual(['dist/templates/new.md']);
  });

  it('resolves the compiler from the checkout, naming a missing one', async () => {
    const { base, root } = repo({ buildable: false });
    write(root, 'cli/new.mts', 'export const value = 2;\n');
    write(root, 'dist/cli/new.mjs', 'export const value = 2;\n');

    await expect(inspectDistIntegrity(root, base, NEW)).rejects.toThrow(
      'no TypeScript compiler in',
    );
  });

  it('kills a compiler that ignores SIGTERM at its bound, failing closed instead of stale', () => {
    const root = mkTmp('dist-integrity-hung-tsc-');
    const marker = join(root, 'finished');
    write(root, 'package.json', '{}\n');
    write(root, 'cli/new.mts', 'export const value = 2;\n');
    write(root, 'dist/cli/new.mjs', 'export const value = 2;\n');
    write(root, 'node_modules/@typescript/native/package.json', '{"name":"@typescript/native"}\n');
    write(
      root,
      'node_modules/@typescript/native/bin/tsc',
      `process.on('SIGTERM', () => {});
setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); process.exit(0); }, 5000);\n`,
    );
    const toArtifact = (source: string) =>
      source === 'cli/new.mts' ? 'dist/cli/new.mjs' : undefined;

    expect(() => staleNewDist(root, ['dist/cli/new.mjs'], new Map(), toArtifact, 300)).toThrow(
      'tsc did not finish within 0.3s',
    );
    expect(existsSync(marker)).toBe(false);
  });
});
