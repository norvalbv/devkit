/** Runtime-neutral edits in scope "diff": a comment, formatting or type-only change carries no added
 * executable lines and leaves the measured code intact, so it neither needs nor invalidates a run. */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotSource, TOUCHED } from '../provenance.mts';
import { runtimeNeutral } from '../neutral-edit/runtime-neutral.mts';
import { cleanupRepos, gate, git, measure, repo, stage, write } from './_provenance-fixtures.mts';

beforeEach(() => {
  vi.stubEnv('GUARD_COVERAGE_OK', '');
  vi.stubEnv('GUARD_NO_COVERAGE', '');
  vi.stubEnv('DEVKIT_RUN_MODE', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupRepos();
});

/** One istanbul entry from { line: hits }; an empty map is a file with no statements. */
const entry = (hits: Record<number, number>) => {
  const lines = Object.entries(hits);
  return {
    statementMap: Object.fromEntries(lines.map(([l], i) => [String(i), { start: { line: +l } }])),
    s: Object.fromEntries(lines.map(([, h], i) => [String(i), h])),
    f: {},
    b: {},
  };
};

/** One artifact: repo-relative path → { line: hits }, keyed by `root` as istanbul writes it. */
const cov = (root: string, files: Record<string, Record<number, number>>): string =>
  JSON.stringify(
    Object.fromEntries(Object.entries(files).map(([p, h]) => [`${root}/${p}`, entry(h)])),
  );

const TYPES = '/**\n * One.\n * Two.\n * Three.\n */\nexport interface T {\n  a: string;\n}\n';
const TYPES_SHORT = '/**\n * One. Two. Three.\n */\nexport interface T {\n  a: string;\n}\n';
const A2 = 'export const a = 1;\nexport const b = 2;\n';

/** a.mts gains a scored line 2 and src/types.mts is born with `types`, both measured UNSTAGED, so
 * the measured bytes of types.mts exist only if the run wrote them. */
function measuredTypes(types = TYPES): string {
  const { root } = repo('', { scope: 'diff', addedLines: 70 });
  write(root, 'src/a.mts', A2);
  write(root, 'src/types.mts', types);
  measure(
    root,
    snapshotSource(root),
    cov(root, { 'src/a.mts': { 1: 1, 2: 1 }, 'src/types.mts': {} }),
  );
  return root;
}

/** Edit types.mts after the run, stage everything, and run the gate. */
function afterRun(root: string, types: string) {
  write(root, 'src/types.mts', types);
  stage(root);
  return gate(root);
}

describe('runtimeNeutral', () => {
  it.each([
    ['a comment edit', 'export const a = 1; // x\n', '/** y */\nexport const a = 1;\n'],
    ['a formatting edit', 'export const a = 1;\n', 'export const a =\n  1;\n'],
    [
      'a type field added',
      'export interface T { a: string }\n',
      'export interface T { a: string; b: number }\n',
    ],
    ['a declare-only script', 'declare const x: number;\n', 'declare const x: string;\n'],
    [
      'a JSDoc edit in a file whose code mentions sourceURL',
      "export const k = 'sourceURL';\n",
      "/** The key. */\nexport const k = 'sourceURL';\n",
    ],
    // A Windows checkout reads CRLF from disk while git's blob holds LF.
    [
      'a CRLF checkout of an LF blob',
      'export const a = 1; // x\n',
      '/** y */\r\nexport const a = 1;\r\n',
    ],
    [
      'ambient modules and type-only star exports',
      "declare module 'm' { export const v: number }\nexport type * from './t';\n",
      "declare module 'm' {\n  export const v: string;\n}\nexport type * from './t';\n",
    ],
  ])('holds for %s', (_, before, after) => {
    expect(runtimeNeutral('src/x.ts', before, after)).toBe(true);
  });

  it('holds for a new types-only file and not for a new file with code', () => {
    expect(runtimeNeutral('src/x.mts', null, 'export type X = 1;\n')).toBe(true);
    const typeImport = "import type { A } from './a';\nexport interface B extends A {}\n";
    expect(runtimeNeutral('src/x.mts', null, typeImport)).toBe(true);
    expect(runtimeNeutral('src/x.mts', null, 'export const x = 1;\n')).toBe(false);
  });

  it.each([
    ['a value change', 'src/x.ts', 'export const a = 1;\n', 'export const a = 2;\n'],
    [
      'whitespace inside a template literal',
      'src/x.ts',
      'export const s = `a b`;\n',
      'export const s = `a  b`;\n',
    ],
    [
      'an inline type import, which still loads the module',
      'src/x.ts',
      'export type T = 1;\n',
      "import { type A } from './a';\nexport type T = A;\n",
    ],
    ['a const enum', 'src/x.ts', '', 'const enum E { A }\nexport const e = E.A;\n'],
    [
      'a re-export',
      'src/x.ts',
      'export type T = 1;\n',
      'export type T = 1;\nexport { X } from "./x";\n',
    ],
    [
      'an unused named import',
      'src/x.ts',
      'import { a } from "./a";\nexport type T = 1;\n',
      'export type T = 1;\n',
    ],
    ['a parse error', 'src/x.ts', 'export const a = 1;\n', '/* open\nexport const a = 1;\n'],
    [
      'a JSX pragma',
      'src/x.tsx',
      'export const a = 1;\n',
      '/** @jsxImportSource preact */\nexport const a = 1;\n',
    ],
    ['a source map comment', 'src/x.js', 'a();\n', 'a();\n//# sourceMappingURL=x.js.map\n'],
    ['a non-JS file', 'src/x.vue', '<template/>\n', '<!-- c -->\n<template/>\n'],
  ])('does not hold for %s', (_, path, before, after) => {
    expect(runtimeNeutral(path, before, after)).toBe(false);
  });
});

describe('scope "diff": a runtime-neutral edit needs no artifact', () => {
  it('passes a JSDoc-only edit to a file with code when no coverage/ exists', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 70 });
    write(root, 'src/a.mts', '/** The answer. */\nexport const a = 1;\n');
    stage(root);
    const { code, out } = gate(root);
    expect(existsSync(join(root, 'coverage'))).toBe(false);
    expect(code).toBe(0);
    expect(out).toContain('no artifact needed');
  });

  it('passes a new types-only file that no test loads', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 70 });
    write(root, 'src/a.mts', A2);
    write(root, 'src/types.mts', TYPES);
    stage(root);
    measure(root, snapshotSource(root), cov(root, { 'src/a.mts': { 1: 1, 2: 1 } }));
    const { code, out } = gate(root);
    expect(code).toBe(0);
    expect(out).toContain('1/1 added executable lines covered');
  });

  it('still blocks a comment added beside code with no artifact', () => {
    const { root } = repo('', { scope: 'diff', addedLines: 70 });
    write(root, 'src/a.mts', '// note\nexport const a = 2;\n');
    stage(root);
    expect(gate(root).code).toBe(1);
  });
});

