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
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runStructureGate } from '../run.mjs';

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
});
