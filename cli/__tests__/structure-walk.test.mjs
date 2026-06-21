/**
 * Generic config-driven structure walker (gate-engine/structure/walk.mjs) — the engine that lets
 * devkit govern ANY repo's folder structure from a declared `grammar`, not just frink's six electron
 * trees. Covers: flat component-lib, domain-gated lib subfolders, root-domain-gated engines, the
 * empty-registry-grandfathers + frozen-dir + capture-every-file invariants, and the config-driven
 * generateStructureBaselines path.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { walkTree } from '../../gate-engine/structure/walk.mjs';
import { generateImportWallBaseline } from '../lib/generate/generate-import-wall-baseline.mjs';
import { generateStructureBaselines } from '../lib/generate/generate-structure-baseline.mjs';
import { structFixtures } from './_helpers.mjs';

const { tmpRepo, write, cleanup } = structFixtures('swalk-');
afterEach(cleanup);

const KEBAB_MODULE = {
  kebabModule: {
    folderName: '{kebab_dir}',
    files: ['{kebab}', '{kebab_test}', '{json}'],
    recurse: 'kebabModule',
  },
};

describe('walkTree — flat component-library (frink-primitives shape)', () => {
  const tree = {
    name: 'primitives',
    root: 'src',
    entryAllowlist: ['index.ts', 'cn.ts'],
    grammar: { files: ['index.ts', 'cn.ts', '{pascal}', '{camel}', '{test}'] },
  };
  it('PascalCase .tsx + cn.ts + index.ts are valid; a kebab/loose file is grandfathered', () => {
    const root = tmpRepo();
    write(root, 'src/Button.tsx');
    write(root, 'src/Tooltip.tsx');
    write(root, 'src/cn.ts');
    write(root, 'src/index.ts');
    write(root, 'src/Button.test.tsx');
    write(root, 'src/bad-name.tsx'); // kebab → violates PascalCase component rule
    write(root, 'src/notes.md'); // not a source ext
    const v = walkTree(tree, join(root, 'src'), ['ts', 'tsx']);
    expect(v).toEqual(['bad-name.tsx', 'notes.md']);
  });
});

describe('walkTree — domain-gated lib (devkit cli shape)', () => {
  const tree = {
    name: 'cli',
    root: 'cli',
    entryAllowlist: ['index.mjs'],
    ignoredDirs: ['__tests__'],
    libDomains: { lib: ['generate', 'install'] },
    grammar: {
      files: ['index.mjs'],
      folders: {
        commands: { files: ['{kebab}', '{kebab_test}'] },
        lib: { files: ['{kebab}'], domainGate: 'lib', recurse: 'kebabModule' },
      },
      rules: KEBAB_MODULE,
    },
  };
  it('registered lib domains pass; an unregistered one is grandfathered (all its files)', () => {
    const root = tmpRepo();
    write(root, 'cli/index.mjs');
    write(root, 'cli/commands/init.mjs');
    write(root, 'cli/lib/components.mjs'); // loose kebab file at lib root → allowed
    write(root, 'cli/lib/generate/gen.mjs'); // registered domain
    write(root, 'cli/lib/junk-drawer/a.mjs'); // unregistered domain
    write(root, 'cli/lib/junk-drawer/b.mjs');
    const v = walkTree(tree, join(root, 'cli'), ['mjs', 'js']);
    expect(v).toContain('lib/junk-drawer/a.mjs');
    expect(v).toContain('lib/junk-drawer/b.mjs'); // EVERY file in the broken folder
    expect(v).not.toContain('lib/generate/gen.mjs');
    expect(v).not.toContain('lib/components.mjs');
    expect(v).not.toContain('commands/init.mjs');
  });
  it('an empty domain registry grandfathers existing lib subfolders (pre-baseline safe)', () => {
    const root = tmpRepo();
    write(root, 'cli/lib/anything/x.mjs');
    const t2 = { ...tree, libDomains: { lib: [] } };
    expect(walkTree(t2, join(root, 'cli'), ['mjs', 'js'])).toContain('lib/anything/x.mjs');
  });
});

describe('walkTree — root-domain-gated (devkit gate-engine shape)', () => {
  const tree = {
    name: 'gate-engine',
    root: 'gate-engine',
    entryAllowlist: ['config.mjs'],
    ignoredDirs: ['__tests__', 'eval'],
    libDomains: { '@root': ['decisions', 'ratchets'] },
    grammar: {
      files: ['config.mjs'],
      domainGate: '@root',
      recurse: 'engineModule',
      rules: { engineModule: KEBAB_MODULE.kebabModule },
    },
  };
  it("the root's own folders are the closed vocabulary; an unregistered engine is grandfathered", () => {
    const root = tmpRepo();
    write(root, 'gate-engine/config.mjs');
    write(root, 'gate-engine/decisions/detect.mjs'); // registered
    write(root, 'gate-engine/misc/junk.mjs'); // unregistered engine
    const v = walkTree(tree, join(root, 'gate-engine'), ['mjs', 'js']);
    expect(v).toEqual(['misc/junk.mjs']);
  });
});

describe('walkTree — frozen dirs', () => {
  it('every descendant of a frozen dir is grandfathered (one-way door)', () => {
    const root = tmpRepo();
    write(root, 'src/lib/registered/ok.ts');
    write(root, 'src/legacy/old.ts');
    write(root, 'src/legacy/nested/older.ts');
    const tree = {
      name: 'x',
      root: 'src',
      frozenDirs: ['legacy'],
      libDomains: { lib: ['registered'] },
      grammar: {
        folders: { lib: { domainGate: 'lib', recurse: 'kebabModule' } },
        rules: KEBAB_MODULE,
      },
    };
    const v = walkTree(tree, join(root, 'src'), ['ts']);
    expect(v).toContain('legacy/old.ts');
    expect(v).toContain('legacy/nested/older.ts');
    expect(v).not.toContain('lib/registered/ok.ts');
  });
});

describe('walkTree — multi-recurse (sibling rule families)', () => {
  it('dispatches an unnamed folder to the FIRST rule whose folderName matches', () => {
    const root = tmpRepo();
    write(root, 'src/Pascal/index.ts'); // PascalCase dir → pascalRule
    write(root, 'src/kebab-dir/x.ts'); // kebab dir → kebabRule (pascalRule folderName doesn't match)
    write(root, 'src/Bad/weird.md'); // Pascal dir → pascalRule, but weird.md isn't allowed → violator
    const tree = {
      name: 'x',
      root: 'src',
      sourceExtensions: ['ts'],
      grammar: {
        recurse: ['pascalRule', 'kebabRule'],
        rules: {
          pascalRule: {
            folderName: '{pascal_dir}',
            files: ['index.ts', '{pascal_ts}'],
            recurse: 'pascalRule',
          },
          kebabRule: { folderName: '{kebab_dir}', files: ['{kebab}'], recurse: 'kebabRule' },
        },
      },
    };
    const v = walkTree(tree, join(root, 'src'), ['ts']);
    expect(v).not.toContain('Pascal/index.ts'); // matched pascalRule
    expect(v).not.toContain('kebab-dir/x.ts'); // fell through to kebabRule
    expect(v).toContain('Bad/weird.md'); // pascalRule allows index.ts/{pascal_ts} only
  });
});

describe('generateStructureBaselines — config-driven path', () => {
  it('walks structure.trees from cfg and writes one baseline per existing tree', async () => {
    const root = tmpRepo();
    write(root, 'src/Button.tsx');
    write(root, 'src/bad-name.tsx');
    const cfg = {
      sourceExtensions: ['ts', 'tsx'],
      structure: {
        trees: [
          { name: 'ui', root: 'src', grammar: { files: ['{pascal}', '{test}'] } },
          { name: 'absent', root: 'does-not-exist', grammar: { files: [] } },
        ],
        walls: [],
      },
    };
    const summary = await generateStructureBaselines(root, { cfg });
    const byTree = Object.fromEntries(summary.map((s) => [s.tree, s]));
    expect(byTree.ui.written).toBe(true);
    expect(byTree.ui.count).toBe(1);
    expect(byTree.absent.written).toBe(false);
    const file = readFileSync(join(root, 'eslint/baselines/ui.mjs'), 'utf8');
    expect(file).toContain('export const uiStructureBaseline = [');
    expect(file).toContain('bad-name.tsx');
  });
});

describe('generateImportWallBaseline — empty-walls early-return', () => {
  it('config-driven repo with no declared walls skips the eslint scan and returns []', () => {
    const root = tmpRepo();
    const cfg = {
      structure: { trees: [{ name: 'x', root: 'src', grammar: { files: [] } }], walls: [] },
    };
    // No eslint installed in the tmp repo — early-return must not even try to scan.
    expect(generateImportWallBaseline(root, { cfg })).toEqual([]);
  });
});
