import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findDangling,
  forcedStyle,
  mapPath,
  moveContext,
  respell,
  rewriteSource,
} from './rewrite-plan.mts';

const ALIASES = [
  { prefix: '@/', root: '/r/src' },
  { prefix: '~/', root: '/r/src' },
  { prefix: '#pkg/', root: '/r/packages/pkg' },
];

describe('respell', () => {
  it('keeps a relative specifier relative and adds the ./ prefix for a child path', () => {
    expect(respell('./util', '/r/src/a/x.ts', '/r/src/a/lib/util.ts', ALIASES)).toBe('./lib/util');
  });

  it('keeps an alias on the same prefix it was written with', () => {
    expect(respell('~/a/util', '/r/src/b/x.ts', '/r/src/lib/util.ts', ALIASES)).toBe('~/lib/util');
  });

  it('never swaps a written alias for a different prefix; it goes relative instead', () => {
    expect(respell('@/a/util', '/r/src/b/x.ts', '/r/packages/pkg/util.ts', ALIASES)).toBe(
      '../../packages/pkg/util',
    );
    // a forced switch into the root may pick whichever alias covers the target
    expect(respell('../x', '/r/src/b/x.ts', '/r/packages/pkg/util.ts', ALIASES, 'alias')).toBe(
      '#pkg/util',
    );
  });

  it('falls back to relative when no alias root covers the new home', () => {
    expect(respell('@/a/util', '/r/src/b/x.ts', '/r/other/util.ts', ALIASES)).toBe(
      '../../other/util',
    );
  });

  it('drops an implicit index but keeps one that was written out', () => {
    expect(respell('./Dir', '/r/src/c/i.ts', '/r/src/c/New/index.tsx', ALIASES)).toBe('./New');
    expect(respell('./Dir/index', '/r/src/c/i.ts', '/r/src/c/New/index.tsx', ALIASES)).toBe(
      './New/index',
    );
  });

  it('keeps a written extension, including against a .d.ts resolution', () => {
    expect(respell('./util.js', '/r/src/a/x.ts', '/r/src/b/util.ts', ALIASES)).toBe('../b/util.js');
    expect(respell('./types', '/r/src/a/x.ts', '/r/src/b/types.d.ts', ALIASES)).toBe('../b/types');
  });

  it('keeps a written ".d.ts" whole instead of collapsing it to ".ts"', () => {
    expect(respell('./types.d.ts', '/r/src/a/x.ts', '/r/src/b/types.d.ts', ALIASES)).toBe(
      '../b/types.d.ts',
    );
  });

  it('spells the importer’s own directory index as "."', () => {
    expect(respell('../c', '/r/src/c/x.ts', '/r/src/c/index.ts', ALIASES)).toBe('.');
  });
});

describe('forcedStyle (the alias wall, sc-3016)', () => {
  const ROOT = [{ prefix: '@/', root: '/r/src/renderer' }];
  it('forces an alias written from outside its root to relative', () => {
    expect(
      forcedStyle(
        '@/lib/y',
        '/r/src/main/a.ts',
        '/r/src/renderer/lib/y.ts',
        '/r/src/renderer/lib/y.ts',
        ROOT,
      ),
    ).toBe('relative');
  });

  it('keeps an alias written from inside its root', () => {
    expect(
      forcedStyle(
        '@/lib/y',
        '/r/src/renderer/a.ts',
        '/r/src/renderer/lib/y.ts',
        '/r/src/renderer/x/y.ts',
        ROOT,
      ),
    ).toBeNull();
  });

  it('switches a relative path to an alias only when its target crossed into the root', () => {
    expect(
      forcedStyle(
        '../../main/x',
        '/r/src/renderer/f/r.ts',
        '/r/src/main/x.ts',
        '/r/src/renderer/lib/x.ts',
        ROOT,
      ),
    ).toBe('alias');
    // already inside before the move: the author chose relative, so it stays relative
    expect(
      forcedStyle(
        './x',
        '/r/src/renderer/f/r.ts',
        '/r/src/renderer/f/x.ts',
        '/r/src/renderer/lib/x.ts',
        ROOT,
      ),
    ).toBeNull();
    // importer outside the root: an alias is never an option
    expect(
      forcedStyle('../x', '/r/src/main/a.ts', '/r/src/x.ts', '/r/src/renderer/x.ts', ROOT),
    ).toBeNull();
  });

  it('keeps an alias the importer reaches through any fallback target of its prefix', () => {
    const multi = [...ROOT, { prefix: '@/', root: '/r/src/shared' }];
    expect(
      forcedStyle(
        '@/y',
        '/r/src/shared/a.ts',
        '/r/src/shared/y.ts',
        '/r/src/shared/lib/y.ts',
        multi,
      ),
    ).toBeNull();
  });

  it('does not count a sibling directory sharing the root name as inside it', () => {
    expect(
      forcedStyle(
        '@/lib/y',
        '/r/src/renderer-legacy/a.ts',
        '/r/src/renderer/lib/y.ts',
        '/r/src/renderer/lib/y.ts',
        ROOT,
      ),
    ).toBe('relative');
  });
});

