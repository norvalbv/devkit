import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectionRemedy,
  formatMissingRootDependencies,
  installDirFor,
  missingDeclaredDependencies,
  missingModule,
} from '../dependencies.mts';
import { readClearMarker, writeClearMarker } from '../clear-marker/store.mts';
import { formatClearMarker, formatDiagnosis, readDiagnosis } from '../failures.mts';

let roots: string[] = [];
const makeRoot = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-collection-')));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const put = (root: string, rel: string, body = '{}') => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};

const declares = (...names: string[]) =>
  JSON.stringify({ dependencies: Object.fromEntries(names.map((n) => [n, '1'])) });

/** vitest's json reporter, trimmed to the fields readDiagnosis reads. */
const results = (root: string, testResults: unknown[]): string => {
  const file = join(root, 'results.json');
  writeFileSync(file, JSON.stringify({ testResults }));
  return file;
};

/** The shape real vitest 5 writes for a file whose import chain hits an uninstalled package. */
const importFailure = (root: string) => ({
  name: join(root, 'test/a.test.ts'),
  status: 'failed',
  message: `Cannot find package 'helmet' imported from ${join(root, 'relay/src/index.ts')}`,
  assertionResults: [],
});

describe('readDiagnosis collection failures', () => {
  it('records a suite that failed with no assertion results as a collection failure', () => {
    const root = makeRoot();
    const suite = importFailure(root);
    const diagnosis = readDiagnosis(results(root, [suite]), 1);
    expect(diagnosis?.collection).toEqual([{ file: suite.name, message: suite.message }]);
    expect(diagnosis?.failedFiles).toEqual([suite.name]);
  });

  it('does not call an afterAll failure a collection failure: its tests ran', () => {
    const root = makeRoot();
    const diagnosis = readDiagnosis(
      results(root, [
        {
          name: '/repo/after.test.ts',
          status: 'failed',
          message: 'AssertionError: expected 1 to be 2',
          assertionResults: [{ fullName: 'ok', status: 'passed', failureMessages: [] }],
        },
      ]),
      1,
    );
    expect(diagnosis?.failedFiles).toEqual(['/repo/after.test.ts']);
    expect(diagnosis?.collection).toBeUndefined();
  });

  // The marker keeps one message per file; a transform error can carry a whole code frame.
  it('bounds the stored message without losing the cause on its first line', () => {
    const root = makeRoot();
    const suite = importFailure(root);
    const message = `${suite.message}\n${'x'.repeat(50_000)}`;
    const [stored] = readDiagnosis(results(root, [{ ...suite, message }]), 1)?.collection ?? [];
    expect(stored?.message).toHaveLength(2000);
    expect(stored?.message.split('\n')[0]).toBe(suite.message);
  });

  it('leaves a whole-file hook timeout to the timeout path', () => {
    const root = makeRoot();
    const diagnosis = readDiagnosis(
      results(root, [
        {
          name: '/repo/hook.test.ts',
          status: 'failed',
          message: 'Hook timed out in 10000ms.',
          assertionResults: [],
        },
      ]),
      1,
    );
    expect(diagnosis?.collection).toBeUndefined();
  });
});

describe('formatDiagnosis collection lines', () => {
  it('names the first cause and the nested package install that fixes it', () => {
    const root = makeRoot();
    put(root, 'package.json');
    put(root, 'bun.lock');
    put(root, 'relay/package.json', declares('helmet'));
    put(root, 'relay/bun.lock');
    const diagnosis = readDiagnosis(results(root, [importFailure(root), importFailure(root)]), 1);
    const lines = formatDiagnosis(diagnosis!, root, null);
    expect(lines).toContain(
      '🚫 1 test file(s) failed to COLLECT — no test in them ran. First cause:',
    );
    expect(lines).toContain(
      `     test/a.test.ts — Cannot find package 'helmet' imported from ${join(root, 'relay/src/index.ts')}`,
    );
    expect(lines).toContain(
      '   A dependency is not installed. Run: (cd relay && bun install --frozen-lockfile)',
    );
  });

  it('prints the first cause without a remedy when the error is not a missing module', () => {
    const root = makeRoot();
    const diagnosis = readDiagnosis(
      results(root, [
        {
          name: join(root, 'b.test.ts'),
          status: 'failed',
          message: 'SyntaxError: Unexpected token\n    at line 3',
          assertionResults: [],
        },
      ]),
      1,
    );
    const lines = formatDiagnosis(diagnosis!, root, null);
    expect(lines).toContain('     b.test.ts — SyntaxError: Unexpected token');
    expect(lines.some((l) => l.includes('Run:'))).toBe(false);
  });
});

