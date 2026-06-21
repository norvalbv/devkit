/**
 * compileToEslint (gate-engine/structure/compile.mjs) + the NO-DRIFT guarantee. The eslint rule's
 * regexParameters and the walker's predicates both derive from `tokenRegex` — this suite pins that
 * they classify the same filenames identically, and that a tree's grammar compiles to the expected
 * createFolderStructure shape (structureRoot, the closed-registry alternation, recurse rules,
 * __tests__/ignoredDirs ignore globs, baseline pass-through).
 */
import { describe, expect, it } from 'vitest';
import { compileToEslint } from '../../gate-engine/structure/compile.mjs';
import { tokenPredicate, tokenRegex } from '../../gate-engine/structure/grammar.mjs';

describe('no-drift — predicate == emitted regex (single source: tokenRegex)', () => {
  const exts = ['mjs', 'js'];
  const cases = [
    ['kebab', ['staged-filter.mjs', 'a.js'], ['Button.mjs', 'a.test.mjs', 'x.ts']],
    ['kebab_test', ['a.test.mjs', 'foo-bar.spec.js'], ['a.mjs', 'a.test.ts']],
    ['pascal', ['Button.mjs'], ['button.mjs', 'Button.test.mjs']],
    ['camel', ['cn.mjs', 'useFoo.js'], ['Cn.mjs', 'cn.test.mjs']],
    ['test', ['x.test.mjs', 'y.spec.js'], ['x.mjs']],
    ['json', ['x.json'], ['x.mjs', 'x.jsonl']],
    ['kebab_dir', ['co-occurrence', 'lib'], ['CoOcc', 'x.mjs']],
  ];
  it('the walker predicate and the eslint regex agree on every sample', () => {
    for (const [token, yes, no] of cases) {
      const pred = tokenPredicate(`{${token}}`, exts);
      const re = new RegExp(tokenRegex(token, exts));
      for (const n of yes) {
        expect(pred(n), `${token} should accept ${n}`).toBe(true);
        expect(re.test(n), `regex ${token} should accept ${n}`).toBe(true);
      }
      for (const n of no) {
        expect(pred(n), `${token} should reject ${n}`).toBe(false);
        expect(re.test(n), `regex ${token} should reject ${n}`).toBe(false);
      }
    }
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
