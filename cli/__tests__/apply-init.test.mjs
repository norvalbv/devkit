/**
 * Exercises the apply layer directly (applyInit + selection helpers) — the testable seam
 * the wizard funnels into. Calling applyInit with a chosen component map is preferable to
 * simulating a clack TTY: it covers the same install/remove logic the wizard drives.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the fallow installer so the fallow apply step never shells out to bun/npm/cargo/fallow.
// hoisted spies let each test assert the exact call order applyInit drives.
const fallowSpies = vi.hoisted(() => ({
  installFallow: vi.fn(() => ({ ok: true, method: 'bun', message: 'installed fallow' })),
  ensureFallowGitignore: vi.fn(),
  wireFallowGate: vi.fn(() => ({ ok: true })),
  saveFallowBaselines: vi.fn(() => ({ ok: true })),
}));
vi.mock('../lib/install-fallow.mjs', () => fallowSpies);

import { applyInit, detectInstalled, parseFlags, selectionFromFlags } from '../commands/init.mjs';
import { defaultSelection, normalizeSelection } from '../lib/components.mjs';

let roots = [];
function tmpRepo(pkg = { name: 'fx', version: '0.0.0', type: 'module' }) {
  const root = mkdtempSync(join(tmpdir(), 'apply-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  return root;
}
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const fn of Object.values(fallowSpies)) fn.mockClear();
});
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

  it('fallow is OPT-IN: off by default, on with --fallow, off again with --no-fallow', () => {
    expect(selectionFromFlags(parseFlags(['--yes'])).fallow).toBe(false);
    expect(selectionFromFlags(parseFlags(['--yes', '--fallow'])).fallow).toBe(true);
    expect(selectionFromFlags(parseFlags(['--yes', '--fallow', '--no-fallow'])).fallow).toBe(false);
  });

  it('parseFlags reads --scan-root / --scan-roots as a comma list', () => {
    expect(parseFlags(['--scan-root', 'services/webapp/src']).scanRoots).toEqual([
      'services/webapp/src',
    ]);
    expect(parseFlags(['--scan-roots', 'a/src, b/src']).scanRoots).toEqual(['a/src', 'b/src']);
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

  it('--scan-root overrides guard.config scanRoots before the freeze (generic)', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: {
        biome: false,
        tsconfig: false,
        skills: false,
        husky: false,
        structure: false,
        guards: ['fanout'],
      },
      scanRoots: ['services/webapp/src'],
      devkitRef: 'v0.4.1',
    });
    const cfg = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(cfg.scanRoots).toEqual(['services/webapp/src']);
  });

  it('--scan-root patch preserves the react-app guard.config //-comment guidance', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'react-app',
      selection: { ...defaultSelection(), structure: true },
      scanRoots: ['services/webapp/src'],
      devkitRef: 'v0.4.1',
    });
    const raw = readFileSync(join(root, 'guard.config.json'), 'utf8');
    expect(JSON.parse(raw).scanRoots).toEqual(['services/webapp/src']);
    // Regex patch (not a JSON round-trip), so the //-comment guidance survives.
    expect(raw).toContain('"//scanRoots"');
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

describe('structure is stack-generic (react-app un-gated)', () => {
  it('--stack react-app installs the react-app structure template + records structure on', async () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      dependencies: { react: '^18' },
    });
    await applyInit(root, {
      stack: 'react-app',
      selection: { ...defaultSelection(), skills: false, fallow: false },
      devkitRef: 'v0.3.0',
    });
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(true);
    expect(existsSync(join(root, 'eslint/domains.mjs'))).toBe(true);
    expect(existsSync(join(root, 'eslint/baselines/exempt.mjs'))).toBe(true);
    // It must come from templates/react-app, not templates/electron.
    expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toMatch(/react-app preset/);
    expect(config(root).components.structure).toBe(true);
  });

  it('electron parity: structure still records on for the electron stack', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'electron',
      selection: { ...defaultSelection(), skills: false, fallow: false },
      devkitRef: 'v0.3.0',
    });
    expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).not.toMatch(/react-app preset/);
    expect(config(root).components.structure).toBe(true);
  });
});

describe('fallow apply step (mocked installer — never shells out)', () => {
  it('selection.fallow drives install → gitignore → gate in order + records it', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: {
        biome: false,
        tsconfig: false,
        skills: false,
        husky: false,
        structure: false,
        fallow: true,
        guards: [],
      },
      devkitRef: 'v0.3.0',
    });
    expect(fallowSpies.installFallow).toHaveBeenCalledTimes(1);
    expect(fallowSpies.ensureFallowGitignore).toHaveBeenCalledTimes(1);
    expect(fallowSpies.wireFallowGate).toHaveBeenCalledTimes(1);
    // Gate target is git (the husky-managed hook, not the agent hook).
    expect(fallowSpies.wireFallowGate.mock.calls[0][0]).toMatchObject({ target: 'git' });
    // install runs before the gate is wired.
    expect(fallowSpies.installFallow.mock.invocationCallOrder[0]).toBeLessThan(
      fallowSpies.wireFallowGate.mock.invocationCallOrder[0],
    );
    expect(config(root).components.fallow).toBe(true);
  });

  it('does NOT run any fallow step when fallow is unselected, records fallow:false', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: { ...defaultSelection(), fallow: false },
      devkitRef: 'v0.3.0',
    });
    expect(fallowSpies.installFallow).not.toHaveBeenCalled();
    expect(fallowSpies.wireFallowGate).not.toHaveBeenCalled();
    expect(config(root).components.fallow).toBe(false);
  });
});
