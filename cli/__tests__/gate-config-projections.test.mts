import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  materializeProjectionRuntime,
  mutableProjectionRoots,
  verifyProjectionRuntime,
} from '../lib/ship/review/projection/runtime.mts';
import { rootRegistry } from './_helpers.mts';

const linkScript = fileURLToPath(new URL('../lib/ship/link-gate-configs.sh', import.meta.url));
const pathScript = fileURLToPath(new URL('../lib/ship/gate-config-paths.mts', import.meta.url));
const projectionRuntime = fileURLToPath(
  new URL('../lib/ship/review/projection/runtime.mts', import.meta.url),
);
const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

function fixture() {
  const parent = mkTmp('gate projection-');
  const root = join(parent, 'target repo');
  const worktree = join(parent, 'gate worktree');
  mkdirSync(root);
  mkdirSync(worktree);
  execFileSync('git', ['init', '-q', root]);
  return { root, worktree };
}

function project(
  root: string,
  worktree: string,
  purpose = 'review',
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const manifest = join(root, '..', 'projection-runtime.json');
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'set -u; source "$1"; link_untracked_gate_configs "$2" "$3" "$4"',
      'test',
      linkScript,
      worktree,
      root,
      purpose,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(purpose === 'review' || purpose === 'review-baseline'
          ? { DEVKIT_REVIEW_PROJECTION_MANIFEST: manifest }
          : {}),
        ...extraEnv,
      },
    },
  );
}

