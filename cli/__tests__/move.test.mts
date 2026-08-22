/**
 * `devkit move` codemod — verifies it relocates a file and rewrites EVERY reference style
 * (alias importer, relative importer, the moved file's own relative imports, vi.mock + dynamic
 * import string args, colocated test sibling) into `@/` alias form, and surgically prunes the
 * structure baseline. Runs the real CLI in a throwaway git repo (git mv needs an index).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI, rootRegistry, testSpawnSync } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

const DEFAULT_TSCONFIG = JSON.stringify({
  compilerOptions: { paths: { '@/*': ['./src/renderer/*'] } },
  include: ['src'],
});

function fixture(tsconfigText = DEFAULT_TSCONFIG) {
  const root = mkTmp('move-');
  const write = (rel, content) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module' }));
  write('tsconfig.json', tsconfigText);
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
    '.devkit/baselines/structure/renderer.mjs',
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
    const baseline = read(root, '.devkit/baselines/structure/renderer.mjs');
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
      '.devkit/baselines/structure/app.mjs',
      'export const appStructureBaseline = [\n  "foo.ts",\n  "keep/other.ts"\n];\n',
    );
    git(root, 'init', '-q');
    git(root, 'add', '-A');

    execFileSync(process.execPath, [CLI, 'move', 'app/foo.ts', 'app/sub'], {
      cwd: root,
      stdio: 'pipe',
    });

    expect(existsSync(join(root, 'app/sub/foo.ts'))).toBe(true);
    const baseline = read(root, '.devkit/baselines/structure/app.mjs');
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

// tsconfig is JSONC, not JSON. These fixtures are raw text because JSON.stringify can never
// emit the comment forms that broke the old regex stripper (sc-1713).
const JSONC_TSCONFIG = `{
  // devkit reads this through TypeScript's own config reader
  "//": "notes at https://example.dev/tsconfig — the // in this value must survive",
  "compilerOptions": {
    /* block comment */
    "paths": { "@/*": ["./src/renderer/*"] }, // trailing comment
  },
  "include": ["src"],
}
`;

const NO_ALIAS_TSCONFIG = `{
  "//": "devkit's own shape: a comment key holding https://, and no paths at all",
  "compilerOptions": { "strict": true },
  "include": ["src"]
}
`;

const MOVE_ARGS = ['move', 'src/renderer/features/a/util.ts', 'src/renderer/lib/utils'];
const runMove = (root, ...extra) =>
  testSpawnSync(process.execPath, [CLI, ...MOVE_ARGS, ...extra], { cwd: root, encoding: 'utf8' });

describe('devkit move — tsconfig reading', () => {
  it('reads a JSONC tsconfig with "//" comment keys, block comments and trailing commas', () => {
    const root = fixture(JSONC_TSCONFIG);
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/Bad control character|Unexpected token/);
    // the alias root came FROM the JSONC — not merely "nothing threw"
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('resolves paths declared by an extended base config in a subdirectory', () => {
    const root = fixture(JSON.stringify({ extends: './config/base.json', include: ['src'] }));
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(
      join(root, 'config/base.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['../src/renderer/*'] } } }),
    );
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    // '../src/renderer/*' is relative to config/, not to cwd
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('--dry-run still previews when tsconfig declares no alias, but reports the real run cannot run', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root, '--dry-run');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[dry] mv src/renderer/features/a/util.ts');
    expect(r.stdout).toContain('[dry] would rewrite importers');
    expect(r.stderr).toMatch(/no "@\/\*"-style path alias found/);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(false);
  });

  it('the real run aborts on a missing alias without printing an mv line', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no "@\/\*"-style path alias found/);
    expect(r.stdout).not.toContain('mv '); // nothing moved, so nothing may claim it did
  });

  it('a broken extends chain is diagnosed by name, not reported as a missing alias', () => {
    const root = fixture(JSON.stringify({ extends: './config/missing.json', include: ['src'] }));
    const r = runMove(root, '--dry-run');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing\.json/);
    expect(r.stderr).not.toMatch(/pass --alias/);
  });

  it('names the offending file when an extends target exists but is malformed', () => {
    const root = fixture(JSON.stringify({ extends: './config/broken.json', include: ['src'] }));
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config/broken.json'), '{ "compilerOptions": { oops }');
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/broken\.json/);
    expect(r.stderr).not.toMatch(/pass --alias/);
  });

  it('rejects --alias without a directory instead of failing inside path.resolve', () => {
    const r = runMove(fixture(), '--alias=@/');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--alias needs PREFIX=DIR/);
    expect(r.stderr).not.toMatch(/must be of type string/);
  });
});

const writeCfg = (root, rel, value) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), JSON.stringify(value));
};

describe('devkit move — tsconfig edge cases', () => {
  // --alias is the remedy the no-alias error names, so it has to work on the repos that hit it.
  it('--alias moves and rewrites in a repo whose tsconfig declares no paths', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root, '--alias=@/=src/renderer');
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(true);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('--alias makes --dry-run report a viable run in a repo with no paths', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root, '--dry-run', '--alias=@/=src/renderer');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[dry] mv src/renderer/features/a/util.ts');
    expect(r.stderr).not.toMatch(/path alias found/);
  });

  it('reports a missing tsconfig by name rather than leaking a raw ENOENT', () => {
    const root = fixture();
    rmSync(join(root, 'tsconfig.json'));
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not read tsconfig\.json/);
    expect(r.stderr).not.toMatch(/ENOENT/);
  });

  it('reports a syntactically broken tsconfig without leaking a JSON.parse error', () => {
    const root = fixture('{ "compilerOptions": { oops }');
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not read tsconfig\.json/);
    expect(r.stderr).not.toMatch(/Unexpected token|Bad control character/);
  });

  it('treats a paths key with an empty target list as no alias, not a crash', () => {
    const root = fixture(JSON.stringify({ compilerOptions: { paths: { '@/*': [] } } }));
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no "@\/\*"-style path alias found/);
    expect(r.stderr).not.toMatch(/Cannot read properties of undefined/);
  });

  it('ignores exact-match paths keys, which this codemod cannot rewrite', () => {
    const root = fixture(
      JSON.stringify({ compilerOptions: { paths: { '@app': ['./src/renderer/app.ts'] } } }),
    );
    const r = runMove(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no "@\/\*"-style path alias found/);
  });

  // --alias short-circuits tsconfig reading, but ts-morph still needs tsconfig to enumerate
  // sources. That check has to happen BEFORE git mv, or the tree is left half-moved.
  it('does not half-move the tree when --alias is given but tsconfig is missing', () => {
    const root = fixture();
    rmSync(join(root, 'tsconfig.json'));
    const r = runMove(root, '--alias=@/=src/renderer');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not read tsconfig\.json/);
    // nothing may be relocated when the run cannot finish rewriting importers
    expect(existsSync(join(root, 'src/renderer/features/a/util.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(false);
    expect(r.stdout).not.toContain('mv ');
  });

  it('skips an empty target list and uses the next usable paths key', () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { paths: { '@/*': [], '~/*': ['./src/renderer/*'] } },
        include: ['src'],
      }),
    );
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    // '~/' was selected, so the relative importer re-anchors to it
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'~/lib/utils/util'");
  });

  it('resolves paths against baseUrl when baseUrl is declared', () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { baseUrl: './src', paths: { '@/*': ['./renderer/*'] } },
        include: ['src'],
      }),
    );
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('follows an extends chain more than one hop deep', () => {
    const root = fixture(JSON.stringify({ extends: './config/mid.json', include: ['src'] }));
    writeCfg(root, 'config/mid.json', { extends: './deep/base.json' });
    writeCfg(root, 'config/deep/base.json', {
      compilerOptions: { paths: { '@/*': ['../../src/renderer/*'] } },
    });
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('accepts an extends array, where the last entry wins', () => {
    const root = fixture(
      JSON.stringify({ extends: ['./config/a.json', './config/b.json'], include: ['src'] }),
    );
    writeCfg(root, 'config/a.json', { compilerOptions: { strict: true } });
    writeCfg(root, 'config/b.json', {
      compilerOptions: { paths: { '@/*': ['../src/renderer/*'] } },
    });
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  // Editors on Windows routinely write a BOM; JSON.parse rejects one, ts.sys.readFile strips it.
  it('parses a tsconfig written with a UTF-8 BOM', () => {
    const root = fixture(
      `﻿${JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/renderer/*'] } },
        include: ['src'],
      })}`,
    );
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });
});
