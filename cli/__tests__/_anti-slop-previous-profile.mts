/** Rewrite a synced managed anti-slop capability into the shape an earlier Devkit release emitted. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../lib/fs-helpers.mts';
import {
  ANTI_SLOP_CONFIG_REL,
  ANTI_SLOP_MANIFEST_REL,
  ANTI_SLOP_UPSTREAM_RULE_IDS,
  ANTI_SLOP_V060_RULE_IDS,
} from '../lib/install/anti-slop/constants.mts';

interface ManagedRules {
  rules: { [ruleId: string]: string };
}

interface ManagedConfig extends ManagedRules {
  jsPlugins: Array<{ specifier: string }>;
  overrides: ManagedRules[];
}

/** Write managed config bytes; the manifest's digest and rule surface follow the config. */
export function writeManagedAntiSlopConfig(cwd: string, config: string): void {
  writeFileSync(join(cwd, ANTI_SLOP_CONFIG_REL), config);
  // SAFETY: the object check below proves the only consumed field before it is enumerated.
  const rules = (JSON.parse(config) as ManagedRules).rules;
  if (Object(rules) !== rules || Array.isArray(rules))
    throw new Error('managed config lacks rules');
  const ruleIds = Object.keys(rules);
  const manifestPath = join(cwd, ANTI_SLOP_MANIFEST_REL);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.ruleIds = ruleIds;
  manifest.configDigest = digest(config);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function keepRules(managed: ManagedRules, kept: readonly string[]): void {
  managed.rules = Object.fromEntries(
    Object.entries(managed.rules).filter(([ruleId]) => kept.includes(ruleId)),
  );
}

function previousConfig(currentConfig: string, kept: readonly string[]): ManagedConfig {
  // SAFETY: callers pass the bytes the managed sync just wrote, which always carry these fields.
  const previous = JSON.parse(currentConfig) as ManagedConfig;
  keepRules(previous, kept);
  for (const override of previous.overrides) keepRules(override, kept);
  return previous;
}

/** The 17-rule surface of v0.60.0 onward, optionally with both external-record rules still off. */
export function writeV060AntiSlopConfig(
  cwd: string,
  currentConfig: string,
  externalRecordsOff: boolean,
): void {
  const previous = previousConfig(currentConfig, ANTI_SLOP_V060_RULE_IDS);
  if (externalRecordsOff) {
    previous.rules['anti-slop/no-unsafe-external-record-access'] = 'off';
    previous.rules['anti-slop/no-unsafe-external-record-enumeration'] = 'off';
  }
  writeManagedAntiSlopConfig(cwd, `${JSON.stringify(previous, null, 2)}\n`);
}

/** The published v0.59.0 capability: upstream rules only, a `.js` entry, no recorded version. */
export function writePublishedV059AntiSlopConfig(cwd: string, currentConfig: string): void {
  const previous = previousConfig(currentConfig, ANTI_SLOP_UPSTREAM_RULE_IDS);
  previous.jsPlugins[0]!.specifier = './plugin/index.js';
  writeManagedAntiSlopConfig(cwd, `${JSON.stringify(previous, null, 2)}\n`);
  const manifestPath = join(cwd, ANTI_SLOP_MANIFEST_REL);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.devkitVersion;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
