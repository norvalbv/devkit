import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isTransientModuleAbsence,
  loadImportWallExempt,
  makeBaselineLoaders,
} from '../load-baseline.mts';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'structure-baselines-'));
  roots.push(root);
  return root;
}

function write(root: string, relativePath: string, contents: string): void {
  const file = join(root, relativePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('makeBaselineLoaders', () => {
  it('loads canonical Devkit baseline and exempt state', async () => {
    const root = makeRoot();
    write(
      root,
      '.devkit/baselines/structure/ui.mjs',
      'export const uiStructureBaseline = ["canonical.ts"]\n',
    );
    write(
      root,
      '.devkit/structure/exempt.mjs',
      'export const structureExempt = { ui: ["canonical-exempt.ts"] }\n',
    );

    const loaders = makeBaselineLoaders(root);
    expect(await loaders.loadBaseline('ui')).toEqual(['canonical.ts']);
    expect(await loaders.loadExempt('ui')).toEqual(['canonical-exempt.ts']);
  });
});

describe('loadImportWallExempt', () => {
  it('returns an empty set when no exemption module exists', async () => {
    await expect(loadImportWallExempt(makeRoot())).resolves.toEqual(new Set());
  });

  it('rejects an invalid exemption module instead of weakening policy', async () => {
    const root = makeRoot();
    write(root, '.devkit/structure/exempt.mjs', 'export const importWallExempt = [\n');

    await expect(loadImportWallExempt(root)).rejects.toThrow();
  });
});

describe('isTransientModuleAbsence — the regeneration unlink→rewrite race classifier', () => {
  const seeded = () => {
    const root = makeRoot();
    write(root, '.devkit/baselines/structure/ui.mjs', 'export const uiStructureBaseline = []\n');
    return { root, file: join(root, '.devkit/baselines/structure/ui.mjs') };
  };

  it("classifies this module's own ERR_MODULE_NOT_FOUND/ENOENT as the transient unlink", () => {
    const { file } = seeded();
    for (const code of ['ERR_MODULE_NOT_FOUND', 'ENOENT']) {
      const absence = Object.assign(new Error(`Cannot find module '${file}'`), { code });
      expect(isTransientModuleAbsence(absence, file)).toBe(true);
    }
  });

  it('a file that is absent right now is transient regardless of the reported module', () => {
    const { root } = seeded();
    const gone = join(root, '.devkit/baselines/structure/removed.mjs');
    const nested = Object.assign(
      new Error(`Cannot find module '/repo/other.mjs' imported from '${gone}'`),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    expect(isTransientModuleAbsence(nested, gone)).toBe(true);
  });

  it("keeps a consumer's stable failures loud: a nested break in a present module, syntax errors", () => {
    const { file } = seeded();
    const nested = Object.assign(
      new Error(`Cannot find module '/repo/other.mjs' imported from '${file}'`),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    expect(isTransientModuleAbsence(nested, file)).toBe(false);
    expect(isTransientModuleAbsence(new SyntaxError('Unexpected end of input'), file)).toBe(false);
  });

  it('matches through a symlinked root segment (Node reports the real path)', () => {
    const { root } = seeded();
    const linkedRoot = join(makeRoot(), 'via-link');
    symlinkSync(root, linkedRoot);
    const viaLink = join(linkedRoot, '.devkit/baselines/structure/ui.mjs');
    const absence = Object.assign(
      new Error(
        `Cannot find module '${realpathSync(join(root, '.devkit/baselines/structure/ui.mjs'))}'`,
      ),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    expect(isTransientModuleAbsence(absence, viaLink)).toBe(true);
  });

  it('a module recreated during the retry window is loaded, not misclassified as stable', async () => {
    const root = makeRoot();
    const target = join(root, '.devkit/baselines/structure/ui.mjs');
    write(
      root,
      '.devkit/baselines/structure/ui.mjs',
      'export const uiStructureBaseline = ["a.ts"]\n',
    );
    // Simulate the writer's unlink→rewrite landing inside the loader's bounded probes.
    const rewrite = (async () => {
      rmSync(target);
      await new Promise((settle) => setTimeout(settle, 2));
      write(
        root,
        '.devkit/baselines/structure/ui.mjs',
        'export const uiStructureBaseline = ["b.ts"]\n',
      );
    })();
    const loaded = await makeBaselineLoaders(root).loadBaseline('ui');
    await rewrite;
    expect(loaded).toEqual(['b.ts']);
  });
});
