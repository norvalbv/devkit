// sc-2309: the plugin roots itself at its own install, so the gate must pin an absolute projectRoot
// — these tmp repos sit outside devkit's checkout (global install) or link node_modules (worktree).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStructureConfigs } from '../eslint-config.mts';
import { runStagedStructureGate, runStructureGate } from '../run.mts';

const DEVKIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Unlink a linked node_modules first so teardown can never recurse into the donor install.
    const link = join(root, 'node_modules');
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {
      // no node_modules in this fixture
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const pascalTree = (root = 'src') => ({
  scanRoots: [root],
  structure: {
    trees: [
      { name: 'lib', root, sourceExtensions: ['ts', 'tsx'], grammar: { files: ['{pascal}'] } },
    ],
  },
});

function repo(
  config: ReturnType<typeof pascalTree> = pascalTree(),
  prefix = 'guard-structure-root-',
) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  writeFileSync(join(root, 'guard.config.json'), JSON.stringify(config));
  return root;
}
function write(root: string, rel: string, body = 'export const x = 1;\n') {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
}

describe('config-driven structure gate anchors the plugin to the repo under test (sc-2309)', () => {
  it('reports a planted violation when the plugin is installed outside the repo', async () => {
    const root = repo();
    write(root, 'src/Ok.ts');
    write(root, 'src/bad-name.ts');
    const result = await runStructureGate(root);
    expect(result.code).toBe(1);
    expect(result.text).toContain('bad-name');
  });

  it('reports a planted violation when node_modules is a symlink to another checkout', async () => {
    const root = repo();
    symlinkSync(join(DEVKIT_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    write(root, 'src/bad-name.ts');
    expect((await runStructureGate(root)).code).toBe(1);
  });

  it('reports the violation whichever way the temp path is spelled (macOS /var vs /private/var)', async () => {
    const root = repo();
    write(root, 'src/bad-name.ts');
    expect((await runStructureGate(root)).code).toBe(1);
    expect((await runStructureGate(realpathSync(root))).code).toBe(1);
  });

  it('reports a violation under a repo path containing spaces', async () => {
    const root = repo(pascalTree(), 'guard structure with spaces-');
    write(root, 'src/bad-name.ts');
    expect((await runStructureGate(root)).code).toBe(1);
  });

  it('reports a violation under a multi-segment tree root (src/renderer)', async () => {
    const root = repo(pascalTree('src/renderer'));
    write(root, 'src/renderer/Ok.ts');
    write(root, 'src/renderer/bad-name.ts');
    expect((await runStructureGate(root)).code).toBe(1);
  });

  it('keeps a grandfathered file suppressed once the root is anchored (baseline still applies)', async () => {
    const root = repo();
    write(root, 'src/bad-name.ts');
    write(
      root,
      '.devkit/baselines/structure/lib.mjs',
      "export const libBaseline = ['bad-name.ts'];\n",
    );
    expect((await runStructureGate(root)).code).toBe(0);
    // ...and an un-grandfathered sibling still fails: the baseline did not blanket-silence the tree.
    write(root, 'src/other-bad.ts');
    expect((await runStructureGate(root)).code).toBe(1);
  });

  it('two repos with the same violating filename both fail (no cross-repo cache dedup)', async () => {
    const first = repo();
    const second = repo();
    write(first, 'src/bad-name.ts');
    write(second, 'src/bad-name.ts');
    const [a, b] = await Promise.all([runStructureGate(first), runStructureGate(second)]);
    expect(a.code).toBe(1);
    expect(b.code).toBe(1);
  });

  it('the staged pre-commit path reports a staged violation (gate wiring, not just the unit)', async () => {
    const root = repo();
    write(root, 'src/bad-name.ts');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '--', 'guard.config.json', 'src/bad-name.ts'], { cwd: root });
    expect((await runStagedStructureGate(root)).code).toBe(1);
  });
});

describe("the plugin's error cache cannot carry a violation across runs (sc-2309)", () => {
  it('writes no projectStructure.cache.json into the consumer tree on a violating run', async () => {
    const root = repo();
    write(root, 'src/bad-name.ts');
    expect((await runStructureGate(root)).code).toBe(1);
    expect(existsSync(join(root, 'projectStructure.cache.json'))).toBe(false);
  });

  it('a repo-root cache left by an IDE lint (other path spelling) does not silence the gate', async () => {
    const root = repo();
    write(root, 'src/bad-name.ts');
    // The editor loads the shim, which lints with the plugin's DEFAULT cache location (the project
    // root) and may see the realpathed spelling of the same file.
    const ide = new ESLint({
      cwd: realpathSync(root),
      overrideConfigFile: true,
      baseConfig: await buildStructureConfigs(realpathSync(root)),
    });
    const [ideResult] = await ide.lintFiles(['src']);
    expect(ideResult.errorCount).toBe(1);
    expect(existsSync(join(root, 'projectStructure.cache.json'))).toBe(true);

    expect((await runStructureGate(root)).code).toBe(1);
  });
});

describe('buildStructureConfigs projectRoot', () => {
  const projectRootOf = async (root: string) => {
    const [config] = await buildStructureConfigs(root);
    // SAFETY: buildStructureConfigs always emits folder-structure as ['error', <compiled config>].
    const rule = config.rules?.['project-structure/folder-structure'] as [
      string,
      { projectRoot?: string },
    ];
    return rule[1].projectRoot;
  };

  it('emits the repo root as an ABSOLUTE projectRoot (a relative one resolves against the donor)', async () => {
    const root = repo();
    expect(await projectRootOf(root)).toBe(root);
  });

  it('absolutises a RELATIVE repo root, which the plugin would otherwise resolve against the donor', async () => {
    const root = repo();
    expect(await projectRootOf(relative(process.cwd(), root))).toBe(root);
  });
});
