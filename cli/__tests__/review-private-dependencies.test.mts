import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverDependencySurfaces,
  materializeDependencyRuntime,
  verifyDependencyRuntime,
} from '../lib/ship/review/dependency-runtime.mts';
import { rootRegistry } from './_helpers.mts';

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  '../lib/ship/review/dependency-runtime.mts',
);
const PREPARE = join(dirname(CLI), '../prepare-gate-worktree.sh');
const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

function fixture(name = 'runtime') {
  const parent = mkTmp(`devkit-review-dependencies-${name}-`);
  const source = join(parent, 'source');
  const destination = join(parent, 'destination');
  const manifest = join(parent, 'runtime.json');
  mkdirSync(source);
  mkdirSync(destination);
  return { parent, source, destination, manifest };
}

function write(root: string, path: string, contents = 'runtime\n'): string {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
  return destination;
}

function prepare(source: string, destination: string, purpose: string, manifest?: string) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'set -euo pipefail; source "$1"; prepare_gate_worktree "$2" "$3" "$4"',
      'devkit-review-prepare-test',
      PREPARE,
      destination,
      source,
      purpose,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEVKIT_REVIEW_DEPENDENCY_MANIFEST: manifest,
        DEVKIT_REVIEW_DEPENDENCY_TOOL: CLI,
      },
    },
  );
}

