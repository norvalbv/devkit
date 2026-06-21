// @ts-nocheck — emitted config file: it imports peer-installed tools (eslint-plugin-project-
// structure, @typescript-eslint/parser) that live in the CONSUMER repo, not in devkit. TS in
// the devkit repo can't resolve them; eslint configs aren't type-checked anyway.
// ESLint config — scoped narrowly to the project-structure plugin (folder
// hierarchy + file naming + import walls + file/function size). Biome handles
// all code/style/lint rules; this config is purely structural.
//
// Why ESLint not biome: biome 2.x GritQL plugins cannot validate folder
// structure (no path primitives, no cross-file checks). The project-structure
// plugin is purpose-built for it and gives real-time IDE feedback.
//
// EMITTED BY: `devkit init --stack electron`. The 6 structureRoots, rule shapes,
// and the renderer⊅main trust wall are the electron-stack contract; the lib/
// domain registries (eslint/domains.mjs) start EMPTY and grow one append at a time.
//
// BASELINES ARE OPTIONAL AT LOAD TIME: a fresh repo has no eslint/baselines/*.mjs
// yet, and an emptied domain registry would otherwise hard-fail every existing
// lib folder. So the grandfather lists are loaded with `loadBaseline` (returns []
// when the file is absent) and `devkit init` runs the baseline generators to
// grandfather the current tree right after emitting this config. The config
// therefore loads + lints clean BOTH on a bare repo AND post-init.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tsParser from '@typescript-eslint/parser';
import {
  createFolderStructure,
  createIndependentModules,
  projectStructureParser,
  projectStructurePlugin,
} from 'eslint-plugin-project-structure';
import {
  MAIN_LIB_DOMAINS,
  RENDERER_LIB_DOMAINS,
  SOCKET_LIB_DOMAINS,
  VERCEL_LIB_DOMAINS,
} from './eslint/domains.mjs';

// Reason: electron and react-app are SEPARATE shipped eslint templates, each a standalone file copied into a consumer repo (no devkit import to share a base) - intentional per-stack duplication
// fallow-ignore-next-line code-duplication
const HERE = dirname(fileURLToPath(import.meta.url));

// Load a named export from a baseline .mjs, or [] if the file doesn't exist yet.
// `devkit init` generates these AFTER emitting this config — until then (and on a
// fresh repo) the config must load clean with empty grandfather lists.
async function loadBaseline(file, exportName) {
  const abs = join(HERE, 'eslint', 'baselines', file);
  if (!existsSync(abs)) return [];
  const mod = await import(pathToFileURL(abs).href);
  return mod[exportName] ?? [];
}

// Optional hand-maintained permanent exemptions (reason-required). Absent on a
// fresh repo → empty arrays.
async function loadExempt(exportName) {
  const abs = join(HERE, 'eslint', 'baselines', 'exempt.mjs');
  if (!existsSync(abs)) return [];
  const mod = await import(pathToFileURL(abs).href);
  return mod[exportName] ?? [];
}

const [
  rendererStructureBaseline,
  mainStructureBaseline,
  sharedStructureBaseline,
  preloadStructureBaseline,
  socketStructureBaseline,
  vercelStructureBaseline,
  rendererImportWallBaseline,
  rendererStructureExempt,
  mainStructureExempt,
  importWallExempt,
] = await Promise.all([
  loadBaseline('renderer.mjs', 'rendererStructureBaseline'),
  loadBaseline('main.mjs', 'mainStructureBaseline'),
  loadBaseline('shared.mjs', 'sharedStructureBaseline'),
  loadBaseline('preload.mjs', 'preloadStructureBaseline'),
  loadBaseline('socket.mjs', 'socketStructureBaseline'),
  loadBaseline('vercel.mjs', 'vercelStructureBaseline'),
  loadBaseline('imports.mjs', 'rendererImportWallBaseline'),
  loadExempt('rendererStructureExempt'),
  loadExempt('mainStructureExempt'),
  loadExempt('importWallExempt'),
]);

