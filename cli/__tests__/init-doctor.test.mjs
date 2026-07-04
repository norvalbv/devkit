import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectResults } from '../commands/doctor.mjs';
import { readConfig as config, tmpRepos } from './_helpers.mjs';

// --yes (passed by each test) forces the non-interactive path even when the runner has a TTY.
const { tmpRepo, devkit, cleanup } = tmpRepos('init-');
afterEach(cleanup);

describe('init --yes (all recommended)', () => {
  it('emits the full generic config set + husky hook + .devkit/config.json', () => {
    const root = tmpRepo();
    const r = devkit(root, 'init', '--stack', 'generic', '--yes');
    expect(r.status).toBe(0);
    for (const f of [
      'guard.config.json',
      'biome.jsonc',
      'tsconfig.json',
      '.husky/pre-commit',
      '.devkit/config.json',
    ]) {
      expect(existsSync(join(root, f)), `${f} should exist`).toBe(true);
    }
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(false);
    const cfg = config(root);
    expect(cfg.stack).toBe('generic');
    expect(cfg.components.biome).toBe(true);
    expect(cfg.components.guards).toEqual(['size', 'fanout', 'dup', 'clone', 'decisions']);
    expect(cfg.components.structure).toBe(false);
  });

  it('is idempotent: a second run reports "already wired", writes no new files', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    const before = readFileSync(join(root, 'guard.config.json'), 'utf8');
    const r2 = devkit(root, 'init', '--stack', 'generic', '--yes');
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/already wired/);
    expect(readFileSync(join(root, 'guard.config.json'), 'utf8')).toBe(before);
  });

  it('--dry-run writes nothing', () => {
    const root = tmpRepo();
    const r = devkit(root, 'init', '--stack', 'generic', '--dry-run', '--yes');
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'guard.config.json'))).toBe(false);
    expect(existsSync(join(root, '.devkit/config.json'))).toBe(false);
  });

  it('generic stack wires no structure-lint (no --structure arg on the deterministic line)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    expect(hook).toContain('bunx guard-deterministic'); // deterministic guards still run
    expect(hook).not.toContain('--structure'); // structure off for a generic stack
    expect(hook).not.toContain('guard-structure');
  });
});

describe('init --stack react-app (structure ungated)', () => {
  it('installs the react-app structure template set + records structure on', () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      dependencies: { react: '^18' },
    });
    const r = devkit(root, 'init', '--stack', 'react-app', '--yes');
    expect(r.status).toBe(0);
    for (const f of [
      'eslint.config.mjs',
      'eslint/baselines/exempt.mjs',
      'guard.config.json',
      'biome.jsonc',
      'tsconfig.json',
    ]) {
      expect(existsSync(join(root, f)), `${f} should exist`).toBe(true);
    }
    // react-app is config-driven now: the shared shim + a data structure block, no domains registry.
    expect(existsSync(join(root, 'eslint/domains.mjs'))).toBe(false);
    const cfg = config(root);
    expect(cfg.stack).toBe('react-app');
    expect(cfg.components.structure).toBe(true);
    expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toMatch(/THE UNIVERSAL SHIM/);
  });

  it('enables the structure-lint line in the husky hook (template exists)', () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      dependencies: { react: '^18' },
    });
    devkit(root, 'init', '--stack', 'react-app', '--yes');
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    // config-driven stack → devkit's guard-structure bin, joined to the deterministic orchestrator.
    expect(hook).toContain('--structure "guard-structure gate"');
  });
});

describe('init — zero consumer deps (config-driven structure)', () => {
  it('component-lib package mode adds NO jscpd/eslint/plugin/parser; runs guard-structure', () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      peerDependencies: { react: '^18' },
      exports: {},
    });
    devkit(root, 'init', '--stack', 'component-lib', '--yes');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const dep of [
      'jscpd',
      'eslint',
      'eslint-plugin-project-structure',
      '@typescript-eslint/parser',
    ]) {
      expect(pkg.devDependencies[dep], `${dep} should NOT be a consumer dep`).toBeUndefined();
    }
    // devkit itself carries them; the gate runs devkit's bin.
    expect(pkg.devDependencies['@norvalbv/devkit']).toBeDefined();
    expect(pkg.scripts['lint:structure']).toBeUndefined();
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    // guard-structure runs as the orchestrator's structure gate (trichotomy: exit 2 stays fail-open).
    expect(hook).toContain('--structure "guard-structure gate"');
    expect(hook).not.toContain('bunx eslint src');
  });

  it('electron package mode KEEPS eslint/parser/plugin + runs bunx eslint src', () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      devDependencies: { electron: '^30' },
    });
    devkit(root, 'init', '--stack', 'electron', '--yes');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies.eslint).toBeDefined();
    expect(pkg.devDependencies['@typescript-eslint/parser']).toBeDefined();
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    expect(hook).toContain('--structure "bunx eslint src"');
    expect(hook).not.toContain('guard-structure');
  });
});

