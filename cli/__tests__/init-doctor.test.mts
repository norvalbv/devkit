import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectResults } from '../commands/doctor.mts';
import { checkRegistrations } from '../lib/doctor/asset-checks.mts';
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
      'tsconfig.json',
      '.husky/pre-commit',
      '.devkit/config.json',
    ]) {
      expect(existsSync(join(root, f)), `${f} should exist`).toBe(true);
    }
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(false);
    const cfg = config(root);
    expect(cfg.stack).toBe('generic');
    expect(cfg.components.biome).toBeUndefined();
    expect(cfg.components.guards).toEqual([
      'size',
      'fanout',
      'dup',
      'clone',
      'comments',
      'decisions',
      'ui-evidence',
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
      '@babel/core',
      '@babel/eslint-parser',
      '@babel/plugin-syntax-jsx',
      '@babel/preset-typescript',
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

  it('electron on TypeScript 6 keeps the TypeScript parser + preserves worktree symlinks', () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      devDependencies: { electron: '^30', typescript: '^6.0.3' },
    });
    devkit(root, 'init', '--stack', 'electron', '--yes');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies.eslint).toBeDefined();
    expect(pkg.devDependencies['@typescript-eslint/parser']).toBeDefined();
    expect(pkg.devDependencies['@babel/eslint-parser']).toBeUndefined();
    // The repo-wide sweep (`bun run lint`, CI, agents-hooks/lint-check.sh) is a CONSUMER-run eslint,
    // so it carries the flag itself; the staged gate's own invocation cannot cover it.
    expect(pkg.scripts['lint:structure']).toBe(
      'node --preserve-symlinks node_modules/eslint/bin/eslint.js src',
    );
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf8');
    expect(hook).toContain('--structure "guard-structure staged"');
  });

  it('electron on TypeScript 7 gets the Babel parser, since TS7 ships no compiler API', () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      devDependencies: { electron: '^30', typescript: '7.0.2' },
    });
    devkit(root, 'init', '--stack', 'electron', '--yes');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@babel/core']).toBeDefined();
    expect(pkg.devDependencies['@babel/eslint-parser']).toBeDefined();
    expect(pkg.devDependencies['@babel/plugin-syntax-jsx']).toBeDefined();
    expect(pkg.devDependencies['@babel/preset-typescript']).toBeDefined();
    expect(pkg.devDependencies['@typescript-eslint/parser']).toBeUndefined();
  });

  it('a TypeScript 7 alias beside a TypeScript 6 library keeps the TypeScript parser', () => {
    // The documented side-by-side arrangement: TS7 supplies the `tsc` binary under an alias while
    // the canonical `typescript` stays TS6 and keeps serving the compiler API the parser reads.
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      devDependencies: {
        electron: '^30',
        '@typescript/native': 'npm:typescript@7.0.2',
        typescript: '^6.0.3',
      },
    });
    devkit(root, 'init', '--stack', 'electron', '--yes');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@typescript-eslint/parser']).toBeDefined();
    expect(pkg.devDependencies['@babel/eslint-parser']).toBeUndefined();
  });

  it('never strips a parser the consumer already declared', () => {
    // init adds what the stack needs; removing a package the consumer chose is `devkit clean`'s job.
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      devDependencies: {
        electron: '^30',
        typescript: '7.0.2',
        '@typescript-eslint/parser': '^8.0.0',
      },
    });
    devkit(root, 'init', '--stack', 'electron', '--yes');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@typescript-eslint/parser']).toBe('^8.0.0');
    expect(pkg.devDependencies['@babel/eslint-parser']).toBeDefined();
  });
});

