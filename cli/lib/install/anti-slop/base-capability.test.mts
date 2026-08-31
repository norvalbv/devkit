import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import antiSlop from '../../../commands/oxc/anti-slop.mts';
import { digest } from '../../fs-helpers.mts';
import { syncOxcCapability } from '../oxc/lifecycle.mts';
import { adoptManagedCapability } from './base-capability.mts';
import { baselineFromGroups, writeBaseline } from './baseline.mts';
import {
  gitBaselineEnvelope,
  withBaseAntiSlopSnapshot,
  withStableGitIndex,
} from './git-snapshot.mts';
import { type GitLockReleaseOperations, resolveRef } from './git-index-lock.mts';
import {
  ANTI_SLOP_BASELINE_REL,
  ANTI_SLOP_UPSTREAM,
  antiSlopBaselineMigrationId,
} from './constants.mts';
import { syncAntiSlopCapability } from './lifecycle.mts';
import { collectAntiSlopGroups } from './runner.mts';

const roots: string[] = [];
const EMPTY_BASELINE = `${JSON.stringify(
  { schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] },
  null,
  2,
)}\n`;
const CLEAN_SOURCE = 'export const value = "base";\n';
// `anti-slop/no-object-parameters` — the same shape the capability's own integration probe uses.
const FINDING_SOURCE = 'export function widen(value: object) {\n  return value;\n}\n';
const OXC_BASE_REL = '.devkit/oxc/oxlint.base.json';
const OXC_MANIFEST_REL = '.devkit/oxc/manifest.json';
const ANTI_SLOP_CONFIG_REL = '.devkit/anti-slop/oxlint.json';
const ANTI_SLOP_MANIFEST_REL = '.devkit/anti-slop/manifest.json';
const EXTERNAL_RECORD_RULE_IDS = [
  'anti-slop/no-unsafe-external-record-access',
  'anti-slop/no-unsafe-external-record-enumeration',
];
// Two identical inner lines collapse to ONE fingerprint with count 2 — partial forgiveness.
const REPEATED_FINDING_SOURCE = [
  'function first() {',
  '  const inner = (value: object) => value;',
  '  return inner;',
  '}',
  'function second() {',
  '  const inner = (value: object) => value;',
  '  return inner;',
  '}',
  'export const pair = [first, second];',
  '',
].join('\n');
const THIRD_FINDING_SOURCE = [
  'function third() {',
  '  const inner = (value: object) => value;',
  '  return inner;',
  '}',
  'export const extra = third;',
  '',
].join('\n');
const DICTIONARY_FINDING_SOURCE = 'export type Dict = Record<string, unknown>;\n';

let out: string[] = [];
let err: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function withFailingGitProbe<T>(probe: 'resolve-ref' | 'symbolic-head', action: () => T): T {
  const delegatePath = process.env.PATH;
  if (!delegatePath) throw new Error('test requires PATH to locate Git');
  const shimDirectory = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-git-shim-'));
  roots.push(shimDirectory);
  const failure =
    probe === 'resolve-ref'
      ? 'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then exit 2; fi'
      : 'if [ "$1" = "symbolic-ref" ]; then exit 2; fi';
  writeFileSync(
    join(shimDirectory, 'git'),
    ['#!/bin/sh', failure, 'PATH="$DEVKIT_TEST_GIT_PATH"', 'export PATH', 'exec git "$@"', ''].join(
      '\n',
    ),
    { mode: 0o755 },
  );
  const previousDelegatePath = process.env.DEVKIT_TEST_GIT_PATH;
  process.env.DEVKIT_TEST_GIT_PATH = delegatePath;
  process.env.PATH = `${shimDirectory}:${delegatePath}`;
  try {
    return action();
  } finally {
    process.env.PATH = delegatePath;
    if (previousDelegatePath === undefined) delete process.env.DEVKIT_TEST_GIT_PATH;
    else process.env.DEVKIT_TEST_GIT_PATH = previousDelegatePath;
  }
}

function commit(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c',
    'user.name=Devkit test',
    '-c',
    'user.email=devkit@test.invalid',
    'commit',
    '-qm',
    message,
  ]);
}

/** A repository with a REAL capability install; `prefix` puts the package below the repo root. */
function installedRepository(prefix = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-base-capability-'));
  roots.push(root);
  git(root, ['init', '-q']);
  const cwd = prefix ? join(root, prefix) : root;
  mkdirSync(join(cwd, 'src'), { recursive: true });
  syncAntiSlopCapability(cwd);
  syncOxcCapability(cwd, { antiSlop: true });
  writeFileSync(join(cwd, ANTI_SLOP_BASELINE_REL), EMPTY_BASELINE);
  writeFileSync(join(cwd, 'src', 'file.ts'), CLEAN_SOURCE);
  return cwd;
}

/**
 * Managed state that is internally coherent but mismatches the RUNNING package — the sc-2084 shape.
 * Synthesized, because no older devkit is installable in-test.
 */
function ageManagedCapability(cwd: string): void {
  // Trailing whitespace: different bytes, still valid JSON, no assumption about the config shape.
  const basePath = join(cwd, OXC_BASE_REL);
  const aged = `${readFileSync(basePath, 'utf8').trimEnd()}\n\n`;
  writeFileSync(basePath, aged);
  const manifestPath = join(cwd, OXC_MANIFEST_REL);
  const manifest = readFileSync(manifestPath, 'utf8');
  writeFileSync(
    manifestPath,
    manifest.replace(/"baseDigest": "[0-9a-f]+"/u, `"baseDigest": "${digest(aged)}"`),
  );
}

function treeOf(cwd: string, ref: string): string {
  return git(cwd, ['rev-parse', `${ref}^{tree}`]);
}