function configuredPaths(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [pathScript, root, ...args], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('gate config projections', () => {
  it('selects one configured path without emitting the other gate inputs', () => {
    const { root } = fixture();
    writeFileSync(
      join(root, 'guard.config.json'),
      JSON.stringify({
        indexPath: '.cache/search.db',
        allowlistPath: '.config/allowlist.json',
        decisionsDir: '..decisions',
      }),
    );

    expect(configuredPaths(root)).toBe('.cache/search.db\n.config/allowlist.json\n..decisions\n');
    expect(configuredPaths(root, 'indexPath')).toBe('.cache/search.db\n');
    expect(configuredPaths(root, 'indexPath', '--null')).toBe('.cache/search.db\0');
    expect(configuredPaths(root, 'unknown')).toBe('');

    writeFileSync(join(root, 'guard.config.json'), '{"indexPath":"../outside.db"}\n');
    expect(configuredPaths(root, 'indexPath', '--null')).toBe('');
  });

  it('keeps ship projections as symlinks but makes review projections private copies', () => {
    const ship = fixture();
    writeFileSync(join(ship.root, 'guard.config.json'), '{"scanRoots":["src"]}\n');
    expect(project(ship.root, ship.worktree, 'ship').status).toBe(0);
    expect(lstatSync(join(ship.worktree, 'guard.config.json')).isSymbolicLink()).toBe(true);

    const review = fixture();
    const materialized = join(review.root, 'materialized-config.json');
    writeFileSync(materialized, '{"scanRoots":["src"]}\n');
    symlinkSync(materialized, join(review.root, 'guard.config.json'));
    mkdirSync(join(review.root, 'eslint', 'baselines'), { recursive: true });
    writeFileSync(join(review.root, 'eslint', 'baselines', 'size.json'), '{"max":500}\n');
    const result = project(review.root, review.worktree);
    expect(result.status, result.stderr).toBe(0);
    const projected = join(review.worktree, 'guard.config.json');
    expect(lstatSync(projected).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(review.worktree, 'eslint', 'baselines')).isSymbolicLink()).toBe(false);
    writeFileSync(projected, '{"scanRoots":["runtime"]}\n');
    writeFileSync(join(review.worktree, 'eslint', 'baselines', 'size.json'), '{"max":1}\n');
    expect(readFileSync(materialized, 'utf8')).toContain('src');
    expect(readFileSync(join(review.root, 'eslint', 'baselines', 'size.json'), 'utf8')).toContain(
      '500',
    );
    expect(project(review.root, review.worktree, 'typo').status).toBe(2);
  });

  it('leaves a gate-config symlink already present in the review snapshot untouched', () => {
    const { root, worktree } = fixture();
    writeFileSync(join(root, 'guard.config.json'), '{"scanRoots":["src"]}\n');
    writeFileSync(join(worktree, 'tracked-config.json'), '{"scanRoots":["tracked"]}\n');
    symlinkSync('tracked-config.json', join(worktree, 'guard.config.json'));

    const result = project(root, worktree);

    expect(result.status, result.stderr).toBe(0);
    expect(lstatSync(join(worktree, 'guard.config.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(worktree, 'guard.config.json'), 'utf8')).toContain('tracked');
  });

  it('fails review projection closed when configured paths cannot be resolved', () => {
    const { root, worktree } = fixture();
    writeFileSync(join(root, 'guard.config.json'), '{ not: valid json');

    const result = project(root, worktree);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not resolve gate config paths');
    expect(() => lstatSync(join(worktree, 'guard.config.json'))).toThrow();
  });

  it('copies the complete SQLite family and isolates runtime writes from the target', () => {
    const { root, worktree } = fixture();
    const indexPath = '.search-code/index\nreview.db';
    const source = join(root, indexPath);
    mkdirSync(join(root, '.search-code'));
    writeFileSync(join(root, 'guard.config.json'), `${JSON.stringify({ indexPath })}\n`);
    for (const [suffix, content] of [
      ['', 'main'],
      ['-wal', 'wal'],
      ['-shm', 'shm'],
      ['-journal', 'journal'],
    ]) {
      writeFileSync(`${source}${suffix}`, content);
    }

    const result = project(root, worktree);

    expect(result.status, result.stderr).toBe(0);
    for (const [suffix, content] of [
      ['', 'main'],
      ['-wal', 'wal'],
      ['-shm', 'shm'],
      ['-journal', 'journal'],
    ]) {
      expect(readFileSync(`${join(worktree, indexPath)}${suffix}`, 'utf8')).toBe(content);
    }
    writeFileSync(`${join(worktree, indexPath)}-wal`, 'runtime');
    expect(readFileSync(`${source}-wal`, 'utf8')).toBe('wal');
  });

  it('rejects a SQLite family that changes during one coherent capture', () => {
    const { root, worktree } = fixture();
    const source = join(root, '.search-code', 'index.db');
    const manifest = join(root, '..', 'projection-runtime.json');
    mkdirSync(join(root, '.search-code'));
    writeFileSync(join(root, 'guard.config.json'), '{"indexPath":".search-code/index.db"}\n');
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      writeFileSync(`${source}${suffix}`, suffix);

    expect(() =>
      materializeProjectionRuntime(
        root,
        worktree,
        manifest,
        ['guard.config.json', '.search-code/index.db'],
        '.search-code/index.db',
        { beforeSourceVerification: () => writeFileSync(`${source}-wal`, 'mutation') },
      ),
    ).toThrow(/gate projections changed during capture/);
  });

  it('removes a partially copied projection when the source changes mid-tree', () => {
    const { root, worktree } = fixture();
    const source = join(root, '.fallow');
    const manifest = join(root, '..', 'projection-runtime.json');
    mkdirSync(source);
    writeFileSync(join(source, 'a.txt'), 'copied first\n');
    writeFileSync(join(source, 'z.txt'), 'captured regular file\n');

    expect(() =>
      materializeProjectionRuntime(root, worktree, manifest, ['.fallow'], '', {
        beforePrivateCopy: () => {
          rmSync(join(source, 'z.txt'));
          symlinkSync(join(source, 'a.txt'), join(source, 'z.txt'));
        },
      }),
    ).toThrow(/nested symlink/);
    expect(() => lstatSync(join(worktree, '.fallow'))).toThrow();
    expect(() => lstatSync(manifest)).toThrow();
  });

  it('propagates a coherent SQLite capture failure through the shell projection path', () => {
    const { root, worktree } = fixture();
    const source = join(root, '.search-code', 'index.db');
    const mutationTool = join(root, '..', 'mutating-projection-tool.mjs');
    mkdirSync(join(root, '.search-code'));
    writeFileSync(join(root, 'guard.config.json'), '{"indexPath":".search-code/index.db"}\n');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      writeFileSync(`${source}${suffix}`, suffix);
    }
    writeFileSync(
      mutationTool,
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        `import { materializeProjectionRuntime } from ${JSON.stringify(pathToFileURL(projectionRuntime).href)};`,
        "const [command, sourceRoot, destinationRoot, manifestPath, indexPath = ''] = process.argv.slice(2);",
        "if (command !== 'materialize') throw new Error('unexpected projection command');",
        "const candidates = readFileSync(0).toString('utf8').split('\\0').filter(Boolean);",
        'const mutationPath = process.env.MUTATE_PROJECTION_PATH;',
        "if (!mutationPath) throw new Error('mutation path is unavailable');",
        'try {',
        '  materializeProjectionRuntime(sourceRoot, destinationRoot, manifestPath, candidates, indexPath, {',
        "    beforeSourceVerification: () => writeFileSync(mutationPath, 'mutation'),",
        '  });',
        '} catch (error) {',
        '  console.error(error instanceof Error ? error.message : String(error));',
        '  process.exitCode = 1;',
        '}',
      ].join('\n'),
    );

    const result = project(root, worktree, 'review', {
      DEVKIT_REVIEW_PROJECTION_TOOL: mutationTool,
      MUTATE_PROJECTION_PATH: `${source}-wal`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gate projections changed during capture; retry');
  });

  it('authenticates immutable projections while allowing only declared private cache changes', () => {
    const { root, worktree } = fixture();
    const manifest = join(root, '..', 'projection-runtime.json');
    writeFileSync(join(root, 'guard.config.json'), '{"scanRoots":["src"]}\n');
    mkdirSync(join(root, '.fallow'));
    writeFileSync(join(root, '.fallow', 'cache.json'), '{}\n');

    materializeProjectionRuntime(root, worktree, manifest, ['guard.config.json', '.fallow']);
    expect(mutableProjectionRoots(manifest)).toEqual(['.fallow']);
    writeFileSync(join(worktree, '.fallow', 'cache.json'), '{"updated":true}\n');
    expect(() => verifyProjectionRuntime(root, worktree, manifest)).not.toThrow();

    writeFileSync(join(worktree, 'guard.config.json'), '{"scanRoots":[]}\n');
    expect(() => verifyProjectionRuntime(root, worktree, manifest)).toThrow(
      /private immutable gate projection changed/,
    );
  });

  it('freezes external materializer links and rejects post-capture or nested-link changes', () => {
    const projected = fixture();
    const external = join(projected.root, '..', 'external.json');
    writeFileSync(external, '{}\n');
    symlinkSync(external, join(projected.root, 'guard.config.json'));
    const projectedManifest = join(projected.root, '..', 'projected-runtime.json');
    materializeProjectionRuntime(projected.root, projected.worktree, projectedManifest, [
      'guard.config.json',
    ]);
    expect(lstatSync(join(projected.worktree, 'guard.config.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(projected.worktree, 'guard.config.json'), 'utf8')).toBe('{}\n');
    expect(() =>
      verifyProjectionRuntime(projected.root, projected.worktree, projectedManifest),
    ).not.toThrow();
    writeFileSync(external, '{"changed":true}\n');
    expect(() =>
      verifyProjectionRuntime(projected.root, projected.worktree, projectedManifest),
    ).toThrow(/target gate projection changed/);

    const nested = fixture();
    const externalTree = join(nested.root, '..', 'external-tree');
    const externalLeaf = join(nested.root, '..', 'external-leaf.json');
    mkdirSync(externalTree);
    writeFileSync(externalLeaf, '{}\n');
    symlinkSync(externalLeaf, join(externalTree, 'nested-link.json'));
    symlinkSync(externalTree, join(nested.root, '.fallow'));
    expect(() =>
      materializeProjectionRuntime(
        nested.root,
        nested.worktree,
        join(nested.root, '..', 'nested-runtime.json'),
        ['.fallow'],
      ),
    ).toThrow(/nested symlink/);

    const captured = fixture();
    const manifest = join(captured.root, '..', 'projection-runtime.json');
    writeFileSync(join(captured.root, 'guard.config.json'), '{}\n');
    mkdirSync(join(captured.root, '.fallow'));
    writeFileSync(join(captured.root, '.fallow', 'cache.json'), '{}\n');
    materializeProjectionRuntime(captured.root, captured.worktree, manifest, [
      'guard.config.json',
      '.fallow',
    ]);
    writeFileSync(join(captured.root, 'guard.config.json'), '{"changed":true}\n');
    expect(() => verifyProjectionRuntime(captured.root, captured.worktree, manifest)).toThrow(
      /target gate projection changed/,
    );
    writeFileSync(join(captured.root, 'guard.config.json'), '{}\n');
    const outside = join(captured.root, '..', 'outside-cache');
    mkdirSync(outside);
    symlinkSync(outside, join(captured.worktree, '.fallow', 'unsafe'));
    expect(() => verifyProjectionRuntime(captured.root, captured.worktree, manifest)).toThrow(
      /nested symlink/,
    );
  });
});