const regex = {
  PascalCase: '^[A-Z][a-zA-Z0-9]*$',
  kebab_case: '^[a-z][a-z0-9-]*$',
  use_hook: '^use-[a-z][a-z0-9-]*\\.tsx?$',
  use_hook_pascal: '^use[A-Z][a-zA-Z0-9]*$',
  use_hook_camel: '^use[A-Z][a-zA-Z0-9]*\\.tsx?$',
  test_file: '^.+\\.(test|spec)\\.tsx?$',
  kebab_ts: '^[a-z][a-z0-9-]*\\.ts$',
  kebab_tsx: '^[a-z][a-z0-9-]*\\.tsx$',
  kebab_test: '^[a-z][a-z0-9-]*\\.(test|spec)\\.tsx?$',
  any_file: '^.+$',
  any_css: '^.+\\.css$',
};

// STRICT component folder rule — PascalCase folder MUST contain index.tsx and may
// contain only: index.tsx (required), constants.ts, types.ts, css, colocated
// tests, recursive child folders, __tests__/.
const componentFolderRule = {
  name: '{PascalCase}',
  enforceExistence: 'index.tsx',
  children: [
    { name: 'index.tsx' },
    { name: 'index.ts' },
    { name: 'constants.ts' },
    { name: 'types.ts' },
    { name: '{test_file}' },
    { name: '{any_css}' },
    {
      name: '__tests__',
      children: [
        { name: '{test_file}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'componentFolder' },
  ],
};

// Feature folder rule — kebab-case feature module wrapping PascalCase component
// folders: features/<kebab>/<Pascal>/index.tsx. UI-only: NO loose logic files
// ({kebab_ts} deliberately absent) — logic lives in lib/ (or hooks/).
const featureFolderRule = {
  name: '{kebab_case}',
  children: [
    { name: 'index.ts' },
    { name: 'index.tsx' },
    { name: 'constants.ts' },
    { ruleId: 'componentFolder' },
  ],
};

// General RECURSIVE kebab-module rule for src/renderer/lib. NO enforceExistence
// (index.ts allowed, not required). ONE rule governs every lib subfolder.
const libKebabFolderRule = {
  name: '{kebab_case}',
  children: [
    { name: 'index.ts' },
    { name: 'index.tsx' },
    { name: 'constants.ts' },
    { name: 'types.ts' },
    { name: '{kebab_ts}' },
    { name: '{kebab_tsx}' },
    { name: '{kebab_test}' },
    { name: '{use_hook}' },
    { name: '{any_css}' },
    {
      name: '__tests__',
      children: [
        { name: '{kebab_test}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'libKebabFolder' },
  ],
};

const folderStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    // Closed domain vocabulary for first-level lib/ folders — see eslint/domains.mjs.
    // Empty registry => a regex that matches NOTHING, so every lib folder is
    // "unregistered". That is SAFE because the baseline generator grandfathers
    // every existing lib file at init time; new lib folders then need a domain.
    lib_domain: RENDERER_LIB_DOMAINS.length
      ? `^(${RENDERER_LIB_DOMAINS.join('|')})$`
      : '^$',
    // Seals the frozen legacy dirs (matches nothing).
    frozen_dir_migrate_to_lib: '^$',
  },
  structureRoot: 'src/renderer',
  ignorePatterns: [
    'assets/**',
    'public/**',
    'styles/**',
    'components/ui/**',
    'icons/**',
    ...rendererStructureBaseline,
    ...rendererStructureExempt,
  ],
  structure: {
    name: 'renderer',
    children: [
      { name: 'App.tsx' },
      { name: 'main.tsx' },
      { name: 'wdyr.ts' },
      { name: 'index.html' },
      { name: 'login.html' },
      { name: 'components', children: [{ ruleId: 'componentFolder' }] },
      { name: 'features', children: [{ ruleId: 'featureFolder' }] },
      {
        name: 'hooks',
        children: [
          { name: '{use_hook}' },
          { name: '{use_hook_camel}' },
          { name: '{test_file}' },
          {
            name: '{use_hook_pascal}',
            children: [{ name: 'index.ts' }, { name: 'index.tsx' }, { name: '{test_file}' }],
          },
        ],
      },
      {
        name: 'lib',
        children: [
          { name: 'index.ts' },
          { name: '{lib_domain}', children: libKebabFolderRule.children },
        ],
      },
      { name: 'contexts', children: [{ name: '{frozen_dir_migrate_to_lib}' }] },
      { name: 'constants', children: [{ name: '{frozen_dir_migrate_to_lib}' }] },
      { name: 'types', children: [{ name: '{frozen_dir_migrate_to_lib}' }] },
      { name: 'utils', children: [{ name: '{frozen_dir_migrate_to_lib}' }] },
      { name: 'icons', children: [{ name: '{any_file}' }, { ruleId: 'componentFolder' }] },
      { name: 'styles', children: [{ name: '{any_file}' }, { ruleId: 'componentFolder' }] },
      { name: 'assets', children: [{ name: '{any_file}' }, { ruleId: 'componentFolder' }] },
      { name: 'public', children: [{ name: '{any_file}' }, { ruleId: 'componentFolder' }] },
    ],
  },
  rules: {
    componentFolder: componentFolderRule,
    featureFolder: featureFolderRule,
    libKebabFolder: libKebabFolderRule,
  },
});

// ─── src/main/ structure ────────────────────────────────────────────────────
// Electron main process — pure Node, no React. Module-as-folder pattern: every
// folder is a module with index.ts as its public API.
const mainKebabFolderRule = {
  name: '{kebab_case}',
  enforceExistence: 'index.ts',
  children: [
    { name: 'index.ts' },
    { name: 'constants.ts' },
    { name: '{kebab_ts}' },
    { name: '{kebab_test}' },
    {
      name: '__tests__',
      children: [
        { name: '{kebab_test}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'mainKebabFolder' },
  ],
};

const mainStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    kebab_ts: '^[a-z][a-z0-9-]*\\.ts$',
    kebab_test: '^[a-z][a-z0-9-]*\\.(test|spec)\\.ts$',
    main_lib_domain: MAIN_LIB_DOMAINS.length ? `^(${MAIN_LIB_DOMAINS.join('|')})$` : '^$',
  },
  structureRoot: 'src/main',
  ignorePatterns: [...mainStructureBaseline, ...mainStructureExempt],
  structure: {
    name: 'main',
    enforceExistence: 'index.ts',
    children: [
      { name: 'index.ts' },
      { name: 'constants.ts' },
      {
        name: 'lib',
        children: [
          { name: 'index.ts' },
          {
            name: '{main_lib_domain}',
            enforceExistence: 'index.ts',
            children: mainKebabFolderRule.children,
          },
        ],
      },
      { name: 'windows', enforceExistence: 'index.ts', children: mainKebabFolderRule.children },
    ],
  },
  rules: { mainKebabFolder: mainKebabFolderRule },
});

// ─── src/shared/ structure ───────────────────────────────────────────────────
// PROCESS-AGNOSTIC code imported by BOTH main and renderer. Recursive kebab
// modules; index.ts OPTIONAL (mostly leaf types/helpers).
// Reason: electron and react-app are SEPARATE shipped eslint templates, each a standalone file copied into a consumer repo (no devkit import to share a base) - intentional per-stack duplication
// fallow-ignore-next-line code-duplication
const sharedKebabFolderRule = {
  name: '{kebab_case}',
  children: [
    { name: 'index.ts' },
    { name: 'constants.ts' },
    { name: 'types.ts' },
    { name: '{kebab_ts}' },
    { name: '{kebab_test}' },
    {
      name: '__tests__',
      children: [
        { name: '{kebab_test}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'sharedKebabFolder' },
  ],
};

const sharedStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    kebab_ts: '^[a-z][a-z0-9-]*\\.ts$',
    kebab_test: '^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*\\.(test|spec)\\.ts$',
  },
  structureRoot: 'src/shared',
  ignorePatterns: [...sharedStructureBaseline],
  structure: {
    name: 'shared',
    children: [
      { name: 'index.ts' },
      { name: 'constants.ts' },
      { name: '{kebab_ts}' },
      { name: '{kebab_test}' },
      { ruleId: 'sharedKebabFolder' },
    ],
  },
  rules: { sharedKebabFolder: sharedKebabFolderRule },
});

// ─── src/preload/ structure ──────────────────────────────────────────────────
// TRUSTED contextBridge — the ONLY renderer↔main surface. FLAT files.
const preloadStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    kebab_ts: '^[a-z][a-z0-9-]*\\.ts$',
    kebab_test: '^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*\\.(test|spec)\\.ts$',
  },
  structureRoot: 'src/preload',
  ignorePatterns: [...preloadStructureBaseline],
  structure: {
    name: 'preload',
    children: [
      { name: 'index.ts' },
      { name: 'index.d.ts' },
      { name: 'constants.ts' },
      { name: '{kebab_ts}' },
      { name: '{kebab_test}' },
      { name: '__tests__', children: [{ name: '{kebab_test}' }] },
    ],
  },
});

