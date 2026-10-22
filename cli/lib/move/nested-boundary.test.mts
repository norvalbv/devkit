import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectScope } from './config.mts';
import { findNestedDangling, nestedRepoOf } from './nested-boundary.mts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nested-boundary-')));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function scan(root: string, files: string[], moves: [string, string][], roots = ['src']) {
  const scope: ProjectScope = {
    options: { baseUrl: root, paths: { '@/*': roots.map((r) => `${r}/*`) } },
    aliases: roots.map((r) => ({ prefix: '@/', root: join(root, r) })),
    files: files.map((f) => join(root, f)),
  };
  return findNestedDangling(
    scope.files,
    root,
    () => scope,
    moves.map(([from, to]) => ({ oldAbs: join(root, from), newAbs: join(root, to) })),
    [],
  ).map((d) => ({
    ...d,
    file: d.file.slice(root.length + 1),
    repo: d.repo.slice(root.length + 1),
  }));
}

describe('nestedRepoOf', () => {
  it('finds a .git directory or a submodule .git file, and nothing outside a nest', () => {
    const root = repo({
      '.git': 'gitdir: elsewhere\n',
      'src/a.ts': '',
      'src/vendor/.git/HEAD': '',
      'src/sub/.git': 'gitdir: ../../.git/modules/sub\n',
    });
    expect(nestedRepoOf(join(root, 'src/vendor/deep/x.ts'), root)).toBe(join(root, 'src/vendor'));
    expect(nestedRepoOf(join(root, 'src/sub/x.ts'), root)).toBe(join(root, 'src/sub'));
    expect(nestedRepoOf(join(root, 'src/a.ts'), root)).toBeNull();
    expect(nestedRepoOf(join(root, 'src/vendor'), root)).toBeNull();
    expect(nestedRepoOf(root, root)).toBeNull();
    expect(nestedRepoOf(join(dirname(root), 'x.ts'), root)).toBeNull();
  });

  it('treats a path under a regular file as outside any nest instead of throwing', () => {
    const root = repo({ 'src/a.ts': '' });
    expect(nestedRepoOf(join(root, 'src/a.ts/b.ts'), root)).toBeNull();
  });
});

describe('findNestedDangling', () => {
  it('names an unrelated nested file whose alias reached a moved outer file', () => {
    const root = repo({
      'src/a/util.ts': 'export const x = 1;\n',
      'src/vendor/.git/HEAD': '',
      'src/vendor/n.ts':
        "import { x } from '@/a/util';\nimport 'zod';\nimport '@/never/existed';\n",
    });
    expect(scan(root, ['src/a/util.ts', 'src/vendor/n.ts'], [['src/a', 'src/lib']])).toEqual([
      { file: 'src/vendor/n.ts', spec: '@/a/util', repo: 'src/vendor', suggestion: '@/lib/util' },
    ]);
  });

  it('names a moved nested file that reaches its own sibling through the outer alias', () => {
    const root = repo({
      'src/pkg/nested/.git/HEAD': '',
      'src/pkg/nested/inner.ts': "import { o } from '@/pkg/nested/other';\n",
      'src/pkg/nested/other.ts': 'export const o = 1;\n',
    });
    const files = ['src/pkg/nested/inner.ts', 'src/pkg/nested/other.ts'];
    expect(scan(root, files, [['src/pkg', 'src/lib/pkg']])).toEqual([
      {
        file: 'src/pkg/nested/inner.ts',
        spec: '@/pkg/nested/other',
        repo: 'src/pkg/nested',
        suggestion: '@/lib/pkg/nested/other',
      },
    ]);
  });

  it('stays quiet for relative imports inside a nested repo that moves whole into an alias root', () => {
    const root = repo({
      'vendor/.git/HEAD': '',
      'vendor/a.ts': "import { b } from './b';\n",
      'vendor/b.ts': 'export const b = 1;\n',
    });
    expect(scan(root, ['vendor/a.ts', 'vendor/b.ts'], [['vendor', 'src/vendor']])).toEqual([]);
  });

  it('suggests a relative spelling when the alias one would land on an earlier fallback', () => {
    const root = repo({
      'src/old/util.ts': 'export const x = 1;\n',
      'src/util.ts': 'export const decoy = 1;\n',
      'vendor/.git/HEAD': '',
      'vendor/n.ts': "import { x } from '@/old/util';\n",
    });
    const files = ['src/old/util.ts', 'src/util.ts', 'vendor/n.ts'];
    expect(scan(root, files, [['src/old/util.ts', 'lib/util.ts']], ['src', 'lib'])).toEqual([
      { file: 'vendor/n.ts', spec: '@/old/util', repo: 'vendor', suggestion: '../lib/util' },
    ]);
  });

  it('stays quiet when no planned file sits in a nested repository', () => {
    const root = repo({
      'src/a/util.ts': 'export const x = 1;\n',
      'src/b.ts': "import { x } from '@/a/util';\n",
    });
    expect(scan(root, ['src/a/util.ts', 'src/b.ts'], [['src/a', 'src/lib']])).toEqual([]);
  });
});
