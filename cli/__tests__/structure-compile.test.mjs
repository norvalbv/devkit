/**
 * compileToEslint (gate-engine/structure/compile.mjs) + the NO-DRIFT guarantee. The eslint rule's
 * regexParameters and the walker's predicates both derive from `tokenRegex` — this suite pins that
 * they classify the same filenames identically, and that a tree's grammar compiles to the expected
 * createFolderStructure shape (structureRoot, the closed-registry alternation, recurse rules,
 * __tests__/ignoredDirs ignore globs, baseline pass-through).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compileToEslint } from '../../gate-engine/structure/compile.mjs';
import { buildStructureConfigs } from '../../gate-engine/structure/eslint-config.mjs';
import { tokenPredicate, tokenRegex } from '../../gate-engine/structure/grammar.mjs';
import { structFixtures } from './_helpers.mjs';

const { tmpRepo, write, cleanup } = structFixtures('scompile-');
afterEach(cleanup);

// Assert, for each [token, accepts[], rejects[]] case, that the walker predicate and the emitted
// regex agree (the no-drift guarantee — both derive from tokenRegex).
function assertNoDrift(cases, exts) {
  for (const [token, yes, no] of cases) {
    const pred = tokenPredicate(`{${token}}`, exts);
    const re = new RegExp(tokenRegex(token, exts));
    for (const n of yes) {
      expect(pred(n), `${token} accept ${n}`).toBe(true);
      expect(re.test(n), `regex ${token} accept ${n}`).toBe(true);
    }
    for (const n of no) {
      expect(pred(n), `${token} reject ${n}`).toBe(false);
      expect(re.test(n), `regex ${token} reject ${n}`).toBe(false);
    }
  }
}

describe('no-drift — predicate == emitted regex (single source: tokenRegex)', () => {
  it('the base vocabulary agrees on every sample (.mjs/.js tree)', () => {
    assertNoDrift(
      [
        ['kebab', ['staged-filter.mjs', 'a.js'], ['Button.mjs', 'a.test.mjs', 'x.ts']],
        ['kebab_test', ['a.test.mjs', 'foo-bar.spec.js'], ['a.mjs', 'a.test.ts']],
        ['pascal', ['Button.mjs'], ['button.mjs', 'Button.test.mjs']],
        ['camel', ['cn.mjs', 'useFoo.js'], ['Cn.mjs', 'cn.test.mjs']],
        ['test', ['x.test.mjs', 'y.spec.js'], ['x.mjs']],
        ['json', ['x.json'], ['x.mjs', 'x.jsonl']],
        ['kebab_dir', ['co-occurrence', 'lib'], ['CoOcc', 'x.mjs']],
      ],
      ['mjs', 'js'],
    );
  });

  it('the convention-specific tokens (react-app/electron) classify correctly', () => {
    assertNoDrift(
      [
        ['pascal_tsx', ['Button.tsx'], ['Button.ts', 'button.tsx']],
        ['pascal_ts', ['Theme.ts'], ['Theme.tsx', 'theme.ts']],
        ['use_hook_kebab', ['use-foo.ts', 'use-bar.tsx'], ['useFoo.ts', 'foo.ts']],
        ['use_hook_camel', ['useFoo.tsx'], ['use-foo.ts', 'Foo.ts']],
        ['use_hook_pascal', ['useFoo'], ['use-foo', 'Foo', 'useFoo.ts']],
        ['kebab_test_dotted', ['foo.server.test.ts', 'bar.spec.ts'], ['foo.ts', 'Foo.test.ts']],
        ['vercel_route', ['users.ts', '[id].ts'], ['Users.ts', 'users.test.ts']],
        ['any_md', ['README.md'], ['x.ts']],
        ['any_file', ['anything.xyz', 'README'], []],
      ],
      ['ts', 'tsx'],
    );
  });
});

describe('compileToEslint — devkit cli tree (domain-gated lib)', () => {
  const cliTree = {
    name: 'cli',
    root: 'cli',
    entryAllowlist: ['index.mjs'],
    libDomains: { lib: ['generate', 'husky', 'install'] },
    grammar: {
      files: ['index.mjs'],
      folders: {
        commands: { files: ['{kebab}'] },
        lib: { files: ['{kebab}'], domainGate: 'lib', recurse: 'kebabModule' },
      },
      rules: {
        kebabModule: {
          folderName: '{kebab_dir}',
          files: ['{kebab}', '{json}'],
          recurse: 'kebabModule',
        },
      },
    },
  };
  const out = compileToEslint(cliTree, ['mjs', 'js'], { baseline: ['lib/legacy.mjs'] });

  it('emits structureRoot + the token table + the closed-registry alternation', () => {
    expect(out.structureRoot).toBe('cli');
    expect(out.regexParameters.kebab).toBe('^[a-z][a-z0-9-]*\\.(mjs|js)$');
    expect(out.regexParameters.lib_domain).toBe('^(generate|husky|install)$');
  });
  it('registers the recurse rule and gates lib subfolders by the registry', () => {
    expect(out.rules.kebabModule.name).toBe('{kebab_dir}');
    const lib = out.structure.children.find((c) => c.name === 'lib');
    expect(lib.children.some((c) => c.name === '{lib_domain}')).toBe(true);
  });
  it('ignores __tests__ + threads the baseline through ignorePatterns', () => {
    expect(out.ignorePatterns).toContain('**/__tests__/**');
    expect(out.ignorePatterns).toContain('lib/legacy.mjs');
  });
});

describe('compileToEslint — devkit gate-engine tree (root-domain-gated)', () => {
  const geTree = {
    name: 'gate-engine',
    root: 'gate-engine',
    entryAllowlist: ['config.mjs'],
    ignoredDirs: ['eval'],
    libDomains: { '@root': ['decisions', 'ratchets', 'structure'] },
    grammar: {
      files: ['config.mjs'],
      domainGate: '@root',
      recurse: 'engineModule',
      rules: {
        engineModule: {
          folderName: '{kebab_dir}',
          files: ['{kebab}', '{json}'],
          recurse: 'engineModule',
        },
      },
    },
  };
  const out = compileToEslint(geTree, ['mjs', 'js']);

  it('sanitizes the @root key to a valid token + emits its alternation', () => {
    expect(out.regexParameters.root_domain).toBe('^(decisions|ratchets|structure)$');
    expect(out.structure.children.some((c) => c.name === '{root_domain}')).toBe(true);
  });
  it('emits the ignoredDirs glob at any depth', () => {
    expect(out.ignorePatterns).toContain('**/eval/**');
  });
});

describe('compileToEslint — structure root name = structureRoot basename (not tree.name)', () => {
  // The plugin matches paths relative to structureRoot; the root node name MUST be the structureRoot's
  // last segment or the rule silently passes everything. A tree whose logical name differs from its
  // root (e.g. name 'lib', root 'src') must still anchor on the folder.
  it('name lib / root src → structure.name is src', () => {
    const out = compileToEslint({ name: 'lib', root: 'src', grammar: { files: ['{pascal}'] } }, [
      'ts',
      'tsx',
    ]);
    expect(out.structure.name).toBe('src');
  });
  it('nested root packages/ui/src → structure.name is src', () => {
    const out = compileToEslint(
      { name: 'ui', root: 'packages/ui/src', grammar: { files: ['{pascal}'] } },
      ['ts', 'tsx'],
    );
    expect(out.structure.name).toBe('src');
  });
});

describe('buildStructureConfigs — the universal shim/dogfood assembly (one source)', () => {
  it('returns one folder-structure flat-config per grammar tree, scoped to its root', async () => {
    const root = tmpRepo();
    write(
      root,
      'guard.config.json',
      JSON.stringify({
        sourceExtensions: ['ts', 'tsx'],
        structure: {
          trees: [{ name: 'lib', root: 'src', grammar: { files: ['{pascal}'] } }],
          walls: [],
        },
      }),
    );
    const configs = await buildStructureConfigs(root);
    expect(configs).toHaveLength(1);
    expect(configs[0].files).toEqual(['src/**/*.{ts,tsx}']);
    expect(configs[0].rules['project-structure/folder-structure'][0]).toBe('error');
    expect(configs[0].plugins['project-structure']).toBeTruthy();
  });
  it('returns [] when the repo declares no structure block (ungoverned)', async () => {
    const root = tmpRepo();
    write(root, 'guard.config.json', JSON.stringify({ sourceExtensions: ['ts'] }));
    expect(await buildStructureConfigs(root)).toEqual([]);
  });
});
