import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadImportWallExempt, makeBaselineLoaders } from '../load-baseline.mts';

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
  it('prefers canonical Devkit state over legacy ESLint storage', async () => {
    const root = makeRoot();
    write(root, 'eslint/baselines/ui.mjs', 'export const uiStructureBaseline = ["legacy.ts"]\n');
    write(
      root,
      '.devkit/baselines/structure/ui.mjs',
      'export const uiStructureBaseline = ["canonical.ts"]\n',
    );
    write(
      root,
      'eslint/baselines/exempt.mjs',
      'export const structureExempt = { ui: ["legacy-exempt.ts"] }\n',
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

  it('reads legacy modules until upgrade migrates them', async () => {
    const root = makeRoot();
    write(root, 'eslint/baselines/ui.mjs', 'export const uiStructureBaseline = ["legacy.ts"]\n');
    write(
      root,
      'eslint/baselines/exempt.mjs',
      'export const structureExempt = { ui: ["legacy-exempt.ts"] }\n',
    );

    const loaders = makeBaselineLoaders(root);
    expect(await loaders.loadBaseline('ui')).toEqual(['legacy.ts']);
    expect(await loaders.loadExempt('ui')).toEqual(['legacy-exempt.ts']);
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