function currentManagedBytes(cwd: string): Map<string, string> {
  return new Map(
    [OXC_BASE_REL, OXC_MANIFEST_REL].map((rel) => [rel, readFileSync(join(cwd, rel), 'utf8')]),
  );
}

function restore(cwd: string, bytes: Map<string, string>): void {
  for (const [rel, content] of bytes) writeFileSync(join(cwd, rel), content);
}

function writeManagedAntiSlopConfig(cwd: string, config: string): void {
  writeFileSync(join(cwd, ANTI_SLOP_CONFIG_REL), config);
  const manifestPath = join(cwd, ANTI_SLOP_MANIFEST_REL);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.configDigest = digest(config);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeDisabledExternalRecordConfig(cwd: string, currentConfig: string): void {
  const previous = JSON.parse(currentConfig);
  previous.rules['anti-slop/no-unsafe-external-record-access'] = 'off';
  previous.rules['anti-slop/no-unsafe-external-record-enumeration'] = 'off';
  writeManagedAntiSlopConfig(cwd, `${JSON.stringify(previous, null, 2)}\n`);
}

function writePublishedV059AntiSlopConfig(cwd: string, currentConfig: string): void {
  const previous = JSON.parse(currentConfig);
  previous.jsPlugins[0].specifier = './plugin/index.js';
  delete previous.rules['anti-slop/no-unsafe-external-record-access'];
  delete previous.rules['anti-slop/no-unsafe-external-record-enumeration'];
  delete previous.overrides[0].rules['anti-slop/no-unsafe-external-record-access'];
  delete previous.overrides[0].rules['anti-slop/no-unsafe-external-record-enumeration'];
  const config = `${JSON.stringify(previous, null, 2)}\n`;
  writeFileSync(join(cwd, ANTI_SLOP_CONFIG_REL), config);
  const manifestPath = join(cwd, ANTI_SLOP_MANIFEST_REL);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.devkitVersion;
  manifest.ruleIds = manifest.ruleIds.filter(
    (ruleId: string) => !EXTERNAL_RECORD_RULE_IDS.includes(ruleId),
  );
  manifest.configDigest = digest(config);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function managedMigrationReceipt(cwd: string): string {
  const manifest = JSON.parse(readFileSync(join(cwd, ANTI_SLOP_MANIFEST_REL), 'utf8'));
  return antiSlopBaselineMigrationId(manifest.devkitVersion, manifest.configDigest);
}

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('adoptManagedCapability', () => {
  it('replaces the destination managed state and leaves the rest of the tree alone', () => {
    const source = installedRepository();
    const target = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-adopt-target-'));
    roots.push(target);
    mkdirSync(join(target, '.devkit', 'oxc'), { recursive: true });
    writeFileSync(join(target, OXC_BASE_REL), '{"stale":true}\n');
    writeFileSync(join(target, 'keep.txt'), 'untouched\n');

    adoptManagedCapability(source, target);

    expect(readFileSync(join(target, OXC_BASE_REL), 'utf8')).toEqual(
      readFileSync(join(source, OXC_BASE_REL), 'utf8'),
    );
    expect(existsSync(join(target, '.devkit/anti-slop/manifest.json'))).toBe(true);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toEqual('untouched\n');
  });

  it('skips a managed directory the source never had', () => {
    const source = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-adopt-empty-'));
    const target = installedRepository();
    roots.push(source);
    const before = readFileSync(join(target, OXC_BASE_REL), 'utf8');

    expect(() => adoptManagedCapability(source, target)).not.toThrow();
    expect(readFileSync(join(target, OXC_BASE_REL), 'utf8')).toEqual(before);
  });
});

describe('staged anti-slop check across a capability upgrade', () => {
  it('lets unscoped create --force replace an invalid baseline', () => {
    const cwd = installedRepository();
    writeFileSync(join(cwd, ANTI_SLOP_BASELINE_REL), '{}\n');

    const status = antiSlop(['create', '--force'], cwd);

    expect(status).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, ANTI_SLOP_BASELINE_REL), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      upstreamCommit: ANTI_SLOP_UPSTREAM,
    });
  });

  it('accepts baseline entries only for rules newly activated by the managed capability', () => {
    const cwd = installedRepository();
    const configPath = join(cwd, ANTI_SLOP_CONFIG_REL);
    const currentConfig = readFileSync(configPath, 'utf8');
    const manifestPath = join(cwd, ANTI_SLOP_MANIFEST_REL);
    const currentManifest = readFileSync(manifestPath, 'utf8');
    writePublishedV059AntiSlopConfig(cwd, currentConfig);
    commit(cwd, 'base before the external-record access rule was enabled');

    writeFileSync(configPath, currentConfig);
    writeFileSync(manifestPath, currentManifest);
    writeFileSync(
      join(cwd, 'src', 'file.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"];\n',
    );
    const adopted = baselineFromGroups(collectAntiSlopGroups(cwd, []));
    adopted.migrationReceipts = [managedMigrationReceipt(cwd)];
    writeBaseline(cwd, adopted);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    expect(out.join('\n')).toContain(
      'accepted 1 baseline finding(s) for newly activated rule(s): anti-slop/no-unsafe-external-record-access',
    );
    expect(err.join('\n')).not.toContain('BASELINE-GROWTH');
    expect(status).toBe(0);
  });

  it('does not forgive omitted debt from a newly activated rule as inherited base debt', () => {
    const cwd = installedRepository();
    const configPath = join(cwd, ANTI_SLOP_CONFIG_REL);
    const currentConfig = readFileSync(configPath, 'utf8');
    const manifestPath = join(cwd, ANTI_SLOP_MANIFEST_REL);
    const currentManifest = readFileSync(manifestPath, 'utf8');
    writePublishedV059AntiSlopConfig(cwd, currentConfig);
    writeFileSync(
      join(cwd, 'src', 'file.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"];\n',
    );
    commit(cwd, 'published base carrying debt for a not-yet-present rule');

    writeFileSync(configPath, currentConfig);
    writeFileSync(manifestPath, currentManifest);
    const receiptOnly = baselineFromGroups([]);
    receiptOnly.migrationReceipts = [managedMigrationReceipt(cwd)];
    writeBaseline(cwd, receiptOnly);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    expect(out.join('\n')).toContain(
      'ERROR anti-slop/no-unsafe-external-record-access src/file.ts',
    );
    expect(out.join('\n')).not.toContain(
      'base allowance forgave 1 inherited finding(s) across 1 rule(s): anti-slop/no-unsafe-external-record-access',
    );
    expect(status).toBe(1);
  });

  it('rejects omitted activation debt outside a scoped --base report', () => {
    const cwd = installedRepository();
    const configPath = join(cwd, ANTI_SLOP_CONFIG_REL);
    const currentConfig = readFileSync(configPath, 'utf8');
    const manifestPath = join(cwd, ANTI_SLOP_MANIFEST_REL);
    const currentManifest = readFileSync(manifestPath, 'utf8');
    writePublishedV059AntiSlopConfig(cwd, currentConfig);
    writeFileSync(
      join(cwd, 'src', 'unscoped.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"];\n',
    );
    writeFileSync(join(cwd, 'src', 'changed.ts'), CLEAN_SOURCE);
    commit(cwd, 'published base carrying unscoped debt for a not-yet-present rule');

    writeFileSync(configPath, currentConfig);
    writeFileSync(manifestPath, currentManifest);
    const receiptOnly = baselineFromGroups([]);
    receiptOnly.migrationReceipts = [managedMigrationReceipt(cwd)];
    writeBaseline(cwd, receiptOnly);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--base', 'HEAD', '--', 'src/changed.ts'], cwd);

    expect(out.join('\n')).toContain(
      'ERROR anti-slop/no-unsafe-external-record-access src/unscoped.ts',
    );
    expect(err.join('\n')).toContain(
      'newly activated error finding(s) must be fixed or recorded in the release baseline',
    );
    expect(status).toBe(1);
  });

  it('offers rename adoption before judging newly activated debt at its new path', () => {
    const cwd = installedRepository();
    const configPath = join(cwd, ANTI_SLOP_CONFIG_REL);
    const currentConfig = readFileSync(configPath, 'utf8');
    const manifestPath = join(cwd, ANTI_SLOP_MANIFEST_REL);
    const currentManifest = readFileSync(manifestPath, 'utf8');
    writePublishedV059AntiSlopConfig(cwd, currentConfig);
    writeFileSync(
      join(cwd, 'src', 'file.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"];\n',
    );
    commit(cwd, 'published base carrying debt at its original path');

    writeFileSync(configPath, currentConfig);
    writeFileSync(manifestPath, currentManifest);
    const adopted = baselineFromGroups(collectAntiSlopGroups(cwd, []));
    adopted.migrationReceipts = [managedMigrationReceipt(cwd)];
    writeBaseline(cwd, adopted);
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(err.join('\n')).toContain(
      'BASELINE-RENAME anti-slop/no-unsafe-external-record-access src/file.ts -> src/moved.ts',
    );
    expect(err.join('\n')).not.toContain(
      'newly activated error finding(s) must be fixed or recorded in the release baseline',
    );

    expect(antiSlop(['adopt-renames'], cwd)).toBe(0);
    git(cwd, ['add', ANTI_SLOP_BASELINE_REL]);
    out = [];
    err = [];
    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
  });

  it('validates full migration evidence while reporting a scoped --base check', () => {
    const cwd = installedRepository();
    const configPath = join(cwd, ANTI_SLOP_CONFIG_REL);
    const currentConfig = readFileSync(configPath, 'utf8');
    writeDisabledExternalRecordConfig(cwd, currentConfig);
    writeFileSync(
      join(cwd, 'src', 'unscoped.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"];\n',
    );
    writeFileSync(join(cwd, 'src', 'changed.ts'), CLEAN_SOURCE);
    commit(cwd, 'base before a scoped external-record activation check');

    writeManagedAntiSlopConfig(cwd, currentConfig);
    const adopted = baselineFromGroups(collectAntiSlopGroups(cwd, []));
    adopted.migrationReceipts = [managedMigrationReceipt(cwd)];
    writeBaseline(cwd, adopted);
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--base', 'HEAD', '--', 'src/changed.ts'], cwd)).toBe(0);
    expect(out.join('\n')).toContain(
      'accepted 1 baseline finding(s) for newly activated rule(s): anti-slop/no-unsafe-external-record-access',
    );
    expect(err.join('\n')).not.toContain('BASELINE-GROWTH');

    out = [];
    err = [];
    writeFileSync(join(cwd, 'src', 'unscoped.ts'), CLEAN_SOURCE);
    git(cwd, ['add', 'src/unscoped.ts']);

    expect(antiSlop(['check', '--base', 'HEAD', '--', 'src/changed.ts'], cwd)).toBe(1);
    expect(err.join('\n')).toContain(
      'BASELINE-GROWTH anti-slop/no-unsafe-external-record-access src/unscoped.ts',
    );
  });

  it('rejects newly activated baseline debt that is absent from the candidate scan', () => {
    const cwd = installedRepository();
    const configPath = join(cwd, ANTI_SLOP_CONFIG_REL);
    const currentConfig = readFileSync(configPath, 'utf8');
    writeDisabledExternalRecordConfig(cwd, currentConfig);
    commit(cwd, 'base before the external-record access rule was enabled');

    writeManagedAntiSlopConfig(cwd, currentConfig);
    writeFileSync(
      join(cwd, 'src', 'file.ts'),
      'const parsed = JSON.parse(raw); parsed["constructor"];\n',
    );
    const fabricated = baselineFromGroups(collectAntiSlopGroups(cwd, []));
    fabricated.migrationReceipts = [managedMigrationReceipt(cwd)];
    writeBaseline(cwd, fabricated);
    writeFileSync(join(cwd, 'src', 'file.ts'), CLEAN_SOURCE);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    expect(err.join('\n')).toContain(
      'BASELINE-GROWTH anti-slop/no-unsafe-external-record-access src/file.ts',
    );
    expect(status).toBe(1);
  });

  it('requires a release-bound receipt for a zero-finding rule activation', () => {
    const cwd = installedRepository();
    const configPath = join(cwd, ANTI_SLOP_CONFIG_REL);
    const currentConfig = readFileSync(configPath, 'utf8');
    writeDisabledExternalRecordConfig(cwd, currentConfig);
    commit(cwd, 'base before a zero-debt activation');

    writeManagedAntiSlopConfig(cwd, currentConfig);
    git(cwd, ['add', '-A']);

    const missing = antiSlop(['check', '--staged'], cwd);
    expect(err.join('\n')).toContain('BASELINE-MIGRATION-RECEIPT');
    expect(missing).toBe(1);

    const baseline = baselineFromGroups([]);
    baseline.migrationReceipts = [managedMigrationReceipt(cwd)];
    writeBaseline(cwd, baseline);
    git(cwd, ['add', '-A']);
    err = [];

    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
  });

  it('rejects a receipt staged before the managed config that issued it', () => {
    const cwd = installedRepository();
    const targetReceipt = managedMigrationReceipt(cwd);
    const configPath = join(cwd, ANTI_SLOP_CONFIG_REL);
    writeDisabledExternalRecordConfig(cwd, readFileSync(configPath, 'utf8'));
    commit(cwd, 'base before the managed activation');

    const premature = baselineFromGroups([]);
    premature.migrationReceipts = [targetReceipt];
    writeBaseline(cwd, premature);
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(err.join('\n')).toContain(`${targetReceipt} does not match candidate capability`);
  });

  it('accepts receipt recovery when the matching managed config is already active', () => {
    const cwd = installedRepository();
    const receipt = managedMigrationReceipt(cwd);
    commit(cwd, 'base with active managed config but no receipt');
    const recovered = baselineFromGroups([]);
    recovered.migrationReceipts = [receipt];
    writeBaseline(cwd, recovered);
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
  });

  it('rejects removal of a completed rule-migration receipt', () => {
    const cwd = installedRepository();
    writeBaseline(cwd, {
      ...baselineFromGroups([]),
      migrationReceipts: ['migration-access'],
    });
    commit(cwd, 'base with a completed zero-debt migration');

    writeBaseline(cwd, baselineFromGroups([]));
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    expect(err.join('\n')).toContain('BASELINE-MIGRATION-RECEIPT migration-access removed');
    expect(status).toBe(1);
  });

  it('reports the new finding instead of a stale managed-state error', () => {
    const cwd = installedRepository();
    const current = currentManagedBytes(cwd);
    ageManagedCapability(cwd);
    commit(cwd, 'base with older managed capability');

    restore(cwd, current);
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    const output = [...out, ...err].join('\n');
    expect(output).not.toContain('digest is stale');
    expect(output).not.toContain('not fully integrated');
    expect(output).toContain('ERROR anti-slop/no-object-parameters src/file.ts');
    expect(status).toBe(1);
  });

  it('reports the new finding on the CI --base path too', () => {
    const cwd = installedRepository();
    const current = currentManagedBytes(cwd);
    ageManagedCapability(cwd);
    commit(cwd, 'base with older managed capability');
    const base = git(cwd, ['rev-parse', 'HEAD']);

    restore(cwd, current);
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--base', base], cwd);

    const output = [...out, ...err].join('\n');
    expect(output).not.toContain('digest is stale');
    expect(output).toContain('ERROR anti-slop/no-object-parameters src/file.ts');
    expect(status).toBe(1);
  });

  it('names the skip and still reports the finding when the base tree stays unjudgeable', () => {
    const cwd = installedRepository();
    const config = readFileSync(join(cwd, '.oxlintrc.json'), 'utf8');
    // A base whose consumer config never loaded the managed base: adopting managed bytes cannot
    // repair it, because the failure is in tree state the capability does not own.
    writeFileSync(join(cwd, '.oxlintrc.json'), '{}\n');
    commit(cwd, 'base whose consumer config does not load the managed base');

    writeFileSync(join(cwd, '.oxlintrc.json'), config);
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    expect(err.join('\n')).toContain('inherited base allowance skipped');
    expect(out.join('\n')).toContain('ERROR anti-slop/no-object-parameters src/file.ts');
    expect(status).toBe(1);
  });

  it('leaves an ordinary clean commit untouched — no skip note, no forgiveness advisory', () => {
    const cwd = installedRepository();
    commit(cwd, 'base');
    writeFileSync(join(cwd, 'src', 'file.ts'), 'export const value = "candidate";\n');
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    const output = [...out, ...err].join('\n');
    expect(output).not.toContain('inherited base allowance skipped');
    expect(output).not.toContain('base allowance forgave');
    expect(status).toBe(0);
  });

  it('names how many inherited findings the base allowance forgave', () => {
    const cwd = installedRepository();
    // Debt that exists at BASE and is absent from the committed baseline: the allowance forgives it,
    // and that forgiveness has to be visible rather than silent.
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    commit(cwd, 'base carrying an unbaselined finding');

    writeFileSync(join(cwd, 'src', 'file.ts'), `${FINDING_SOURCE}\nexport const extra = 1;\n`);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    expect(out.join('\n')).toContain(
      'anti-slop: base allowance forgave 1 inherited finding(s) across 1 rule(s): anti-slop/no-object-parameters',
    );
    expect(status).toBe(0);
  });
});

describe('anti-slop rename adoption', () => {
  it('requires explicit confirmation before an unscoped resnapshot removes existing-file debt', () => {
    const cwd = installedRepository();
    const path = join(cwd, ANTI_SLOP_BASELINE_REL);
    rmSync(path);
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    expect(antiSlop(['create'], cwd)).toBe(0);
    const before = readFileSync(path, 'utf8');
    writeFileSync(join(cwd, 'src', 'file.ts'), CLEAN_SOURCE);

    expect(antiSlop(['create', '--force'], cwd)).toBe(2);
    expect(err.join('\n')).toContain('--confirm-baseline-removals');
    expect(readFileSync(path, 'utf8')).toBe(before);

    expect(antiSlop(['create', '--force', '.'], cwd)).toBe(2);
    expect(readFileSync(path, 'utf8')).toBe(before);

    expect(antiSlop(['create', '--force', '--confirm-baseline-removals', '.'], cwd)).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8')).entries).toEqual([]);

    writeFileSync(path, '{ stale baseline');
    expect(antiSlop(['create', '--force'], cwd)).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8')).entries).toEqual([]);
  });

  it('refuses to write a rename migration from a changed Git index', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { candidateTree, headOid, headRef } = gitBaselineEnvelope(cwd, 'HEAD');
    git(cwd, ['mv', 'src/moved.ts', 'src/other.ts']);
    let wrote = false;

    expect(() =>
      withStableGitIndex(cwd, { oid: headOid, symbolicRef: headRef }, null, candidateTree, () => {
        wrote = true;
      }),
    ).toThrow('Git index changed while staged renames were being read');
    expect(wrote).toBe(false);
  });

  it('refuses to write a rename migration after HEAD advances over the same index tree', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { candidateTree, headOid, headRef } = gitBaselineEnvelope(cwd, 'HEAD');
    const parent = git(cwd, ['rev-parse', 'HEAD']);
    const tree = git(cwd, ['rev-parse', 'HEAD^{tree}']);
    const next = git(cwd, [
      '-c',
      'user.name=Devkit test',
      '-c',
      'user.email=devkit@test.invalid',
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      'same-tree HEAD advance',
    ]);
    git(cwd, ['update-ref', 'HEAD', next, parent]);
    let wrote = false;

    expect(() =>
      withStableGitIndex(cwd, { oid: headOid, symbolicRef: headRef }, null, candidateTree, () => {
        wrote = true;
      }),
    ).toThrow('Git HEAD changed while staged renames were being read');
    expect(wrote).toBe(false);
  });

  it('distinguishes a missing Git ref from an operational resolution failure', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');

    expect(resolveRef(cwd, 'refs/heads/absent')).toBeNull();
    expect(() => withFailingGitProbe('resolve-ref', () => resolveRef(cwd, 'HEAD'))).toThrow(
      'could not resolve Git ref HEAD safely',
    );
  });

  it('fails closed when symbolic HEAD verification errors during a same-OID ref transition', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    const branch = git(cwd, ['symbolic-ref', 'HEAD']);
    git(cwd, ['checkout', '--detach', '-q']);
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { candidateTree, headOid, headRef } = gitBaselineEnvelope(cwd, 'HEAD');
    expect(headRef).toBeNull();
    git(cwd, ['symbolic-ref', 'HEAD', branch]);
    let wrote = false;

    expect(() =>
      withFailingGitProbe('symbolic-head', () =>
        withStableGitIndex(cwd, { oid: headOid, symbolicRef: headRef }, null, candidateTree, () => {
          wrote = true;
        }),
      ),
    ).toThrow('could not determine symbolic Git HEAD safely');
    expect(wrote).toBe(false);
  });

  it('refuses to write after HEAD switches to a same-tree branch', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { candidateTree, headOid, headRef } = gitBaselineEnvelope(cwd, 'HEAD');
    git(cwd, ['branch', 'same-tree-peer']);
    git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/same-tree-peer']);
    let wrote = false;

    expect(() =>
      withStableGitIndex(cwd, { oid: headOid, symbolicRef: headRef }, null, candidateTree, () => {
        wrote = true;
      }),
    ).toThrow('Git HEAD changed while staged renames were being read');
    expect(wrote).toBe(false);
  });

  it('refuses to write after a direct base ref advances', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    git(cwd, ['branch', 'comparison-base']);
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { baseOid, baseRefName, candidateTree, headOid, headRef } = gitBaselineEnvelope(
      cwd,
      'comparison-base',
    );
    const tree = git(cwd, ['rev-parse', 'comparison-base^{tree}']);
    const next = git(cwd, [
      '-c',
      'user.name=Devkit test',
      '-c',
      'user.email=devkit@test.invalid',
      'commit-tree',
      tree,
      '-p',
      'comparison-base',
      '-m',
      'advance comparison base',
    ]);
    git(cwd, ['update-ref', 'refs/heads/comparison-base', next, baseOid ?? '']);
    let wrote = false;

    expect(() =>
      withStableGitIndex(
        cwd,
        { oid: headOid, symbolicRef: headRef },
        { expression: 'comparison-base', oid: baseOid, symbolicRef: baseRefName },
        candidateTree,
        () => {
          wrote = true;
        },
      ),
    ).toThrow('Git base changed while rename evidence was being read');
    expect(wrote).toBe(false);
  });

  it('never reaps an unrecognized Git lock while retrying', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { candidateTree, headOid, headRef } = gitBaselineEnvelope(cwd, 'HEAD');
    const indexLock = `${git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])}.lock`;
    const foreign = '999999:------------------------------------';
    writeFileSync(indexLock, foreign);

    expect(() =>
      withStableGitIndex(cwd, { oid: headOid, symbolicRef: headRef }, null, candidateTree, () => 0),
    ).toThrow(`Git lock is busy at ${indexLock}`);
    expect(readFileSync(indexLock, 'utf8')).toBe(foreign);
  });

  it('does not delete a replacement Git lock that appears during release', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { candidateTree, headOid, headRef } = gitBaselineEnvelope(cwd, 'HEAD');
    const indexLock = `${git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])}.lock`;
    const foreign = 'foreign-owner';
    const releaseOperations: GitLockReleaseOperations = {
      removeToken: (path) => rmSync(path, { force: true }),
      removeDirectory: (path) => {
        if (path !== indexLock) {
          rmdirSync(path);
          return;
        }
        rmdirSync(path);
        writeFileSync(path, foreign);
        rmdirSync(path);
      },
    };

    withStableGitIndex(
      cwd,
      { oid: headOid, symbolicRef: headRef },
      null,
      candidateTree,
      () => undefined,
      releaseOperations,
    );

    expect(readFileSync(indexLock, 'utf8')).toBe(foreign);
  });

  it('retries a transient Git lock release without losing ownership', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { candidateTree, headOid, headRef } = gitBaselineEnvelope(cwd, 'HEAD');
    const indexLock = `${git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])}.lock`;
    let failedOnce = false;
    const releaseOperations: GitLockReleaseOperations = {
      removeToken: (path) => rmSync(path, { force: true }),
      removeDirectory: (path) => {
        if (path === indexLock && !failedOnce) {
          failedOnce = true;
          throw Object.assign(new Error('transient Git lock release'), { code: 'EBUSY' });
        }
        rmdirSync(path);
      },
    };

    expect(() =>
      withStableGitIndex(
        cwd,
        { oid: headOid, symbolicRef: headRef },
        null,
        candidateTree,
        () => undefined,
        releaseOperations,
      ),
    ).not.toThrow();
    expect(failedOnce).toBe(true);
    expect(existsSync(indexLock)).toBe(false);
  });

  it('restores signal handling when Git lock release retries are exhausted', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { candidateTree, headOid, headRef } = gitBaselineEnvelope(cwd, 'HEAD');
    const indexLock = `${git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])}.lock`;
    const exitListenersBefore = new Set(process.listeners('exit'));
    const sigintListenersBefore = process.listenerCount('SIGINT');
    const sigtermListenersBefore = process.listenerCount('SIGTERM');
    let releaseBlocked = true;
    const releaseOperations: GitLockReleaseOperations = {
      removeToken: (path) => rmSync(path, { force: true }),
      removeDirectory: (path) => {
        if (path === indexLock && releaseBlocked) {
          throw Object.assign(new Error('persistent Git lock release failure'), { code: 'EBUSY' });
        }
        rmdirSync(path);
      },
    };

    expect(() =>
      withStableGitIndex(
        cwd,
        { oid: headOid, symbolicRef: headRef },
        null,
        candidateTree,
        () => undefined,
        releaseOperations,
      ),
    ).toThrow('persistent Git lock release failure');
    expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListenersBefore);
    expect(existsSync(indexLock)).toBe(true);

    const retainedExitListeners = process
      .listeners('exit')
      .filter((listener) => !exitListenersBefore.has(listener));
    expect(retainedExitListeners).toHaveLength(1);
    releaseBlocked = false;
    for (const listener of retainedExitListeners) {
      listener(0);
      process.removeListener('exit', listener);
    }
    expect(existsSync(indexLock)).toBe(false);
    expect(process.listeners('exit')).toEqual([...exitListenersBefore]);
  });

  it('keeps Git locks held when another signal listener lets the protected action resume', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { candidateTree, headOid, headRef } = gitBaselineEnvelope(cwd, 'HEAD');
    const indexLock = `${git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])}.lock`;
    const peerListener = vi.fn();
    process.once('SIGINT', peerListener);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const nativeRemoveListener = process.removeListener.bind(process);
    let removedSignalHandlerWhileLocked = false;
    vi.spyOn(process, 'removeListener').mockImplementation((event, listener) => {
      if (
        (event === 'SIGINT' || event === 'SIGTERM') &&
        peerListener.mock.calls.length > 0 &&
        existsSync(indexLock)
      ) {
        removedSignalHandlerWhileLocked = true;
      }
      return nativeRemoveListener(event, listener);
    });

    try {
      expect(
        withStableGitIndex(cwd, { oid: headOid, symbolicRef: headRef }, null, candidateTree, () => {
          process.emit('SIGINT');
          return existsSync(indexLock);
        }),
      ).toBe(true);
      expect(peerListener).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
      expect(removedSignalHandlerWhileLocked).toBe(false);
      expect(existsSync(indexLock)).toBe(false);
    } finally {
      process.removeListener('SIGINT', peerListener);
    }
  });

  it('releases Git locks before re-raising a terminating signal', () => {
    const cwd = installedRepository();
    commit(cwd, 'establish base');
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    const { candidateTree, headOid, headRef } = gitBaselineEnvelope(cwd, 'HEAD');
    const indexLock = `${git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])}.lock`;
    const moduleUrl = new URL('./git-index-lock.mts', import.meta.url).href;
    const script = [
      `import { withStableGitIndex } from ${JSON.stringify(moduleUrl)};`,
      `withStableGitIndex(${JSON.stringify(cwd)}, ${JSON.stringify({ oid: headOid, symbolicRef: headRef })}, null, ${JSON.stringify(candidateTree)}, () => {`,
      `  process.emit('SIGINT');`,
      `});`,
    ].join('\n');

    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
    });

    expect(child.signal, child.stderr).toBe('SIGINT');
    expect(existsSync(indexLock)).toBe(false);
  });

  it('migrates only package-relative staged renames and leaves a no-op baseline untouched', () => {
    const cwd = installedRepository('packages/app');
    rmSync(join(cwd, ANTI_SLOP_BASELINE_REL));
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    writeFileSync(join(cwd, 'src', 'unrelated.ts'), FINDING_SOURCE);
    expect(antiSlop(['create'], cwd)).toBe(0);
    commit(cwd, 'adopt package debt');
    // SAFETY: antiSlop create writes the validated baseline schema before this parse.
    const before = JSON.parse(readFileSync(join(cwd, ANTI_SLOP_BASELINE_REL), 'utf8')) as {
      entries: Array<{ file: string; count: number }>;
    };
    const unrelated = before.entries.filter((entry) => entry.file === 'src/unrelated.ts');

    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    writeFileSync(join(cwd, 'src', 'unrelated.ts'), CLEAN_SOURCE);

    expect(antiSlop(['adopt-renames'], cwd)).toBe(0);
    // SAFETY: adopt-renames preserves the validated baseline schema while migrating paths.
    const adopted = JSON.parse(readFileSync(join(cwd, ANTI_SLOP_BASELINE_REL), 'utf8')) as {
      entries: Array<{ file: string; count: number }>;
    };
    expect(adopted.entries.filter((entry) => entry.file === 'src/unrelated.ts')).toEqual(unrelated);
    expect(adopted.entries.some((entry) => entry.file === 'src/file.ts')).toBe(false);
    expect(adopted.entries.some((entry) => entry.file === 'src/moved.ts')).toBe(true);
    expect(adopted.entries.reduce((sum, entry) => sum + entry.count, 0)).toBe(
      before.entries.reduce((sum, entry) => sum + entry.count, 0),
    );

    const path = join(cwd, ANTI_SLOP_BASELINE_REL);
    const historical = new Date('2001-01-01T00:00:00.000Z');
    utimesSync(path, historical, historical);
    const mtimeMs = statSync(path).mtimeMs;
    expect(antiSlop(['adopt-renames'], cwd)).toBe(0);
    expect(statSync(path).mtimeMs).toBe(mtimeMs);
    expect(out.join('\n')).toContain('0 finding(s) across 0 staged rename(s)');
  });

  it('adopts debt across a committed rename using the same base as the CI check', () => {
    const cwd = installedRepository();
    const path = join(cwd, ANTI_SLOP_BASELINE_REL);
    rmSync(path);
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    expect(antiSlop(['create'], cwd)).toBe(0);
    commit(cwd, 'commit debt baseline');
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    commit(cwd, 'commit debt-bearing rename');
    git(cwd, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    expect(antiSlop(['check', '--base', 'HEAD~1'], cwd)).toBe(1);
    expect(err.join('\n')).toContain(`adopt-renames --base ${git(cwd, ['rev-parse', 'HEAD~1'])}`);
    expect(antiSlop(['adopt-renames', '--base', 'origin/main~1'], cwd)).toBe(2);
    expect(err.join('\n')).toContain('--base cannot be locked');
    expect(antiSlop(['adopt-renames', '--base', 'HEAD~1'], cwd)).toBe(0);
    // SAFETY: adopt-renames preserves the validated baseline schema while migrating paths.
    const adopted = JSON.parse(readFileSync(path, 'utf8')) as {
      entries: Array<{ file: string }>;
    };
    expect(adopted.entries.some((entry) => entry.file === 'src/file.ts')).toBe(false);
    expect(adopted.entries.some((entry) => entry.file === 'src/moved.ts')).toBe(true);
    git(cwd, ['add', ANTI_SLOP_BASELINE_REL]);
    expect(antiSlop(['check', '--base', 'HEAD~1'], cwd)).toBe(0);

    expect(antiSlop(['adopt-renames', '--base', 'HEAD'], cwd)).toBe(2);
    expect(err.join('\n')).toContain('no Git renames');
  });

  it('rejects arguments before it can rewrite the baseline', () => {
    const cwd = installedRepository();
    const path = join(cwd, ANTI_SLOP_BASELINE_REL);
    const before = readFileSync(path, 'utf8');

    expect(antiSlop(['adopt-renames', 'src'], cwd)).toBe(2);

    expect(err.join('\n')).toContain('adopt-renames accepts no flags or paths');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('inherited base snapshot edge cases', () => {
  it('adopts the STAGED capability, not whatever the working tree happens to hold', () => {
    const cwd = installedRepository();
    const current = currentManagedBytes(cwd);
    // Debt that exists at BASE: forgiving it proves the base tree was linted at all.
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    ageManagedCapability(cwd);
    commit(cwd, 'base with older managed capability and existing debt');

    restore(cwd, current);
    writeFileSync(join(cwd, 'src', 'file.ts'), `${FINDING_SOURCE}export const extra = 1;\n`);
    git(cwd, ['add', '-A']);
    // Only AFTER staging: a working tree whose managed bytes no longer match their manifest. The
    // index is the contract for `--staged`, so reading this would be reading the wrong tree.
    writeFileSync(join(cwd, ANTI_SLOP_CONFIG_REL), '{"corrupted":true}\n');

    const status = antiSlop(['check', '--staged'], cwd);

    expect(err.join('\n')).not.toContain('inherited base allowance skipped');
    expect(out.join('\n')).toContain('base allowance forgave 1 inherited finding(s)');
    expect(status).toBe(0);
  });

  it('resolves the snapshot package directory when the package sits below the repository root', () => {
    const cwd = installedRepository('packages/app');
    const current = currentManagedBytes(cwd);
    ageManagedCapability(cwd);
    commit(cwd, 'base with older managed capability');

    restore(cwd, current);
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    const output = [...out, ...err].join('\n');
    expect(output).not.toContain('digest is stale');
    expect(output).not.toContain('inherited base allowance skipped');
    expect(output).toContain('ERROR anti-slop/no-object-parameters src/file.ts');
    expect(status).toBe(1);
  });

  it('follows a rename into the base tree instead of blaming the move for inherited debt', () => {
    const cwd = installedRepository();
    const current = currentManagedBytes(cwd);
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    ageManagedCapability(cwd);
    commit(cwd, 'base carrying debt at its original path');

    restore(cwd, current);
    git(cwd, ['mv', 'src/file.ts', 'src/moved.ts']);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    const output = [...out, ...err].join('\n');
    expect(output).not.toContain('ERROR anti-slop/no-object-parameters');
    expect(output).not.toContain('inherited base allowance skipped');
    expect(status).toBe(0);
  });

  it('judges a base tree that never tracked managed state, rather than crashing on it', () => {
    const cwd = installedRepository();
    writeFileSync(join(cwd, '.gitignore'), '.devkit/\n');
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    // The commit that ADOPTS tracked managed state: at base `.devkit` is ignored and therefore
    // absent from the tree, so the base snapshot has a baseline and a config but no capability.
    commit(cwd, 'base with managed state untracked');

    writeFileSync(join(cwd, '.gitignore'), '');
    writeFileSync(join(cwd, 'src', 'file.ts'), `${FINDING_SOURCE}export const extra = 1;\n`);
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    const output = [...out, ...err].join('\n');
    expect(output).not.toContain('anti-slop is not installed');
    expect(output).toContain('base allowance forgave 1 inherited finding(s)');
    expect(status).toBe(0);
  });

  it('counts partially forgiven debt by its delta and names every rule involved', () => {
    const cwd = installedRepository();
    writeFileSync(join(cwd, 'src', 'file.ts'), REPEATED_FINDING_SOURCE);
    writeFileSync(join(cwd, 'src', 'dict.ts'), DICTIONARY_FINDING_SOURCE);
    commit(cwd, 'base carrying two repeated findings and one dictionary finding');

    // A THIRD copy of the repeated finding: two of the three are inherited, one is genuinely new.
    writeFileSync(join(cwd, 'src', 'file.ts'), `${REPEATED_FINDING_SOURCE}${THIRD_FINDING_SOURCE}`);
    // Touched so the dictionary finding is in scope too; its single occurrence is fully inherited.
    writeFileSync(
      join(cwd, 'src', 'dict.ts'),
      `${DICTIONARY_FINDING_SOURCE}export const tag = 1;\n`,
    );
    git(cwd, ['add', '-A']);

    const status = antiSlop(['check', '--staged'], cwd);

    expect(out.join('\n')).toContain(
      'base allowance forgave 3 inherited finding(s) across 2 rule(s): anti-slop/no-object-parameters, anti-slop/no-unsafe-dictionary-type',
    );
    expect(out.join('\n')).toContain('ERROR anti-slop/no-object-parameters src/file.ts');
    expect(status).toBe(1);
  });
});

describe('capability pinning against a concurrent sync', () => {
  it('pins the exact capability a lint used, so a later step cannot judge a different one', () => {
    const cwd = installedRepository();
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    const pin = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-pin-'));
    roots.push(pin);

    const groups = collectAntiSlopGroups(cwd, [], pin);

    expect(groups.map((group) => group.ruleId)).toContain('anti-slop/no-object-parameters');
    expect(readFileSync(join(pin, OXC_BASE_REL), 'utf8')).toEqual(
      readFileSync(join(cwd, OXC_BASE_REL), 'utf8'),
    );
    // A sync landing after the lint must not reach the pin — that is the whole point of taking it
    // inside the lint's own lock.
    ageManagedCapability(cwd);
    expect(readFileSync(join(pin, OXC_BASE_REL), 'utf8')).not.toEqual(
      readFileSync(join(cwd, OXC_BASE_REL), 'utf8'),
    );
  });

  it("judges the base tree with the pinned capability rather than the repository's current one", () => {
    const cwd = installedRepository();
    const pin = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-pin-'));
    roots.push(pin);
    adoptManagedCapability(cwd, pin);
    writeFileSync(join(cwd, 'src', 'file.ts'), FINDING_SOURCE);
    commit(cwd, 'base carrying a finding');
    const base = git(cwd, ['rev-parse', 'HEAD']);
    // The repository capability is now unusable; only the pin can still judge the base tree.
    writeFileSync(join(cwd, ANTI_SLOP_CONFIG_REL), '{"corrupted":true}\n');

    const baseGroups = withBaseAntiSlopSnapshot(cwd, pin, treeOf(cwd, base), ['src/file.ts'], (s) =>
      collectAntiSlopGroups(s.cwd, s.paths),
    );

    expect(baseGroups.map((group) => group.ruleId)).toEqual(['anti-slop/no-object-parameters']);
  });
});

describe('managed capability locking', () => {
  it('waits on the Oxc lock too, so an Oxc-only writer cannot republish mid-run', () => {
    const cwd = installedRepository();
    // A live holder of the OXC lock alone. If the collector took only the anti-slop lock it would
    // sail past this and lint against state that writer is free to replace.
    const oxcLock = join(cwd, '.devkit', 'oxc.lock');
    mkdirSync(oxcLock, { recursive: true });
    writeFileSync(join(oxcLock, 'holder'), `${process.pid}:held-by-test`);

    expect(() => collectAntiSlopGroups(cwd, [])).toThrow(/timed out acquiring manifest lock/u);
  });
});