describe('init — per-component flag selection', () => {
  it('--no-biome → no biome.jsonc, no biome devDep, no biome husky step', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--no-biome');
    expect(existsSync(join(root, 'biome.jsonc'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@biomejs/biome']).toBeUndefined();
    expect(pkg.scripts.lint).toBeUndefined();
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    expect(hook).not.toContain('biome format');
    expect(config(root).components.biome).toBe(false);
  });

  it('--guards fanout,size → the deterministic orchestrator + the recorded subset, no AI guard', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--guards', 'fanout,size');
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    // The selected deterministic guards run through the ONE orchestrator (which re-reads the subset
    // from .devkit/config.json at commit time), so the WHICH lives in config, not per-hook-line.
    expect(hook).toContain('bunx guard-deterministic');
    expect(hook).not.toContain('bunx guard-decisions'); // decisions deselected
    expect(config(root).components.guards).toEqual(['fanout', 'size']);
    // No clone guard → jscpd devDep omitted.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies.jscpd).toBeUndefined();
  });

  it('--no-skills → no skills synced, no manifest', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--no-skills');
    expect(existsSync(join(root, '.claude/skills'))).toBe(false);
    expect(existsSync(join(root, '.devkit/skills-manifest.json'))).toBe(false);
    expect(config(root).components.skills).toBe(false);
  });
});

describe('init — removal (deselected + present)', () => {
  it('biome present then deselected with --remove-deselected → biome.jsonc gone, others intact', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    expect(existsSync(join(root, 'biome.jsonc'))).toBe(true);

    devkit(root, 'init', '--stack', 'generic', '--yes', '--no-biome', '--remove-deselected');
    expect(existsSync(join(root, 'biome.jsonc'))).toBe(false);
    // Untouched components survive.
    expect(existsSync(join(root, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(root, '.husky/pre-commit'))).toBe(true);
    expect(existsSync(join(root, 'guard.config.json'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@biomejs/biome']).toBeUndefined();
    expect(pkg.scripts.format).toBeUndefined();
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    expect(hook).not.toContain('biome format');
    expect(hook).toContain('bunx guard-deterministic'); // guards intact
    expect(config(root).components.biome).toBe(false);
  });

  it('WITHOUT --remove-deselected a deselected-but-present component is left in place', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    // No --remove-deselected: removal is opt-in. biome.jsonc stays even though deselected.
    devkit(root, 'init', '--stack', 'generic', '--yes', '--no-biome');
    expect(existsSync(join(root, 'biome.jsonc'))).toBe(true);
  });

  it('narrowing the guard subset records the new set (orchestrator re-reads it)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    devkit(
      root,
      'init',
      '--stack',
      'generic',
      '--yes',
      '--guards',
      'fanout',
      '--remove-deselected',
    );
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    // The orchestrator stays a single line; the narrowed subset lives in .devkit/config.json.
    expect(hook).toContain('bunx guard-deterministic');
    expect(hook).not.toContain('bunx guard-decisions'); // decisions dropped
    expect(config(root).components.guards).toEqual(['fanout']);
  });
});

