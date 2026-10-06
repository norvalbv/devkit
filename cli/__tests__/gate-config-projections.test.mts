import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTI_SLOP_BASELINE_REL,
  ANTI_SLOP_MANAGED_REL,
} from '../lib/install/anti-slop/constants.mts';
import { OVERLAY_ENTRY_REL } from '../lib/install/oxc/lifecycle.mts';
import { readManifest } from '../lib/ship/review/projection/manifest.mts';
import {
  materializeProjectionRuntime,
  mutableProjectionRoots,
  verifyProjectionRuntime,
} from '../lib/ship/review/projection/runtime.mts';
import { type GateInput, gateInputs } from '../../gate-engine/deterministic/gate-inputs.mts';
import { STRUCTURE_BASELINE_DIR } from '../../gate-engine/ratchets/baseline-paths.mts';
import { rootRegistry } from './_helpers.mts';

const linkScript = fileURLToPath(new URL('../lib/ship/link-gate-configs.sh', import.meta.url));
const prepareScript = fileURLToPath(
  new URL('../lib/ship/prepare-gate-worktree.sh', import.meta.url),
);
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
      'set -u; source "$1"; source "$2"; link_untracked_gate_configs "$3" "$4" "$5"',
      'test',
      prepareScript,
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

// The review manifest flags a registry entry carries; the runtime flags the index SQLite family itself.
function reviewFlags(input: GateInput) {
  const index = input.field === 'indexPath';
  return {
    mutable: index || input.mutable === true,
    sourceVolatile: index || input.sourceVolatile === true,
  };
}