describe('private review dependency runtime', () => {
  it('discovers root and package surfaces without entering .git, node_modules, or symlink dirs', () => {
    const { parent, source } = fixture('discover');
    mkdirSync(join(source, 'node_modules/nested/node_modules'), { recursive: true });
    mkdirSync(join(source, 'packages/a/node_modules'), { recursive: true });
    mkdirSync(join(source, 'packages/line\nbreak/node_modules'), { recursive: true });
    mkdirSync(join(source, '.git/hidden/node_modules'), { recursive: true });
    mkdirSync(join(parent, 'linked-target/hidden/node_modules'), { recursive: true });
    symlinkSync(join(parent, 'linked-target'), join(source, 'linked'));

    expect(discoverDependencySurfaces(source)).toEqual([
      'node_modules',
      'packages/a/node_modules',
      'packages/line\nbreak/node_modules',
    ]);
  });

  it('rebases workspace links into the destination and preserves cyclic workspace topology', () => {
    const { source, destination, manifest } = fixture('workspace');
    write(source, 'node_modules/tool/bin.js', '#!/usr/bin/env node\n');
    chmodSync(join(source, 'node_modules/tool/bin.js'), 0o755);
    for (const workspace of ['a', 'b']) {
      write(source, `packages/${workspace}/source.ts`, `${workspace}\n`);
      write(destination, `packages/${workspace}/source.ts`, `${workspace}\n`);
      mkdirSync(join(source, `packages/${workspace}/node_modules`), { recursive: true });
    }
    symlinkSync(join(source, 'packages/a'), join(source, 'node_modules/a'));
    symlinkSync('../../b', join(source, 'packages/a/node_modules/b'));
    symlinkSync('../../a', join(source, 'packages/b/node_modules/a'));

    const captured = materializeDependencyRuntime(source, destination, manifest);

    expect(captured.surfaces).toEqual([
      'node_modules',
      'packages/a/node_modules',
      'packages/b/node_modules',
    ]);
    expect(realpathSync(join(destination, 'node_modules/a'))).toBe(
      realpathSync(join(destination, 'packages/a')),
    );
    expect(readlinkSync(join(destination, 'node_modules/a'))).not.toContain(source);
    expect(lstatSync(join(destination, 'node_modules/tool/bin.js')).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync(manifest, 'utf8')).fingerprint).toBe(captured.fingerprint);
  });

  it('keeps hook cache writes private and verifies the unchanged source through the CLI', () => {
    const { source, destination, manifest } = fixture('cache');
    write(source, 'node_modules/tool/index.js');
    const materialized = spawnSync(
      process.execPath,
      [CLI, 'materialize', source, destination, manifest],
      { encoding: 'utf8' },
    );
    expect(materialized.status, materialized.stderr).toBe(0);

    write(destination, 'node_modules/.cache/state', 'private\n');
    const verified = spawnSync(process.execPath, [CLI, 'verify', source, manifest], {
      encoding: 'utf8',
    });

    expect(verified.status, verified.stderr).toBe(0);
    expect(existsSync(join(source, 'node_modules/.cache/state'))).toBe(false);
  });

  it('merges identical snapshot entries, fills missing bytes, and preserves snapshot-only files', () => {
    const { source, destination, manifest } = fixture('merge');
    write(source, 'node_modules/pkg/existing.js', 'same\n');
    write(source, 'node_modules/pkg/missing.js', 'filled\n');
    write(destination, 'node_modules/pkg/existing.js', 'same\n');
    write(destination, 'node_modules/pkg/snapshot-only.js', 'keep\n');

    materializeDependencyRuntime(source, destination, manifest);

    expect(readFileSync(join(destination, 'node_modules/pkg/missing.js'), 'utf8')).toBe('filled\n');
    expect(readFileSync(join(destination, 'node_modules/pkg/snapshot-only.js'), 'utf8')).toBe(
      'keep\n',
    );
  });

  it('never clobbers a differing snapshot entry', () => {
    const { source, destination, manifest } = fixture('conflict');
    write(source, 'node_modules/pkg/a-added.js', 'added\n');
    write(source, 'node_modules/pkg/z-conflict.js', 'runtime\n');
    write(destination, 'node_modules/pkg/z-conflict.js', 'snapshot\n');

    expect(() => materializeDependencyRuntime(source, destination, manifest)).toThrow(
      /differs from snapshot entry/,
    );
    expect(readFileSync(join(destination, 'node_modules/pkg/z-conflict.js'), 'utf8')).toBe(
      'snapshot\n',
    );
    expect(existsSync(join(destination, 'node_modules/pkg/a-added.js'))).toBe(false);
    expect(existsSync(manifest)).toBe(false);
  });

  it('rejects destination symlink ancestors without writing outside the private worktree', () => {
    const { parent, source, destination, manifest } = fixture('destination-escape');
    const external = join(parent, 'external');
    write(source, 'packages/a/node_modules/pkg/index.js');
    mkdirSync(external);
    mkdirSync(join(destination, 'packages'), { recursive: true });
    symlinkSync(external, join(destination, 'packages/a'));

    expect(() => materializeDependencyRuntime(source, destination, manifest)).toThrow(
      /unsafe parent/,
    );
    expect(existsSync(join(external, 'node_modules'))).toBe(false);
    expect(existsSync(manifest)).toBe(false);
  });

  it('rolls back additions when the source mutates during capture', () => {
    const { source, destination, manifest } = fixture('mutation');
    const dependency = write(source, 'node_modules/pkg/index.js', 'before\n');

    expect(() =>
      materializeDependencyRuntime(source, destination, manifest, {
        beforeSourceVerification: () => writeFileSync(dependency, 'after\n'),
      }),
    ).toThrow(/dependencies changed during capture/);
    expect(existsSync(join(destination, 'node_modules'))).toBe(false);
    expect(existsSync(manifest)).toBe(false);
  });

  it('never follows a replaced destination ancestor during rollback', () => {
    const { parent, source, destination, manifest } = fixture('rollback-escape');
    const dependency = write(source, 'packages/a/node_modules/pkg/index.js', 'before\n');
    mkdirSync(join(destination, 'packages/a'), { recursive: true });
    const external = join(parent, 'external');
    write(external, 'node_modules/pkg/index.js', 'sentinel\n');

    expect(() =>
      materializeDependencyRuntime(source, destination, manifest, {
        beforeSourceVerification: () => {
          rmSync(join(destination, 'packages/a'), { recursive: true });
          symlinkSync(external, join(destination, 'packages/a'));
          writeFileSync(dependency, 'after\n');
        },
      }),
    ).toThrow(/dependencies changed during capture/);
    expect(readFileSync(join(external, 'node_modules/pkg/index.js'), 'utf8')).toBe('sentinel\n');
  });

  it.each([
    ['escaping', (_source: string, parent: string) => join(parent, 'external')],
    ['dangling', (source: string) => join(source, 'missing')],
    ['git', (source: string) => join(source, '.git/private')],
  ])('rejects %s dependency links', (_name, target) => {
    const { parent, source, destination, manifest } = fixture('unsafe-link');
    mkdirSync(join(source, 'node_modules'), { recursive: true });
    const linkTarget = target(source, parent);
    if (!linkTarget.endsWith('missing')) write(parent, relative(parent, linkTarget));
    symlinkSync(linkTarget, join(source, 'node_modules/link'));

    expect(() => materializeDependencyRuntime(source, destination, manifest)).toThrow(
      /escapes the repository|dangling dependency link|targets \.git/,
    );
  });

  it.runIf(process.platform !== 'win32')(
    'rejects special files inside a dependency surface',
    () => {
      const { source, destination, manifest } = fixture('special');
      mkdirSync(join(source, 'node_modules'), { recursive: true });
      const fifo = join(source, 'node_modules/runtime.fifo');
      const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
      expect(created.status, created.stderr).toBe(0);

      expect(() => materializeDependencyRuntime(source, destination, manifest)).toThrow(
        /unsupported dependency entry type/,
      );
    },
  );

  it('rejects overlapping roots and detects post-copy source changes', () => {
    const { source, destination, manifest } = fixture('verify');
    const dependency = write(source, 'node_modules/pkg/index.js', 'before\n');
    expect(() => materializeDependencyRuntime(source, source, manifest)).toThrow(/non-nested/);
    materializeDependencyRuntime(source, destination, manifest);

    writeFileSync(dependency, 'after\n');
    expect(() => verifyDependencyRuntime(source, manifest)).toThrow(
      /target dependencies changed while review was running/,
    );
  });

  it('requires the durable manifest to live outside both checkouts', () => {
    const { source, destination } = fixture('manifest-boundary');
    write(source, 'node_modules/pkg/index.js');

    expect(() =>
      materializeDependencyRuntime(source, destination, join(source, 'runtime.json')),
    ).toThrow(/manifest must live outside/);
    expect(() =>
      materializeDependencyRuntime(source, destination, join(destination, 'runtime.json')),
    ).toThrow(/manifest must live outside/);
    expect(existsSync(join(destination, 'node_modules'))).toBe(false);
  });

  it.each([
    'review',
    'review-baseline',
  ])('prepares %s with private dependencies and without target-owned reviewer assets', (purpose) => {
    const { parent, source, destination } = fixture(`prepare-${purpose}`);
    const manifest = join(parent, `${purpose}.json`);
    write(source, '.husky/_/pre-commit', 'runner\n');
    write(source, 'node_modules/pkg/index.js');
    write(source, '.claude/agents/reviewer.md');
    write(source, '.claude/skills/reviewer/SKILL.md');

    const result = prepare(source, destination, purpose, manifest);

    expect(result.status, result.stderr).toBe(0);
    expect(lstatSync(join(destination, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(destination, 'node_modules/pkg/index.js'), 'utf8')).toBe('runtime\n');
    expect(existsSync(join(destination, '.claude'))).toBe(false);
    expect(existsSync(manifest)).toBe(true);
    write(destination, 'node_modules/.cache/state', 'private\n');
    expect(existsSync(join(source, 'node_modules/.cache/state'))).toBe(false);
  });

  it.each([
    'ship',
    'reship',
    'review-extra',
  ])('preserves existing %s dependency and Claude projection links', (purpose) => {
    const { source, destination } = fixture(`prepare-${purpose}`);
    write(source, '.husky/_/pre-commit', 'runner\n');
    write(source, 'node_modules/pkg/index.js');
    write(source, '.claude/agents/reviewer.md');
    write(source, '.claude/skills/reviewer/SKILL.md');

    const result = prepare(source, destination, purpose);

    expect(result.status, result.stderr).toBe(0);
    expect(lstatSync(join(destination, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(destination, '.claude/agents')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(destination, '.claude/skills')).isSymbolicLink()).toBe(true);
  });

  it('fails closed when review has no caller-owned dependency manifest', () => {
    const { source, destination } = fixture('prepare-no-manifest');
    write(source, '.husky/_/pre-commit', 'runner\n');

    const result = prepare(source, destination, 'review');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private dependency manifest path is unavailable');
  });
});
