// @ts-nocheck — emitted config file: it imports peer-installed tools (eslint-plugin-project-
// structure, @typescript-eslint/parser) that live in the CONSUMER repo, not in devkit. TS in
// the devkit repo can't resolve them; eslint configs aren't type-checked anyway.
// ESLint config — react-app preset. Scoped narrowly to the project-structure
// plugin (folder naming + file/function size). Biome handles all code/style/lint
// rules; this config is purely structural.
//
// Why ESLint not biome: biome 2.x GritQL plugins cannot validate folder
// structure (no path primitives, no cross-file checks). The project-structure
// plugin is purpose-built for it and gives real-time IDE feedback.
//
// EMITTED BY: `devkit init --stack react-app`. This preset is LIGHT and
// AMENDABLE on purpose — a plain Vite/CRA app organises `src/` however it likes
// (utils/, services/, store/, hooks/, constants/, pages/, …). So we DO NOT ship
// the frink-renderer taxonomy (no lib/<domain> mandate, no utils-frozen, no
// renderer⊅main wall, no Node-builtin ban). We keep ONLY the rules universal to
// any React app:
//   1. PascalCase component folders (`src/components/<Pascal>/…`).
//   2. PascalCase page folders     (`src/pages/<Pascal>/…`).
//   3. File + function size caps    (same numbers as the electron preset).
// Fan-out is governed by the guard-fanout ratchet (guard.config.json), NOT here.
//
// ── HOW THE TOP-LEVEL FOLDER SET STAYS OPEN ──────────────────────────────────
// The project-structure plugin is a CLOSED-WORLD validator: anything not listed
// in a `structureRoot` tree is an error. So instead of describing all of `src/`
// (which would reject your services/, store/, mocks/, … the moment they appear),
// we scope each structure rule to ONE folder — `src/components` and `src/pages`.
// Every OTHER top-level folder is simply never visited by this plugin, i.e.
// ungoverned and free. To start governing a new folder, copy a block at the
// bottom and point `structureRoot` at it.
//
// ── HOW TO AMEND ─────────────────────────────────────────────────────────────
//   • Nested app root: every path below is derived from `SRC` = guard.config.json
//     `scanRoots[0]` (default `src`). A monorepo app at services/webapp/src just
//     sets that in guard.config.json — no edits here. Same value drives fan-out/size.
//   • Add a governed folder: copy the `components` flat-config block + structure
//     rule, change `structureRoot`, run the baseline generator to grandfather it.
//   • Add a domain vocabulary: append to eslint/domains.mjs, reference its
//     `{<name>_domain}` regex param, re-run the baseline generator.
//   • Re-grandfather after a bulk move: re-run `devkit init --stack react-app`
//     (regenerates eslint/baselines/*.mjs from the current tree).
//
// BASELINES ARE OPTIONAL AT LOAD TIME: a fresh repo has no eslint/baselines/*.mjs
// yet, so the grandfather lists are loaded with `loadBaseline` (returns [] when
// the file is absent). The config therefore loads + lints clean on a bare repo,
// AND after the generator grandfathers your current tree.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tsParser from '@typescript-eslint/parser';
import {
  createFolderStructure,
  projectStructureParser,
  projectStructurePlugin,
} from 'eslint-plugin-project-structure';
// Imported for amendment ergonomics: empty by default, these become a closed
// vocabulary only if YOU opt one folder in. See eslint/domains.mjs.
import { LIB_DOMAINS, SERVICE_DOMAINS } from './eslint/domains.mjs';

// Reference the registries so the import is never "unused" before you opt in.
// Empty array => match-NOTHING regex (never a crash); becomes `^(a|b)$` once you
// append names in eslint/domains.mjs and wire `{lib_domain}`/`{service_domain}`
// into a structureRoot below.
const matchNothingOr = (names) => (names.length ? `^(${names.join('|')})$` : '^$');
const LIB_DOMAIN = matchNothingOr(LIB_DOMAINS);
const SERVICE_DOMAIN = matchNothingOr(SERVICE_DOMAINS);

const HERE = dirname(fileURLToPath(import.meta.url));

