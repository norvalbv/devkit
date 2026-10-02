// sc-3148: the REAL Electron template + a CLI grammar tree, each leg blocking on its own. run.test
// stubs the preset, so only this suite catches a dropped template rule.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const DEVKIT_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const RUN = join(DEVKIT_ROOT, 'gate-engine/structure/run.mts');
const SLOW = 120_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLI_TREE = {
  name: 'cli',
  root: 'cli',
  sourceExtensions: ['ts'],
  grammar: { files: ['{kebab}'] },
};
const ELECTRON_WALL_PROBE = 'src/renderer/lib/utils/import-main.ts';
const CLI_PLACEMENT_PROBE = 'cli/BadName.ts';

function write(root: string, relativePath: string, content = 'export {};\n') {
  mkdirSync(dirname(join(root, relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), content);
}

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

function mixedRepo(walls: object[] = [], trees: object[] = [CLI_TREE]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'electron-cli-grammar-')));
  roots.push(root);
  symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  write(root, 'package.json', '{"type":"module","devDependencies":{"electron":"^30.0.0"}}\n');
  write(root, '.devkit/config.json', '{"stack":"electron"}\n');
  write(
    root,
    'guard.config.json',
    JSON.stringify({
      scanRoots: ['src'],
      backends: { socketServer: false, vercel: false },
      structure: { trees, walls },
    }),
  );
  copyFileSync(
    join(DEVKIT_ROOT, 'templates/electron/eslint.config.mjs'),
    join(root, 'eslint.config.mjs'),
  );
  mkdirSync(join(root, 'eslint'));
  copyFileSync(
    join(DEVKIT_ROOT, 'templates/electron/eslint/domains.mjs'),
    join(root, 'eslint/domains.mjs'),
  );
  write(
    root,
    '.devkit/structure/exempt.mjs',
    'export const rendererStructureExempt = [];\nexport const mainStructureExempt = [];\nexport const importWallExempt = [];\n',
  );
  write(root, '.devkit/baselines/imports.mjs', 'export const rendererImportWallBaseline = [];\n');
  write(root, '.gitignore', 'node_modules\n');
  write(root, 'src/main/index.ts');
  write(root, 'src/renderer/lib/utils/format.ts');
  write(root, 'cli/run-command.ts');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'devkit-test@example.com');
  git(root, 'config', 'user.name', 'Devkit Test');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'setup');
  return root;
}

function stage(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  git(root, 'add', '--', ...Object.keys(files));
}

function gate(root: string, mode: 'staged' | 'gate') {
  const result = spawnSync(process.execPath, [RUN, mode], { cwd: root, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const electronWall = { [ELECTRON_WALL_PROBE]: "import '../../../main/index';\nexport {};\n" };
const cliPlacement = { [CLI_PLACEMENT_PROBE]: 'export {};\n' };

describe.each(['staged', 'gate'] as const)('electron preset + CLI grammar tree (%s)', (mode) => {
  it(
    'a clean mixed tree passes, so neither leg false-blocks the other',
    () => {
      const root = mixedRepo();
      stage(root, {
        'cli/list-tasks.ts': 'export {};\n',
        'src/renderer/lib/utils/parse.ts': 'export {};\n',
      });
      const result = gate(root, mode);
      expect(result.status, result.output).toBe(0);
    },
    SLOW,
  );

  it(
    "the real template's renderer→main import wall blocks on its own",
    () => {
      const root = mixedRepo();
      stage(root, electronWall);
      const result = gate(root, mode);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('project-structure/independent-modules');
      expect(result.output).toContain('import-main.ts');
      expect(result.output).not.toContain('BadName.ts');
    },
    SLOW,
  );

  it(
    'an invalid CLI placement blocks on its own',
    () => {
      const root = mixedRepo();
      stage(root, cliPlacement);
      const result = gate(root, mode);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('BadName.ts');
      expect(result.output).not.toContain('independent-modules');
    },
    SLOW,
  );

  it(
    'both violations in one commit are both reported',
    () => {
      const root = mixedRepo();
      stage(root, { ...electronWall, ...cliPlacement });
      const result = gate(root, mode);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('import-main.ts');
      expect(result.output).toContain('BadName.ts');
    },
    SLOW,
  );

  // Nothing compiles structure.walls yet. A declared wall that is not enforced must surface as
  // could-not-run (gate-opt-out-is-visible-and-detectable), never as a clean 0.
  const cliWall = { pattern: 'cli/**', allowImportsFrom: ['cli/**'] };

  it(
    'declared structure.walls never report a clean pass while no wall compiler exists',
    () => {
      const root = mixedRepo([cliWall]);
      stage(root, { 'cli/import-main.ts': "import '../src/main/index';\nexport {};\n" });
      const result = gate(root, mode);
      expect(result.status, result.output).toBe(2);
      expect(result.output).toMatch(/structure\.walls/);
    },
    SLOW,
  );

  it(
    'the uncompiled-walls notice never masks a CLI placement violation',
    () => {
      const root = mixedRepo([cliWall]);
      stage(root, cliPlacement);
      const result = gate(root, mode);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('BadName.ts');
      expect(result.output).toMatch(/structure\.walls/);
    },
    SLOW,
  );
  it(
    'walls surface when only the preset leg runs (a renderer-only change)',
    () => {
      const root = mixedRepo([cliWall]);
      stage(root, { 'src/renderer/lib/utils/parse.ts': 'export {};\n' });
      const result = gate(root, mode);
      expect(result.status, result.output).toBe(2);
      expect(result.output).toMatch(/structure\.walls/);
    },
    SLOW,
  );

  it(
    'walls surface for a preset-only electron repo with no grammar tree at all',
    () => {
      const root = mixedRepo([cliWall], []);
      stage(root, { 'src/renderer/lib/utils/parse.ts': 'export {};\n' });
      const result = gate(root, mode);
      expect(result.status, result.output).toBe(2);
      expect(result.output).toMatch(/structure\.walls/);
    },
    SLOW,
  );
});
