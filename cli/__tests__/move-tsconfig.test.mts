/** `devkit move` reading tsconfig: JSONC, a missing alias, edge cases and solution-style references. */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI, testSpawnSync } from './_helpers.mts';
import {
  cleanup,
  fakeGit,
  fixture,
  git,
  MOVE_ARGS,
  read,
  runMove,
  runMoveArgs,
  writePath,
} from './_move-fixture.mts';

// Never called: declares the spawned module to vitest's graph, so `vitest related` selects this file.
void (() => import('../commands/move.mts'));

afterEach(cleanup);

// tsconfig is JSONC, not JSON: these fixtures are raw text because JSON.stringify cannot emit
// comments, trailing commas or a // inside a string value.
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

  it('--dry-run previews a repo whose tsconfig declares no alias, counting the rewrites', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root, '--dry-run');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[dry] mv src/renderer/features/a/util.ts');
    // sibling + util's own helper import; the alias importers cannot resolve without paths
    expect(r.stdout).toMatch(/\[dry\] would rewrite 2 specifier\(s\)/);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(false);
  });

  it('moves a repo with no alias, keeping relative importers relative', () => {
    const root = fixture(NO_ALIAS_TSCONFIG);
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'src/renderer/lib/utils/util.ts'))).toBe(true);
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
    expect(r.stderr).not.toMatch(/path alias found/);
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
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/Cannot read properties of undefined/);
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
  });

  it('ignores exact-match paths keys, which name no directory to re-anchor under', () => {
    const root = fixture(
      JSON.stringify({ compilerOptions: { paths: { '@app': ['./src/renderer/app.ts'] } } }),
    );
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
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
    writePath(
      root,
      'src/renderer/features/d/tilde.ts',
      "import { x } from '~/features/a/util';\nexport const t = x;\n",
    );
    git(root, 'add', '-A');
    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    // '~/' is the usable alias: an importer written with it stays '~/', relatives stay relative
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
    expect(read(root, 'src/renderer/features/d/tilde.ts')).toContain("'~/lib/utils/util'");
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

describe('devkit move — solution-style tsconfig (project references)', () => {
  const PATHS = { '@/*': ['./src/renderer/*'] };

  it('rewrites importers that only a referenced project includes', () => {
    const root = fixture(
      JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
    );
    writeCfg(root, 'tsconfig.app.json', {
      compilerOptions: { composite: true, paths: PATHS },
      include: ['src'],
    });
    git(root, 'add', '-A');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
    expect(read(root, 'src/renderer/features/a/sibling.ts')).toContain("'../../lib/utils/util'");
  });

  it('finishes rewriting when the move itself breaks a project reference', () => {
    const root = fixture(
      JSON.stringify({ files: [], references: [{ path: './src/renderer/features/a' }] }),
    );
    writeCfg(root, 'src/renderer/features/a/tsconfig.json', {
      compilerOptions: { composite: true },
      include: ['.'],
    });
    git(root, 'add', '-A');

    const r = runMoveArgs(root, 'src/renderer/features/a', 'src/renderer/lib');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/could not re-read tsconfig after the move/);
    expect(existsSync(join(root, 'src/renderer/lib/a/util.ts'))).toBe(true);
  });

  it("rewrites a file created mid-move in a referenced project with that project's aliases", () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { paths: PATHS },
        include: ['src/renderer/features/a', 'src/renderer/features/c'],
        references: [{ path: './tsconfig.other.json' }],
      }),
    );
    writeCfg(root, 'tsconfig.other.json', {
      compilerOptions: { composite: true, paths: { '~/*': ['./src/renderer/*'] } },
      include: ['src/renderer/features/b'],
    });
    git(root, 'add', '-A');
    const late = join(root, 'src/renderer/features/b/late.ts');
    const env = fakeGit(root, `  printf "import { x } from '~/features/a/util';\\n" > "${late}"`);

    const r = testSpawnSync(process.execPath, [CLI, ...MOVE_ARGS], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'src/renderer/features/b/late.ts')).toBe(
      "import { x } from '~/lib/utils/util';\n",
    );
  });

  it('leaves a node_modules file alone even when tsconfig lists it, in the rescan too', () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { paths: PATHS },
        include: ['src'],
        files: ['node_modules/vendor/dep.ts'],
      }),
    );
    // an alias import resolves from inside node_modules, unlike a relative one (TypeScript calls
    // that an external library), so only the scope filter keeps this file out of the rewrite
    const vendored = "import { x } from '@/features/a/util';\nexport const v = x;\n";
    writePath(root, 'node_modules/vendor/dep.ts', vendored);
    git(root, 'add', '-A', '-f');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    expect(read(root, 'node_modules/vendor/dep.ts')).toBe(vendored);
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'@/lib/utils/util'");
  });

  it('rewrites each referenced project with its own aliases', () => {
    const root = fixture(
      JSON.stringify({
        compilerOptions: { paths: PATHS },
        include: ['src/renderer/features/a', 'src/renderer/features/c'],
        references: [{ path: './tsconfig.other.json' }],
      }),
    );
    writeCfg(root, 'tsconfig.other.json', {
      compilerOptions: { composite: true, paths: { '~/*': ['./src/renderer/*'] } },
      include: ['src/renderer/features/b'],
    });
    writePath(
      root,
      'src/renderer/features/b/use.ts',
      "import { x } from '~/features/a/util';\nexport const z = x;\n",
    );
    git(root, 'add', '-A');

    const r = runMove(root);
    expect(r.status, r.stderr).toBe(0);
    // the other project's '~/' import resolves only with its own paths, and keeps that prefix
    expect(read(root, 'src/renderer/features/b/use.ts')).toContain("'~/lib/utils/util'");
    expect(read(root, 'src/renderer/features/c/c.test.ts')).toContain(
      "vi.mock('@/lib/utils/util')",
    );
  });
});