// App root — SINGLE SOURCE OF TRUTH = guard.config.json `scanRoots[0]` (default 'src'). Every
// path below (structureRoot + size globs) is built from it, so a nested layout (a monorepo app
// at services/webapp/src) just sets scanRoots there and this file needs NO edits. The same
// scanRoots value also drives the guard-fanout / guard-size ratchets — one value, one root.
// guard.config.json sits beside this config at the repo root, so read it relative to HERE
// (cwd-independent). On a bare repo with no guard.config.json yet, falls back to 'src'.
// Reason: CRAP-driven (cyc 5/cog 4, low): each branch is one defensive narrowing of untrusted guard.config.json (file readable? scanRoots an array? [0] a non-empty string? else 'src'); exercised end-to-end at eslint config load, not unit-tested
// fallow-ignore-next-line complexity
function appRoot() {
  try {
    const cfg = JSON.parse(readFileSync(join(HERE, 'guard.config.json'), 'utf8'));
    const root = Array.isArray(cfg.scanRoots) && cfg.scanRoots[0];
    return typeof root === 'string' && root ? root : 'src';
  } catch {
    return 'src';
  }
}
// Reason: electron and react-app are SEPARATE shipped eslint templates, each a standalone file copied into a consumer repo (no devkit import to share a base) - intentional per-stack duplication
// fallow-ignore-next-line code-duplication
const SRC = appRoot();

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
  componentStructureBaseline,
  pageStructureBaseline,
  componentStructureExempt,
  pageStructureExempt,
] = await Promise.all([
  loadBaseline('components.mjs', 'componentStructureBaseline'),
  loadBaseline('pages.mjs', 'pageStructureBaseline'),
  loadExempt('componentStructureExempt'),
  loadExempt('pageStructureExempt'),
]);

const regex = {
  PascalCase: '^[A-Z][a-zA-Z0-9]*$',
  kebab_case: '^[a-z][a-z0-9-]*$',
  pascal_tsx: '^[A-Z][a-zA-Z0-9]*\\.tsx$',
  use_hook_camel: '^use[A-Z][a-zA-Z0-9]*\\.tsx?$',
  camel_ts: '^[a-z][a-zA-Z0-9]*\\.ts$',
  test_file: '^.+\\.(test|spec)\\.tsx?$',
  any_file: '^.+$',
  any_css: '^.+\\.css$',
  any_md: '^.+\\.md$',
  // Closed-vocab params — match NOTHING until you opt a folder in (see top).
  lib_domain: LIB_DOMAIN,
  service_domain: SERVICE_DOMAIN,
};

// PascalCase component folder. PERMISSIVE on purpose — a real React app colocates
// the folder's main component AND its private subcomponents/helpers in the same
// folder (Foo/index.tsx + Foo/FooRow.tsx + Foo/useFoo.ts + Foo/fooUtils.ts).
// We therefore DO NOT `enforceExistence: 'index.tsx'` (some folders are pure leaf
// collections, e.g. an icon set) and we ALLOW colocated PascalCase subcomponents,
// camelCase + useX helpers, types/constants, css, markdown and tests. This is the
// universal-React shape; tighten it per-repo if you want index-only folders.
const componentFolderRule = {
  name: '{PascalCase}',
  children: [
    { name: 'index.tsx' },
    { name: 'index.ts' },
    { name: 'constants.ts' },
    { name: 'types.ts' },
    { name: '{pascal_tsx}' }, // colocated private subcomponent
    { name: '{use_hook_camel}' }, // colocated hook (useFoo.ts/.tsx)
    { name: '{camel_ts}' }, // colocated helper (fooUtils.ts, schema.ts)
    { name: '{test_file}' },
    { name: '{any_css}' },
    { name: '{any_md}' },
    {
      name: '__tests__',
      children: [
        { name: '{test_file}' },
        { name: '__snapshots__', children: [{ name: '{any_file}' }] },
      ],
    },
    { ruleId: 'componentFolder' }, // recurse into nested component folders
  ],
};

// PascalCase page/route folder. Same permissive shape as a component folder —
// pages colocate their sections + page-local hooks/helpers.
const pageFolderRule = {
  name: '{PascalCase}',
  children: [
    ...componentFolderRule.children.filter((c) => c.ruleId !== 'componentFolder'),
    { ruleId: 'pageFolder' }, // recurse into nested page sub-folders
    { ruleId: 'componentFolder' }, // a page may also nest component folders
  ],
};

