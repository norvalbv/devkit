/**
 * devkit migrate — reconciles a consumer's EMITTED snapshot files (eslint.config.mjs, guard.config.json)
 * with the installed devkit. Pins: devkit-owned eslint.config is REPLACED when stale; guard.config is
 * MERGED (missing keys added, existing values never clobbered); a clean repo plans nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeMigration } from '../commands/migrate-config.mts';
import { packageDir } from '../lib/fs-helpers.mts';
import { structFixtures } from './_helpers.mts';

const { tmpRepo, write, cleanup } = structFixtures('migrate-');
afterEach(cleanup);

const shim = () =>
  readFileSync(join(packageDir(), 'templates', '_shared', 'eslint.config.mjs'), 'utf8');

describe('computeMigration (react-app: 0.12-era snapshot → current model)', () => {
  it('plans an eslint.config REPLACE + a guard.config MERGE when the emitted files are stale', () => {
    const root = tmpRepo();
    write(root, 'eslint.config.mjs', '// OLD hand-written react-app preset\nexport default [];\n');
    write(root, 'guard.config.json', JSON.stringify({ scanRoots: ['src'], fanoutCap: 12 }));
    const byFile = Object.fromEntries(computeMigration(root, 'react-app').map((c) => [c.file, c]));
    expect(byFile['eslint.config.mjs'].kind).toBe('replace');
    expect(byFile['guard.config.json'].kind).toBe('merge');
    expect(byFile['guard.config.json'].why).toMatch(/structure/);
  });

  it('applying writes the shim + adds the structure block WITHOUT clobbering existing keys', () => {
    const root = tmpRepo();
    write(root, 'eslint.config.mjs', '// OLD\n');
    write(root, 'guard.config.json', JSON.stringify({ scanRoots: ['custom/src'], fanoutCap: 99 }));
    for (const c of computeMigration(root, 'react-app')) c.write();
    expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toBe(shim());
    const gc = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(gc.scanRoots).toEqual(['custom/src']); // preserved
    expect(gc.fanoutCap).toBe(99); // preserved
    expect(gc.structure.trees.map((t) => t.name)).toEqual(['components', 'pages']); // added
    expect(gc.maxLines).toBe(500); // added
  });

  it('plans NOTHING when already on the current shim + full guard.config', () => {
    const root = tmpRepo();
    write(root, 'eslint.config.mjs', shim());
    const tpl = readFileSync(
      join(packageDir(), 'templates', 'react-app', 'guard.config.json'),
      'utf8',
    );
    write(root, 'guard.config.json', tpl);
    expect(computeMigration(root, 'react-app')).toEqual([]);
  });
});

// The electron eslint.config is regenerated wholesale on migrate, but WHICH backends it
// structure-lints lives in guard.config.json `backends` (merge-preserved) — never in the
// regenerated file. So migrate can no longer silently re-disable a consumer's backend
// governance: it preserves an explicit choice, and a consumer missing the key gets the
// both-on default (never both-off). This is the regression guard for that contract.
describe('computeMigration (electron: backend governance survives the eslint regen)', () => {
  it('preserves a consumer’s explicit backends choice — never clobbers it', () => {
    const root = tmpRepo();
    write(root, 'eslint.config.mjs', '// OLD electron preset\nexport default [];\n');
    write(
      root,
      'guard.config.json',
      JSON.stringify({ scanRoots: ['src'], backends: { socketServer: true, vercel: false } }),
    );
    for (const c of computeMigration(root, 'electron')) c.write();
    const gc = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(gc.backends).toEqual({ socketServer: true, vercel: false }); // preserved, not reset
  });

  it('adds backends with the both-on default when an electron consumer lacks the key', () => {
    const root = tmpRepo();
    write(root, 'eslint.config.mjs', '// OLD\n');
    write(root, 'guard.config.json', JSON.stringify({ scanRoots: ['src'], fanoutCap: 12 }));
    for (const c of computeMigration(root, 'electron')) c.write();
    const gc = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(gc.backends).toEqual({ socketServer: true, vercel: true }); // default, never both-off
    expect(gc['//backends']).toBeDefined(); // the explanatory comment sibling rides along
  });
});
