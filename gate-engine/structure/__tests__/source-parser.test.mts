// The bundled TypeScript source parser: it must load from devkit's own install, really parse imports,
// and turn a load failure into a named could-not-run rather than a thrown gate.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSourceParser } from '../source-parser.mts';
import { clean, violations, withUncompiledWalls } from '../verdict.mts';

const roots: string[] = [];
function consumer(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'source-parser-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

const MISSING = "Cannot find module '@typescript-eslint/parser'";
const missingParser = () => {
  throw new Error(MISSING);
};

// Lint a node_modules-free consumer with ESLint from devkit's install and the loaded parser.
async function lintConsumer(files: Record<string, string>, rules: Linter.RulesRecord = {}) {
  const source = loadSourceParser();
  if ('reason' in source) throw new Error(source.reason);
  const eslint = new ESLint({
    cwd: consumer(files),
    overrideConfigFile: true,
    baseConfig: [
      {
        files: ['**/*.{ts,tsx,mts,cts}'],
        languageOptions: { parser: source.parser, parserOptions: source.parserOptions },
        rules,
      },
    ],
  });
  return eslint.lintFiles(['src']);
}

describe('loadSourceParser', () => {
  it('parses a TypeScript import for a consumer with no node_modules of its own', async () => {
    const [result] = await lintConsumer(
      {
        'src/a.ts':
          "import { a } from './b.mts';\nimport { c } from './b.mts';\nexport const x: number = a + c;\n",
      },
      { 'no-duplicate-imports': 'error' },
    );
    // Only a real parser yields the ImportDeclarations this rule reads: the stub parser reports
    // nothing, and espree dies on the type annotation.
    expect(result.messages.map((message) => message.ruleId)).toEqual(['no-duplicate-imports']);
  });

  it('parses every TypeScript file shape a walled tree holds without a fatal error', async () => {
    // A fatal parse counts as a lint error, so a replacement parser that drops one shape (a Babel
    // setup without JSX for .tsx, say) would false-block every such file once walls compile.
    const results = await lintConsumer({
      'src/cast.ts': "import { a } from './b';\nexport const n = <number>a;\n",
      'src/view.tsx': "import { a } from './b';\nexport const V = () => <div>{a}</div>;\n",
      'src/generic.tsx': 'export const id = <T,>(x: T) => x;\n',
      'src/meta.mts': "import { a } from './b.mts';\nexport const u = import.meta.url + a;\n",
      'src/legacy.cts': "import a = require('./b');\nexport = a;\n",
    });
    expect(results.flatMap((result) => result.messages)).toEqual([]);
    expect(results).toHaveLength(5);
  });

  it('names the cause and the TypeScript requirement instead of throwing when it cannot load', () => {
    // Under a hoisted TypeScript 7 the raw error can be as opaque as "reading 'Intrinsic'", so the
    // reason states what the parser needs as well as the load error.
    const source = loadSourceParser(missingParser);
    expect(source).toEqual({
      reason: `TypeScript source parser unavailable (needs TypeScript 6 or earlier; TypeScript 7 has no JavaScript compiler API): ${MISSING}`,
    });
  });
});

describe('withUncompiledWalls and the source parser', () => {
  const wallsConfig = JSON.stringify({
    scanRoots: ['src'],
    structure: { trees: [], walls: [{ pattern: 'src/**', allowImportsFrom: ['src/**'] }] },
  });
  const unavailable = () => loadSourceParser(missingParser);

  it('names an unloadable parser beside the unenforced walls (could-not-run)', () => {
    const root = consumer({ 'guard.config.json': wallsConfig });
    const result = withUncompiledWalls(root, clean(), unavailable);
    expect(result.code).toBe(2);
    expect(result.text).toContain('structure.walls declares 1 import wall(s)');
    expect(result.text).toContain('TypeScript source parser unavailable');
  });

  it('keeps a found violation blocking while naming both gaps', () => {
    const root = consumer({ 'guard.config.json': wallsConfig });
    const result = withUncompiledWalls(root, violations(1, 'src/bad-name.ts'), unavailable);
    expect(result.code).toBe(1);
    expect(result.text).toContain('src/bad-name.ts');
    expect(result.text).toContain('TypeScript source parser unavailable');
  });

  it('never loads the parser when no walls are declared', () => {
    const root = consumer({ 'guard.config.json': JSON.stringify({ structure: { walls: [] } }) });
    let loads = 0;
    const result = withUncompiledWalls(root, clean(), () => {
      loads += 1;
      return { reason: 'unused' };
    });
    expect(result.code).toBe(0);
    expect(loads).toBe(0);
  });
});