// A real React app keeps BOTH folder-per-component (Foo/index.tsx) AND single-file
// components loose at the components/pages root (Foo.tsx, useBar.ts). So the root allows
// the same files a component folder allows — alongside the {PascalCase} sub-folders. Still
// name-controlled: a misnamed loose file (foo-bar.ts) is still rejected. Tighten to
// folders-only per-repo by dropping this spread.
const looseRootChildren = componentFolderRule.children.filter((c) => c.ruleId !== 'componentFolder');

// ── src/components/ ──────────────────────────────────────────────────────────
const componentsStructure = createFolderStructure({
  regexParameters: regex,
  structureRoot: `${SRC}/components`,
  // Loose files DIRECTLY at <src>/components/ root, plus generated grandfathers +
  // hand-maintained exempts. ignorePatterns means "not validated here".
  ignorePatterns: [...componentStructureBaseline, ...componentStructureExempt],
  structure: {
    name: 'components',
    children: [...looseRootChildren, { ruleId: 'componentFolder' }],
  },
  rules: { componentFolder: componentFolderRule },
});

// ── src/pages/ ───────────────────────────────────────────────────────────────
// Reason: electron and react-app are SEPARATE shipped eslint templates, each a standalone file copied into a consumer repo (no devkit import to share a base) - intentional per-stack duplication
// fallow-ignore-next-line code-duplication
const pagesStructure = createFolderStructure({
  regexParameters: regex,
  structureRoot: `${SRC}/pages`,
  ignorePatterns: [...pageStructureBaseline, ...pageStructureExempt],
  structure: {
    name: 'pages',
    children: [...looseRootChildren, { ruleId: 'pageFolder' }, { ruleId: 'componentFolder' }],
  },
  rules: { pageFolder: pageFolderRule, componentFolder: componentFolderRule },
});

// Stub plugin factory: registers rule names so legacy inline disable comments
// validate. Each rule is a no-op.
const stubRule = { meta: { schema: [], messages: {} }, create: () => ({}) };
const legacyDisableStub = (ruleNames) => ({
  rules: Object.fromEntries(ruleNames.map((n) => [n, stubRule])),
});

export default [
  // Never lint build output / generated artifacts (gitignored).
  { ignores: ['**/dist/**', '**/build/**', '**/out/**', '**/*.tsbuildinfo'] },
  {
    files: [`${SRC}/components/**/*.{ts,tsx,css}`, `${SRC}/components/*`],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', componentsStructure] },
  },
  {
    files: [`${SRC}/pages/**/*.{ts,tsx,css}`, `${SRC}/pages/*`],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', pagesStructure] },
  },
  // ── Govern another folder? Copy this block, swap the path + structure rule. ──
  // Then run `devkit init --stack react-app` to grandfather its current files.
  // {
  //   files: ['src/services/**/*.{ts,tsx}', 'src/services/*'],
  //   plugins: { 'project-structure': projectStructurePlugin },
  //   languageOptions: { parser: projectStructureParser },
  //   rules: { 'project-structure/folder-structure': ['error', servicesStructure] },
  // },
  //
  // ── Cross-folder import walls (independent-modules) are NOT shipped here. ────
  // A plain React app has no trust boundary to wall off. If you adopt a
  // feature-sliced layout (src/features/<x>/index.ts barrels), add a
  // createIndependentModules block — see the electron preset for the pattern.
  // Do NOT add a wall whose `pattern` matches nothing in your repo: an empty
  // match is a silent no-op at best and confusing at worst.
  //
  // File-size + function-size limits. Source = 500/file + 200/function. .tsx
  // render functions get 300. Tests = 2000/file (loose). Stub plugins register
  // rule names for legacy inline disables.
  {
    // Reason: electron and react-app are SEPARATE shipped eslint templates, each a standalone file copied into a consumer repo (no devkit import to share a base) - intentional per-stack duplication
    // fallow-ignore-next-line code-duplication
    files: [`${SRC}/**/*.{ts,tsx}`],
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
    files: [`${SRC}/**/*.tsx`],
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
