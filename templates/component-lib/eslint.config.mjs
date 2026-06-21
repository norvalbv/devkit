// @ts-nocheck — emitted config: imports eslint-plugin-project-structure (peer-installed in THIS repo,
// not in devkit). ESLint configs aren't type-checked. Biome owns code/style lint; this governs folder
// + file PLACEMENT only. File/function SIZE is governed by the guard-size ratchet (guard.config.json),
// NOT here — so this config needs no @typescript-eslint/parser, only the structure plugin's own parser.
//
// FLAT COMPONENT-LIBRARY preset. A primitives/components package keeps src/ FLAT — PascalCase
// component files DIRECTLY (Button.tsx) + camelCase helpers (cn.ts) + an index.ts barrel — NOT an
// app's components/<Pascal>/index.tsx foldering. The rule governs that flat src/:
//   PascalCase component    → Button.tsx          {pascal_file}
//   camelCase helper/barrel → cn.ts, index.ts     {camel_ts}
//   colocated test          → Button.test.tsx     {test_file}
//   stylesheet              → styles.css          {any_css}
//   optional Pascal subdir  → a future Button/ folder conforms recursively
// A misnamed loose file (kebab `foo-bar.ts`, camelCase `.tsx` like `badName.tsx`) is REJECTED. To
// loosen/tighten, edit `flatChildren`. SRC derives from guard.config.json scanRoots[0], so a monorepo
// lib at packages/ui/src just sets that there — no edits here.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createFolderStructure,
  projectStructureParser,
  projectStructurePlugin,
} from 'eslint-plugin-project-structure';

const HERE = dirname(fileURLToPath(import.meta.url));

// App root — SINGLE SOURCE OF TRUTH = guard.config.json scanRoots[0] (default 'src'). Read relative
// to HERE (cwd-independent); falls back to 'src' on a bare repo.
// Reason: CRAP-driven (cyc 5/cog 4, low): each branch is one defensive narrowing of untrusted
// guard.config.json (file readable? scanRoots an array? [0] a non-empty string? else 'src'); exercised
// end-to-end at eslint config load, not unit-tested.
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
const SRC = appRoot();

// Load a named array export from eslint/baselines/, or [] when the file is absent (a clean lib has
// none — the flat rule already passes; generated grandfathers only appear if you opt into a baseline).
async function loadArray(file, exportName) {
  const abs = join(HERE, 'eslint', 'baselines', file);
  if (!existsSync(abs)) return [];
  const mod = await import(pathToFileURL(abs).href);
  return mod[exportName] ?? [];
}
const [libStructureBaseline, libStructureExempt] = await Promise.all([
  loadArray('lib.mjs', 'libStructureBaseline'),
  loadArray('exempt.mjs', 'libStructureExempt'),
]);

const regex = {
  PascalDir: '^[A-Z][a-zA-Z0-9]*$',
  pascal_file: '^[A-Z][a-zA-Z0-9]*\\.tsx?$',
  camel_ts: '^[a-z][a-zA-Z0-9]*\\.ts$',
  test_file: '^.+\\.(test|spec)\\.tsx?$',
  any_css: '^.+\\.css$',
};

// The controlled file vocabulary for the flat src/ root (and any PascalCase subfolder).
const flatChildren = [
  { name: '{pascal_file}' }, // Button.tsx, Tile.tsx
  { name: '{camel_ts}' }, // cn.ts, index.ts, theme.ts
  { name: '{test_file}' }, // Button.test.tsx
  { name: '{any_css}' }, // styles.css
];

// A PascalCase subfolder (e.g. a future Button/ grouping) conforms recursively to the same vocabulary.
const componentFolderRule = {
  name: '{PascalDir}',
  children: [...flatChildren, { name: 'index.ts' }, { name: 'index.tsx' }, { ruleId: 'componentFolder' }],
};

const libStructure = createFolderStructure({
  regexParameters: regex,
  structureRoot: SRC,
  // __tests__ is wall-free; baseline = generated grandfathers (opt-in); exempt = hand-maintained.
  ignorePatterns: ['**/__tests__/**', ...libStructureBaseline, ...libStructureExempt],
  structure: { name: SRC, children: [...flatChildren, { ruleId: 'componentFolder' }] },
  rules: { componentFolder: componentFolderRule },
});

export default [
  { ignores: ['**/dist/**', '**/build/**', '**/out/**', '**/*.tsbuildinfo'] },
  {
    files: [`${SRC}/**/*.{ts,tsx,css}`, `${SRC}/*`],
    plugins: { 'project-structure': projectStructurePlugin },
    languageOptions: { parser: projectStructureParser },
    rules: { 'project-structure/folder-structure': ['error', libStructure] },
  },
];
