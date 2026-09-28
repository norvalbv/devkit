// guard-structure runs eslint + the plugin from devkit's OWN install, so these tmp repos (outside
// devkit's checkout, no node_modules) also pin the absolute projectRoot anchoring (sc-2309).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  combineStructureResults,
  planStagedStructureLint,
  runStagedStructureGate,
  runStructureGate,
} from '../run.mts';

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

  it('exit 2 when the declared tree is absent (inspected nothing — not clean)', async () => {
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
    const result = await runStructureGate(root);
    expect(result.code).toBe(2);
    expect(result.text).toContain('did NOT run');
  });

  it('exit 2 when no structure trees are declared (e.g. the generic guard.config)', async () => {
    const root = repo({ scanRoots: ['src'], structure: { trees: [] } });
    write(root, 'src/whatever.ts');
    const result = await runStructureGate(root);
    expect(result.code).toBe(2);
    expect(result.text).toContain('did NOT run');
  });

  it('exit 2 when a present root declares no grammar (the electron/preset consumer)', async () => {
    const root = repo({
      scanRoots: ['src'],
      structure: { trees: [{ name: 'lib', root: 'src', sourceExtensions: ['ts'] }] },
    });
    write(root, 'src/whatever.ts');
    const result = await runStructureGate(root);
    expect(result.code).toBe(2);
    expect(result.text).toContain('preset-only');
  });

  it('exit 0 when only ignored files are present (no throw leaks out)', async () => {
    // A root holding no file of a governed extension → ESLint throws "no files matching"; the bin
    // must swallow that as clean, not fail. (`thing.ts` here would be LINTED — and violate {pascal}.)
    const root = repo({
      scanRoots: ['src'],
      structure: {
        trees: [
          { name: 'lib', root: 'src', sourceExtensions: ['ts'], grammar: { files: ['{pascal}'] } },
        ],
      },
    });
    write(root, 'src/notes.md');
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
    write(root, 'a/bad-name.ts');
    expect((await runStructureGate(root)).code).toBe(1); // the present root is really enforced
  });

  it('a present-but-all-ignored FIRST root does not mask later roots (per-root lint, not one batch)', async () => {
    // Root 'a' holds nothing lintable, which would throw for a batched lintFiles(['a','b']); per-root,
    // 'a' is skipped as clean and 'b' is still linted — proven by 'b' reporting a real violation.
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
    write(root, 'a/notes.md'); // nothing lintable in 'a'
    write(root, 'b/Ok.ts'); // conforms
    expect((await runStructureGate(root)).code).toBe(0); // 'b' reached + clean, not a masked/fail-open
    write(root, 'b/bad-name.ts');
    expect((await runStructureGate(root)).code).toBe(1); // ...and 'b' is genuinely enforced
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

  it.each([
    'eslint.config.mjs.bak',
    'guard.config.json.orig',
    'eslint/domains.mjs~',
    '.devkit/config.json.backup',
    '.devkit/structure/exempt.mjs.old',
    '.devkit/baselines/imports.mjs.tmp',
  ])('does not treat %s (a name extending a policy file) as policy', (lookalike) => {
    expect(planStagedStructureLint(scopes, ['src/Feature/index.ts'], [], [lookalike])).toEqual({
      targets: ['src/Feature/index.ts'],
      probeScopes: [],
      deferred: [],
    });
  });

  it.each(['.devkit/config.json', 'eslint.config.mjs', 'guard.config.json'])(
    'a staged DELETION of policy %s probes every root, like an edit would',
    (policy) => {
      expect(planStagedStructureLint(scopes, [], [policy], []).probeScopes).toEqual(scopes);
    },
  );

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
    '.devkit/config.json',
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

    // Deferred, not rejected (never 1) — and never a vacuous clean 0: it inspected nothing.
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(2);
    expect(result.text).toContain('src/Ok.ts');
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

    const result = await runStagedStructureGate(pkg);
    expect(result.code).toBe(2);
    expect(result.text).toContain('src/Ok.ts');
  });

  it('a deletion that empties a root reports its skipped probe as could-not-run, not clean', async () => {
    const root = repo();
    write(root, 'guard.config.json', JSON.stringify(config));
    write(root, 'src/Ok.ts');
    initializeGit(root);
    execFileSync('git', ['add', '--', 'guard.config.json', 'src/Ok.ts'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    write(root, 'src/Gone.ts');
    execFileSync('git', ['add', '--', 'src/Gone.ts'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'second'], { cwd: root });
    execFileSync('git', ['rm', '-q', '--', 'src/Gone.ts', 'src/Ok.ts'], { cwd: root });
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(2); // the deletion emptied the root: its probe could not run
    expect(result.text).toContain('src');
  });

  it('exit 0 when nothing structure-relevant is staged (delegation must not become an opt-out)', async () => {
    const root = repo();
    write(root, 'guard.config.json', JSON.stringify(config));
    write(root, 'src/Ok.ts');
    write(root, 'README.md');
    initializeGit(root);
    execFileSync('git', ['add', '--', 'README.md'], { cwd: root });

    await expect(runStagedStructureGate(root)).resolves.toMatchObject({ code: 0 });
  });

  it('exit 2, not 1, when the electron path has no locally pinned eslint binary', async () => {
    const root = repo({ scanRoots: ['src'], sourceExtensions: ['ts'] });
    write(root, 'src/whatever.ts');
    initializeGit(root);
    execFileSync('git', ['add', '--', 'guard.config.json', 'src/whatever.ts'], { cwd: root });

    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(2);
    expect(result.text).toContain('did NOT run');
  });
});