describe('missingModule', () => {
  it.each([
    ["Cannot find package 'helmet' imported from /w/relay/src/index.ts", '/w/relay/src/index.ts'],
    [
      "Cannot find module 'helmet'\nRequire stack:\n- /w/relay/src/index.cjs\n- /w/test/a.test.ts",
      '/w/relay/src/index.cjs',
    ],
    [
      'Failed to resolve import "helmet" from "relay/src/index.ts". Does the file exist?',
      'relay/src/index.ts',
    ],
    [
      'Failed to load url helmet (resolved id: helmet) in /w/relay/src/index.ts. Does the file exist?',
      '/w/relay/src/index.ts',
    ],
    ["Cannot find package 'helmet' imported from file:///w/relay/x.ts", '/w/relay/x.ts'],
    ["Cannot find package 'helmet' imported from /w/a.ts\n    at stack (/w/b.ts:1:1)", '/w/a.ts'],
  ])('reads the importer from %j', (message, importer) => {
    expect(missingModule(message)).toEqual({ specifier: 'helmet', importer });
  });

  it('returns null for an error that names no missing module', () => {
    expect(missingModule('TypeError: x is not a function')).toBeNull();
  });

  // A checkout under "Application Support" is ordinary on macOS; a path cut at the first space
  // resolves to some other directory, or to none.
  it('keeps an importer path that contains spaces, in every wording', () => {
    const importer = '/Users/a/My Projects/app/relay/src/index.ts';
    for (const message of [
      `Cannot find package 'helmet' imported from ${importer}`,
      `Cannot find module 'helmet'\nRequire stack:\n- ${importer}\n- /x/a.test.ts`,
      `Failed to resolve import "helmet" from "${importer}". Does the file exist?`,
      `Failed to load url helmet (resolved id: helmet) in ${importer}. Does the file exist?`,
      `Cannot find package 'helmet' imported from file:///Users/a/My%20Projects/app/relay/src/index.ts`,
    ]) {
      expect(missingModule(message)?.importer).toBe(importer);
    }
  });
});

