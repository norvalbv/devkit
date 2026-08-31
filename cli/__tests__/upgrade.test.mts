/**
 * `devkit upgrade` — end-to-end reconcile of a consumer repo (the frink-primitives repro shape).
 *
 * Subprocess-style (like init-doctor.test): a real component-lib repo built by `init`, then drifted
 * (stale pin, behind devkitRef, hand-tuned tsconfig, a drifted skill), then `upgrade` must return
 * doctor-clean in ONE invocation. DEVKIT_REPO is pointed at a bogus URL so `git ls-remote` fails
 * fast (no network) → upgrade takes the installed==latest reconcile path deterministically.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { digest } from '../lib/fs-helpers.mts';
import {
  ANTI_SLOP_BASELINE_UPGRADE_REL,
  antiSlopBaselineMigrationId,
} from '../lib/install/anti-slop/constants.mts';
import { captureAntiSlopBaselineActivation } from '../lib/install/anti-slop/managed-state.mts';
import { CLI, readConfig as config, tmpRepos } from './_helpers.mts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const V = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const DEP = '@norvalbv/devkit';
const CLIB_PKG = {
  name: 'fx',
  version: '0.0.0',
  type: 'module',
  peerDependencies: { react: '^18' },
  exports: {},
};

const { tmpRepo, cleanup } = tmpRepos('upgrade-');
afterEach(cleanup);

// Runner with a bogus remote so the version step never hits the network — upgrade tolerates the
// unreachable remote and reconciles against the installed version.
const run = (root, ...args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_REPO: 'file:///devkit-nonexistent-xyz' },
  });

const read = (p) => readFileSync(p, 'utf8');
const readPkg = (root) => JSON.parse(read(join(root, 'package.json')));
const devkitRef = (root) => readPkg(root).devDependencies[DEP];
const EXTERNAL_RECORD_RULE_IDS = [
  'anti-slop/no-unsafe-external-record-access',
  'anti-slop/no-unsafe-external-record-enumeration',
];

function disableExternalRecordRules(root) {
  const path = join(root, '.devkit', 'anti-slop', 'oxlint.json');
  const managed = JSON.parse(read(path));
  const rules = managed.rules;
  for (const ruleId of EXTERNAL_RECORD_RULE_IDS) {
    if (!Object.hasOwn(rules, ruleId)) throw new Error(`missing managed rule: ${ruleId}`);
    rules[ruleId] = 'off';
  }
  const configBytes = `${JSON.stringify(managed, null, 2)}\n`;
  writeFileSync(path, configBytes);
  const manifestPath = join(root, '.devkit', 'anti-slop', 'manifest.json');
  const manifest = JSON.parse(read(manifestPath));
  manifest.configDigest = digest(configBytes);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function restorePublishedV059AntiSlop(root) {
  const path = join(root, '.devkit', 'anti-slop', 'oxlint.json');
  const managed = JSON.parse(read(path));
  managed.jsPlugins[0].specifier = './plugin/index.js';
  delete managed.rules['anti-slop/no-unsafe-external-record-access'];
  delete managed.rules['anti-slop/no-unsafe-external-record-enumeration'];
  delete managed.overrides[0].rules['anti-slop/no-unsafe-external-record-access'];
  delete managed.overrides[0].rules['anti-slop/no-unsafe-external-record-enumeration'];
  const configBytes = `${JSON.stringify(managed, null, 2)}\n`;
  if (digest(configBytes) !== '042d879db74dbd032183a444d88d1e2c9fafd904913cde3649410df7b6d31018') {
    throw new Error('published v0.59.0 anti-slop config fixture drifted');
  }
  writeFileSync(path, configBytes);
  const manifestPath = join(root, '.devkit', 'anti-slop', 'manifest.json');
  const manifest = JSON.parse(read(manifestPath));
  delete manifest.devkitVersion;
  manifest.ruleIds = manifest.ruleIds.filter(
    (ruleId) => !EXTERNAL_RECORD_RULE_IDS.includes(ruleId),
  );
  manifest.pluginDigest = '890d1ae533a85b859e7bd09c6af46175a9af47facd2d969fd723182567149ba2';
  manifest.configDigest = digest(configBytes);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function commitGitBase(root) {
  const commands = [
    ['init', '-q'],
    ['config', 'user.email', 'devkit-tests@example.invalid'],
    ['config', 'user.name', 'Devkit Tests'],
    ['config', 'core.hooksPath', '.husky'],
    ['add', '-A'],
    ['commit', '--no-verify', '-qm', 'base'],
  ];
  for (const args of commands) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  }
}

// A doctor-clean component-lib repo on the given agent surface(s). Defaults to claude-only.
function initFixture(extraFlags = ['--no-cursor']) {
  const root = tmpRepo(CLIB_PKG);
  const r = run(root, 'init', '--stack', 'component-lib', '--yes', '--agent-hooks', ...extraFlags);
  expect(r.status, r.stderr || r.stdout).toBe(0);
  return root;
}

// Stale the recorded refs (failure mode a) + record the tsconfig override, then hand-tune tsconfig.
function driftRepo(root) {
  const pkg = readPkg(root);
  pkg.devDependencies[DEP] = 'git+ssh://git@github.com/norvalbv/devkit.git#v0.16.0';
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  const cfg = config(root);
  cfg.devkitRef = 'v0.15.0';
  cfg.configOverrides = ['tsconfig.json'];
  writeFileSync(join(root, '.devkit', 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);

  // A hand-tuned, no-devkit-extends tsconfig — an intentional override (recorded above).
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }, null, 2)}\n`,
  );
}

// Mutate a synced skill's consumer copy so checkSkills sees drift (upgrade must re-sync it).
function driftFirstSkill(root) {
  const manifest = JSON.parse(read(join(root, '.devkit', 'skills-manifest.json')));
  const rel = Object.keys(manifest.files)[0];
  const p = join(root, '.claude', 'skills', rel);
  writeFileSync(p, `${read(p)}\n// local drift\n`);
  return rel;
}

describe('devkit upgrade — full reconcile (component-lib repro)', () => {
  it('one invocation → doctor-clean: re-pins, bumps devkitRef, re-syncs, no .cursor re-added', () => {
    const root = initFixture(['--no-cursor']); // claude-only
    driftRepo(root);
    driftFirstSkill(root);

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0); // doctor exit — the whole repo is clean

    // pin + devkitRef reconciled to the installed version.
    expect(devkitRef(root)).toMatch(new RegExp(`#v${V.replace(/\./g, '\\.')}$`));
    expect(config(root).devkitRef).toBe(`v${V}`);
    // consumer opt-out survived the config rewrite (2c).
    expect(config(root).configOverrides).toEqual(['tsconfig.json']);
    // claude-only honoured — no .cursor surface created.
    expect(existsSync(join(root, '.cursor'))).toBe(false);
  });

  it('is idempotent: a second upgrade writes nothing and stays clean', () => {
    const root = initFixture(['--no-cursor']);
    driftRepo(root);
    run(root, 'upgrade');

    const pkgBefore = read(join(root, 'package.json'));
    const cfgBefore = read(join(root, '.devkit', 'config.json'));
    const up2 = run(root, 'upgrade');
    expect(up2.status).toBe(0);
    expect(read(join(root, 'package.json'))).toBe(pkgBefore);
    expect(read(join(root, '.devkit', 'config.json'))).toBe(cfgBefore);
  });

  it('baselines only findings activated when upgrading the published v0.59.0 capability', () => {
    const root = initFixture(['--no-cursor', '--anti-slop']);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'existing.ts'),
      'export function widen(value: object) { return value; }\n',
    );
    expect(run(root, 'anti-slop', 'create').status).toBe(0);
    const before = JSON.parse(read(join(root, '.anti-slop-baseline.json')));
    expect(before.entries).toHaveLength(1);

    writeFileSync(
      join(root, 'src', 'introduced.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"]; Object.entries(parsed);\n',
    );
    restorePublishedV059AntiSlop(root);

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(up.stdout).toMatch(/adopted 2 existing finding\(s\).*2 newly activated rule\(s\)/);

    const after = JSON.parse(read(join(root, '.anti-slop-baseline.json')));
    expect(after.entries.filter((entry) => entry.ruleId === before.entries[0].ruleId)).toEqual(
      before.entries,
    );
    expect(after.entries.map((entry) => entry.ruleId)).toEqual(
      expect.arrayContaining([
        'anti-slop/no-unsafe-external-record-access',
        'anti-slop/no-unsafe-external-record-enumeration',
      ]),
    );
    expect(existsSync(join(root, '.devkit', 'anti-slop-baseline-upgrade.json'))).toBe(false);
    const checked = run(root, 'anti-slop', 'check');
    expect(checked.status, checked.stderr || checked.stdout).toBe(0);

    const bytes = read(join(root, '.anti-slop-baseline.json'));
    expect(run(root, 'upgrade').status).toBe(0);
    expect(read(join(root, '.anti-slop-baseline.json'))).toBe(bytes);
  });

  it('retries baseline adoption after capability sync completed but the prior upgrade stopped', () => {
    const root = initFixture(['--no-cursor', '--anti-slop']);
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(run(root, 'anti-slop', 'create').status).toBe(0);
    writeFileSync(
      join(root, 'src', 'introduced.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"];\n',
    );
    writeFileSync(
      join(root, '.devkit', 'anti-slop-baseline-upgrade.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          migrationId: 'migration-retry-access',
          activatedRuleIds: ['anti-slop/no-unsafe-external-record-access'],
        },
        null,
        2,
      )}\n`,
    );

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(up.stdout).toMatch(/adopted 1 existing finding\(s\).*1 newly activated rule\(s\)/);
    const baseline = JSON.parse(read(join(root, '.anti-slop-baseline.json')));
    expect(baseline.entries).toContainEqual(
      expect.objectContaining({ ruleId: 'anti-slop/no-unsafe-external-record-access' }),
    );
    expect(existsSync(join(root, '.devkit', 'anti-slop-baseline-upgrade.json'))).toBe(false);
  });

  it('does not consume a target receipt when create runs under the old managed config', () => {
    const root = initFixture(['--no-cursor', '--anti-slop']);
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(run(root, 'anti-slop', 'create').status).toBe(0);
    disableExternalRecordRules(root);
    writeFileSync(
      join(root, 'src', 'introduced.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"];\n',
    );

    const activation = captureAntiSlopBaselineActivation(root);
    expect(activation?.activatedRuleIds).toEqual(new Set(EXTERNAL_RECORD_RULE_IDS));
    rmSync(join(root, '.anti-slop-baseline.json'), { force: true });

    const premature = run(root, 'anti-slop', 'create');
    expect(premature.status, premature.stderr || premature.stdout).toBe(0);
    expect(premature.stdout).toContain('preserved pending release transition');
    expect(existsSync(join(root, ANTI_SLOP_BASELINE_UPGRADE_REL))).toBe(true);
    expect(
      JSON.parse(read(join(root, '.anti-slop-baseline.json'))).migrationReceipts ?? [],
    ).not.toContain(activation?.migrationId);

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(up.stdout).toMatch(/adopted 1 existing finding\(s\).*2 newly activated rule\(s\)/);
    const baseline = JSON.parse(read(join(root, '.anti-slop-baseline.json')));
    expect(baseline.migrationReceipts).toContain(activation?.migrationId);
    expect(baseline.entries).toContainEqual(
      expect.objectContaining({ ruleId: 'anti-slop/no-unsafe-external-record-access' }),
    );
    expect(existsSync(join(root, ANTI_SLOP_BASELINE_UPGRADE_REL))).toBe(false);
  });

  it('does not adopt a later violation when a zero-finding migration marker is retried', () => {
    const root = initFixture(['--no-cursor', '--anti-slop']);
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(run(root, 'anti-slop', 'create').status).toBe(0);
    disableExternalRecordRules(root);

    const first = run(root, 'upgrade');
    expect(first.status, first.stderr || first.stdout).toBe(0);
    const migrated = JSON.parse(read(join(root, '.anti-slop-baseline.json')));
    expect(migrated.migrationReceipts).toHaveLength(1);

    writeFileSync(
      join(root, 'src', 'later.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"];\n',
    );
    writeFileSync(
      join(root, '.devkit', 'anti-slop-baseline-upgrade.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        migrationId: migrated.migrationReceipts[0],
        activatedRuleIds: ['anti-slop/no-unsafe-external-record-access'],
      })}\n`,
    );

    const retry = run(root, 'upgrade');
    expect(retry.status, retry.stderr || retry.stdout).toBe(0);
    const after = JSON.parse(read(join(root, '.anti-slop-baseline.json')));
    expect(
      after.entries.some((entry) => entry.ruleId === 'anti-slop/no-unsafe-external-record-access'),
    ).toBe(false);
    expect(existsSync(join(root, '.devkit', 'anti-slop-baseline-upgrade.json'))).toBe(false);
  });

  it('explicit create closes pending zero-finding activation evidence', () => {
    const root = initFixture(['--no-cursor', '--anti-slop']);
    const manifest = JSON.parse(read(join(root, '.devkit', 'anti-slop', 'manifest.json')));
    const migrationId = antiSlopBaselineMigrationId(manifest.devkitVersion, manifest.configDigest);
    writeFileSync(
      join(root, '.devkit', 'anti-slop-baseline-upgrade.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        migrationId,
        activatedRuleIds: ['anti-slop/no-unsafe-external-record-access'],
      })}\n`,
    );

    expect(run(root, 'anti-slop', 'create').status).toBe(0);
    const baseline = JSON.parse(read(join(root, '.anti-slop-baseline.json')));
    expect(baseline.migrationReceipts).toContain(migrationId);
    expect(existsSync(join(root, '.devkit', 'anti-slop-baseline-upgrade.json'))).toBe(false);
  });

  it('does not consume a pending activation when this upgrade disables anti-slop', () => {
    const root = initFixture(['--no-cursor', '--anti-slop']);
    expect(run(root, 'anti-slop', 'create').status).toBe(0);
    writeFileSync(
      join(root, '.devkit', 'anti-slop-baseline-upgrade.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        migrationId: 'migration-disabled',
        activatedRuleIds: ['anti-slop/no-unsafe-external-record-access'],
      })}\n`,
    );
    const cfg = config(root);
    cfg.components.antiSlop = false;
    writeFileSync(join(root, '.devkit', 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(existsSync(join(root, '.devkit', 'anti-slop-baseline-upgrade.json'))).toBe(true);
    const baseline = JSON.parse(read(join(root, '.anti-slop-baseline.json')));
    expect(baseline.migrationReceipts ?? []).not.toContain('migration-disabled');
  });

  it('previews newly activated anti-slop rules without changing the baseline on dry-run', () => {
    const root = initFixture(['--no-cursor', '--anti-slop']);
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(run(root, 'anti-slop', 'create').status).toBe(0);
    const baselinePath = join(root, '.anti-slop-baseline.json');
    const before = read(baselinePath);
    disableExternalRecordRules(root);

    const up = run(root, 'upgrade', '--dry-run');
    expect(up.status).toBe(0);
    expect(up.stdout).toMatch(/would adopt existing findings.*2 newly activated rule\(s\)/);
    expect(read(baselinePath)).toBe(before);
  });

  it('records a receipt without guessing rule debt when prior managed evidence is invalid', () => {
    const root = initFixture(['--no-cursor', '--anti-slop']);
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(run(root, 'anti-slop', 'create').status).toBe(0);
    const baselinePath = join(root, '.anti-slop-baseline.json');
    disableExternalRecordRules(root);
    commitGitBase(root);
    const before = JSON.parse(read(baselinePath));
    writeFileSync(
      join(root, 'src', 'introduced.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"];\n',
    );
    writeFileSync(join(root, '.devkit', 'anti-slop', 'manifest.json'), '{}\n');

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(up.stdout).toContain(
      'recording the release transition without adopting unproven findings',
    );
    const manifest = JSON.parse(read(join(root, '.devkit', 'anti-slop', 'manifest.json')));
    const migrationId = antiSlopBaselineMigrationId(manifest.devkitVersion, manifest.configDigest);
    const after = JSON.parse(read(baselinePath));
    expect(after.entries).toEqual(before.entries);
    expect(after.migrationReceipts).toContain(migrationId);
    expect(existsSync(join(root, ANTI_SLOP_BASELINE_UPGRADE_REL))).toBe(false);

    writeFileSync(join(root, 'src', 'introduced.ts'), 'export const introduced = true;\n');
    expect(spawnSync('git', ['add', '-A'], { cwd: root }).status).toBe(0);
    const staged = run(root, 'anti-slop', 'check', '--staged');
    expect(staged.status, staged.stderr || staged.stdout).toBe(0);
  });

  it('creates a release-bound marker when the baseline is missing, then recovers', () => {
    for (const removeManagedEvidence of [false, true]) {
      const root = initFixture(['--no-cursor', '--anti-slop']);
      expect(run(root, 'anti-slop', 'create').status).toBe(0);
      disableExternalRecordRules(root);
      rmSync(join(root, '.anti-slop-baseline.json'), { force: true });
      if (removeManagedEvidence) {
        rmSync(join(root, '.devkit', 'anti-slop', 'manifest.json'), { force: true });
        rmSync(join(root, '.devkit', 'anti-slop', 'oxlint.json'), { force: true });
      }

      const up = run(root, 'upgrade');
      expect(up.status, up.stderr || up.stdout).toBe(1);
      expect(`${up.stdout}\n${up.stderr}`).toContain('.anti-slop-baseline.json is missing');

      const manifest = JSON.parse(read(join(root, '.devkit', 'anti-slop', 'manifest.json')));
      const migrationId = antiSlopBaselineMigrationId(
        manifest.devkitVersion,
        manifest.configDigest,
      );
      const pending = JSON.parse(read(join(root, ANTI_SLOP_BASELINE_UPGRADE_REL)));
      expect(pending.migrationId).toBe(migrationId);
      expect(pending.activatedRuleIds).toEqual(
        removeManagedEvidence ? [] : EXTERNAL_RECORD_RULE_IDS,
      );
      expect(run(root, 'anti-slop', 'create').status).toBe(0);
      expect(JSON.parse(read(join(root, '.anti-slop-baseline.json'))).migrationReceipts).toContain(
        migrationId,
      );
      expect(existsSync(join(root, ANTI_SLOP_BASELINE_UPGRADE_REL))).toBe(false);
      expect(run(root, 'upgrade').status).toBe(0);
    }
  });

  it('makes the hook registration ledger trackable under a broad .devkit ignore', () => {
    const root = initFixture(['--no-cursor']);
    const ledger = '.devkit/agent-hook-registrations-manifest.json';
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    writeFileSync(
      join(root, '.gitignore'),
      '!.devkit/agent-hook-registrations-manifest.json\n.devkit/*\n!.devkit/agent-hooks-manifest.json\n',
    );
    expect(spawnSync('git', ['check-ignore', '-q', ledger], { cwd: root }).status).toBe(0);

    const up = run(root, 'upgrade');
    expect(up.stdout).toMatch(/hook registrations: OK/);

    expect(spawnSync('git', ['check-ignore', '-q', ledger], { cwd: root }).status).toBe(1);
    expect(
      spawnSync('git', ['status', '--short', '--', ledger], { cwd: root, encoding: 'utf8' }).stdout,
    ).toContain(ledger);
  });

  it('--dry-run writes nothing (stale pin unchanged) and skips the verify', () => {
    const root = initFixture(['--no-cursor']);
    driftRepo(root);
    const before = read(join(root, 'package.json'));

    const up = run(root, 'upgrade', '--dry-run');
    expect(up.status).toBe(0);
    expect(up.stdout).toMatch(/dry-run/i);
    expect(read(join(root, 'package.json'))).toBe(before); // still #v0.16.0
    expect(config(root).devkitRef).toBe('v0.15.0'); // unchanged
  });

  it('infers a claude-only surface from disk when agentTargets is absent (legacy config)', () => {
    const root = initFixture(['--no-cursor']);
    const cfg = config(root);
    delete cfg.components.agentTargets; // simulate a pre-agentTargets config
    writeFileSync(join(root, '.devkit', 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(existsSync(join(root, '.cursor'))).toBe(false); // not re-added
  });

  it('does NOT add structure-lint to a legacy config that never recorded/wired it', () => {
    // A config-driven repo initialised WITHOUT structure, then a legacy config with the `structure`
    // key stripped. normalizeSelection defaults structure→true; upgrade must honour the raw/inferred
    // (no eslint.config.mjs on disk) value and NOT newly enable structure-lint.
    const root = tmpRepo(CLIB_PKG);
    expect(
      run(root, 'init', '--stack', 'component-lib', '--yes', '--no-structure', '--no-cursor')
        .status,
    ).toBe(0);
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(false); // structure was off

    const cfg = config(root);
    delete cfg.components.structure; // simulate a pre-structure-key config
    writeFileSync(join(root, '.devkit', 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);

    // (doctor exit isn't asserted here — a component-lib WITHOUT structure gets the generic base biome,
    // an orthogonal mismatch; this test only pins that upgrade does not NEWLY add structure-lint.)
    run(root, 'upgrade');
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(false); // still off — not newly added
    expect(readFileSync(join(root, '.husky/pre-commit'), 'utf8')).not.toContain('guard-structure');
  });

  it('migrates an enabled Electron structure hook to the Devkit staged runner', () => {
    const root = tmpRepo({ ...CLIB_PKG, devDependencies: { electron: '^30' } });
    expect(run(root, 'init', '--stack', 'electron', '--yes', '--no-cursor').status).toBe(0);
    const hookPath = join(root, '.husky', 'pre-commit');
    writeFileSync(
      hookPath,
      readFileSync(hookPath, 'utf8').replace(
        'guard-structure staged',
        'node --preserve-symlinks node_modules/eslint/bin/eslint.js src',
      ),
    );

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(readFileSync(hookPath, 'utf8')).toContain('guard-structure staged');
    expect(config(root).components.structure).toBe(true);
  });

  it('does not recreate Biome config when an Electron structure consumer deselects it', () => {
    const root = tmpRepo({ ...CLIB_PKG, devDependencies: { electron: '^30' } });
    expect(run(root, 'init', '--stack', 'electron', '--yes', '--no-cursor').status).toBe(0);

    const cfg = config(root);
    cfg.components.biome = false;
    writeFileSync(join(root, '.devkit', 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
    rmSync(join(root, 'biome.jsonc'));

    const up = run(root, 'upgrade');
    expect(up.status, up.stderr || up.stdout).toBe(0);
    expect(existsSync(join(root, 'biome.jsonc'))).toBe(false);
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(true);
    expect(existsSync(join(root, 'tsconfig.json'))).toBe(true);
    expect(readFileSync(join(root, '.husky/pre-commit'), 'utf8')).not.toContain('biome format');
  });
});

describe('devkit upgrade — preflight', () => {
  it('exits 2 on an uninitialized repo', () => {
    const root = tmpRepo(CLIB_PKG);
    expect(run(root, 'upgrade').status).toBe(2);
  });
});