// sc-3149: the preset is a stub eslint.js that logs its argv and fails any "Bad" path — this pins the
// leg wiring; the real electron template's rules are pinned by cli/__tests__/electron-*.test.mts.
describe('guard-structure mixed electron preset + grammar trees', () => {
  const STUB = `const { appendFileSync, readdirSync, statSync } = require('node:fs');
const files = process.argv.slice(process.argv.indexOf('--') + 1);
appendFileSync(require('node:path').join(process.cwd(), 'preset-calls.log'), JSON.stringify(files) + '\\n');
const flags = process.argv.slice(2, process.argv.indexOf('--'));
appendFileSync(require('node:path').join(process.cwd(), 'preset-flags.log'), JSON.stringify(flags) + '\\n');
const names = files.flatMap((f) => (statSync(f).isDirectory() ? readdirSync(f, { recursive: true }) : [f]));
if (names.some((f) => String(f).includes('Crash'))) { console.error('Oops! Something went wrong!'); process.exit(2); }
if (names.some((f) => String(f).includes('Bad'))) { console.log('PRESET-VIOLATION'); process.exit(1); }
`;
  const cliTree = {
    name: 'cli',
    root: 'cli',
    sourceExtensions: ['ts', 'tsx'],
    grammar: { files: ['{kebab}'] },
  };
  const mixedConfig = { scanRoots: ['src'], structure: { trees: [cliTree] } };

  function electronRepo({ stack = 'electron', preset = true, config = mixedConfig } = {}) {
    const root = repo(config);
    if (stack !== null) write(root, '.devkit/config.json', JSON.stringify({ stack }));
    if (preset) write(root, 'node_modules/eslint/bin/eslint.js', STUB);
    write(root, '.gitignore', 'node_modules/\npreset-calls.log\npreset-flags.log\n');
    initializeGit(root);
    commitAll(root); // policy files committed, so the staged plan sees only what a test stages
    return root;
  }
  function commitAll(root) {
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'setup'], { cwd: root });
  }
  function stage(root, ...files) {
    for (const file of files) write(root, file);
    execFileSync('git', ['add', '--', ...files], { cwd: root });
  }
  function presetCalls(root): string[][] {
    try {
      return readFileSync(join(root, 'preset-calls.log'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  it('still runs the preset over a staged scanRoots file once a grammar tree is declared', async () => {
    const root = electronRepo();
    stage(root, 'src/Bad.ts');
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(1);
    expect(presetCalls(root)).toEqual([['src/Bad.ts']]);
  });

  it('runs the grammar leg on a staged grammar-root file and never hands it to the preset', async () => {
    const root = electronRepo();
    stage(root, 'cli/NotKebab.ts');
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(1);
    expect(result.text).toContain('NotKebab.ts');
    expect(presetCalls(root)).toEqual([]);
  });

  it('reports BOTH legs when each has a violation in one commit', async () => {
    const root = electronRepo();
    stage(root, 'src/Bad.ts', 'cli/NotKebab.ts');
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(1);
    expect(result.text).toContain('NotKebab.ts');
    expect(result.text).toContain('local eslint failed');
    expect(presetCalls(root)).toEqual([['src/Bad.ts']]);
  });

  it('a local eslint crash (exit 2, e.g. a broken config) is could-not-run, never a violation', async () => {
    const root = electronRepo();
    stage(root, 'src/Crash.ts');
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(2);
    expect(result.text).toContain('status 2');
  });

  it('a local eslint crash does not mask a grammar violation in the same commit', async () => {
    const root = electronRepo();
    stage(root, 'src/Crash.ts', 'cli/NotKebab.ts');
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(1);
    expect(result.text).toContain('NotKebab.ts');
    expect(result.text).toContain('status 2');
  });

  it('exit 0 when both legs are clean', async () => {
    const root = electronRepo();
    stage(root, 'src/Fine.ts', 'cli/fine-name.ts');
    await expect(runStagedStructureGate(root)).resolves.toMatchObject({ code: 0 });
    expect(presetCalls(root)).toEqual([['src/Fine.ts']]);
  });

  it('a missing local eslint does not mask a grammar violation (preset fail-open is per leg)', async () => {
    const root = electronRepo({ preset: false });
    stage(root, 'src/Fine.ts', 'cli/NotKebab.ts');
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(1);
    expect(result.text).toContain('NotKebab.ts');
    expect(result.text).toContain('locally pinned eslint binary');
  });

  it('a missing local eslint with a clean grammar leg is exit 2, never a claimed clean', async () => {
    const root = electronRepo({ preset: false });
    stage(root, 'src/Fine.ts', 'cli/fine-name.ts');
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(2);
    expect(result.text).toContain('did NOT run');
  });

  it('hands a file under a grammar root nested in a scanRoot to BOTH legs', async () => {
    const root = electronRepo({
      config: {
        scanRoots: ['src'],
        structure: { trees: [{ ...cliTree, root: 'src/cli' }] },
      },
    });
    stage(root, 'src/cli/BadCase.ts');
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(1);
    expect(result.text).toContain('BadCase.ts'); // grammar leg
    expect(presetCalls(root)).toEqual([['src/cli/BadCase.ts']]); // preset leg
  });

  it('keeps a preset-only tree entry on the preset leg (story repro step 3)', async () => {
    const root = electronRepo({
      config: {
        scanRoots: ['src'],
        structure: { trees: [{ name: 'renderer', root: 'src' }, cliTree] },
      },
    });
    stage(root, 'src/Bad.ts');
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(1);
    expect(presetCalls(root)).toEqual([['src/Bad.ts']]);
  });

  it('probes the preset leg after a staged deletion under scanRoots in a mixed repo', async () => {
    const root = electronRepo();
    stage(root, 'src/Keep.ts', 'src/Gone.ts', 'cli/fine-name.ts');
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    execFileSync('git', ['rm', '-q', '--', 'src/Gone.ts'], { cwd: root });
    await runStagedStructureGate(root);
    expect(presetCalls(root)).toEqual([['src/Keep.ts']]);
  });

  it('hands a grammar-scope deletion probe to the preset too when the preset owns the probe file', async () => {
    const root = electronRepo({
      config: {
        scanRoots: ['src'],
        structure: {
          trees: [{ ...cliTree, root: 'src/cli', sourceExtensions: ['ts', 'mts'] }],
        },
      },
    });
    stage(root, 'src/cli/keep-me.ts', 'src/cli/gone.mts');
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });
    execFileSync('git', ['rm', '-q', '--', 'src/cli/gone.mts'], { cwd: root });
    await runStagedStructureGate(root);
    expect(presetCalls(root)).toEqual([['src/cli/keep-me.ts']]);
  });

  it.each([
    ['a config without `stack`', '{}'],
    ['no .devkit/config.json', null],
  ])(
    'with %s, an electron manifest still selects the preset leg (recorded ?? detected)',
    async (_label, body) => {
      const root = electronRepo({ stack: null });
      if (body !== null) write(root, '.devkit/config.json', body);
      write(root, 'package.json', JSON.stringify({ devDependencies: { electron: '^30.0.0' } }));
      commitAll(root);
      stage(root, 'src/Bad.ts');
      expect((await runStagedStructureGate(root)).code).toBe(1);
      expect(presetCalls(root)).toEqual([['src/Bad.ts']]);
    },
  );

  it('defers when a DETECTED stack reads an unstaged package.json, never when the stack is recorded', async () => {
    const detected = electronRepo({ stack: null });
    write(detected, 'package.json', JSON.stringify({ devDependencies: { electron: '^30.0.0' } }));
    commitAll(detected);
    stage(detected, 'src/Bad.ts');
    write(detected, 'package.json', '{}'); // unstaged: the worktree no longer names electron
    const deferred = await runStagedStructureGate(detected);
    expect(deferred.code).toBe(2); // deferred as policy — visible, never a vacuous clean
    expect(deferred.text).toContain('structure policy');

    const recorded = electronRepo();
    write(recorded, 'package.json', '{}');
    commitAll(recorded);
    stage(recorded, 'src/Bad.ts');
    write(recorded, 'package.json', '{"name":"x"}'); // unstaged, but routing ignores the manifest
    expect((await runStagedStructureGate(recorded)).code).toBe(1);
  });

  it.each(['{ not json', '{"dependencies":5}', 'null'])(
    'with no recorded stack, a malformed package.json (%s) is could-not-run, never a silent non-electron',
    async (manifest) => {
      const root = electronRepo({ stack: null });
      write(root, 'package.json', manifest);
      commitAll(root);
      stage(root, 'src/Bad.ts');
      const result = await runStagedStructureGate(root);
      expect(result.code).toBe(2);
      expect(result.text).toContain('package.json');
    },
  );

  it('an unstaged stack flip in .devkit/config.json defers scanRoots input, never drops it as out of scope', async () => {
    const root = electronRepo();
    stage(root, 'src/Bad.ts');
    write(root, '.devkit/config.json', JSON.stringify({ stack: 'react-app' })); // unstaged
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(2);
    expect(result.text).toContain('src/Bad.ts');
  });

  it('a staged deletion of .devkit/config.json re-probes under the routing the commit leaves behind', async () => {
    const root = electronRepo();
    write(root, 'package.json', JSON.stringify({ devDependencies: { electron: '^30.0.0' } }));
    write(root, 'src/Bad.ts');
    commitAll(root);
    execFileSync('git', ['rm', '-q', '--', '.devkit/config.json'], { cwd: root });
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(1); // detected electron still owns src/, and the probe reached it
    expect(presetCalls(root)).toEqual([['src/Bad.ts']]);
  });

  it('never routes a non-electron repo without grammar to a local eslint (stack decides the leg)', async () => {
    const root = electronRepo({ stack: 'react-app', config: { scanRoots: ['src'] } });
    stage(root, 'src/Bad.ts');
    const result = await runStagedStructureGate(root);
    expect(result.code).toBe(2);
    expect(presetCalls(root)).toEqual([]);
  });

  it('runs the preset leg from a package subdirectory cwd with package-relative paths', async () => {
    const root = repo();
    const pkg = join(root, 'packages', 'app');
    write(pkg, 'guard.config.json', JSON.stringify(mixedConfig));
    write(pkg, '.devkit/config.json', JSON.stringify({ stack: 'electron' }));
    write(pkg, 'node_modules/eslint/bin/eslint.js', STUB);
    write(root, '.gitignore', 'node_modules/\npreset-calls.log\n');
    initializeGit(root);
    commitAll(root);
    stage(root, 'packages/app/src/Bad.ts');
    const result = await runStagedStructureGate(pkg);
    expect(result.code).toBe(1);
    expect(presetCalls(pkg)).toEqual([['src/Bad.ts']]);
  });

  it.each([
    ['no recorded stack', null],
    ['a non-electron stack', 'component-lib'],
  ])(
    'with %s, a grammar repo never invokes a local eslint (no double lint)',
    async (_label, stack) => {
      const root = electronRepo({ stack });
      stage(root, 'src/Bad.ts', 'cli/fine-name.ts');
      await expect(runStagedStructureGate(root)).resolves.toMatchObject({ code: 0 });
      expect(presetCalls(root)).toEqual([]);
    },
  );

  it.each([
    '{ not json',
    'null',
    '[]',
    '{"stack":42}',
    '{"stack":null}',
    '{"stack":["electron"]}',
    '{"stack":{}}',
  ])(
    'a present but unreadable .devkit/config.json (%s) is could-not-run, never a silent clean',
    async (body) => {
      const root = electronRepo();
      write(root, '.devkit/config.json', body);
      commitAll(root);
      stage(root, 'src/Bad.ts');
      const staged = await runStagedStructureGate(root);
      expect(staged.code).toBe(2);
      expect(staged.text).toContain('.devkit/config.json');
      const full = await runStructureGate(root);
      expect(full.code).toBe(2);
      expect(full.text).toContain('.devkit/config.json');
    },
  );

  describe('full gate (guard-structure gate)', () => {
    it('lints scanRoots through the preset in a mixed electron repo', async () => {
      const root = electronRepo();
      write(root, 'src/Bad.ts');
      write(root, 'cli/fine-name.ts');
      const result = await runStructureGate(root);
      expect(result.code).toBe(1);
      expect(presetCalls(root)).toEqual([['src']]);
    });

    it('lints a grammar root nested in a preset tree root once, not once per enclosing root', async () => {
      const root = electronRepo({
        config: {
          scanRoots: ['src'],
          structure: {
            trees: [
              { name: 'renderer', root: 'src' },
              { ...cliTree, root: 'src/cli' },
            ],
          },
        },
      });
      write(root, 'src/cli/NotKebab.ts');
      const result = await runStructureGate(root);
      expect(result).toMatchObject({ code: 1, errorCount: 1 });
    });

    it('runs the preset for a preset-only electron repo instead of reporting did-not-run', async () => {
      const root = electronRepo({ config: { scanRoots: ['src'] } });
      write(root, 'src/Fine.ts');
      await expect(runStructureGate(root)).resolves.toMatchObject({ code: 0 });
      expect(presetCalls(root)).toEqual([['src']]);
    });

    it('hands directory roots to the preset with --no-error-on-unmatched-pattern (empty root = clean)', async () => {
      const root = electronRepo({ config: { scanRoots: ['src'] } });
      write(root, 'src/notes.md');
      await runStructureGate(root);
      const flags = readFileSync(join(root, 'preset-flags.log'), 'utf8');
      expect(flags).toContain('--no-error-on-unmatched-pattern');
    });

    it('skips absent scanRoots when handing roots to the preset', async () => {
      const root = electronRepo({ config: { scanRoots: ['src', 'socket-server/src'] } });
      write(root, 'src/Fine.ts');
      await runStructureGate(root);
      expect(presetCalls(root)).toEqual([['src']]);
    });

    it('a missing local eslint with a clean grammar leg is exit 2, never a claimed clean', async () => {
      const root = electronRepo({ preset: false });
      write(root, 'src/Fine.ts');
      write(root, 'cli/fine-name.ts');
      expect((await runStructureGate(root)).code).toBe(2);
    });
  });
});