// ─── socket-server/src structure ─────────────────────────────────────────────
// Railway-style backend (Express). Kept here so the SAME baseline + domain
// vocabulary work the moment you add the dir. The FLAT-CONFIG block that
// activates this rule is commented out below — uncomment when you add the dir.
// Reason: electron and react-app are SEPARATE shipped eslint templates, each a standalone file copied into a consumer repo (no devkit import to share a base) - intentional per-stack duplication
// fallow-ignore-next-line code-duplication
const socketKebabFolderRule = {
  name: '{kebab_case}',
  children: [
    { name: 'index.ts' },
    { name: 'constants.ts' },
    { name: 'types.ts' },
    { name: '{kebab_ts}' },
    { name: '{kebab_test}' },
    {
      name: '__tests__',
      children: [
        { name: '{kebab_test}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'socketKebabFolder' },
  ],
};

const socketStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    kebab_ts: '^[a-z][a-z0-9-]*\\.ts$',
    kebab_test: '^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*\\.(test|spec)\\.ts$',
    socket_lib_domain: SOCKET_LIB_DOMAINS.length ? `^(${SOCKET_LIB_DOMAINS.join('|')})$` : '^$',
  },
  structureRoot: 'socket-server/src',
  ignorePatterns: [...socketStructureBaseline],
  structure: {
    name: 'src',
    children: [
      { name: 'index.ts' },
      { name: 'constants.ts' },
      { name: '{kebab_test}' },
      { name: 'types', children: [{ name: '{kebab_ts}' }, { name: '{kebab_test}' }] },
      {
        name: 'api',
        children: [
          { name: 'router.ts' },
          { name: 'routes', children: socketKebabFolderRule.children },
        ],
      },
      {
        name: 'lib',
        children: [
          { name: 'index.ts' },
          { name: '{socket_lib_domain}', children: socketKebabFolderRule.children },
        ],
      },
    ],
  },
  rules: { socketKebabFolder: socketKebabFolderRule },
});

