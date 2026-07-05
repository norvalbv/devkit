/**
 * `devkit move` codemod — verifies it relocates a file and rewrites EVERY reference style
 * (alias importer, relative importer, the moved file's own relative imports, vi.mock + dynamic
 * import string args, colocated test sibling) into `@/` alias form, and surgically prunes the
 * structure baseline. Runs the real CLI in a throwaway git repo (git mv needs an index).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI, rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

function fixture() {
  const root = mkTmp('move-');
  const write = (rel, content) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }));
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { paths: { '@/*': ['./src/renderer/*'] } },
      include: ['src'],
    }),
  );
  // the file to move + a non-moved dependency it imports relatively (tests re-anchor)
  write(
    'src/renderer/features/a/util.ts',
    "import { helper } from './helper';\nexport const x = helper;\n",
  );
  write('src/renderer/features/a/helper.ts', 'export const helper = 1;\n');
  // colocated test sibling — moves WITH util
  write(
    'src/renderer/features/a/util.test.ts',
    "import { x } from './util';\nexport const t = x;\n",
  );
  // relative importer (same dir) + alias importer (other feature)
  write('src/renderer/features/a/sibling.ts', "import { x } from './util';\nexport const y = x;\n");
  write(
    'src/renderer/features/b/use.ts',
    "import { x } from '@/features/a/util';\nexport const z = x;\n",
  );
  // vi.mock + dynamic import string args
  write(
    'src/renderer/features/c/c.test.ts',
    "import { vi } from 'vitest';\nvi.mock('@/features/a/util');\nexport const load = () => import('@/features/a/util');\n",
  );
  write(
    'eslint/baselines/renderer.mjs',
    'export const rendererStructureBaseline = [\n  "features/a/util.ts",\n  "features/a/util.test.ts",\n  "keep/other.ts"\n];\n',
  );
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  return root;
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

describe('devkit move', () => {
  it('relocates a file and rewrites all references in alias style + prunes baseline', () => {
    const root = fixture();
    execFileSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/a/util.ts', 'src/renderer/lib/utils'],
      {
        cwd: root,
        stdio: 'pipe',
      },
    );

    // file moved (+ colocated test moved with it)
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.test.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(false);

    // alias importer rewritten
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
    expect(read(root, 'src/renderer/features/b/use.ts')).not.toContain('@/features/a/util');

    // relative importer rewritten to alias
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'@/lib/utils/util'");
    expect(read(root, 'src/renderer/features/a/sibling.ts')).not.toContain("'./util'");

    // moved file's OWN relative import re-anchored to alias (helper stayed put)
    expect(read(root, 'src/renderer/lib/utils/util.ts')).toContain("'@/features/a/helper'");

    // vi.mock + dynamic import() string args rewritten
    const cTest = read(root, 'src/renderer/features/c/c.test.ts');
    expect(cTest).toContain("vi.mock('@/lib/utils/util')");
    expect(cTest).toContain("import('@/lib/utils/util')");
    expect(cTest).not.toContain('@/features/a/util');

    // baseline pruned (moved entries gone, unrelated kept)
    const baseline = read(root, 'eslint/baselines/renderer.mjs');
    expect(baseline).not.toContain('features/a/util.ts');
    expect(baseline).not.toContain('features/a/util.test.ts');
    expect(baseline).toContain('keep/other.ts');
  });

  it('prunes a non-electron (config-driven) baseline using guard.config.json roots', () => {
    // Layout-agnostic: a consumer whose structure.trees declare an `app/` root must still
    // get its baseline pruned — the prune now follows guard.config.json, not the electron literal.
    const root = mkTmp('move-app-');
    const write = (rel, content) => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), content);
    };
    write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }));
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./app/*'] } }, include: ['app'] }),
    );
    write(
      'guard.config.json',
      JSON.stringify({ scanRoots: ['app'], structure: { trees: [{ name: 'app', root: 'app' }] } }),
    );
    write('app/foo.ts', 'export const x = 1;\n');
    write('app/use.ts', "import { x } from '@/foo';\nexport const z = x;\n");
    write(
      'eslint/baselines/app.mjs',
      'export const appStructureBaseline = [\n  "foo.ts",\n  "keep/other.ts"\n];\n',
    );
    git(root, 'init', '-q');
    git(root, 'add', '-A');

    execFileSync(process.execPath, [CLI, 'move', 'app/foo.ts', 'app/sub'], {
      cwd: root,
      stdio: 'pipe',
    });

    expect(existsSync(join(root, 'app/sub/foo.ts'))).toBe(true);
    const baseline = read(root, 'eslint/baselines/app.mjs');
    expect(baseline).not.toContain('"foo.ts"'); // moved entry pruned
    expect(baseline).toContain('keep/other.ts'); // unrelated entry kept
  });

  it('--dry-run previews without touching files', () => {
    const root = fixture();
    execFileSync(
      process.execPath,
      [CLI, 'move', 'src/renderer/features/a/util.ts', 'src/renderer/lib/utils', '--dry-run'],
      {
        cwd: root,
        stdio: 'pipe',
      },
    );
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(false);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain('@/features/a/util');
  });
});
