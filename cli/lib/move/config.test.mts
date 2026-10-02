import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProjectConfig } from './config.mts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'move-config-')));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('readProjectConfig', () => {
  it('models every fallback target of a paths entry, in order', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/app/*', './src/shared/*'] } },
      }),
      'src/app/a.ts': '',
    });
    expect(readProjectConfig(root).scopes[0].aliases).toEqual([
      { prefix: '@/', root: join(root, 'src/app') },
      { prefix: '@/', root: join(root, 'src/shared') },
    ]);
  });

  it('splits --alias on the first "=" only, so a directory may contain one', () => {
    const root = project({ 'tsconfig.json': '{}', 'src/a=b/x.ts': '' });
    expect(readProjectConfig(root, '@/=src/a=b').scopes[0].aliases[0]).toEqual({
      prefix: '@/',
      root: join(root, 'src/a=b'),
    });
  });

  it('rejects an empty --alias= instead of treating it as absent', () => {
    const root = project({ 'tsconfig.json': '{}', 'a.ts': '' });
    expect(() => readProjectConfig(root, '')).toThrow(/--alias needs PREFIX=DIR/);
    expect(() => readProjectConfig(root, '=src')).toThrow(/--alias needs PREFIX=DIR/);
    expect(() => readProjectConfig(root, '*=src')).toThrow(/--alias needs PREFIX=DIR/);
    expect(() => readProjectConfig(root, '@*x=src')).toThrow(/--alias needs PREFIX=DIR/);
  });

  it('models slashless alias keys, the bare "*" included', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@*': ['./src/*'], '*': ['./x/*'] } },
      }),
      'src/a.ts': '',
    });
    expect(readProjectConfig(root).scopes[0].aliases).toEqual([
      { prefix: '@', root: join(root, 'src') },
      { prefix: '', root: join(root, 'x') },
    ]);
  });

  it('refuses a config tsc would reject even when its paths read cleanly', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/*'] } },
        include: [42],
      }),
    });
    expect(() => readProjectConfig(root)).toThrow(/could not read tsconfig\.json: .*'include'/);
  });

  it('refuses an option it does not know, whether or not TypeScript can name a likely typo', () => {
    const typo = project({ 'tsconfig.json': JSON.stringify({ compilerOptions: { pathz: {} } }) });
    expect(() => readProjectConfig(typo)).toThrow(/Did you mean 'paths'/);
    const unknown = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { fooBarBaz: true } }),
      'a.ts': '',
    });
    expect(() => readProjectConfig(unknown)).toThrow(/Unknown compiler option 'fooBarBaz'/);
  });

  it('refuses a referenced project it cannot read instead of planning without it', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.gone.json' }],
      }),
    });
    expect(() => readProjectConfig(root)).toThrow(/referenced project tsconfig\.gone\.json/);
  });

  it('refuses a referenced project whose own config tsc would reject', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': JSON.stringify({ compilerOptions: { composite: true }, include: [42] }),
    });
    expect(() => readProjectConfig(root)).toThrow(/could not read tsconfig\.app\.json/);
  });

  it('models no root for a target whose * is not trailing', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/*/index.ts', './lib/*'] } },
      }),
      'lib/a.ts': '',
    });
    expect(readProjectConfig(root).scopes[0].aliases).toEqual([
      { prefix: '@/', root: join(root, 'lib') },
    ]);
  });

  it('keeps each project in a references build with its own resolution options', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          moduleResolution: 'bundler',
          module: 'esnext',
          paths: { '@/*': ['./web/*'] },
        },
        include: ['web'],
        references: [{ path: './tsconfig.node.json' }],
      }),
      'tsconfig.node.json': JSON.stringify({
        compilerOptions: { composite: true, moduleResolution: 'nodenext', module: 'nodenext' },
        include: ['node'],
      }),
      'web/a.ts': '',
      'node/b.ts': '',
    });
    const config = readProjectConfig(root);
    const web = config.scopeOf(join(root, 'web/a.ts'));
    const node = config.scopeOf(join(root, 'node/b.ts'));
    expect(web).not.toBe(node);
    expect(web.aliases).toEqual([{ prefix: '@/', root: join(root, 'web') }]);
    expect(node.aliases).toEqual([]);
    // a file no project claims resolves with the first project that type-checks anything
    expect(config.scopeOf(join(root, 'elsewhere.ts'))).toBe(web);
  });

  it('uses the referenced project for its own files when the root type-checks none', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': JSON.stringify({
        compilerOptions: { composite: true, paths: { '@/*': ['./src/*'] } },
        include: ['src'],
      }),
      'src/a.ts': '',
    });
    const config = readProjectConfig(root);
    expect(config.scopeOf(join(root, 'src/a.ts')).aliases).toEqual([
      { prefix: '@/', root: join(root, 'src') },
    ]);
    expect(config.files).toContain(join(root, 'src/a.ts'));
  });
});