describe('init — per-component flag selection', () => {
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
  it('preserves a consumer-owned Babel core when Electron structure is removed', () => {
    const root = tmpRepo({
      name: 'fx',
      version: '0',
      type: 'module',
      devDependencies: { electron: '^30', '@babel/core': '^8.0.1' },
    });
    devkit(root, 'init', '--stack', 'electron', '--yes');

    devkit(root, 'init', '--stack', 'electron', '--yes', '--no-structure', '--remove-deselected');

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@babel/core']).toBe('^8.0.1');
    expect(pkg.devDependencies['@babel/eslint-parser']).toBeUndefined();
    expect(pkg.devDependencies['@babel/plugin-syntax-jsx']).toBeUndefined();
    expect(pkg.devDependencies['@babel/preset-typescript']).toBeUndefined();
  });

  it('WITHOUT --remove-deselected a deselected-but-present component is left in place', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    // No --remove-deselected: removal is opt-in. tsconfig.json stays even though deselected.
    devkit(root, 'init', '--stack', 'generic', '--yes', '--no-tsconfig');
    expect(existsSync(join(root, 'tsconfig.json'))).toBe(true);
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

  it('component-lib doctor reports the structure-lint line as OK', () => {
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

  it('only checks the selected guards in the husky block', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--guards', 'fanout,size');
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/pre-commit: OK — block order: format → deterministic\n/);
  });

  // The order printed is the installed hook's, not the recorded selection's: ui-evidence recorded
  // before review must still print after it, or a reader concludes QA runs before the reviewers.
  it('prints the overlay hook order, including its staged lint overlay', () => {
    const root = tmpRepo();
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    devkit(root, 'init', '--overlay', '--stack', 'generic', '--yes', '--guards', 'size,review');
    const { stdout } = devkit(root, 'doctor');
    expect(stdout).toMatch(/pre-commit block order: .*deterministic → lint overlay → guard-review/);
    expect(stdout).toContain('commit-msg block order: guard-completeness');
  });

  it('prints the stages of a hook whose only guard is the commit-msg sentry judge', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--guards', 'sentry');
    expect(devkit(root, 'doctor').stdout).toContain(
      'pre-commit: OK — block order: format → guard-sentry-prewarm',
    );
  });

  it('prints each hook block in the order it runs, not the recorded guard order', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--guards', 'ui-evidence,review,size');
    const { stdout } = devkit(root, 'doctor');
    expect(stdout).toContain(
      'pre-commit: OK — block order: format → deterministic → guard-review → guard-ui-evidence',
    );
    expect(stdout).toContain('commit-msg: OK — block order: guard-completeness');
  });

  it('reports invalid JSON in a managed config as drift (not a silent pass)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    writeFileSync(join(root, 'tsconfig.json'), '{ "extends": [ }'); // malformed
    const r = devkit(root, 'doctor');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/tsconfig\.json.*invalid JSON/s);
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

  it('names and heals a retired hook in settings.local.json, which shared scope does not own', () => {
    const root = tmpRepo();
    const initArgs = ['init', '--stack', 'generic', '--yes', '--guards', 'size'];
    expect(devkit(root, ...initArgs).status).toBe(0);
    mkdirSync(join(root, '.claude'), { recursive: true });
    const local = join(root, '.claude', 'settings.local.json');
    writeFileSync(local, JSON.stringify(retiredFallowClaudeSettings()));

    const drifted = devkit(root, 'doctor');
    expect(drifted.status).toBe(1);
    expect(drifted.stdout).toMatch(
      /hook registrations: DRIFT .*claude:retired-registration:\.claude\/settings\.local\.json/,
    );

    expect(devkit(root, 'doctor', '--fix').stdout).toMatch(/--fix applied/);
    expect(readFileSync(local, 'utf8')).not.toContain('FALLOW_GATE_COMMIT_ONLY');
    expect(devkit(root, 'doctor').status).toBe(0);
  });
});

describe('checkRegistrations — overlay and a committed settings.json', () => {
  it('reports an advisory row that neither fails doctor nor claims --fix', () => {
    const root = tmpRepo();
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify(retiredFallowClaudeSettings()),
    );
    expect(spawnSync('git', ['add', '.claude'], { cwd: root }).status).toBe(0);

    expect(checkRegistrations(root, [], ['claude'], true)).toMatchObject({
      status: 'DRIFT',
      advisory: true,
      fixable: false,
      detail: expect.stringContaining('.claude/settings.json'),
    });
  });
});

// Unit-cover the doctor dispatch (extracted from run() so it's testable without the subprocess).
describe('doctor collectResults dispatch', () => {
  const names = (results) => results.map((r) => r.name);

  it('only builds checks for the selected components', async () => {
    const root = tmpRepo();
    const cfg = {
      standalone: false,
      components: { tsconfig: true, skills: false, husky: false, guards: [] },
    };
    const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
    const n = names(results);
    expect(n).toContain('tsconfig.json');
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
    const cfg = { standalone: true, components: { guards: [] } };
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
      components: { tsconfig: true, husky: false, guards: [] },
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
      components: { tsconfig: true, husky: false, guards: [] },
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
      components: { tsconfig: true, husky: false, guards: [] },
    };
    const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
    const ts = results.find((r) => r.name === 'tsconfig.json');
    expect(ts.status).toBe('DRIFT');
    expect(ts.detail).toMatch(/invalid JSON/);
  });
});
