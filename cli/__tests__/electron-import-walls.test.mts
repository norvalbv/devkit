import {
  copyFileSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const DEVKIT_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const ESLINT = join(DEVKIT_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const WALL_RULE = 'project-structure/independent-modules';
const BUILTIN_RULE = 'no-restricted-imports';
const GRANDFATHERED = 'src/renderer/lib/tasks/grandfathered-main.ts';

const PROBES = {
  'src/renderer/lib/tasks/import-main.ts': "import '../../../main/index';\nexport {};\n",
  'src/renderer/lib/tasks/import-main-type.ts':
    "import type { AppRouter } from '../../../main/lib/trpc/routers';\nexport type X = AppRouter;\n",
  'src/renderer/lib/tasks/import-main-alias-escape.ts': "import '@/../main/index';\nexport {};\n",
  'src/renderer/features/terminal/import-feature-deep.ts':
    "import '@/features/agents/atoms';\nexport {};\n",
  'src/renderer/features/terminal/import-feature-barrel.ts':
    "import '@/features/changes';\nexport {};\n",
  'src/renderer/features/agents/import-own-feature.ts':
    "import '@/features/agents/atoms';\nexport {};\n",
  'src/renderer/lib/tasks/import-frozen-dir.ts': "import '@/utils/source-filter';\nexport {};\n",
  'src/renderer/utils/import-frozen-sibling.ts': "import './source-filter';\nexport {};\n",
  'src/renderer/components/import-component.ts': "import '@/components/ui/button';\nexport {};\n",
  'src/renderer/lib/tasks/import-worker.ts': "import './worker-target?worker';\nexport {};\n",
  'src/renderer/lib/tasks/import-unresolved.ts': "import './does-not-exist';\nexport {};\n",
  'src/shared/import-main.ts': "import '../main/index';\nexport {};\n",
  'src/shared/import-sibling.ts': "import './detect-language';\nexport {};\n",
  'src/renderer/lib/tasks/import-node-builtin.ts':
    "import path from 'node:path';\nexport const x = path;\n",
  'src/renderer/lib/tasks/import-browser-path.ts':
    "import path from 'path';\nexport const x = path;\n",
  [GRANDFATHERED]: "import '../../../main/index';\nexport {};\n",
  'src/renderer/lib/trpc.ts':
    "import type { AppRouter } from '../../main/lib/trpc/routers';\nexport type Router = AppRouter;\n",
};

let root = '';
let wallErrors: Map<string, number>;
let builtinErrors: Map<string, number>;

function write(relativePath: string, content = 'export {};\n') {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeSource(relativePath: string, content = 'export {};\n') {
  write(relativePath, content);
}

function writeTestConfig() {
  write('package.json', '{"type":"module"}\n');
  write(
    'guard.config.json',
    JSON.stringify({ scanRoots: ['src'], backends: { socketServer: false, vercel: false } }),
  );
  const configPath = join(root, 'eslint.config.mjs');
  copyFileSync(join(DEVKIT_ROOT, 'templates/electron/eslint.config.mjs'), configPath);
  const config = readFileSync(configPath, 'utf8');
  const fixtureBase = relative(DEVKIT_ROOT, root).replaceAll('\\', '/');
  const isolatedConfig = config.replace(
    "pathAliases: { baseUrl: '.',",
    `pathAliases: { baseUrl: '${fixtureBase}',`,
  );
  if (isolatedConfig === config) throw new Error('Electron template path-alias anchor changed');
  writeFileSync(configPath, isolatedConfig);
  mkdirSync(join(root, 'eslint'), { recursive: true });
  copyFileSync(
    join(DEVKIT_ROOT, 'templates/electron/eslint/domains.mjs'),
    join(root, 'eslint/domains.mjs'),
  );
  mkdirSync(join(root, '.devkit/structure'), { recursive: true });
  write(
    '.devkit/structure/exempt.mjs',
    `export const rendererStructureExempt = [];
export const mainStructureExempt = [];
export const importWallExempt = [{ name: 'app-router', pattern: 'src/renderer/lib/trpc.ts', allowImportsFrom: ['{renderer_base}', 'src/main/lib/trpc/routers/**'] }];
`,
  );
  write(
    '.devkit/baselines/imports.mjs',
    `export const rendererImportWallBaseline = [{ name: 'grandfathered', pattern: '${GRANDFATHERED}', allowImportsFrom: ['{renderer_base}', 'src/main/**'] }];\n`,
  );
}

function writeTargetSources() {
  for (const target of [
    'src/main/index.ts',
    'src/main/lib/trpc/routers/index.ts',
    'src/renderer/features/agents/atoms.ts',
    'src/renderer/features/changes/index.ts',
    'src/renderer/utils/source-filter.ts',
    'src/renderer/components/ui/button.ts',
    'src/renderer/lib/tasks/worker-target.ts',
    'src/shared/detect-language.ts',
  ]) {
    writeSource(target);
  }
  for (const [relativePath, content] of Object.entries(PROBES)) writeSource(relativePath, content);
}

function collectRuleErrors() {
  const result = spawnSync(
    process.execPath,
    [
      ESLINT,
      '--config',
      join(root, 'eslint.config.mjs'),
      '--format',
      'json',
      ...Object.keys(PROBES),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (!result.stdout) {
    throw new Error(`Electron import-wall fixture produced no ESLint JSON:\n${result.stderr}`);
  }
  const byFile = new Map(
    JSON.parse(result.stdout).map((file) => [
      relative(root, file.filePath).replaceAll('\\', '/'),
      file.messages ?? [],
    ]),
  );
  const count = (relativePath: string, ruleId: string) =>
    (byFile.get(relativePath) ?? []).filter((message) => message.ruleId === ruleId).length;
  wallErrors = new Map(
    Object.keys(PROBES).map((relativePath) => [relativePath, count(relativePath, WALL_RULE)]),
  );
  builtinErrors = new Map(
    Object.keys(PROBES).map((relativePath) => [relativePath, count(relativePath, BUILTIN_RULE)]),
  );
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(DEVKIT_ROOT, '.electron-import-walls-')));
  writeTestConfig();
  writeTargetSources();
  collectRuleErrors();
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('shipped Electron import walls', () => {
  it.each([
    'src/renderer/lib/tasks/import-main.ts',
    'src/renderer/lib/tasks/import-main-type.ts',
    'src/renderer/lib/tasks/import-main-alias-escape.ts',
  ])('blocks renderer trust-boundary escape: %s', (relativePath) => {
    expect(wallErrors.get(relativePath)).toBeGreaterThan(0);
  });

  it('keeps the permanent AppRouter exception ahead of the renderer wall', () => {
    expect(wallErrors.get('src/renderer/lib/trpc.ts')).toBe(0);
  });

  it('keeps a generated grandfather entry ahead of the renderer wall', () => {
    expect(wallErrors.get(GRANDFATHERED)).toBe(0);
  });

  it('blocks another feature deep path but allows its barrel and the current feature', () => {
    expect(wallErrors.get('src/renderer/features/terminal/import-feature-deep.ts')).toBeGreaterThan(
      0,
    );
    expect(wallErrors.get('src/renderer/features/terminal/import-feature-barrel.ts')).toBe(0);
    expect(wallErrors.get('src/renderer/features/agents/import-own-feature.ts')).toBe(0);
  });

  it('blocks frozen-directory consumption, including a fresh sibling import', () => {
    expect(wallErrors.get('src/renderer/lib/tasks/import-frozen-dir.ts')).toBeGreaterThan(0);
    expect(wallErrors.get('src/renderer/utils/import-frozen-sibling.ts')).toBeGreaterThan(0);
  });

  it('allows the renderer base surface and bundler virtual imports', () => {
    expect(wallErrors.get('src/renderer/components/import-component.ts')).toBe(0);
    expect(wallErrors.get('src/renderer/lib/tasks/import-worker.ts')).toBe(0);
  });

  it('reports an unresolvable local import instead of silently allowing it', () => {
    expect(wallErrors.get('src/renderer/lib/tasks/import-unresolved.ts')).toBeGreaterThan(0);
  });

  it('blocks shared imports upward but allows shared siblings', () => {
    expect(wallErrors.get('src/shared/import-main.ts')).toBeGreaterThan(0);
    expect(wallErrors.get('src/shared/import-sibling.ts')).toBe(0);
  });

  it('blocks node: builtins while preserving the browser-aliased bare path import', () => {
    expect(builtinErrors.get('src/renderer/lib/tasks/import-node-builtin.ts')).toBeGreaterThan(0);
    expect(builtinErrors.get('src/renderer/lib/tasks/import-browser-path.ts')).toBe(0);
  });
});