describe('installDirFor', () => {
  const missing = (root: string, rel: string, specifier = 'helmet') => ({
    specifier,
    importer: join(root, rel),
  });

  it('skips an installed package under node_modules and names the package that owns it', () => {
    const root = makeRoot();
    put(root, 'relay/package.json');
    put(root, 'relay/bun.lock');
    put(root, 'relay/node_modules/foo/package.json');
    put(root, 'relay/node_modules/foo/package-lock.json');
    expect(installDirFor(missing(root, 'relay/node_modules/foo/index.js'), root)).toBe(
      join(root, 'relay'),
    );
  });

  it('passes over a workspace member with no lockfile to the root that installs it', () => {
    const root = makeRoot();
    put(root, 'package.json', JSON.stringify({ workspaces: ['packages/*', '!packages/out'] }));
    put(root, 'yarn.lock');
    put(root, 'packages/a/package.json', declares('@scope/q'));
    expect(installDirFor(missing(root, 'packages/a/src/x.ts', '@scope/q/sub'), root)).toBe(root);
    expect(
      collectionRemedy(
        `Cannot find package '@scope/q' imported from ${root}/packages/a/x.ts`,
        root,
      ),
    ).toBe('yarn install --immutable');
    put(root, 'package.json', JSON.stringify({ workspaces: { packages: ['packages/a/'] } }));
    expect(installDirFor(missing(root, 'packages/a/src/x.ts', '@scope/q'), root)).toBe(root);
  });

  // The root's install only reaches a package its `workspaces` lists; any other nested package
  // without a lockfile has no install this can name.
  it('names no install for a nested package the root lockfile does not cover', () => {
    const root = makeRoot();
    put(root, 'bun.lock');
    put(root, 'relay/package.json', declares('helmet'));
    put(root, 'packages/out/package.json', declares('helmet'));
    for (const manifest of [
      {},
      { workspaces: ['packages/*', '!packages/out'] },
      { workspaces: 7 },
    ]) {
      put(root, 'package.json', JSON.stringify(manifest));
      expect(installDirFor(missing(root, 'relay/src/index.ts'), root)).toBeNull();
      expect(installDirFor(missing(root, 'packages/out/x.ts'), root)).toBeNull();
    }
  });

  // A missing subpath of an installed package reads like a missing package; installing fixes nothing.
  it('names no install when the package already resolves from the importer', () => {
    const root = makeRoot();
    put(root, 'package.json', JSON.stringify({ workspaces: ['relay'] }));
    put(root, 'bun.lock');
    put(root, 'relay/package.json', declares('helmet', '@scope/q'));
    put(root, 'relay/bun.lock');
    put(root, 'relay/node_modules/helmet/package.json');
    put(root, 'node_modules/@scope/q/package.json');
    expect(
      installDirFor(missing(root, 'relay/src/index.ts', 'helmet/lib/missing'), root),
    ).toBeNull();
    expect(installDirFor(missing(root, 'relay/src/index.ts', '@scope/q/gone'), root)).toBeNull();
    expect(
      collectionRemedy(
        'Failed to resolve import "helmet/lib/missing" from "relay/src/index.ts"',
        root,
      ),
    ).toBeNull();
  });

  it('does not read an inherited object key as a declared package', () => {
    const root = makeRoot();
    put(root, 'package.json', declares('express'));
    put(root, 'bun.lock');
    expect(installDirFor(missing(root, 'src/x.ts', 'constructor'), root)).toBeNull();
  });

  // A nested package that leans on the root's install: installing the nested one would fix nothing.
  it('passes over a lockfile-owning package that does not declare the missing package', () => {
    const root = makeRoot();
    put(root, 'package.json', declares('helmet'));
    put(root, 'bun.lock');
    put(root, 'relay/package.json', declares('express'));
    put(root, 'relay/bun.lock');
    expect(installDirFor(missing(root, 'relay/src/index.ts'), root)).toBe(root);
  });

  it('names no install when nothing declares the package, or the import is not a package', () => {
    const root = makeRoot();
    put(root, 'package.json', declares('express'));
    put(root, 'bun.lock');
    expect(installDirFor(missing(root, 'src/index.ts'), root)).toBeNull();
    put(root, 'package.json', '{ not json');
    expect(installDirFor(missing(root, 'src/index.ts'), root)).toBeNull();
    put(root, 'package.json', declares('helmet'));
    for (const specifier of [
      './helmet',
      '../helmet',
      '/abs/helmet.ts',
      'node:helmet',
      '@/helmet',
    ]) {
      expect(installDirFor(missing(root, 'src/index.ts', specifier), root)).toBeNull();
    }
    expect(
      collectionRemedy(`Failed to resolve import "./gone" from "${root}/src/index.ts"`, root),
    ).toBeNull();
  });

  it('never climbs above the root', () => {
    const root = makeRoot();
    const inner = join(root, 'repo');
    put(root, 'package.json', declares('helmet'));
    put(root, 'bun.lock');
    mkdirSync(inner);
    expect(installDirFor(missing(inner, 'src/x.ts'), inner)).toBeNull();
    expect(installDirFor(missing(root, 'elsewhere/x.ts'), inner)).toBeNull();
  });

  // vitest reports realpaths; the cwd devkit is handed may be a symlink to the same tree.
  it('resolves through a symlinked cwd, and quotes a directory a shell would split', () => {
    const root = makeRoot();
    put(root, 'my relay/package.json', declares('helmet'));
    put(root, 'my relay/bun.lock');
    const link = `${root}-link`;
    symlinkSync(root, link);
    roots.push(link);
    const message = `Cannot find package 'helmet' imported from ${root}/my relay/src/index.ts`;
    expect(collectionRemedy(message, link)).toBe(
      "(cd 'my relay' && bun install --frozen-lockfile)",
    );
  });
});

