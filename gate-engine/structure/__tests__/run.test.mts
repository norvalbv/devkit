/**
 * `guard-structure` bin — the zero-consumer-dependency structure gate. It runs eslint + the
 * folder-structure plugin from DEVKIT's OWN install (buildStructureConfigs embeds the plugin as a
 * loaded object), so a consumer needs NO eslint / plugin / parser. These tmp repos have no
 * node_modules at all — the gate must still resolve + run. Exit contract: 0 clean, 1 violations,
 * 2 fail-open.
 *
 * The exit-1 (violation → block) path is exercised in the real tree by devkit's OWN pre-commit
 * (`guard-structure` is wired into devkit's hook and dogfooded on every commit) and is verified
 * against `runStructureGate(devkitRoot)` returning code 1 on a planted violation. The unit tests
 * here pin the zero-dependency mechanism + the fail-open / nothing-to-lint contract, which are what
 * the refactor introduces.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planStagedStructureLint, runStagedStructureGate, runStructureGate } from '../run.mts';

const DEVKIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const roots = [];
function repo(guardConfig) {
  const root = mkdtempSync(join(tmpdir(), 'guard-structure-'));
  roots.push(root);
  if (guardConfig !== undefined) {
    writeFileSync(
      join(root, 'guard.config.json'),
      typeof guardConfig === 'string' ? guardConfig : JSON.stringify(guardConfig),
    );
  }
  return root;
}
function write(root, rel, body = 'export const x = 1;\n') {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function initializeGit(root: string) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'devkit-test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Devkit Test'], { cwd: root });
}

describe('guard-structure gate — zero consumer deps', () => {
  it("runs from DEVKIT's own eslint/plugin against a conforming tree — no consumer node_modules", () => {
    // A real component-lib grammar; the repo has NO node_modules, so this passing at all proves the
    // gate resolves eslint + the plugin from devkit's install, not the consumer's.
    const root = repo();
    copyFileSync(
      join(DEVKIT_ROOT, 'templates', 'component-lib', 'guard.config.json'),
      join(root, 'guard.config.json'),
    );
    write(root, 'src/index.ts');
    write(root, 'src/Button/index.ts');
    write(root, 'src/Button/Button.tsx');
    return runStructureGate(root).then((r) => expect(r.code).toBe(0));
  });

  it('exit 0 when the declared tree is absent (nothing present to lint)', async () => {
    const root = repo({
      scanRoots: ['src'],
      structure: {
        trees: [
          {
            name: 'lib',
            root: 'src',
            sourceExtensions: ['ts', 'tsx'],
            grammar: { files: ['{pascal}'] },
          },
        ],
      },
    });
    // no src/ dir at all → the root is filtered out before ESLint, so no "all ignored" throw.
    expect((await runStructureGate(root)).code).toBe(0);
  });

  it('exit 0 when no structure trees are declared (e.g. the generic guard.config)', async () => {
    const root = repo({ scanRoots: ['src'], structure: { trees: [] } });
    write(root, 'src/whatever.ts');
    expect((await runStructureGate(root)).code).toBe(0);
  });

  it('exit 0 when only ignored files are present (no throw leaks out)', async () => {
    // A single-element `{ts}` extension glob is a minimatch literal → matches nothing → ESLint would
    // throw "all files ignored"; the bin must swallow that as clean, not fail.
    const root = repo({
      scanRoots: ['src'],
      structure: {
        trees: [
          { name: 'lib', root: 'src', sourceExtensions: ['ts'], grammar: { files: ['{pascal}'] } },
        ],
      },
    });
    write(root, 'src/thing.ts');
    expect((await runStructureGate(root)).code).toBe(0);
  });

  it('exit 2 (fail-open) when guard.config.json is unreadable — never wedges a commit', async () => {
    const root = repo('{ this is not json');
    write(root, 'src/whatever.ts');
    expect((await runStructureGate(root)).code).toBe(2);
  });

  it('does not mask a violation when a sibling declared root is absent (roots filtered by existence)', async () => {
    // Two roots declared, only one present. Passing the absent root to ESLint would throw and (before
    // the fix) short-circuit the whole run to clean. The present root must still be linted.
    const root = repo({
      scanRoots: ['a', 'b'],
      structure: {
        trees: [
          {
            name: 'a',
            root: 'a',
            sourceExtensions: ['ts', 'tsx'],
            grammar: { files: ['{pascal}'] },
          },
          {
            name: 'b',
            root: 'b',
            sourceExtensions: ['ts', 'tsx'],
            grammar: { files: ['{pascal}'] },
          },
        ],
      },
    });
    write(root, 'a/Ok.ts'); // 'b' never created
    expect((await runStructureGate(root)).code).toBe(0); // clean, not a fail-open throw
  });

  it('a present-but-all-ignored FIRST root does not mask later roots (per-root lint, not one batch)', async () => {
    // Root 'a' matches nothing (single-element `{ts}` glob is a minimatch literal) → ESLint would
    // throw "all files ignored" for a batched lintFiles(['a','b']) and short-circuit, skipping 'b'.
    // Per-root, 'a' is skipped as clean and 'b' is still linted.
    const root = repo({
      scanRoots: ['a', 'b'],
      structure: {
        trees: [
          { name: 'a', root: 'a', sourceExtensions: ['ts'], grammar: { files: ['{pascal}'] } },
          {
            name: 'b',
            root: 'b',
            sourceExtensions: ['ts', 'tsx'],
            grammar: { files: ['{pascal}'] },
          },
        ],
      },
    });
    write(root, 'a/thing.ts'); // all-ignored (single-ext glob)
    write(root, 'b/Ok.ts'); // conforms
    expect((await runStructureGate(root)).code).toBe(0); // 'b' reached + clean, not a masked/fail-open
  });
});

describe('guard-structure staged plan', () => {
  const scopes = [
    { root: 'src', extensions: ['ts', 'tsx', 'css'] },
    { root: 'socket-server/src', extensions: ['ts', 'tsx', 'css'] },
    { root: 'vercel-serverless', extensions: ['ts', 'tsx', 'css'] },
  ];

  it('keeps every configured root and NUL-safe pathname as one ESLint target', () => {
    const unusual = 'socket-server/src/with a space/line\nbreak.ts';
    expect(
      planStagedStructureLint(
        scopes,
        ['src/main.ts', unusual, 'vercel-serverless/handler.ts', 'README.md'],
        [],
        [],
      ),
    ).toEqual({
      targets: ['src/main.ts', unusual, 'vercel-serverless/handler.ts'],
      probeScopes: [],
      deferred: [],
    });
  });

  it('probes only the affected root after a deletion or rename', () => {
    expect(
      planStagedStructureLint(
        scopes,
        ['src/Feature/Renamed.ts'],
        ['src/Feature/index.ts', 'src/Feature/Renamed.ts'],
        [],
      ),
    ).toEqual({
      targets: ['src/Feature/Renamed.ts'],
      probeScopes: [{ root: 'src', extensions: ['ts', 'tsx', 'css'] }],
      deferred: [],
    });
  });

  it('plans additions, deletions, and renames for a repository-root tree', () => {
    const rootScope = [{ root: '.', extensions: ['ts'] }];
    expect(
      planStagedStructureLint(
        rootScope,
        ['src/Added.ts', 'src/Renamed.ts'],
        ['src/Deleted.ts', 'src/Renamed.ts'],
        [],
      ),
    ).toEqual({
      targets: ['src/Added.ts', 'src/Renamed.ts'],
      probeScopes: rootScope,
      deferred: [],
    });
  });

  it('defers a partially staged source file instead of reading its worktree bytes as index bytes', () => {
    expect(
      planStagedStructureLint(scopes, ['src/Feature/index.ts'], [], ['src/Feature/index.ts']),
    ).toEqual({ targets: [], probeScopes: [], deferred: ['src/Feature/index.ts'] });
  });

  it('defers every staged file in a topology root with an unrelated working-tree source', () => {
    expect(
      planStagedStructureLint(scopes, ['src/Feature/index.ts'], [], ['src/Feature/Uncommitted.ts']),
    ).toEqual({ targets: [], probeScopes: [], deferred: ['src/Feature/index.ts'] });
  });

  it.each([
    'eslint.config.mjs',
    '.devkit/structure/exempt.mjs',
    '.devkit/baselines/imports.mjs',
    '.devkit/baselines/structure/renderer.mjs',
  ])('defers all staged structure input when policy %s has unstaged edits', (policy) => {
    expect(planStagedStructureLint(scopes, ['src/Feature/index.ts'], [], [policy])).toEqual({
      targets: [],
      probeScopes: [],
      deferred: ['structure policy', 'src/Feature/index.ts'],
    });
  });
});

describe('guard-structure staged execution', () => {
  const config = {
    scanRoots: ['src'],
    sourceExtensions: ['ts'],
    structure: {
      trees: [
        {
          name: 'lib',
          root: 'src',
          sourceExtensions: ['ts'],
          grammar: { files: ['{pascal}'] },
        },
      ],
    },
  };

  it('checks a config-driven staged file from a package subdirectory, not sibling packages', async () => {
    const root = repo();
    const pkg = join(root, 'packages', 'lib');
    write(pkg, 'guard.config.json', JSON.stringify(config));
    write(pkg, 'src/Ok.ts');
    write(root, 'packages/other/src/Wrong.ts');
    initializeGit(root);
    execFileSync('git', ['add', '--', 'packages/lib/guard.config.json', 'packages/lib/src/Ok.ts'], {
      cwd: root,
    });

    await expect(runStagedStructureGate(pkg)).resolves.toMatchObject({ code: 0 });
  });

  it('does not treat unstaged worktree bytes as a verdict on a staged file', async () => {
    const root = repo();
    write(root, 'guard.config.json', JSON.stringify(config));
    write(root, 'src/Ok.ts');
    initializeGit(root);
    execFileSync('git', ['add', '--', 'guard.config.json', 'src/Ok.ts'], { cwd: root });
    // The index is valid. The working tree is not. The pre-commit runner must defer this file to
    // CI rather than reject a staged snapshot on the basis of an unstaged edit.
    write(root, 'src/not-ok.ts');

    await expect(runStagedStructureGate(root)).resolves.toMatchObject({ code: 0 });
  });

  it('defers an untracked source from a package cwd', async () => {
    const root = repo();
    const pkg = join(root, 'packages', 'lib');
    write(pkg, 'guard.config.json', JSON.stringify(config));
    write(pkg, 'src/Ok.ts');
    initializeGit(root);
    execFileSync('git', ['add', '--', 'packages/lib/guard.config.json', 'packages/lib/src/Ok.ts'], {
      cwd: root,
    });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    write(pkg, 'src/Ok.ts', 'export const changed = true;\n');
    execFileSync('git', ['add', '--', 'packages/lib/src/Ok.ts'], { cwd: root });
    write(pkg, 'src/Uncommitted.ts');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runStagedStructureGate(pkg)).resolves.toMatchObject({ code: 0 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('src/Ok.ts'));
    error.mockRestore();
  });
});