// ─── vercel-serverless structure ─────────────────────────────────────────────
// Webhook/cron handlers. api/ is filename=route constrained; lib/ FOLDER-ONLY.
// The FLAT-CONFIG block that activates this is commented out below — uncomment
// when you add the dir.
const vercelKebabFolderRule = {
  name: '{kebab_case}',
  children: [
    { name: 'index.ts' },
    { name: 'constants.ts' },
    { name: 'types.ts' },
    { name: '{kebab_ts}' },
    { name: '{kebab_test}' },
    { name: '__fixtures__', children: [{ name: '{any_file}' }] },
    { name: '__snapshots__', children: [{ name: '{any_file}' }] },
    {
      name: '__tests__',
      children: [
        { name: '{kebab_test}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'vercelKebabFolder' },
  ],
};

const vercelApiFolderRule = {
  name: '{kebab_case}',
  children: [{ name: '{vercel_route}' }, { name: '{kebab_test}' }, { ruleId: 'vercelApiFolder' }],
};

const vercelStructure = createFolderStructure({
  regexParameters: {
    ...regex,
    kebab_ts: '^[a-z][a-z0-9-]*\\.ts$',
    kebab_test: '^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*\\.(test|spec)\\.ts$',
    vercel_route: '^([a-z][a-z0-9-]*|\\[[a-zA-Z][a-zA-Z0-9]*\\])\\.ts$',
    vercel_lib_domain: VERCEL_LIB_DOMAINS.length ? `^(${VERCEL_LIB_DOMAINS.join('|')})$` : '^$',
  },
  structureRoot: 'vercel-serverless',
  ignorePatterns: [...vercelStructureBaseline],
  structure: {
    name: 'vercel-serverless',
    children: [
      {
        name: 'api',
        children: [
          { name: '{vercel_route}' },
          { name: '{kebab_test}' },
          { ruleId: 'vercelApiFolder' },
        ],
      },
      {
        name: 'lib',
        children: [
          { name: 'index.ts' },
          { name: '{vercel_lib_domain}', children: vercelKebabFolderRule.children },
        ],
      },
    ],
  },
  rules: { vercelApiFolder: vercelApiFolderRule, vercelKebabFolder: vercelKebabFolderRule },
});

// ─── Import walls (independent-modules) ─────────────────────────────────────
// Trust-boundary + cross-feature + frozen-dir consumption walls. Path-RESOLVING
// (relative + '@/' alias resolve to root-relative before matching).
//
// Scan mode (DEVKIT_IMPORTS_BASELINE_SCAN=1): drops the generated grandfather
// entries + flips debugMode so error text carries the import path — used by the
// import-wall baseline generator to (re)generate eslint/baselines/imports.mjs.
const IMPORT_WALL_SCAN = process.env.DEVKIT_IMPORTS_BASELINE_SCAN === '1';

// Reason: electron and react-app are SEPARATE shipped eslint templates, each a standalone file copied into a consumer repo (no devkit import to share a base) - intentional per-stack duplication
// fallow-ignore-next-line code-duplication
const importWalls = createIndependentModules({
  pathAliases: { baseUrl: '.', paths: { '@/*': ['src/renderer/*'] } },
  debugMode: IMPORT_WALL_SCAN,
  reusableImportPatterns: {
    renderer_base: [
      [
        'src/renderer/**',
        '!**/../**',
        '!src/renderer/features/*/**',
        '!src/renderer/utils/**',
        '!src/renderer/types/**',
        '!src/renderer/constants/**',
        '!src/renderer/contexts/**',
      ],
      'src/renderer/features/*/index.ts',
      'src/renderer/features/*/index.tsx',
      '{family_4}/**',
      'src/shared/**',
      '**?worker',
      '**?raw',
      '**?url',
      'virtual:**',
    ],
  },
  modules: [
    // FIRST MATCH WINS — order is load-bearing:
    // 1. Hand-maintained permanent exemptions (reason-required, never shrink).
    ...importWallExempt,
    // 2. Generated per-file grandfathers (shrink-only; dropped in scan mode).
    ...(IMPORT_WALL_SCAN ? [] : rendererImportWallBaseline),
    // 3. The walls.
    {
      name: 'renderer',
      pattern: 'src/renderer/**',
      errorMessage:
        'Renderer import wall: no src/main (cross-process types -> src/shared/types), no other-feature deep paths (use the @/features/<x> barrel), no frozen legacy dirs (@/utils,@/types,@/constants,@/contexts -> lib/). Grandfathered files: eslint/baselines/imports.mjs (shrink-only).',
      allowImportsFrom: ['{renderer_base}'],
    },
    {
      name: 'shared',
      pattern: 'src/shared/**',
      errorMessage:
        'src/shared is process-agnostic: it may only import src/shared (+ externals) — never main/renderer/preload.',
      allowImportsFrom: ['src/shared/**'],
    },
  ],
});

// Stub plugin factory: registers rule names so legacy inline disable comments
// validate. Each rule is a no-op.
const stubRule = { meta: { schema: [], messages: {} }, create: () => ({}) };
const legacyDisableStub = (ruleNames) => ({
  rules: Object.fromEntries(ruleNames.map((n) => [n, stubRule])),
});

export default [
  // Never lint build output / generated artifacts (gitignored).
  { ignores: ['**/dist/**', '**/out/**', '**/*.tsbuildinfo'] },
  {
    files: ['src/renderer/**/*.{ts,tsx,css}', 'src/renderer/*'],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', folderStructure] },
  },
  {
    files: ['src/main/**/*.ts', 'src/main/*'],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', mainStructure] },
  },
  {
    files: ['src/shared/**/*.ts', 'src/shared/*'],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', sharedStructure] },
  },
  {
    files: ['src/preload/**/*.ts', 'src/preload/*'],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', preloadStructure] },
  },
  // ─── Add a backend process? Uncomment the matching block. ──────────────────
  // socket-server (Railway-style Express backend). Uncomment when you add the dir,
  // then run the baseline generators (devkit init --stack electron) to grandfather it.
  // {
  //   files: ['socket-server/src/**/*.ts', 'socket-server/src/*'],
  //   plugins: { 'project-structure': projectStructurePlugin },
  //   languageOptions: { parser: projectStructureParser },
  //   rules: { 'project-structure/folder-structure': ['error', socketStructure] },
  // },
  // vercel-serverless (webhook/cron handlers). Uncomment when you add the dir.
  // {
  //   files: ['vercel-serverless/api/**/*.ts', 'vercel-serverless/lib/**/*.ts'],
  //   plugins: { 'project-structure': projectStructurePlugin },
  //   languageOptions: { parser: projectStructureParser },
  //   rules: { 'project-structure/folder-structure': ['error', vercelStructure] },
  // },
  // Import walls. Tests are wall-free.
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
    ignores: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**'],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    rules: { 'project-structure/independent-modules': ['error', importWalls] },
  },
  // Node-builtin ban for the renderer (browser context). Bare `path` is
  // DELIBERATELY absent — vite aliases it to path-browserify for the renderer.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'node:*/**',
                'fs',
                'fs/**',
                'os',
                'child_process',
                'crypto',
                'net',
                'tls',
                'http',
                'https',
                'stream',
                'stream/**',
                'util',
                'events',
                'url',
                'zlib',
                'worker_threads',
                'readline',
                'dns',
                'dgram',
                'tty',
                'v8',
                'vm',
                'module',
                'process',
                'buffer',
                'assert',
                'async_hooks',
                'perf_hooks',
                'querystring',
                'string_decoder',
                'timers',
                'timers/**',
              ],
              message:
                'Renderer is a browser context: no Node builtins (type the contract in src/shared instead). For path ops use `import path from "path"` — vite aliases it to path-browserify.',
            },
          ],
        },
      ],
    },
  },
  // File-size + function-size limits. Source = 500/file + 200/function. Tests =
  // 2000/file (loose). Stub plugins register rule names for legacy inline disables.
  {
    // Reason: electron and react-app are SEPARATE shipped eslint templates, each a standalone file copied into a consumer repo (no devkit import to share a base) - intentional per-stack duplication
    // fallow-ignore-next-line code-duplication
    files: ['src/**/*.{ts,tsx}', 'socket-server/**/*.ts', 'vercel-serverless/**/*.ts'],
    ignores: ['**/*.{test,spec}.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: {
      'react-hooks': legacyDisableStub(['exhaustive-deps', 'rules-of-hooks']),
      '@typescript-eslint': legacyDisableStub([
        'no-require-imports',
        'consistent-type-imports',
        'only-throw-error',
      ]),
      'jsx-a11y': legacyDisableStub(['no-autofocus']),
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],
      'max-lines-per-function': [
        'error',
        { max: 200, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
    },
  },
  {
    // React components (.tsx): large connected render functions are legitimate —
    // per-function cap 300 (file cap stays 500). .ts logic stays 200.
    // Reason: electron and react-app are SEPARATE shipped eslint templates, each a standalone file copied into a consumer repo (no devkit import to share a base) - intentional per-stack duplication
    // fallow-ignore-next-line code-duplication
    files: ['src/**/*.tsx', 'socket-server/**/*.tsx', 'vercel-serverless/**/*.tsx'],
    ignores: ['**/*.{test,spec}.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'max-lines-per-function': [
        'error',
        { max: 300, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: {
      'react-hooks': legacyDisableStub(['exhaustive-deps', 'rules-of-hooks']),
      '@typescript-eslint': legacyDisableStub([
        'no-require-imports',
        'consistent-type-imports',
        'only-throw-error',
      ]),
      'jsx-a11y': legacyDisableStub(['no-autofocus']),
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'max-lines': ['error', { max: 2000, skipBlankLines: false, skipComments: false }],
    },
  },
];