describe('combineStructureResults', () => {
  const ok = { code: 0 as const, errorCount: 0 };
  const bad = (text) => ({ code: 1 as const, errorCount: 1, text });
  const skip = (text) => ({ code: 2 as const, errorCount: 0, text });

  it.each([
    ['no legs', [], 0],
    ['all clean', [ok, ok], 0],
    ['violation beats fail-open', [skip('a'), bad('b')], 1],
    ['fail-open beats clean', [ok, skip('a')], 2],
  ])('%s', (_label, results, code) => {
    expect(combineStructureResults(results).code).toBe(code);
  });

  it('a violation still names a leg that did NOT run (no silent opt-out)', () => {
    const combined = combineStructureResults([skip('preset did NOT run'), bad('grammar error')]);
    expect(combined.code).toBe(1);
    expect(combined.text).toContain('grammar error');
    expect(combined.text).toContain('preset did NOT run');
  });

  it('sums error counts and keeps every violation text', () => {
    const combined = combineStructureResults([bad('first'), { ...bad('second'), errorCount: 2 }]);
    expect(combined).toMatchObject({ code: 1, errorCount: 3 });
    expect(combined.text).toContain('first');
    expect(combined.text).toContain('second');
  });
});

describe('planStagedStructureLint — overlapping scopes', () => {
  const preset = { root: 'src', extensions: ['ts', 'tsx', 'css'] };
  const grammar = { root: 'src/cli', extensions: ['ts', 'mts'] };

  it('targets a file matched by only the second scope (extension the first lacks)', () => {
    expect(
      planStagedStructureLint([preset, grammar], ['src/cli/tool.mts'], [], []).targets,
    ).toEqual(['src/cli/tool.mts']);
  });

  it('treats caller-named routing inputs as policy', () => {
    expect(
      planStagedStructureLint([preset], ['src/a.ts'], [], ['package.json'], ['package.json']),
    ).toMatchObject({ targets: [], deferred: ['structure policy', 'src/a.ts'] });
    expect(planStagedStructureLint([preset], ['src/a.ts'], [], ['package.json']).targets).toEqual([
      'src/a.ts',
    ]);
  });

  it('defers a file when ANY scope that owns it is unstable', () => {
    expect(
      planStagedStructureLint([preset, grammar], ['src/cli/tool.ts'], [], ['src/cli/other.mts']),
    ).toMatchObject({ targets: [], deferred: ['src/cli/tool.ts'] });
  });
});