describe('mapPath', () => {
  const moves = [{ oldAbs: '/r/src/a', newAbs: '/r/src/z' }];
  it('maps the moved path and its descendants, but not a sibling sharing its prefix', () => {
    expect(mapPath('/r/src/a', moves)).toBe('/r/src/z');
    expect(mapPath('/r/src/a/b/c.ts', moves)).toBe('/r/src/z/b/c.ts');
    expect(mapPath('/r/src/ab/c.ts', moves)).toBe('/r/src/ab/c.ts');
  });
});

describe('planRewrites + findDangling on disk', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'rewrite-plan-'));
    dirs.push(d);
    return d;
  };
  const write = (root: string, rel: string, text: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
    return join(root, rel);
  };

  it('reports a specifier that resolves, but to a different file than the plan expected', () => {
    const root = tmp();
    const importer = write(root, 'a/i.ts', "import { x } from './x';\n");
    write(root, 'a/x.ts', 'export const x = 1;\n');
    const other = write(root, 'b/x.ts', 'export const x = 2;\n');

    const out = findDangling(new Map([[importer, [{ spec: './x', expected: other }]]]), () => ({}));
    expect(out).toEqual([{ file: importer, spec: './x' }]);
  });

  it('accepts a resolution that reaches the expected file through a symlink', () => {
    const root = tmp();
    const target = write(root, 'real/x.ts', 'export const x = 1;\n');
    mkdirSync(join(root, 'a'));
    symlinkSync(target, join(root, 'a/x.ts'));
    const importer = write(root, 'a/i.ts', "import { x } from './x';\n");

    expect(
      findDangling(new Map([[importer, [{ spec: './x', expected: target }]]]), () => ({})),
    ).toEqual([]);
  });
});