describe('doctor — selection-aware', () => {
  it('exits 2 on an uninitialized repo', () => {
    const root = tmpRepo();
    expect(devkit(root, 'doctor').status).toBe(2);
  });

  it('exits 0 after a successful --yes init', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/All checks OK/);
  });

  it('component-lib biome extends react is OK, not drift (stack-aware expected extends, 2a)', () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      peerDependencies: { react: '^18' },
      exports: {},
    });
    devkit(root, 'init', '--stack', 'component-lib', '--yes');
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/biome\.jsonc: OK — extends @norvalbv\/devkit\/biome\/react/);
    expect(r.stdout).toMatch(/structure-lint: OK — runs `guard-structure gate`/);
  });

  it('flags DRIFT when the structure-lint line is missing from the hook', () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      peerDependencies: { react: '^18' },
      exports: {},
    });
    devkit(root, 'init', '--stack', 'component-lib', '--yes');
    // Strip the --structure arg from the deterministic line (simulate a hand-edited / drifted hook).
    const hookPath = join(root, '.husky/pre-commit');
    writeFileSync(
      hookPath,
      readFileSync(hookPath, 'utf8').replace(' --structure "guard-structure gate"', ''),
    );
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/structure-lint: DRIFT/);

    // --fix must actually repair the structure-lint line (it flags itself fixable).
    devkit(root, 'doctor', '--fix');
    const after = devkit(root, 'doctor');
    expect(after.status).toBe(0);
    expect(after.stdout).toMatch(/structure-lint: OK/);
  });

  it('flags a PRE-COLLAPSE hook (per-guard lines, no guard-deterministic) as DRIFT and --fix repairs it', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    // Simulate a hook from a pre-#11 devkit: the deterministic guards ran as per-id `bunx guard-X`
    // lines with no `guard-deterministic` orchestrator. Strip the orchestrator line to reproduce it.
    const hookPath = join(root, '.husky/pre-commit');
    const stripped = readFileSync(hookPath, 'utf8').replace(/^.*guard-deterministic.*$/m, '');
    writeFileSync(hookPath, stripped);
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\.husky\/pre-commit: DRIFT.*deterministic gates/s);

    devkit(root, 'doctor', '--fix');
    const after = devkit(root, 'doctor');
    expect(after.status).toBe(0);
    expect(readFileSync(hookPath, 'utf8')).toContain('bunx guard-deterministic');
  });

  it('does NOT flag biome missing when biome was deselected', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--no-biome');
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/biome\.jsonc/);
  });

  it('only checks the selected guards in the husky block', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--guards', 'fanout,size');
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/block calls: fanout, size/);
  });

  it('reports invalid JSON in a managed config as drift (not a silent pass)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    writeFileSync(join(root, 'biome.jsonc'), '{ "extends": [ }'); // malformed
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/biome\.jsonc.*invalid JSON/s);
  });
});

// Unit-cover the doctor dispatch (extracted from run() so it's testable without the subprocess).
describe('doctor collectResults dispatch', () => {
  const names = (results) => results.map((r) => r.name);

  it('only builds checks for the selected components', async () => {
    const root = tmpRepo();
    const cfg = {
      standalone: false,
      components: { biome: true, tsconfig: false, skills: false, husky: false, guards: [] },
    };
    const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
    const n = names(results);
    expect(n).toContain('biome.jsonc');
    expect(n).not.toContain('tsconfig.json');
    expect(n).not.toContain('skills');
    expect(n).not.toContain('.husky/pre-commit');
    expect(n).toContain('devkit pin'); // non-standalone always checks the pin
  });

  it('skips the pin check in standalone mode', async () => {
    const root = tmpRepo();
    const cfg = { standalone: true, components: { biome: false, guards: [] } };
    const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
    expect(names(results)).not.toContain('devkit pin');
  });

  it('checks skills even when only the cursor surface is selected', async () => {
    const root = tmpRepo();
    const cfg = {
      components: {
        skills: true,
        agentTargets: ['cursor'],
        husky: false,
        biome: false,
        guards: [],
      },
    };
    const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
    expect(names(results)).toContain('skills');
  });

  it('honours configOverrides: a hand-tuned no-extends tsconfig is OK, not drift (2b)', async () => {
    const root = tmpRepo();
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }, null, 2),
    );
    const cfg = {
      stack: 'component-lib',
      standalone: false,
      configOverrides: ['tsconfig.json'],
      components: { tsconfig: true, biome: false, husky: false, guards: [] },
    };
    const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
    const ts = results.find((r) => r.name === 'tsconfig.json');
    expect(ts.status).toBe('OK');
    expect(ts.detail).toMatch(/intentional override/);
  });

  it('without configOverrides the same tsconfig drifts, with a configOverrides remediation hint (2b)', async () => {
    const root = tmpRepo();
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }, null, 2),
    );
    const cfg = {
      stack: 'component-lib',
      standalone: false,
      components: { tsconfig: true, biome: false, husky: false, guards: [] },
    };
    const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
    const ts = results.find((r) => r.name === 'tsconfig.json');
    expect(ts.status).toBe('DRIFT');
    expect(ts.remediation).toMatch(/configOverrides/);
  });

  it('a configOverrides file with BROKEN JSON still DRIFTs (override never masks a syntax error)', async () => {
    const root = tmpRepo();
    writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { strict }'); // malformed
    const cfg = {
      stack: 'component-lib',
      standalone: false,
      configOverrides: ['tsconfig.json'],
      components: { tsconfig: true, biome: false, husky: false, guards: [] },
    };
    const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
    const ts = results.find((r) => r.name === 'tsconfig.json');
    expect(ts.status).toBe('DRIFT');
    expect(ts.detail).toMatch(/invalid JSON/);
  });
});