describe('clear marker collection errors', () => {
  it('round-trips and is printed by the gate', () => {
    const root = makeRoot();
    put(root, 'relay/package.json', declares('helmet'));
    put(root, 'relay/yarn.lock');
    const error = importFailure(root);
    writeClearMarker(root, {
      clearedAt: new Date().toISOString(),
      previousMtime: null,
      head: null,
      failedFiles: [error.name],
      collectionErrors: [{ file: error.name, message: error.message }],
    });
    const marker = readClearMarker(root);
    expect(marker?.collectionErrors).toEqual([{ file: error.name, message: error.message }]);
    expect(formatClearMarker(marker!, root)).toContain(
      '   A dependency is not installed. Run: (cd relay && yarn install --immutable)',
    );
  });

  it('reads a marker written before the field existed', () => {
    const root = makeRoot();
    put(
      root,
      '.last-clear.json',
      JSON.stringify({ clearedAt: new Date().toISOString(), failedFiles: [] }),
    );
    const marker = readClearMarker(root);
    expect(marker?.collectionErrors).toBeUndefined();
    expect(formatClearMarker(marker!, root).some((l) => l.includes('COLLECT'))).toBe(false);
  });

  it('drops a hand-edited entry with no file', () => {
    const root = makeRoot();
    const collectionErrors = [{ file: null, message: 'hand edit' }, { message: 7 }];
    put(
      root,
      '.last-clear.json',
      JSON.stringify({ clearedAt: new Date().toISOString(), failedFiles: [], collectionErrors }),
    );
    expect(readClearMarker(root)?.collectionErrors).toEqual([]);
  });
});

describe('formatMissingRootDependencies', () => {
  it('warns with the names and the install command', () => {
    const root = makeRoot();
    put(root, 'package.json', JSON.stringify({ devDependencies: { '@scope/a': '1', b: '1' } }));
    put(root, 'bun.lock');
    put(root, 'node_modules/b/package.json');
    expect(formatMissingRootDependencies(root)).toEqual([
      '⚠️  1 declared dependency is not installed: @scope/a',
      '   Test files importing them will fail to load. Run `bun install --frozen-lockfile` first.',
    ]);
  });

  it('is silent when everything is installed, and when the manifest is unreadable', () => {
    const root = makeRoot();
    put(root, 'package.json', JSON.stringify({ dependencies: { b: '1' } }));
    put(root, 'node_modules/b/package.json');
    expect(formatMissingRootDependencies(root)).toEqual([]);
    put(root, 'package.json', '{ not json');
    expect(formatMissingRootDependencies(root)).toEqual([]);
  });
});

describe('root dependency warning', () => {
  // A workspace member run from its own directory: its dependencies live in the root's node_modules.
  it('is silent for a dependency an ancestor node_modules provides', () => {
    const root = makeRoot();
    put(root, 'node_modules/b/package.json');
    put(root, 'packages/a/package.json', JSON.stringify({ dependencies: { b: '1', c: '1' } }));
    expect(formatMissingRootDependencies(join(root, 'packages/a'))[0]).toBe(
      '⚠️  1 declared dependency is not installed: c',
    );
    put(root, 'node_modules/c/package.json');
    expect(formatMissingRootDependencies(join(root, 'packages/a'))).toEqual([]);
  });

  it('names no command when the directory has no lockfile to install from', () => {
    const root = makeRoot();
    put(root, 'package.json', declares('helmet'));
    expect(formatMissingRootDependencies(root)[1]).toBe(
      '   Test files importing them will fail to load. Install them first.',
    );
  });

  it('caps the listed names', () => {
    const root = makeRoot();
    const names = Array.from({ length: 12 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    put(root, 'package.json', declares(...names));
    expect(formatMissingRootDependencies(root)[0]).toBe(
      `⚠️  12 declared dependencies are not installed: ${names.slice(0, 10).join(', ')}, …`,
    );
  });
});

describe('missingDeclaredDependencies', () => {
  it('rejects a non-object section and an unsafe name, as ship always has', () => {
    const root = makeRoot();
    const manifest = join(root, 'package.json');
    writeFileSync(manifest, JSON.stringify({ dependencies: ['a'] }));
    expect(() => missingDeclaredDependencies(manifest, root)).toThrow('must be objects');
    writeFileSync(manifest, JSON.stringify({ dependencies: { '../evil': '1' } }));
    expect(() => missingDeclaredDependencies(manifest, root)).toThrow('invalid dependency name');
  });
});