describe('gate config projections', () => {
  // Registry calls run on every ship and review, some with stderr shown to the consumer.
  it('emits the registry without loading sqlite, so no experimental warning reaches stderr', () => {
    const { root } = fixture();
    const result = spawnSync(process.execPath, [pathScript, root, 'indexPath'], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('--usable-chunks counts only comparable rows and stays silent when it cannot judge', () => {
    const { root } = fixture();
    const chunks =
      'CREATE TABLE chunks (file_path TEXT, symbol_name TEXT, embedding BLOB, code_embedding BLOB)';
    const index = (name: string, sql: string) => {
      const db = new DatabaseSync(join(root, name));
      db.exec(sql);
      db.close();
      return join(root, name);
    };
    const blob = "x'00000000'";
    // Rows present but none embedded: what an interrupted or describe-only index run leaves behind.
    const unembedded = index(
      'unembedded.db',
      `${chunks}; INSERT INTO chunks VALUES ('a.ts', 'f', NULL, NULL)`,
    );
    const usable = index(
      'usable.db',
      `${chunks}; INSERT INTO chunks VALUES ('a.ts', 'f', ${blob}, ${blob}), ('a.ts', NULL, ${blob}, ${blob})`,
    );
    const foreign = index('foreign.db', 'CREATE TABLE other (a)');
    writeFileSync(join(root, 'junk.db'), 'not sqlite');

    expect(configuredPaths(unembedded, '--usable-chunks')).toBe('0\n');
    expect(configuredPaths(usable, '--usable-chunks')).toBe('1\n');
    expect(configuredPaths(foreign, '--usable-chunks')).toBe('\n');
    expect(configuredPaths(join(root, 'junk.db'), '--usable-chunks')).toBe('\n');
    expect(configuredPaths(join(root, 'missing.db'), '--usable-chunks')).toBe('\n');
    expect(lstatSync(join(root, 'junk.db')).size).toBe(10); // probing never rewrites the file
  });

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

    expect(configuredPaths(root, 'allowlistPath')).toBe('.config/allowlist.json\n');
    expect(configuredPaths(root, 'decisionsDir')).toBe('..decisions\n');
    expect(configuredPaths(root, 'indexPath')).toBe('.cache/search.db\n');
    expect(configuredPaths(root, 'indexPath', '--null')).toBe('.cache/search.db\0');
    expect(configuredPaths(root, 'unknown')).toBe('');

    writeFileSync(join(root, 'guard.config.json'), '{"indexPath":"../outside.db"}\n');
    expect(configuredPaths(root, 'indexPath', '--null')).toBe('');
  });

  it('emits exactly the registry gateInputs yields, filtered by flag on request', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'guard.config.json'), '{"decisionsDir":"records"}\n');
    mkdirSync(join(root, '.devkit/baselines/structure'), { recursive: true });
    writeFileSync(join(root, '.devkit/baselines/structure/cli.mjs'), '');
    const registry = [...gateInputs(root)];
    const lines = (inputs: GateInput[]) => inputs.map((input) => `${input.path}\n`).join('');

    expect(configuredPaths(root)).toBe(lines(registry));
    expect(configuredPaths(root, '--null')).toBe(lines(registry).replaceAll('\n', '\0'));
    expect(configuredPaths(root, '--cache')).toBe(lines(registry.filter((input) => input.cache)));
    expect(configuredPaths(root, '--each-file')).toBe('.devkit/baselines/structure/cli.mjs\n');
  });

  // gate-engine cannot import cli/, so the registry repeats these cli-owned names; a rename fails here.
  it('registers the cli-owned anti-slop and oxlint overlay paths', () => {
    const registry = [...gateInputs(fixture().root)].map((input) => input.path);
    expect(registry).toEqual(
      expect.arrayContaining([ANTI_SLOP_BASELINE_REL, ANTI_SLOP_MANAGED_REL, OVERLAY_ENTRY_REL]),
    );
  });

  it('projects every registry path into ship and review worktrees with registry flags', () => {
    const config = '{"indexPath":".search-code/index.db","decisionsDir":"records"}\n';
    const seed = (root: string) => {
      writeFileSync(join(root, 'guard.config.json'), config);
      mkdirSync(join(root, '.devkit/baselines/structure'), { recursive: true });
      writeFileSync(join(root, '.devkit/baselines/structure/cli.mjs'), '');
      const registry = [...gateInputs(root)];
      for (const { kind, path } of registry) {
        mkdirSync(join(root, kind === 'dir' ? path : dirname(path)), { recursive: true });
        if (kind === 'file') writeFileSync(join(root, path), '{}\n');
      }
      writeFileSync(join(root, 'guard.config.json'), config);
      return registry;
    };

    const ship = fixture();
    const registry = seed(ship.root);
    expect(project(ship.root, ship.worktree, 'ship').status).toBe(0);
    for (const { path } of registry) {
      expect(lstatSync(join(ship.worktree, path)).isSymbolicLink(), path).toBe(true);
    }

    const review = fixture();
    seed(review.root);
    const result = project(review.root, review.worktree);
    expect(result.status, result.stderr).toBe(0);
    const manifest = readManifest(join(review.root, '..', 'projection-runtime.json'));
    for (const input of registry) {
      expect(lstatSync(join(review.worktree, input.path)).isSymbolicLink(), input.path).toBe(false);
      expect(manifest.entries, input.path).toContainEqual(
        expect.objectContaining({ path: input.path, ...reviewFlags(input) }),
      );
    }
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
    mkdirSync(join(review.root, '.devkit', 'baselines'), { recursive: true });
    writeFileSync(join(review.root, '.devkit', 'baselines', 'size.json'), '{"max":500}\n');
    const result = project(review.root, review.worktree);
    expect(result.status, result.stderr).toBe(0);
    const projected = join(review.worktree, 'guard.config.json');
    expect(lstatSync(projected).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(review.worktree, '.devkit', 'baselines')).isSymbolicLink()).toBe(false);
    writeFileSync(projected, '{"scanRoots":["runtime"]}\n');
    writeFileSync(join(review.worktree, '.devkit', 'baselines', 'size.json'), '{"max":1}\n');
    expect(readFileSync(materialized, 'utf8')).toContain('src');
    expect(readFileSync(join(review.root, '.devkit', 'baselines', 'size.json'), 'utf8')).toContain(
      '500',
    );
    expect(project(review.root, review.worktree, 'typo').status).toBe(2);
  });

  it.each(['main', 'linked'])(
    "ship links a linked worktree's own structure baselines, never the main worktree's (config in %s)",
    (configIn) => {
      const { root: main, worktree } = fixture();
      execFileSync('git', [
        '-C',
        main,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'base',
      ]);
      const linked = join(main, '..', 'linked checkout');
      execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '--detach', linked]);
      for (const [root, name] of [
        [main, 'a.mjs'],
        [linked, 'b.mjs'],
      ]) {
        mkdirSync(join(root, STRUCTURE_BASELINE_DIR), { recursive: true });
        writeFileSync(join(root, STRUCTURE_BASELINE_DIR, name), '');
      }
      writeFileSync(join(configIn === 'main' ? main : linked, 'guard.config.json'), '{}\n');

      const result = project(linked, worktree, 'ship');

      expect(result.status, result.stderr).toBe(0);
      expect(lstatSync(join(worktree, STRUCTURE_BASELINE_DIR, 'b.mjs')).isSymbolicLink()).toBe(
        true,
      );
      expect(
        lstatSync(join(worktree, STRUCTURE_BASELINE_DIR, 'a.mjs'), { throwIfNoEntry: false }),
      ).toBeUndefined();
    },
  );

  it('fails ship closed when the gate-input registry emits nothing', () => {
    const { root, worktree } = fixture();
    writeFileSync(join(root, 'guard.config.json'), '{}\n');
    const bin = join(root, '..', 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const result = project(root, worktree, 'ship', { PATH: `${bin}:${process.env.PATH}` });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gate-input registry emitted nothing');
    expect(
      lstatSync(join(worktree, 'guard.config.json'), { throwIfNoEntry: false }),
    ).toBeUndefined();
  });

  // sc-2175: the gitignored `guard-review waive` store must be projected — ship links it, review copies
  // it privately and must tolerate `reconcile` persisting an env override into that copy.
  describe('correctness-overrides waiver store', () => {
    const STORE = '.devkit/correctness-overrides.json';
    const seedStore = (root: string) => {
      mkdirSync(join(root, '.devkit'), { recursive: true });
      writeFileSync(join(root, STORE), '{"abc123def456":{"rationale":"false positive"}}\n');
    };

    it('ship links the store so an env write-through inside the worktree lands in the checkout', () => {
      const { root, worktree } = fixture();
      seedStore(root);
      const result = project(root, worktree, 'ship');
      expect(result.status, result.stderr).toBe(0);
      expect(lstatSync(join(worktree, STORE)).isSymbolicLink()).toBe(true);
      expect(result.stderr).toContain(STORE);
      writeFileSync(join(worktree, STORE), '{"abc123def456":{"rationale":"updated"}}\n');
      expect(lstatSync(join(worktree, STORE)).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(root, STORE), 'utf8')).toContain('updated');
    });

    it('ship with no recorded waiver projects nothing and still succeeds', () => {
      const { root, worktree } = fixture();
      const result = project(root, worktree, 'ship');
      expect(result.status, result.stderr).toBe(0);
      expect(() => lstatSync(join(worktree, STORE))).toThrow();
      expect(result.stderr).not.toContain(STORE);
    });

    it('review copies the store privately and a reconcile write-through still passes verify', () => {
      const { root, worktree } = fixture();
      seedStore(root);
      const manifest = join(root, '..', 'projection-runtime.json');
      const result = project(root, worktree);
      expect(result.status, result.stderr).toBe(0);
      expect(lstatSync(join(worktree, STORE)).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(worktree, STORE), 'utf8')).toContain('abc123def456');
      expect(mutableProjectionRoots(manifest)).toContain(STORE);
      writeFileSync(join(worktree, STORE), '{"abc123def456":{"rationale":"env write-through"}}\n');
      expect(() => verifyProjectionRuntime(root, worktree, manifest)).not.toThrow();
      expect(readFileSync(join(root, STORE), 'utf8')).toContain('false positive');
    });
  });

  // sc-2274: the linked-input notice may only prescribe "commit it" for real config. A local cache
  // that happens not to be gitignored must be named as one, never handed an imperative to commit it.
  describe('linked-input notice classifies local caches', () => {
    const COMMIT_HINT = 'commit it so gates are consistent';
    const noticeLine = (stderr: string, rel: string) =>
      stderr.split('\n').find((line) => line.startsWith(`   - ${rel} (`)) ?? '';
    type ProjectionConfig = { indexPath?: string; decisionsDir?: string };
    const seed = (root: string, config: ProjectionConfig) => {
      writeFileSync(join(root, 'guard.config.json'), JSON.stringify(config));
      for (const rel of [
        '.decisions/index.json',
        '.fallow/cache.bin',
        '.cache/search index.db',
        '.qavis/receipt.json',
      ]) {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), 'x');
      }
    };

    for (const purpose of ['ship', 'review']) {
      it(`${purpose}: un-ignored caches read as local, untracked config keeps the commit hint`, () => {
        const { root, worktree } = fixture();
        seed(root, { indexPath: '.cache/search index.db' });

        const result = project(root, worktree, purpose);

        expect(result.status, result.stderr).toBe(0);
        for (const rel of [
          '.decisions',
          '.fallow',
          '.cache/search index.db',
          '.qavis/receipt.json',
        ]) {
          expect(noticeLine(result.stderr, rel)).toContain('local cache');
          expect(noticeLine(result.stderr, rel)).not.toContain(COMMIT_HINT);
        }
        expect(noticeLine(result.stderr, 'guard.config.json')).toContain(COMMIT_HINT);
      });
    }

    // Records AT or BENEATH `.decisions` make it source; at `.` they sit beside it, leaving only the cache.
    for (const [decisionsDir, expected] of [
      ['.decisions', COMMIT_HINT],
      ['.decisions/records', COMMIT_HINT],
      ['.', 'local cache'],
    ]) {
      it(`decisionsDir "${decisionsDir}" gives .decisions the ${expected} wording`, () => {
        const { root, worktree } = fixture();
        seed(root, { decisionsDir });

        const result = project(root, worktree, 'ship');

        expect(result.status, result.stderr).toBe(0);
        expect(noticeLine(result.stderr, '.decisions')).toContain(expected);
      });
    }

    it('a gitignored cache keeps the existing "normal" wording ahead of the cache classifier', () => {
      const { root, worktree } = fixture();
      seed(root, {});
      writeFileSync(join(root, '.gitignore'), '.fallow/\n');

      const result = project(root, worktree, 'ship');

      expect(noticeLine(result.stderr, '.fallow')).toContain('gitignored cache — normal');
    });
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

  it('copies the SQLite family but its wal-index and isolates runtime writes from the target', () => {
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
      ['-journal', 'journal'],
    ]) {
      expect(readFileSync(`${join(worktree, indexPath)}${suffix}`, 'utf8')).toBe(content);
    }
    expect(
      lstatSync(`${join(worktree, indexPath)}-shm`, { throwIfNoEntry: false }),
    ).toBeUndefined();
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
        { beforeSourceVerification: () => appendFileSync(`${source}-wal`, 'mutation') },
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
        "import { appendFileSync, readFileSync } from 'node:fs';",
        `import { materializeProjectionRuntime } from ${JSON.stringify(pathToFileURL(projectionRuntime).href)};`,
        "const [command, sourceRoot, destinationRoot, manifestPath, indexPath = ''] = process.argv.slice(2);",
        "if (command !== 'materialize') throw new Error('unexpected projection command');",
        "const candidates = readFileSync(0).toString('utf8').split('\\0').filter(Boolean);",
        'const mutationPath = process.env.MUTATE_PROJECTION_PATH;',
        "if (!mutationPath) throw new Error('mutation path is unavailable');",
        'try {',
        '  materializeProjectionRuntime(sourceRoot, destinationRoot, manifestPath, candidates, indexPath, {',
        "    beforeSourceVerification: () => appendFileSync(mutationPath, 'mutation'),",
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
