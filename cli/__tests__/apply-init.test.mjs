/**
 * Exercises the apply layer directly (applyInit + selection helpers) — the testable seam
 * the wizard funnels into. Calling applyInit with a chosen component map is preferable to
 * simulating a clack TTY: it covers the same install/remove logic the wizard drives.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyInit, detectInstalled, parseFlags, selectionFromFlags } from '../commands/init.mjs';
import { defaultSelection, normalizeSelection } from '../lib/components.mjs';

let roots = [];
function tmpRepo(pkg = { name: 'fx', version: '0.0.0', type: 'module' }) {
  const root = mkdtempSync(join(tmpdir(), 'apply-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  return root;
}
beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});
function config(root) {
  return JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8'));
}

describe('selection helpers', () => {
  it('defaultSelection is all-on with all guards', () => {
    const s = defaultSelection();
    expect(s).toMatchObject({
      biome: true,
      tsconfig: true,
      skills: true,
      husky: true,
      structure: true,
    });
    expect(s.guards).toEqual(['size', 'fanout', 'dup', 'clone', 'decisions']);
  });

  it('normalizeSelection fills missing keys + drops unknown guards', () => {
    const s = normalizeSelection({ biome: false, guards: ['size', 'bogus'] });
    expect(s.biome).toBe(false);
    expect(s.tsconfig).toBe(true);
    expect(s.guards).toEqual(['size']);
  });

  it('parseFlags reads --no-* and --guards and --remove-deselected', () => {
    const f = parseFlags([
      '--yes',
      '--no-biome',
      '--no-skills',
      '--guards',
      'size,dup',
      '--remove-deselected',
    ]);
    expect(f.yes).toBe(true);
    expect(f.no.has('biome')).toBe(true);
    expect(f.no.has('skills')).toBe(true);
    expect(f.guards).toEqual(['size', 'dup']);
    expect(f.removeDeselected).toBe(true);
  });

  it('selectionFromFlags applies --no-* and narrows guards', () => {
    const sel = selectionFromFlags(parseFlags(['--no-biome', '--guards', 'fanout']));
    expect(sel.biome).toBe(false);
    expect(sel.tsconfig).toBe(true);
    expect(sel.guards).toEqual(['fanout']);
  });
});

describe('applyInit (direct chosen map — the wizard seam)', () => {
  it('installs exactly the chosen components and records them', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: {
        biome: false,
        tsconfig: true,
        skills: false,
        husky: true,
        structure: false,
        guards: ['size'],
      },
      devkitRef: 'v0.3.0',
    });
    expect(existsSync(join(root, 'biome.jsonc'))).toBe(false);
    expect(existsSync(join(root, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(root, '.claude/skills'))).toBe(false);
    expect(existsSync(join(root, '.husky/pre-commit'))).toBe(true);
    const cfg = config(root);
    expect(cfg.components).toMatchObject({ biome: false, skills: false, guards: ['size'] });
  });

  it('removes a deselected-but-present component when listed in `remove`', async () => {
    const root = tmpRepo();
    // First install everything.
    await applyInit(root, { stack: 'generic', selection: defaultSelection(), devkitRef: 'v0.3.0' });
    expect(existsSync(join(root, 'biome.jsonc'))).toBe(true);
    // Now deselect + remove biome.
    await applyInit(root, {
      stack: 'generic',
      selection: { ...defaultSelection(), biome: false },
      remove: ['biome'],
      devkitRef: 'v0.3.0',
    });
    expect(existsSync(join(root, 'biome.jsonc'))).toBe(false);
    expect(existsSync(join(root, 'tsconfig.json'))).toBe(true);
    expect(config(root).components.biome).toBe(false);
  });
});

describe('detectInstalled', () => {
  it('reads the recorded components block', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: { ...defaultSelection(), skills: false },
      devkitRef: 'v0.3.0',
    });
    const installed = detectInstalled(root);
    expect(installed.has('biome')).toBe(true);
    expect(installed.has('skills')).toBe(false);
    expect(installed.has('guards')).toBe(true);
  });

  it('falls back to on-disk detection without a components block', () => {
    const root = tmpRepo();
    writeFileSync(join(root, 'biome.jsonc'), '{}');
    const installed = detectInstalled(root);
    expect(installed.has('biome')).toBe(true);
    expect(installed.has('tsconfig')).toBe(false);
  });
});
