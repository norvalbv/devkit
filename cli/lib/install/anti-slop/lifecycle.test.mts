import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../../fs-helpers.mts';
import { syncOxcCapability } from '../oxc/lifecycle.mts';
import { resolveOxcRuntime } from '../oxc/runtime.mts';
import {
  ANTI_SLOP_BASELINE_REL,
  ANTI_SLOP_BASELINE_UPGRADE_REL,
  ANTI_SLOP_UPSTREAM,
  antiSlopBaselineMigrationId,
} from './constants.mts';
import {
  checkAntiSlopCapability,
  removeAntiSlopCapability,
  syncAntiSlopCapability,
} from './lifecycle.mts';
import {
  captureAntiSlopBaselineActivation,
  clearPendingAntiSlopBaselineActivation,
  readActiveAntiSlopRuleIds,
  readAntiSlopManifest,
} from './managed-state.mts';

const roots: string[] = [];

function root(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-lifecycle-'));
  roots.push(cwd);
  return cwd;
}

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => {
  vi.restoreAllMocks();
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('anti-slop capability lifecycle', () => {
  it('installs all rules self-contained and integrates through the managed Oxc base', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    syncOxcCapability(cwd, { antiSlop: true });

    const manifest = JSON.parse(readFileSync(join(cwd, '.devkit/anti-slop/manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      upstreamCommit: '446268e5d15baa968eaec669ff65358d36ae6259',
      pluginApiVersion: '1.78.0',
    });
    expect(manifest.ruleIds).toHaveLength(17);
    expect(manifest.ruleIds).toEqual(
      expect.arrayContaining([
        'anti-slop/no-unsafe-external-record-access',
        'anti-slop/no-unsafe-external-record-enumeration',
      ]),
    );
    expect(existsSync(join(cwd, '.devkit/anti-slop/plugin/oxlint-plugins-api/index.js'))).toBe(
      true,
    );
    expect(readFileSync(join(cwd, '.devkit/anti-slop/plugin/package.json'), 'utf8')).toContain(
      '"#oxlint-plugins"',
    );
    expect(existsSync(join(cwd, '.devkit/anti-slop/plugin/index.devkit-active.ts'))).toBe(true);
    expect(readFileSync(join(cwd, '.devkit/anti-slop/plugin/index.ts'), 'utf8')).toContain(
      'DEVKIT_INTERNAL_ANTI_SLOP_MODE',
    );
    expect(existsSync(join(cwd, '.devkit/anti-slop/probe.ts'))).toBe(true);
    const managedConfig: { rules: Record<string, string> } = JSON.parse(
      readFileSync(join(cwd, '.devkit/anti-slop/oxlint.json'), 'utf8'),
    );
    expect(managedConfig.rules['anti-slop/no-object-parameters']).toBe('error');
    expect(managedConfig.rules['anti-slop/no-unsafe-external-record-access']).toBe('error');
    expect(managedConfig.rules['anti-slop/no-unsafe-external-record-enumeration']).toBe('error');
    expect(readFileSync(join(cwd, '.devkit/oxc/oxlint.base.json'), 'utf8')).toContain(
      '../anti-slop/oxlint.json',
    );
    expect(checkAntiSlopCapability(cwd).every((result) => result.status === 'OK')).toBe(true);

    writeFileSync(
      join(cwd, '.oxlintrc.json'),
      `${JSON.stringify({
        extends: ['./.devkit/oxc/oxlint.base.json'],
        ignorePatterns: ['.devkit'],
        rules: {},
      })}\n`,
    );
    writeFileSync(
      join(cwd, 'unsafe-external-record.ts'),
      'const files = JSON.parse(raw).files; files[key]; Object.entries(files);\n',
    );
    const runtime = resolveOxcRuntime('lint');
    const enabledByDefault = spawnSync(
      process.execPath,
      [runtime.binPath, '--format', 'json', '--disable-nested-config', 'unsafe-external-record.ts'],
      { cwd, encoding: 'utf8' },
    );
    expect(enabledByDefault.status, enabledByDefault.stderr).toBe(1);
    const codes = JSON.parse(enabledByDefault.stdout).diagnostics.map(
      (diagnostic: { code?: string }) => diagnostic.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'anti-slop(no-unsafe-external-record-access)',
        'anti-slop(no-unsafe-external-record-enumeration)',
      ]),
    );
  });

  it('keeps byte-identical managed state healthy across a Devkit package version bump', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    syncOxcCapability(cwd, { antiSlop: true });
    const manifestPath = join(cwd, '.devkit/anti-slop/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.devkitVersion = '0.58.0';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(readAntiSlopManifest(cwd)?.devkitVersion).toBe('0.58.0');
    expect(checkAntiSlopCapability(cwd).every((result) => result.status === 'OK')).toBe(true);
  });

  it('rejects empty or duplicate managed rule identities in every manifest view', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    const manifestPath = join(cwd, '.devkit/anti-slop/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    for (const ruleIds of [[], [manifest.ruleIds[0], manifest.ruleIds[0]]]) {
      writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ruleIds }, null, 2)}\n`);
      expect(readAntiSlopManifest(cwd)).toBeNull();
      expect(readActiveAntiSlopRuleIds(cwd)).toBeNull();
    }
  });

  it('rejects self-consistent activation evidence with an incomplete managed rule set', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    writeFileSync(
      join(cwd, ANTI_SLOP_BASELINE_REL),
      `${JSON.stringify({ schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] })}\n`,
    );
    const manifestPath = join(cwd, '.devkit/anti-slop/manifest.json');
    const configPath = join(cwd, '.devkit/anti-slop/oxlint.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const omitted = 'anti-slop/no-object-parameters';
    manifest.ruleIds = manifest.ruleIds.filter((ruleId: string) => ruleId !== omitted);
    delete config.rules['anti-slop/no-object-parameters'];
    delete config.overrides[0].rules['anti-slop/no-object-parameters'];
    const configBytes = `${JSON.stringify(config, null, 2)}\n`;
    manifest.configDigest = digest(configBytes);
    writeFileSync(configPath, configBytes);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(readActiveAntiSlopRuleIds(cwd)).toBeNull();
    expect(captureAntiSlopBaselineActivation(cwd)?.activatedRuleIds).toEqual(new Set());
  });

  it('rejects self-consistent activation evidence with an unshipped severity profile', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    writeFileSync(
      join(cwd, ANTI_SLOP_BASELINE_REL),
      `${JSON.stringify({ schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] })}\n`,
    );
    const manifestPath = join(cwd, '.devkit/anti-slop/manifest.json');
    const configPath = join(cwd, '.devkit/anti-slop/oxlint.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.rules['anti-slop/no-object-parameters'] = 'off';
    const configBytes = `${JSON.stringify(config, null, 2)}\n`;
    manifest.configDigest = digest(configBytes);
    writeFileSync(configPath, configBytes);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(readActiveAntiSlopRuleIds(cwd)).toBeNull();
    expect(captureAntiSlopBaselineActivation(cwd)?.activatedRuleIds).toEqual(new Set());
  });

  it('repairs managed drift without touching a repository baseline', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    syncOxcCapability(cwd, { antiSlop: true });
    writeFileSync(join(cwd, '.anti-slop-baseline.json'), '{"consumer":"data"}\n');
    writeFileSync(join(cwd, '.devkit/anti-slop/oxlint.json'), '{}\n');
    expect(checkAntiSlopCapability(cwd).some((result) => result.status === 'DRIFT')).toBe(true);

    syncAntiSlopCapability(cwd);
    expect(checkAntiSlopCapability(cwd).every((result) => result.status === 'OK')).toBe(true);
    const repairedManifest = JSON.parse(
      readFileSync(join(cwd, '.devkit/anti-slop/manifest.json'), 'utf8'),
    );
    expect(JSON.parse(readFileSync(join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL), 'utf8'))).toEqual({
      schemaVersion: 1,
      migrationId: antiSlopBaselineMigrationId(
        repairedManifest.devkitVersion,
        repairedManifest.configDigest,
      ),
      activatedRuleIds: [],
    });
    removeAntiSlopCapability(cwd);

    expect(readFileSync(join(cwd, '.anti-slop-baseline.json'), 'utf8')).toBe(
      '{"consumer":"data"}\n',
    );
    expect(existsSync(join(cwd, '.devkit/anti-slop'))).toBe(false);
    const base = JSON.parse(readFileSync(join(cwd, '.devkit/oxc/oxlint.base.json'), 'utf8')) as {
      extends?: string[];
    };
    expect(base.extends ?? []).not.toContain('../anti-slop/oxlint.json');
  });

  it('preserves and unions activation evidence before replacing managed state', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    syncOxcCapability(cwd, { antiSlop: true });
    writeFileSync(
      join(cwd, ANTI_SLOP_BASELINE_REL),
      `${JSON.stringify({ schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] })}\n`,
    );

    const configPath = join(cwd, '.devkit/anti-slop/oxlint.json');
    const previousConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    previousConfig.rules['anti-slop/no-unsafe-external-record-access'] = 'off';
    previousConfig.rules['anti-slop/no-unsafe-external-record-enumeration'] = 'off';
    const previousBytes = `${JSON.stringify(previousConfig, null, 2)}\n`;
    writeFileSync(configPath, previousBytes);
    const manifestPath = join(cwd, '.devkit/anti-slop/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.configDigest = digest(previousBytes);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL),
      `${JSON.stringify({
        schemaVersion: 1,
        migrationId: 'migration-access',
        activatedRuleIds: ['anti-slop/no-unsafe-external-record-access'],
      })}\n`,
    );

    syncAntiSlopCapability(cwd);
    const pending = JSON.parse(readFileSync(join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL), 'utf8'));
    expect(pending.activatedRuleIds).toEqual(
      expect.arrayContaining([
        'anti-slop/no-unsafe-external-record-access',
        'anti-slop/no-unsafe-external-record-enumeration',
      ]),
    );
    expect(pending.activatedRuleIds).toHaveLength(2);

    syncAntiSlopCapability(cwd);
    expect(JSON.parse(readFileSync(join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL), 'utf8'))).toEqual(
      pending,
    );
  });

  it('rebinds preserved activation evidence to the current release when prior state is invalid', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    syncOxcCapability(cwd, { antiSlop: true });
    writeFileSync(
      join(cwd, ANTI_SLOP_BASELINE_REL),
      `${JSON.stringify({ schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] })}\n`,
    );
    writeFileSync(
      join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL),
      `${JSON.stringify({
        schemaVersion: 1,
        migrationId: 'anti-slop-activation@older:stale',
        activatedRuleIds: ['anti-slop/no-unsafe-external-record-access'],
      })}\n`,
    );
    writeFileSync(join(cwd, '.devkit/anti-slop/manifest.json'), '{}\n');

    syncAntiSlopCapability(cwd);

    const manifest = JSON.parse(readFileSync(join(cwd, '.devkit/anti-slop/manifest.json'), 'utf8'));
    const pending = JSON.parse(readFileSync(join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL), 'utf8'));
    expect(pending).toEqual({
      schemaVersion: 1,
      migrationId: antiSlopBaselineMigrationId(manifest.devkitVersion, manifest.configDigest),
      activatedRuleIds: ['anti-slop/no-unsafe-external-record-access'],
    });
  });

  it('preserves an empty receipt-only marker after managed state has been repaired', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    syncOxcCapability(cwd, { antiSlop: true });
    writeFileSync(
      join(cwd, ANTI_SLOP_BASELINE_REL),
      `${JSON.stringify({ schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] })}\n`,
    );
    writeFileSync(join(cwd, '.devkit/anti-slop/manifest.json'), '{}\n');

    syncAntiSlopCapability(cwd);
    const first = captureAntiSlopBaselineActivation(cwd);
    const second = captureAntiSlopBaselineActivation(cwd);

    expect(first?.activatedRuleIds.size).toBe(0);
    expect(second).toEqual(first);
    expect(JSON.parse(readFileSync(join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL), 'utf8'))).toEqual({
      schemaVersion: 1,
      migrationId: first?.migrationId,
      activatedRuleIds: [],
    });
  });

  it('uses one deterministic migration ID across clones of the same Devkit release', () => {
    const migrationIds = [root(), root()].map((cwd) => {
      syncAntiSlopCapability(cwd);
      syncOxcCapability(cwd, { antiSlop: true });
      writeFileSync(
        join(cwd, ANTI_SLOP_BASELINE_REL),
        `${JSON.stringify({ schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] })}\n`,
      );
      const configPath = join(cwd, '.devkit/anti-slop/oxlint.json');
      const previousConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      previousConfig.rules['anti-slop/no-unsafe-external-record-access'] = 'off';
      previousConfig.rules['anti-slop/no-unsafe-external-record-enumeration'] = 'off';
      const previousBytes = `${JSON.stringify(previousConfig, null, 2)}\n`;
      writeFileSync(configPath, previousBytes);
      const manifestPath = join(cwd, '.devkit/anti-slop/manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.configDigest = digest(previousBytes);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return captureAntiSlopBaselineActivation(cwd)?.migrationId;
    });

    expect(migrationIds[0]).toMatch(/^anti-slop-activation@/u);
    expect(migrationIds[1]).toBe(migrationIds[0]);
  });

  it('clears a pending marker only for the completed transition ID', () => {
    const cwd = root();
    mkdirSync(join(cwd, '.devkit'));
    writeFileSync(
      join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL),
      `${JSON.stringify({
        schemaVersion: 1,
        migrationId: 'migration-current',
        activatedRuleIds: ['anti-slop/no-unsafe-external-record-access'],
      })}\n`,
    );

    expect(clearPendingAntiSlopBaselineActivation(cwd, 'migration-stale')).toBe(false);
    expect(existsSync(join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL))).toBe(true);
    expect(clearPendingAntiSlopBaselineActivation(cwd, 'migration-current')).toBe(true);
    expect(existsSync(join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL))).toBe(false);
  });

  it('reports a preserved consumer config that does not compose the managed base', () => {
    const cwd = root();
    writeFileSync(join(cwd, '.oxlintrc.json'), '{ "rules": {} }\n');
    syncAntiSlopCapability(cwd);

    expect(checkAntiSlopCapability(cwd)).toContainEqual(
      expect.objectContaining({ name: 'anti-slop Oxc integration', status: 'DRIFT' }),
    );
    writeFileSync(
      join(cwd, '.oxlintrc.json'),
      '{ "extends": ["./.devkit/anti-slop/oxlint.json"], "rules": {} }\n',
    );
    expect(checkAntiSlopCapability(cwd)).toContainEqual(
      expect.objectContaining({
        name: 'anti-slop Oxc integration',
        status: 'DRIFT',
        detail: 'consumer config does not load the managed Oxlint base',
      }),
    );
    writeFileSync(
      join(cwd, '.oxlintrc.json'),
      '{ "extends": ["./.devkit/oxc/oxlint.base.json"], "ignorePatterns": [".devkit"], "rules": {} }\n',
    );
    expect(checkAntiSlopCapability(cwd).every((result) => result.status === 'OK')).toBe(true);

    writeFileSync(
      join(cwd, 'local-plugin.mjs'),
      `const rule = { create(context) { return { ClassDeclaration(node) { context.report({ message: 'local', node }); } }; } };
export default { meta: { name: 'local' }, rules: { classes: rule } };
`,
    );
    writeFileSync(
      join(cwd, '.oxlintrc.json'),
      '{ "extends": ["./.devkit/oxc/oxlint.base.json"], "jsPlugins": ["./local-plugin.mjs"], "rules": { "local/classes": "error" } }\n',
    );
    expect(checkAntiSlopCapability(cwd).every((result) => result.status === 'OK')).toBe(true);
  });

  it('preflights Oxc collisions before publishing anti-slop managed state', () => {
    const cwd = root();
    writeFileSync(join(cwd, '.oxlintrc.json'), '{}\n');
    writeFileSync(join(cwd, 'oxlint.config.ts'), 'export default {};\n');

    expect(() => syncAntiSlopCapability(cwd)).toThrow('multiple Oxc configs');

    expect(existsSync(join(cwd, '.devkit/anti-slop'))).toBe(false);
    expect(existsSync(join(cwd, '.devkit/oxc'))).toBe(false);
  });
});