describe('rewriteSource', () => {
  // A small pre-move tree; the moves are given per test.
  const FILES = ['/r/src/a/index.ts', '/r/src/util.ts', '/r/src/use.ts', '/r/src/b.ts'];
  const ctxFor = (moves: { oldAbs: string; newAbs: string }[]) => moveContext({}, [], moves, FILES);
  const UTIL_MOVED = [{ oldAbs: '/r/src/util.ts', newAbs: '/r/lib/util.ts' }];
  const UTIL_MOVED_IN_SRC = [{ oldAbs: '/r/src/util.ts', newAbs: '/r/src/lib/util.ts' }];

  it('rewrites every spelling that reached a moved target, not one remembered string', () => {
    const ctx = ctxFor([{ oldAbs: '/r/src/a', newAbs: '/r/src/z' }]);
    const out = rewriteSource(
      "import './a';\nimport './a/index';\nimport './a/index.js';\n",
      '/r/src/use.ts',
      ctx,
    );
    expect(out.text).toBe("import './z';\nimport './z/index';\nimport './z/index.js';\n");
    expect(out.checks.map((c) => c.expected)).toEqual(Array(3).fill('/r/src/z/index.ts'));
  });

  it('covers import types, import-equals and module calls however they are written', () => {
    const out = rewriteSource(
      [
        "type U = typeof import('./util');",
        "import u = require('./util');",
        "vi . mock('./util');",
        "vi /* c */ .mock('./util');",
        "(vi.mock)('./util');",
        "(vi).mock('./util');",
        "require.resolve('./util');",
        '',
      ].join('\n'),
      '/r/src/use.ts',
      ctxFor(UTIL_MOVED),
    );
    expect(out.rewrites).toBe(7);
    expect(out.text).not.toContain("'./util'");
  });

  it('leaves a require that names a local binding alone, require.resolve included', () => {
    const out = rewriteSource(
      "function load(require: { (p: string): void; resolve(p: string): string }) {\n  require('./util');\n  require.resolve('./util');\n  (require).resolve('./util');\n}\n",
      '/r/src/use.ts',
      ctxFor(UTIL_MOVED),
    );
    expect(out.text).toBeNull();
  });

  it('points two files that moved apart at each other from their new homes', () => {
    const ctx = ctxFor([
      { oldAbs: '/r/src/use.ts', newAbs: '/r/lib/x/use.ts' },
      { oldAbs: '/r/src/b.ts', newAbs: '/r/lib/y/b.ts' },
    ]);
    expect(rewriteSource("import './b';\n", '/r/src/use.ts', ctx).text).toBe("import '../y/b';\n");
    expect(rewriteSource("import './use';\n", '/r/src/b.ts', ctx).text).toBe(
      "import '../x/use';\n",
    );
  });

  it('follows a moved non-source target such as a JSON module', () => {
    const ctx = moveContext(
      { resolveJsonModule: true },
      [],
      [{ oldAbs: '/r/src/data', newAbs: '/r/lib/data' }],
      ['/r/src/use.ts'],
      ['/r/src/data/config.json'],
    );
    const out = rewriteSource("import c from './data/config.json';\n", '/r/src/use.ts', ctx);
    expect(out.text).toBe("import c from '../lib/data/config.json';\n");
  });

  it('keeps a one-character alias like @foo, and goes relative when a fallback target would win', () => {
    const at = [{ prefix: '@', root: '/r/src' }];
    const ctx = moveContext(
      { baseUrl: '/', paths: { '@*': ['/r/src/*'] } },
      at,
      UTIL_MOVED_IN_SRC,
      FILES,
    );
    expect(rewriteSource("import '@util';\n", '/r/src/use.ts', ctx).text).toBe(
      "import '@lib/util';\n",
    );

    // '@/*' tries one/ first: an alias spelling of two/new.ts would resolve to one/new.ts instead
    const multi = [
      { prefix: '@/', root: '/r/one' },
      { prefix: '@/', root: '/r/two' },
    ];
    const files = ['/r/one/new.ts', '/r/two/old.ts', '/r/two/use.ts'];
    const shadow = moveContext(
      { baseUrl: '/', paths: { '@/*': ['/r/one/*', '/r/two/*'] } },
      multi,
      [{ oldAbs: '/r/two/old.ts', newAbs: '/r/two/new.ts' }],
      files,
    );
    expect(rewriteSource("import '@/old';\n", '/r/two/use.ts', shadow).text).toBe(
      "import './new';\n",
    );
  });

  it('keeps a bare-wildcard alias bare, and never trades a longer prefix for it', () => {
    const aliases = [
      { prefix: '@/', root: '/r/src' },
      { prefix: '', root: '/r/src' },
    ];
    const ctx = moveContext(
      { baseUrl: '/', paths: { '@/*': ['/r/src/*'], '*': ['/r/src/*'] } },
      aliases,
      [{ oldAbs: '/r/src/util.ts', newAbs: '/r/src/bar.ts' }],
      FILES,
    );
    expect(rewriteSource("import 'util';\nimport '@/util';\n", '/r/src/use.ts', ctx).text).toBe(
      "import 'bar';\nimport '@/bar';\n",
    );
  });

  it('ignores specifiers neither end of which moved, and never checks them', () => {
    const out = rewriteSource("import './b';\n", '/r/src/use.ts', ctxFor(UTIL_MOVED));
    expect(out).toEqual({ text: null, rewrites: 0, unresolved: 0, checks: [] });
  });
});
