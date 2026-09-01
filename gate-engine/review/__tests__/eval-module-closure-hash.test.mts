import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashLocalModuleClosure } from '../eval/module-closure-hash.mts';

describe('completeness-eval local module closure hash', () => {
  let dir: string;
  const write = (name: string, source: string): string => {
    const file = join(dir, name);
    writeFileSync(file, source);
    return file;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'module-closure-hash-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('changes for a transitive dependency edit but not an unrelated file edit', () => {
    const root = write('root.mts', "import './middle.mts';\nimport 'package-name';\n");
    write('middle.mts', "export * from './leaf.mts';\n");
    write('leaf.mts', 'export const value = 1;\n');
    write('unrelated.mts', 'export const unrelated = 1;\n');
    const initial = hashLocalModuleClosure([root]);

    write('unrelated.mts', 'export const unrelated = 2;\n');
    expect(hashLocalModuleClosure([root])).toBe(initial);

    write('leaf.mts', 'export const value = 2;\n');
    expect(hashLocalModuleClosure([root])).not.toBe(initial);
  });

  it('follows literal dynamic imports', () => {
    const root = write('root.mts', "export const load = () => import('./dynamic.mts');\n");
    write('dynamic.mts', 'export const value = 1;\n');
    const initial = hashLocalModuleClosure([root]);

    write('dynamic.mts', 'export const value = 2;\n');

    expect(hashLocalModuleClosure([root])).not.toBe(initial);
  });

  it('resolves source .mts aliases and compiled .mjs modules', () => {
    const sourceRoot = write('source.mts', "export { source } from './source-child.mjs';\n");
    write('source-child.mts', 'export const source = true;\n');
    const compiledRoot = write(
      'compiled.mjs',
      "export { compiled } from './compiled-child.mjs';\n",
    );
    write('compiled-child.mjs', 'export const compiled = true;\n');

    expect(hashLocalModuleClosure([sourceRoot])).toMatch(/^[0-9a-f]{12}$/);
    expect(hashLocalModuleClosure([compiledRoot])).toMatch(/^[0-9a-f]{12}$/);
  });

  it('resolves URL-escaped relative ESM specifiers', () => {
    const root = write('root.mts', "export { value } from './dep%20name.mjs';\n");
    const dependency = write('dep name.mts', 'export const value = 1;\n');
    const initial = hashLocalModuleClosure([root]);

    writeFileSync(dependency, 'export const value = 2;\n');

    expect(hashLocalModuleClosure([root])).not.toBe(initial);
  });

  it('hashes relative JSON modules as leaf dependencies', () => {
    const root = write('root.mts', "import data from './data.json' with { type: 'json' };\n");
    write('data.json', '{"value":1}\n');
    const initial = hashLocalModuleClosure([root]);

    write('data.json', '{"value":2}\n');

    expect(hashLocalModuleClosure([root])).not.toBe(initial);
  });

  it('rejects a closure that does not settle across bounded snapshots', () => {
    const root = write('root.mts', "export { value } from './dependency.mts';\n");
    const dependency = write('dependency.mts', 'export const value = 1;\n');
    let dependencyReads = 0;

    expect(() =>
      hashLocalModuleClosure([root], (file, encoding) => {
        if (file === dependency) {
          dependencyReads += 1;
          return `export const value = ${dependencyReads};\n`;
        }
        return readFileSync(file, encoding);
      }),
    ).toThrow(/changed while hashing/);
  });

  it('handles import cycles without revisiting modules forever', () => {
    const a = write('a.mts', "import './b.mts';\nexport const a = true;\n");
    write('b.mts', "export { a } from './a.mts';\nexport const b = true;\n");

    expect(hashLocalModuleClosure([a])).toMatch(/^[0-9a-f]{12}$/);
  });

  it('fails loudly when a referenced relative module cannot resolve', () => {
    const root = write('root.mts', "import './missing.mts';\n");

    expect(() => hashLocalModuleClosure([root])).toThrow(
      /Cannot resolve relative module "\.\/missing\.mts" imported by/,
    );
  });
});