describe('scope "diff": drift the measured bytes prove harmless', () => {
  it('passes a JSDoc shortened after the run in a types-only file, and says so', () => {
    const root = measuredTypes();
    const sink = join(root, 'events.jsonl');
    vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
    const { code, out } = afterRun(root, TYPES_SHORT);
    expect(code).toBe(0);
    expect(out).toContain('predates 1 file(s) only in runtime-neutral ways');
    expect(out).toMatch(/runtime-neutral[^\n]*\n\s+src\/types\.mts/);
    const event = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'coverage_provenance');
    expect(event).toMatchObject({ state: 'fresh', production_count: 0, exempt_count: 1 });
  });

  it('passes a field added to a type after the run', () => {
    const root = measuredTypes();
    expect(afterRun(root, TYPES.replace('a: string;', 'a: string;\n  b: number;')).code).toBe(0);
  });

  it.each([
    ['a runtime export added', `${TYPES}export const x = 1;\n`, TYPES],
    ['a side-effect import removed', TYPES, `import './a.mts';\n${TYPES}`],
    ['an unused named import removed', TYPES, `import { a } from './a.mts';\n${TYPES}`],
    ['a parse error left behind', `${TYPES}export interface U {\n`, TYPES],
    ['a JSX pragma added', `/** @jsx h */\n${TYPES}`, TYPES],
  ])('blocks %s after the run', (_, after, measured) => {
    const { code, out } = afterRun(measuredTypes(measured), after);
    expect(code).toBe(1);
    expect(out).toContain('the artifact (run');
    expect(out).toContain('src/types.mts');
  });

  it('blocks a comment inserted in a SCORED file after the run, whose lines it shifts', () => {
    const root = measuredTypes();
    write(root, 'src/a.mts', `// shifted\n${A2}`);
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toMatch(/predates:\n\s+src\/a\.mts/);
  });

  it.each([
    ['its call deleted', 'export const b = () => 1;\n'],
    ['its call commented out', 'export const b = () => 1;\n// b();\n'],
  ])('blocks an unscored file with %s after the run', (_, after) => {
    const { root } = repo('', { scope: 'diff', addedLines: 70 });
    write(root, 'src/b.mts', 'export const b = () => 1;\nb();\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'b');
    write(root, 'src/a.mts', A2);
    stage(root);
    measure(
      root,
      snapshotSource(root),
      cov(root, { 'src/a.mts': { 1: 1, 2: 1 }, 'src/b.mts': { 1: 1, 2: 1 } }),
    );
    write(root, 'src/b.mts', after);
    stage(root);
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toMatch(/predates:\n\s+src\/b\.mts/);
  });

  it.each([
    ['are not in git', 'f'.repeat(40)],
    ['were written during the run', TOUCHED],
  ])('blocks as plain drift, never as unknown, when the measured bytes %s', (_, measured) => {
    const { root } = repo('', { scope: 'diff', addedLines: 70 });
    write(root, 'src/a.mts', A2);
    write(root, 'src/types.mts', TYPES);
    stage(root);
    const snap = snapshotSource(root);
    if (!snap) throw new Error('no snapshot');
    snap.dirty['src/types.mts'] = measured;
    measure(root, snap, cov(root, { 'src/a.mts': { 1: 1, 2: 1 }, 'src/types.mts': {} }));
    const { code, out } = gate(root);
    expect(code).toBe(1);
    expect(out).toContain('predates:');
    expect(out).not.toContain('provenance unknown');
  });

  it("judges the commit's own index, not the default one", () => {
    const root = measuredTypes();
    write(root, 'src/types.mts', TYPES_SHORT);
    stage(root);
    const temp = join(root, '.git', 'temp-index');
    copyFileSync(join(root, '.git', 'index'), temp);
    write(root, 'src/types.mts', `${TYPES}export const x = 1;\n`);
    vi.stubEnv('GIT_INDEX_FILE', temp);
    git(root, 'add', 'src/types.mts');
    expect(gate(root).code).toBe(1);
  });
});
