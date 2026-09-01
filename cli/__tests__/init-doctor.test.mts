import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectResults } from '../commands/doctor.mts';
import { CLI, readConfig as config, tmpRepos } from './_helpers.mts';

// --yes (passed by each test) forces the non-interactive path even when the runner has a TTY.
const { tmpRepo, devkit, cleanup } = tmpRepos('init-');
afterEach(cleanup);

function retiredFallowClaudeSettings() {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command:
                'FALLOW_GATE_COMMIT_ONLY=1 bash "$CLAUDE_PROJECT_DIR/.claude/hooks/fallow-gate.sh"',
            },
          ],
        },
      ],
    },
  };
}

describe('init --yes (all recommended)', () => {
  it('persists an explicit review profile from CLI flags', () => {
    const root = tmpRepo();
    const r = devkit(
      root,
      'init',
      '--yes',
      '--guards',
      'size,decisions,review',
      '--review',
      '--review-guards',
      'decisions,review',
      '--review-decisions-dir',
      'architecture/decisions',
    );

    expect(r.status, r.stderr).toBe(0);
    expect(config(root).review).toEqual({
      enabled: true,
      guards: ['decisions', 'review'],
      decisionsDir: 'architecture/decisions',
    });
  });

  it('accepts an explicitly empty review guard allowlist', () => {
    const root = tmpRepo();
    const result = devkit(root, 'init', '--yes', '--review', '--review-guards', '');

    expect(result.status, result.stderr).toBe(0);
    expect(config(root).review).toEqual({
      enabled: true,
      guards: [],
      decisionsDir: 'docs/decisions',
    });
  });

  it('requires explicit --review before accepting review-profile modifiers', () => {
    const guardsOnly = tmpRepo();
    const guardsResult = devkit(guardsOnly, 'init', '--yes', '--review-guards', 'size');
    expect(guardsResult.status).toBe(1);
    expect(guardsResult.stderr).toMatch(/--review-guards require --review/);

    const directoryOnly = tmpRepo();
    const directoryResult = devkit(
      directoryOnly,
      'init',
      '--yes',
      '--review-decisions-dir',
      'architecture/decisions',
    );
    expect(directoryResult.status).toBe(1);
    expect(directoryResult.stderr).toMatch(/--review-decisions-dir require --review/);

    const disabledWithModifier = tmpRepo();
    const disabledResult = devkit(
      disabledWithModifier,
      'init',
      '--yes',
      '--no-review',
      '--review-guards',
      'size',
    );
    expect(disabledResult.status).toBe(1);
    expect(disabledResult.stderr).toMatch(/--review-guards require --review/);
  });

  it('rejects typoed and uninstalled review guard selections', () => {
    const typo = tmpRepo();
    const typoResult = devkit(typo, 'init', '--yes', '--review', '--review-guards', 'decision');
    expect(typoResult.status).toBe(1);
    expect(typoResult.stderr).toMatch(/invalid --review-guards.*unknown: decision/);

    const commitMsgOnly = tmpRepo();
    const commitMsgOnlyResult = devkit(
      commitMsgOnly,
      'init',
      '--yes',
      '--guards',
      'sentry',
      '--review',
      '--review-guards',
      'sentry',
    );
    expect(commitMsgOnlyResult.status).toBe(1);
    expect(commitMsgOnlyResult.stderr).toMatch(/invalid --review-guards.*unknown: sentry/);

    const uninstalled = tmpRepo();
    const uninstalledResult = devkit(
      uninstalled,
      'init',
      '--yes',
      '--review',
      '--review-guards',
      'review',
    );
    expect(uninstalledResult.status).toBe(1);
    expect(uninstalledResult.stderr).toMatch(/not selected by --guards: review/);

    const noHook = tmpRepo();
    const noHookResult = devkit(
      noHook,
      'init',
      '--yes',
      '--no-husky',
      '--review',
      '--review-guards',
      'size',
    );
    expect(noHookResult.status).toBe(1);
    expect(noHookResult.stderr).toMatch(/--review requires the husky pre-commit component/);
  });

  it('validates review flags against overlay-effective components', () => {
    const root = tmpRepo();
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    const result = devkit(
      root,
      'init',
      '--overlay',
      '--yes',
      '--no-husky',
      '--review',
      '--review-guards',
      'size',
    );

    expect(result.status, result.stderr).toBe(0);
    const recorded = config(root);
    expect(recorded.overlay).toBe(true);
    expect(existsSync(join(root, '.devkit', 'hooks', 'pre-commit'))).toBe(true);
    expect(recorded.review).toEqual({
      enabled: true,
      guards: ['size'],
      decisionsDir: 'docs/decisions',
    });
  });

  it('keeps the virtual review profile out of physical component removals', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--yes', '--review', '--review-guards', 'size').status).toBe(0);

    const result = devkit(
      root,
      'init',
      '--yes',
      '--remove-deselected',
      '--review',
      '--review-guards',
      'size',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(/Removing deselected component\(s\):.*devkit-review/);
    expect(config(root).review.enabled).toBe(true);
  });

  it('disables a persisted review profile when the effective hook is removed', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--yes', '--review', '--review-guards', 'size').status).toBe(0);

    const result = devkit(root, 'init', '--yes', '--no-husky', '--remove-deselected');

    expect(result.status, result.stderr).toBe(0);
    expect(config(root).components.husky).toBe(false);
    expect(config(root).review.enabled).toBe(false);
    expect(readFileSync(join(root, '.husky', 'pre-commit'), 'utf8')).not.toContain('guard-review');
  });

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
    expect(cfg.components.guards).toEqual([
      'size',
      'fanout',
      'dup',
      'clone',
      'comments',
      'decisions',
      'qavis-advisory',
    ]);
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
    expect(hook).toContain('$__dk_package_bin_dir/guard-deterministic'); // deterministic guards still run
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
      '.devkit/structure/exempt.mjs',
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
    // Devkit's staged runner is joined to the deterministic orchestrator.
    expect(hook).toContain('--structure "guard-structure staged"');
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
    // devkit itself carries them; the gate runs devkit's bin, pinned via the public git+https remote.
    expect(pkg.devDependencies['@norvalbv/devkit']).toMatch(
      /^git\+https:\/\/github\.com\/norvalbv\/devkit\.git#/,
    );
    expect(pkg.scripts['lint:structure']).toBeUndefined();
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    // guard-structure runs as the staged structure gate (trichotomy: exit 2 stays fail-open).
    expect(hook).toContain('--structure "guard-structure staged"');
    expect(hook).not.toContain('bunx eslint src');
  });

  it('honours DEVKIT_REPO — the written devkit dep uses the override, not the https default', () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      peerDependencies: { react: '^18' },
      exports: {},
    });
    // The shared devkit() helper doesn't forward a custom env, so spawn directly with the override —
    // a private fork / ssh host alias. init must pin the consumer dep at it (via the shared repoUrl()).
    const override = 'git+ssh://git@github-personal/acme/devkit.git';
    spawnSync(process.execPath, [CLI, 'init', '--stack', 'component-lib', '--yes'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DEVKIT_REPO: override },
    });
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@norvalbv/devkit'].startsWith(`${override}#`)).toBe(true);
  });

  it('electron package mode KEEPS eslint/parser/plugin + preserves worktree symlinks', () => {
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
    expect(hook).toContain('--structure "guard-structure staged"');
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

  it('--no-biome keeps the Electron structure preset without creating biome.jsonc', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'electron', '--yes', '--no-biome');

    expect(existsSync(join(root, 'biome.jsonc'))).toBe(false);
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(true);
    expect(existsSync(join(root, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(root, 'guard.config.json'))).toBe(true);
    expect(config(root).components.biome).toBe(false);
    expect(config(root).components.structure).toBe(true);
  });

  it('--guards fanout,size → the deterministic orchestrator + the recorded subset, no AI guard', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--guards', 'fanout,size');
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    // The selected deterministic guards run through the ONE orchestrator (which re-reads the subset
    // from .devkit/config.json at commit time), so the WHICH lives in config, not per-hook-line.
    expect(hook).toContain('$__dk_package_bin_dir/guard-deterministic');
    expect(hook).not.toContain('$__dk_package_bin_dir/guard-decisions'); // decisions deselected
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
    expect(hook).toContain('$__dk_package_bin_dir/guard-deterministic'); // guards intact
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
    expect(hook).toContain('$__dk_package_bin_dir/guard-deterministic');
    expect(hook).not.toContain('$__dk_package_bin_dir/guard-decisions'); // decisions dropped
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

  it('reports grandfathered debt from canonical Devkit baseline paths', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--guards', 'fanout,size');
    mkdirSync(join(root, '.devkit', 'baselines'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'baselines', 'fanout.json'), '{"cap":12,"dirs":{}}\n');
    writeFileSync(join(root, '.devkit', 'baselines', 'size.json'), '{"files":{}}\n');
    writeFileSync(join(root, '.devkit', 'baselines', 'size-lines.json'), '{"files":{}}\n');

    const result = devkit(root, 'doctor');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'baselines: OK — grandfathered debt: fanout + size + line-growth',
    );

    // The retired legacy generation (sc-2256) is invisible to doctor: seeding eslint/baselines
    // instead of canonical state must not report grandfathered debt.
    rmSync(join(root, '.devkit', 'baselines'), { recursive: true });
    mkdirSync(join(root, 'eslint', 'baselines'), { recursive: true });
    writeFileSync(join(root, 'eslint', 'baselines', 'size-lines.json'), '{"files":{}}\n');
    expect(devkit(root, 'doctor').stdout).toContain(
      'baselines: OK — no grandfathered debt (enforced from config)',
    );
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
    expect(r.stdout).toMatch(/structure-lint: OK — runs `guard-structure staged`/);
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
      readFileSync(hookPath, 'utf8').replace(' --structure "guard-structure staged"', ''),
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
    expect(readFileSync(hookPath, 'utf8')).toContain('$__dk_package_bin_dir/guard-deterministic');
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

  // The qavis-advisory gate fails OPEN when qavis can't be reached, so at commit time a missing
  // binary is indistinguishable from a healthy "nothing to QA". Doctor names the state — advisorily,
  // because a repo that keeps the guard but skips installing qavis is a choice, not drift.
  it('reports qavis-advisory health without ever gating the exit code', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--guards', 'size,qavis-advisory');

    const inert = devkit(root, 'doctor');
    expect(inert.status, inert.stderr).toBe(0);
    expect(inert.stdout).toMatch(/qavis-advisory: no .*recipe\.json — gate inert/);

    // A recipe with no qavis on PATH — the silently-dead gate this check exists to surface.
    mkdirSync(join(root, '.qavis'), { recursive: true });
    writeFileSync(join(root, '.qavis', 'recipe.json'), '{}');
    const pathWithoutQavisOrCodex = '/usr/bin:/bin';
    const claudeFamilyJudgePins = {
      GUARD_REVIEW_MODEL: 'haiku',
      GUARD_REVIEW_ESCALATION_MODEL: 'opus',
      GUARD_CORRECTNESS_MODEL: 'opus',
    };
    const dead = spawnSync(process.execPath, [CLI, 'doctor'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: pathWithoutQavisOrCodex, ...claudeFamilyJudgePins },
    });
    expect(dead.stdout).toMatch(/qavis-advisory: .*present but qavis is NOT on PATH/);
    expect(dead.status, dead.stderr).toBe(0);
  });

  // sc-2028: ship's post-push evidence hand-off is inert on a qavis with no publication subcommand,
  // and it says so only in post-push stderr — a stream a headless shipping agent may never read. So
  // doctor names it on the HEALTHY arm too, where the recipe and the binary are both proven present.
  it('reports whether the installed qavis can publish PR evidence, without gating the exit code', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--guards', 'size,qavis-advisory');
    mkdirSync(join(root, '.qavis'), { recursive: true });
    writeFileSync(join(root, '.qavis', 'recipe.json'), '{}');
    const stubBin = join(root, 'stub-bin');
    mkdirSync(stubBin, { recursive: true });

    const doctorWith = (script: string) => {
      writeFileSync(join(stubBin, 'qavis'), `#!/bin/sh\n${script}\n`);
      chmodSync(join(stubBin, 'qavis'), 0o755);
      return spawnSync(process.execPath, [CLI, 'doctor'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
      });
    };
    const qavisStub = (commands: string) => doctorWith(`printf 'Commands:\\n${commands}'`);

    const noPublish = qavisStub('  qa [options]  x\\n  route [options]  x\\n');
    expect(noPublish.stdout).toMatch(/qavis-advisory: qavis on PATH .*cannot publish PR evidence/);

    const withPublish = qavisStub('  qa [options]  x\\n  publish [options]  x\\n');
    expect(withPublish.stdout).toMatch(/qavis-advisory: qavis on PATH .*publishes on ship/);

    // A qavis whose --help cannot be read is a THIRD state. Reporting it as "no publication
    // subcommand" would state a fact about a binary doctor never managed to interrogate.
    const unreadable = doctorWith('echo "boom" >&2; exit 3');
    expect(unreadable.stdout).toMatch(
      /qavis-advisory: qavis on PATH .*publication support UNKNOWN/,
    );
    expect(unreadable.stdout).not.toMatch(/has no publication subcommand/);

    // Advisory to the end: which of the three a repo is in must never move doctor's exit code.
    expect(withPublish.status, withPublish.stderr).toBe(noPublish.status);
    expect(unreadable.status, unreadable.stderr).toBe(noPublish.status);
  });

  it('reports invalid JSON in a managed config as drift (not a silent pass)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    writeFileSync(join(root, 'biome.jsonc'), '{ "extends": [ }'); // malformed
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/biome\.jsonc.*invalid JSON/s);
  });

  it('checks every selected provider-native agent projection', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    const codexAgent = join(root, '.codex', 'agents', 'correctness-reviewer.toml');
    writeFileSync(codexAgent, `${readFileSync(codexAgent, 'utf8')}# drift\n`);
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/agents: DRIFT .*consumer copy drifted/s);
  });

  it('checks both historical providers for a v1 Claude/Cursor manifest', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--no-codex').status).toBe(0);
    writeFileSync(join(root, '.cursor', 'agents', 'correctness-reviewer.md'), '# drift\n');
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/agents: DRIFT .*consumer copy drifted/s);
  });

  it('reports a malformed strict agent manifest as drift instead of crashing', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--no-codex').status).toBe(0);
    writeFileSync(join(root, '.devkit', 'agents-manifest.json'), '{not-json');
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/agents: DRIFT .*invalid agents-manifest\.json/s);
  });

  it('checks hook registrations across every selected provider', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--agent-hooks').status).toBe(0);
    rmSync(join(root, '.codex', 'hooks.json'));
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/hook registrations: DRIFT/);
  });

  it('init heals retired hook registrations when no hook component is selected', () => {
    const root = tmpRepo();
    const initArgs = ['init', '--stack', 'generic', '--yes', '--guards', 'size'];
    expect(devkit(root, ...initArgs).status).toBe(0);
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify(retiredFallowClaudeSettings()),
    );

    const drifted = devkit(root, 'doctor');
    expect(drifted.status).toBe(1);
    expect(drifted.stdout).toMatch(/hook registrations: DRIFT/);

    const healed = devkit(root, ...initArgs);
    expect(healed.status, healed.stderr).toBe(0);
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).not.toContain(
      'FALLOW_GATE_COMMIT_ONLY',
    );
    expect(devkit(root, 'doctor').status).toBe(0);
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

  it('checks retired registrations when no hook-owning component remains selected', async () => {
    const root = tmpRepo();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify(retiredFallowClaudeSettings()),
    );
    const cfg = {
      components: {
        agentTargets: ['claude'],
        agentHooks: false,
        fallow: false,
        guards: [],
      },
    };

    const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });

    expect(results.find((result) => result.name === 'hook registrations')?.status).toBe('DRIFT');
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

  it('infers only historical on-disk providers when agentTargets is absent', async () => {
    const root = tmpRepo();
    expect(
      devkit(root, 'init', '--stack', 'generic', '--yes', '--no-codex', '--no-cursor').status,
    ).toBe(0);
    const cfg = config(root);
    delete cfg.components.agentTargets;
    const { sel } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
    expect(sel.agentTargets).toEqual(['claude']);
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
