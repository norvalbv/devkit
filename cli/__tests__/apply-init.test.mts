/**
 * Exercises the apply layer directly (applyInit + selection helpers) — the testable seam
 * the wizard funnels into. Calling applyInit with a chosen component map is preferable to
 * simulating a clack TTY: it covers the same install/remove logic the wizard drives.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
vi.mock('../lib/install/install-fallow.mts', () => fallowSpies);

import { applyInit, detectInstalled, parseFlags, selectionFromFlags } from '../commands/init.mts';
import { defaultSelection, normalizeSelection } from '../lib/components.mts';
import { selfHostSelection } from '../lib/husky/self-host.mts';
import { readConfig as config, tmpRepos } from './_helpers.mts';

const { tmpRepo, cleanup } = tmpRepos('apply-');
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const fn of Object.values(fallowSpies)) fn.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

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
    expect(s.guards).toEqual(['size', 'fanout', 'dup', 'clone', 'decisions', 'qavis-advisory']);
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

  it('agentTargets: both by default, narrowed by --no-claude / --no-cursor', () => {
    expect(selectionFromFlags(parseFlags(['--yes'])).agentTargets).toEqual(['claude', 'cursor']);
    expect(selectionFromFlags(parseFlags(['--yes', '--no-cursor'])).agentTargets).toEqual([
      'claude',
    ]);
    expect(selectionFromFlags(parseFlags(['--yes', '--no-claude'])).agentTargets).toEqual([
      'cursor',
    ]);
  });

  it('fallow is OPT-IN: off by default, on with --fallow, off again with --no-fallow', () => {
    expect(selectionFromFlags(parseFlags(['--yes'])).fallow).toBe(false);
    expect(selectionFromFlags(parseFlags(['--yes', '--fallow'])).fallow).toBe(true);
    expect(selectionFromFlags(parseFlags(['--yes', '--fallow', '--no-fallow'])).fallow).toBe(false);
  });

  it('lineGrowth is recommended-ON: default true, off with --no-line-growth', () => {
    expect(selectionFromFlags(parseFlags(['--yes'])).lineGrowth).toBe(true);
    expect(selectionFromFlags(parseFlags(['--yes', '--no-line-growth'])).lineGrowth).toBe(false);
  });

  it('parseFlags reads --scan-root / --scan-roots as a comma list', () => {
    expect(parseFlags(['--scan-root', 'services/webapp/src']).scanRoots).toEqual([
      'services/webapp/src',
    ]);
    expect(parseFlags(['--scan-roots', 'a/src, b/src']).scanRoots).toEqual(['a/src', 'b/src']);
  });

  it('parseFlags reads the local review profile flags', () => {
    expect(
      parseFlags([
        '--review',
        '--review-guards',
        'size,decisions',
        '--review-decisions-dir',
        'architecture/decisions',
      ]),
    ).toMatchObject({
      review: true,
      reviewGuards: ['size', 'decisions'],
      reviewDecisionsDir: 'architecture/decisions',
    });
    expect(parseFlags(['--no-review']).review).toBe(false);
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
    expect(cfg.review).toEqual({
      enabled: false,
      guards: ['size'],
      decisionsDir: 'docs/decisions',
    });
  });

  it('writes and preserves a local review profile, pruning guards removed from the install', async () => {
    const root = tmpRepo();
    const selection = {
      biome: false,
      tsconfig: false,
      skills: false,
      husky: true,
      structure: false,
      guards: ['size', 'decisions'],
    };
    await applyInit(root, {
      stack: 'generic',
      selection,
      review: {
        enabled: true,
        guards: ['decisions'],
        decisionsDir: 'architecture/decisions',
      },
    });
    expect(config(root).review).toEqual({
      enabled: true,
      guards: ['decisions'],
      decisionsDir: 'architecture/decisions',
    });

    await applyInit(root, {
      stack: 'generic',
      selection: { ...selection, guards: ['size'] },
    });
    expect(config(root).review).toEqual({
      enabled: true,
      guards: [],
      decisionsDir: 'architecture/decisions',
    });
  });

  it('migrates a legacy initialized config without a review section as enabled', async () => {
    const root = tmpRepo();
    const selection = {
      biome: false,
      tsconfig: false,
      skills: false,
      husky: true,
      structure: false,
      guards: ['size'],
    };
    await applyInit(root, { stack: 'generic', selection });
    const cfgPath = join(root, '.devkit/config.json');
    const legacy = config(root);
    delete legacy.review;
    writeFileSync(cfgPath, `${JSON.stringify(legacy, null, 2)}\n`);

    await applyInit(root, { stack: 'generic', selection });

    expect(config(root).review).toEqual({
      enabled: true,
      guards: ['size'],
      decisionsDir: 'docs/decisions',
    });
  });

  it('preserves legacy-enabled review behavior when reapplying an overlay', async () => {
    const root = tmpRepo();
    const selection = {
      biome: false,
      tsconfig: false,
      skills: false,
      husky: true,
      structure: false,
      guards: ['size'],
    };
    await applyInit(root, { stack: 'generic', selection, overlay: true });
    const cfgPath = join(root, '.devkit/config.json');
    const legacy = config(root);
    delete legacy.review;
    writeFileSync(cfgPath, `${JSON.stringify(legacy, null, 2)}\n`);

    await applyInit(root, { stack: 'generic', selection, overlay: true });

    expect(config(root).review).toEqual({
      enabled: true,
      guards: ['size'],
      decisionsDir: 'docs/decisions',
    });
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

  it('agentTargets: skills sync to ONE surface only + the choice is recorded', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: {
        biome: false,
        tsconfig: false,
        skills: true,
        husky: false,
        structure: false,
        agentTargets: ['claude'],
        guards: [],
      },
      devkitRef: 'v0.3.0',
    });
    expect(existsSync(join(root, '.claude/skills/brainstorming'))).toBe(true);
    expect(existsSync(join(root, '.claude/skills/decisions'))).toBe(false);
    expect(existsSync(join(root, '.cursor/skills'))).toBe(false);
    expect(config(root).components.agentTargets).toEqual(['claude']);
  });

  it('decisions installs its skill and edit hook without general agentHooks', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: {
        biome: false,
        tsconfig: false,
        skills: true,
        agents: false,
        agentHooks: false,
        husky: true,
        structure: false,
        agentTargets: ['claude', 'cursor'],
        guards: ['decisions'],
      },
    });

    expect(existsSync(join(root, '.claude/skills/decisions/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.claude/hooks/decision-edit-guard.mjs'))).toBe(true);
    expect(existsSync(join(root, '.cursor/hooks/decision-edit-guard.mjs'))).toBe(true);
    expect(existsSync(join(root, '.claude/hooks/lint-check.sh'))).toBe(false);
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toContain(
      'decision-edit-guard.mjs',
    );
    expect(readFileSync(join(root, '.cursor/hooks.json'), 'utf8')).toContain(
      'decision-edit-guard.mjs',
    );
  });

  it('--no-skills semantics keep the decisions hook but install no decisions skill', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: {
        biome: false,
        tsconfig: false,
        skills: false,
        agents: false,
        agentHooks: false,
        husky: true,
        structure: false,
        agentTargets: ['claude'],
        guards: ['decisions'],
      },
    });

    expect(existsSync(join(root, '.claude/skills/decisions'))).toBe(false);
    expect(existsSync(join(root, '.claude/hooks/decision-edit-guard.mjs'))).toBe(true);
  });

  it('switching to --no-skills prunes every previously manifested skill', async () => {
    const root = tmpRepo();
    const base = {
      biome: false,
      tsconfig: false,
      agents: false,
      agentHooks: false,
      husky: true,
      structure: false,
      agentTargets: ['claude'],
      guards: ['decisions'],
    };
    await applyInit(root, { stack: 'generic', selection: { ...base, skills: true } });
    expect(existsSync(join(root, '.claude/skills/decisions'))).toBe(true);
    expect(existsSync(join(root, '.claude/skills/brainstorming'))).toBe(true);
    expect(existsSync(join(root, '.devkit/skills-manifest.json'))).toBe(true);
    const consumerSkill = join(root, '.cursor/skills/brainstorming/SKILL.md');
    mkdirSync(join(root, '.cursor/skills/brainstorming'), { recursive: true });
    writeFileSync(consumerSkill, '# consumer-owned on an unmanaged surface\n');

    await applyInit(root, { stack: 'generic', selection: { ...base, skills: false } });
    expect(existsSync(join(root, '.claude/skills/decisions'))).toBe(false);
    expect(existsSync(join(root, '.claude/skills/brainstorming'))).toBe(false);
    expect(existsSync(join(root, '.devkit/skills-manifest.json'))).toBe(false);
    expect(readFileSync(consumerSkill, 'utf8')).toBe('# consumer-owned on an unmanaged surface\n');
    expect(existsSync(join(root, '.claude/hooks/decision-edit-guard.mjs'))).toBe(true);
  });

  it('removing decisions prunes its Devkit-owned skill, hook, and registration', async () => {
    const root = tmpRepo();
    const base = {
      biome: false,
      tsconfig: false,
      skills: true,
      agents: false,
      agentHooks: false,
      husky: true,
      structure: false,
      agentTargets: ['claude'],
    };
    await applyInit(root, {
      stack: 'generic',
      selection: { ...base, guards: ['decisions'] },
    });
    await applyInit(root, { stack: 'generic', selection: { ...base, guards: [] } });

    expect(existsSync(join(root, '.claude/skills/decisions'))).toBe(false);
    expect(existsSync(join(root, '.claude/skills/brainstorming'))).toBe(true);
    expect(existsSync(join(root, '.claude/hooks/decision-edit-guard.mjs'))).toBe(false);
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).not.toContain(
      'decision-edit-guard.mjs',
    );
  });

  it('preserves a consumer-authored decisions skill while the guard is off', async () => {
    const root = tmpRepo();
    const skill = join(root, '.claude/skills/decisions/SKILL.md');
    mkdirSync(join(root, '.claude/skills/decisions'), { recursive: true });
    writeFileSync(skill, '# consumer decisions workflow\n');
    await applyInit(root, {
      stack: 'generic',
      selection: {
        biome: false,
        tsconfig: false,
        skills: true,
        agents: false,
        agentHooks: false,
        husky: true,
        structure: false,
        agentTargets: ['claude'],
        guards: [],
      },
    });

    expect(readFileSync(skill, 'utf8')).toBe('# consumer decisions workflow\n');
    const manifest = readFileSync(join(root, '.devkit/skills-manifest.json'), 'utf8');
    expect(manifest).not.toContain('decisions/');
  });

  it('removing decisions keeps general agent hooks selected', async () => {
    const root = tmpRepo();
    const base = {
      biome: false,
      tsconfig: false,
      skills: false,
      agents: false,
      agentHooks: true,
      husky: true,
      structure: false,
      agentTargets: ['claude'],
    };
    await applyInit(root, {
      stack: 'generic',
      selection: { ...base, guards: ['decisions'] },
    });
    await applyInit(root, { stack: 'generic', selection: { ...base, guards: [] } });

    expect(existsSync(join(root, '.claude/hooks/decision-edit-guard.mjs'))).toBe(false);
    expect(existsSync(join(root, '.claude/hooks/lint-check.sh'))).toBe(true);
    const settings = readFileSync(join(root, '.claude/settings.json'), 'utf8');
    expect(settings).not.toContain('decision-edit-guard.mjs');
    expect(settings).toContain('lint-check.sh');
  });

  it('switching to one surface prunes the deselected surface but keeps the manifest', async () => {
    const root = tmpRepo();
    const base = {
      biome: false,
      tsconfig: false,
      skills: true,
      husky: false,
      structure: false,
      guards: [],
    };
    // 1. Install to BOTH surfaces.
    await applyInit(root, {
      stack: 'generic',
      selection: { ...base, agentTargets: ['claude', 'cursor'] },
      devkitRef: 'v0.3.0',
    });
    expect(existsSync(join(root, '.cursor/skills/brainstorming'))).toBe(true);
    // 2. Re-init claude-only → .cursor copy removed, .claude kept, manifest still present.
    await applyInit(root, {
      stack: 'generic',
      selection: { ...base, agentTargets: ['claude'] },
      devkitRef: 'v0.3.0',
    });
    expect(existsSync(join(root, '.cursor/skills'))).toBe(false);
    expect(existsSync(join(root, '.claude/skills/brainstorming'))).toBe(true);
    expect(existsSync(join(root, '.devkit/skills-manifest.json'))).toBe(true);
    expect(config(root).components.agentTargets).toEqual(['claude']);
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
  it('--stack react-app installs the universal shim + components/pages data trees (no domains)', async () => {
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
    // Config-driven now: the shared shim + a data structure block (components + pages), no per-stack rule.
    expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toMatch(/THE UNIVERSAL SHIM/);
    const guard = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(guard.structure.trees.map((t) => t.name)).toEqual(['components', 'pages']);
    expect(existsSync(join(root, 'eslint/baselines/exempt.mjs'))).toBe(true);
    expect(existsSync(join(root, 'eslint/domains.mjs'))).toBe(false);
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

  it('--stack component-lib installs the universal shim + a data structure block (no domains)', async () => {
    const root = tmpRepo({
      name: 'ui',
      version: '0',
      type: 'module',
      exports: { '.': './dist/index.js' },
      peerDependencies: { react: '>=19' },
    });
    await applyInit(root, {
      stack: 'component-lib',
      selection: { ...defaultSelection(), skills: false, fallow: false },
      devkitRef: 'v0.3.0',
    });
    // eslint.config is the shared universal shim (encodes no topology) — NOT a per-stack preset.
    expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toMatch(/THE UNIVERSAL SHIM/);
    // The topology is data: a `structure` block in guard.config.json (the flat `lib` tree).
    const guard = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(guard.structure.trees.map((t) => t.name)).toEqual(['lib']);
    expect(guard.structure.trees[0].grammar.files).toContain('{pascal}');
    expect(existsSync(join(root, 'eslint/baselines/exempt.mjs'))).toBe(true);
    // Flat rule has NO lib/<domain> vocabulary → no domains.mjs.
    expect(existsSync(join(root, 'eslint/domains.mjs'))).toBe(false);
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

describe('applyInit — config field preservation (2c)', () => {
  it('carries forward consumer-authored minDevkit / configOverrides across a re-run', async () => {
    const root = tmpRepo();
    const sel = { ...defaultSelection(), fallow: false };
    await applyInit(root, { stack: 'generic', selection: sel, devkitRef: 'v0.3.0' });

    // Consumer hand-adds top-level fields init doesn't manage.
    const cfgPath = join(root, '.devkit', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.minDevkit = '0.20.0';
    cfg.configOverrides = ['tsconfig.json'];
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    // A re-run rebuilds the config from scratch — it must NOT wipe those fields.
    await applyInit(root, { stack: 'generic', selection: sel, devkitRef: 'v0.3.0' });
    const after = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(after.minDevkit).toBe('0.20.0');
    expect(after.configOverrides).toEqual(['tsconfig.json']);
  });
});

describe('applyInit — per-file line-growth block (recommended-on)', () => {
  const giant = (root: string) => {
    mkdirSync(join(root, 'src'), { recursive: true });
    // 600 lines (no trailing newline) → over the 500-line cap.
    writeFileSync(join(root, 'src', 'giant.ts'), Array(600).fill('const x = 1;').join('\n'));
  };
  const linesBaseline = (root: string) => join(root, 'eslint', 'baselines', 'size-lines.json');

  it('default init writes maxLines and grandfathers a current giant into size-lines.json', async () => {
    const root = tmpRepo();
    giant(root); // pre-existing giant must be grandfathered by init's freeze, not left to hard-error
    await applyInit(root, { stack: 'generic', selection: defaultSelection() });

    expect(JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8')).maxLines).toBe(500);
    expect(JSON.parse(readFileSync(linesBaseline(root), 'utf8')).files['src/giant.ts']).toBe(600);
    expect(config(root).components.lineGrowth).toBe(true);
  });

  it('--no-line-growth: no cap written, no size-lines baseline', async () => {
    const root = tmpRepo();
    giant(root);
    const sel = selectionFromFlags(parseFlags(['--no-line-growth']));
    await applyInit(root, { stack: 'generic', selection: sel });

    expect(
      JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8')).maxLines,
    ).toBeUndefined();
    expect(existsSync(linesBaseline(root))).toBe(false);
    expect(config(root).components.lineGrowth).toBe(false);
  });
});

describe('applyInit — managed .husky/commit-msg (review/sentry judges)', () => {
  const base = { biome: false, tsconfig: false, skills: false, husky: true, structure: false };
  const hookAt = (root) => join(root, '.husky', 'commit-msg');

  it('review selected → commit-msg written with the completeness fragment only', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: { ...base, guards: ['review'] },
      devkitRef: 'v0.3.0',
    });
    const hook = readFileSync(hookAt(root), 'utf8');
    expect(hook).toContain('guard-review completeness --gate "$1"');
    expect(hook).not.toContain('guard-sentry');
  });

  it('sentry selected → commit-msg carries the sentry fragment', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: { ...base, guards: ['size', 'sentry'] },
      devkitRef: 'v0.3.0',
    });
    expect(readFileSync(hookAt(root), 'utf8')).toContain('bunx guard-sentry --gate "$1"');
  });

  it('default (recommended) guards → NO commit-msg hook is created', async () => {
    const root = tmpRepo();
    await applyInit(root, { stack: 'generic', selection: defaultSelection(), devkitRef: 'v0.3.0' });
    expect(existsSync(hookAt(root))).toBe(false);
  });

  it('deselecting the commit-msg guards on re-init removes the block', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: { ...base, guards: ['sentry'] },
      devkitRef: 'v0.3.0',
    });
    await applyInit(root, {
      stack: 'generic',
      selection: { ...base, guards: ['size'] },
      devkitRef: 'v0.3.0',
    });
    // Marker block gone (the devkit preamble's prose still names the markers — check the marker).
    expect(readFileSync(hookAt(root), 'utf8')).not.toContain('# >>> devkit-guards');
  });
});

describe('self-host mode (devkit dogfooding itself)', () => {
  // A tmp repo that LOOKS like devkit: the package name triggers detection upstream, and the bin map
  // is what installSelfHostHook's bunx→node rewrite resolves against.
  const seedDevkitPkg = (root: string) =>
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify(
        {
          name: '@norvalbv/devkit',
          bin: {
            'guard-deterministic': './dist/gate-engine/deterministic/run.mjs',
            'guard-decisions': './dist/gate-engine/decisions/cli.mjs',
            'guard-review': './dist/gate-engine/review/cli.mjs',
            'guard-qavis-advisory': './dist/gate-engine/qavis-advisory/cli.mjs',
          },
        },
        null,
        2,
      )}\n`,
    );

  it('adds NO self-dep, writes a source-mode hook, records selfHost, leaves package.json deps alone', async () => {
    const root = tmpRepo();
    seedDevkitPkg(root);
    // skills/agents off to keep the test focused on the hook + config (asset sync is mode-agnostic).
    await applyInit(root, {
      stack: 'generic',
      selection: { ...selfHostSelection(), skills: false, agents: false },
      selfHost: true,
    });

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies).toBeUndefined(); // never depends on itself

    const hook = readFileSync(join(root, '.husky', 'pre-commit'), 'utf8');
    expect(hook).toContain('node gate-engine/deterministic/run.mts');
    expect(hook).toContain('node gate-engine/review/cli.mts --gate');
    expect(hook).toContain('--extra "lint=bun run lint"');
    expect(hook).not.toMatch(/bunx guard-/);

    const commitMsg = readFileSync(join(root, '.husky', 'commit-msg'), 'utf8');
    expect(commitMsg).toContain('node gate-engine/review/cli.mts completeness --gate "$1"');
    expect(commitMsg).not.toContain('bunx guard-');

    expect(config(root).selfHost).toBe(true);
  });
});
