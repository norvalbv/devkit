/** Pinned upstream identity and the complete Devkit-managed anti-slop rule surface. */

import { digest } from '../../fs-helpers.mts';

export const ANTI_SLOP_UPSTREAM = '446268e5d15baa968eaec669ff65358d36ae6259';
export const ANTI_SLOP_PLUGIN_API_VERSION = '1.78.0';
export const ANTI_SLOP_MANAGED_REL = '.devkit/anti-slop';
export const ANTI_SLOP_MANIFEST_REL = `${ANTI_SLOP_MANAGED_REL}/manifest.json`;
export const ANTI_SLOP_CONFIG_REL = `${ANTI_SLOP_MANAGED_REL}/oxlint.json`;
export const ANTI_SLOP_BASELINE_REL = '.anti-slop-baseline.json';
export const ANTI_SLOP_BASELINE_UPGRADE_REL = '.devkit/anti-slop-baseline-upgrade.json';
export const ANTI_SLOP_LOCK_REL = '.devkit/anti-slop.lock';
export const ANTI_SLOP_BASELINE_LOCK_REL = '.devkit/anti-slop-baseline.lock';
export const ANTI_SLOP_EXECUTION_MODE_ENV = 'DEVKIT_INTERNAL_ANTI_SLOP_MODE';
export const ANTI_SLOP_NATIVE_MODE = 'native-only';
export const ANTI_SLOP_BASELINE_MODE = 'baseline';

export const ANTI_SLOP_UPSTREAM_RULE_NAMES = [
  'no-chained-type-assertions',
  'no-conditional-empty-object-spread',
  'no-known-value-widening',
  'no-module-mocking',
  'no-object-parameters',
  'no-reflect-apply',
  'no-reflect-get',
  'no-runtime-typeof',
  'no-shape-in-symbol-names',
  'no-unknown-parameters',
  'no-unknown-returns',
  'no-unknown-type-aliases',
  'no-unsafe-dictionary-type',
  'no-widen-then-assert',
  'require-safety-comment-for-type-assertion',
] as const;

/** Devkit-owned extensions that share the managed ruleset's default-error policy. */
export const ANTI_SLOP_DEVKIT_RULE_NAMES = [
  'no-unsafe-external-record-access',
  'no-unsafe-external-record-enumeration',
] as const;

export const ANTI_SLOP_RULE_NAMES = [
  ...ANTI_SLOP_UPSTREAM_RULE_NAMES,
  ...ANTI_SLOP_DEVKIT_RULE_NAMES,
] as const;

export const ANTI_SLOP_RULE_IDS = ANTI_SLOP_RULE_NAMES.map((name) => `anti-slop/${name}`);
export const ANTI_SLOP_UPSTREAM_RULE_IDS = ANTI_SLOP_UPSTREAM_RULE_NAMES.map(
  (name) => `anti-slop/${name}`,
);
export const ANTI_SLOP_DEVKIT_RULE_IDS = ANTI_SLOP_DEVKIT_RULE_NAMES.map(
  (name) => `anti-slop/${name}`,
);

/**
 * Every managed rule-surface/default pair Devkit has emitted. Keep this append-only when rules or
 * defaults change: upgrade evidence is trusted only when both sets match a known profile, never
 * merely because a manifest and config agree with each other.
 */
const ANTI_SLOP_MANAGED_ACTIVATION_PROFILES = [
  {
    ruleIds: ANTI_SLOP_UPSTREAM_RULE_IDS,
    activeRuleIds: ANTI_SLOP_UPSTREAM_RULE_IDS,
  },
  {
    ruleIds: ANTI_SLOP_RULE_IDS,
    activeRuleIds: ANTI_SLOP_UPSTREAM_RULE_IDS,
  },
  {
    ruleIds: ANTI_SLOP_RULE_IDS,
    activeRuleIds: ANTI_SLOP_RULE_IDS,
  },
] as const;

export const ANTI_SLOP_IGNORE_PATTERNS = [
  '.agent/**',
  '.agents/**',
  '.claude/**',
  '.codex/**',
  '.continue/**',
  '.cursor/**',
  '.devkit/anti-slop/**',
  '.gemini/**',
  '.opencode/**',
  '.pi/**',
  '.roo/**',
  '.windsurf/**',
];

interface AntiSlopManagedRuleEvidence {
  baselineMigrationId: string | null;
  configDigest: string;
  ruleIds: string[];
}

export interface AntiSlopManifestEnvelope {
  configDigest: string;
  devkitVersion: string | null;
  pluginApiVersion: string | null;
  pluginDigest: string | null;
  probeConfigDigest: string | null;
  probeDigest: string | null;
  ruleIds: string[];
  upstreamCommit: string | null;
}

export interface AntiSlopManagedActivationEvidence {
  activeRuleIds: Set<string>;
  baselineMigrationId: string | null;
}

export function antiSlopBaselineMigrationId(devkitVersion: string, configDigest: string): string {
  return `anti-slop-activation@${devkitVersion}:${configDigest}`;
}

/** Decode the common manifest envelope once; callers decide whether cross-release or current pins apply. */
export function parseAntiSlopManifestEnvelope(json: string): AntiSlopManifestEnvelope | null {
  try {
    // SAFETY: Common identity fields are validated here; optional pin fields remain nullable for
    // older manifests and are checked by the current-capability reader before it consumes them.
    const value = JSON.parse(json) as {
      configDigest?: unknown;
      devkitVersion?: unknown;
      pluginApiVersion?: unknown;
      pluginDigest?: unknown;
      probeConfigDigest?: unknown;
      probeDigest?: unknown;
      ruleIds?: unknown;
      schemaVersion?: unknown;
      upstreamCommit?: unknown;
    };
    const configDigest = String(value.configDigest);
    const devkitVersion = String(value.devkitVersion);
    const pluginApiVersion = String(value.pluginApiVersion);
    const pluginDigest = String(value.pluginDigest);
    const probeConfigDigest = String(value.probeConfigDigest);
    const probeDigest = String(value.probeDigest);
    const upstreamCommit = String(value.upstreamCommit);
    if (
      value.schemaVersion !== 1 ||
      configDigest !== value.configDigest ||
      !Array.isArray(value.ruleIds) ||
      value.ruleIds.length === 0 ||
      !value.ruleIds.every((id) => String(id) === id) ||
      new Set(value.ruleIds).size !== value.ruleIds.length
    ) {
      return null;
    }
    return {
      configDigest,
      devkitVersion:
        devkitVersion === value.devkitVersion && devkitVersion.length > 0 ? devkitVersion : null,
      pluginApiVersion: pluginApiVersion === value.pluginApiVersion ? pluginApiVersion : null,
      pluginDigest: pluginDigest === value.pluginDigest ? pluginDigest : null,
      probeConfigDigest: probeConfigDigest === value.probeConfigDigest ? probeConfigDigest : null,
      probeDigest: probeDigest === value.probeDigest ? probeDigest : null,
      ruleIds: value.ruleIds.map(String),
      upstreamCommit: upstreamCommit === value.upstreamCommit ? upstreamCommit : null,
    };
  } catch {
    return null;
  }
}

/** Read activation evidence from a coherent older or current managed capability. */
function parseAntiSlopManifestRuleEvidence(json: string): AntiSlopManagedRuleEvidence | null {
  const manifest = parseAntiSlopManifestEnvelope(json);
  if (manifest === null) return null;
  return {
    baselineMigrationId:
      manifest.devkitVersion === null
        ? null
        : antiSlopBaselineMigrationId(manifest.devkitVersion, manifest.configDigest),
    configDigest: manifest.configDigest,
    ruleIds: manifest.ruleIds,
  };
}

/** Parse only managed top-level rule activation; repository overrides remain consumer-owned. */
function parseAntiSlopConfigRuleActivation(
  json: string,
  ruleIds: readonly string[],
): Map<string, boolean> | null {
  try {
    // SAFETY: Object identity and per-entry severity checks validate the consumed config fields.
    const value = JSON.parse(json) as { rules?: unknown };
    if (Object(value.rules) !== value.rules || Array.isArray(value.rules)) return null;
    const rules = Object(value.rules);
    const configuredRuleIds = Object.getOwnPropertyNames(rules);
    if (
      configuredRuleIds.length !== ruleIds.length ||
      configuredRuleIds.some((ruleId) => !ruleIds.includes(ruleId))
    ) {
      return null;
    }
    const activation = new Map<string, boolean>();
    for (const ruleId of ruleIds) {
      const descriptor = Object.getOwnPropertyDescriptor(rules, ruleId);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      const configured: unknown = descriptor.value;
      const severity = Array.isArray(configured) ? configured[0] : configured;
      if (severity === 'off' || severity === 0) activation.set(ruleId, false);
      else if (severity === 'warn' || severity === 'error' || severity === 1 || severity === 2) {
        activation.set(ruleId, true);
      } else {
        return null;
      }
    }
    return activation;
  } catch {
    return null;
  }
}

/** Parse managed rule activation only when the manifest authenticates the exact config bytes. */
export function parseAntiSlopManagedActivationEvidence(
  manifestJson: string,
  configJson: string,
): AntiSlopManagedActivationEvidence | null {
  const evidence = parseAntiSlopManifestRuleEvidence(manifestJson);
  if (evidence === null || digest(configJson) !== evidence.configDigest) return null;
  const activation = parseAntiSlopConfigRuleActivation(configJson, evidence.ruleIds);
  if (activation === null) return null;
  const activeRuleIds = new Set(
    [...activation].filter(([, active]) => active).map(([ruleId]) => ruleId),
  );
  if (
    !ANTI_SLOP_MANAGED_ACTIVATION_PROFILES.some(
      (profile) =>
        profile.ruleIds.length === evidence.ruleIds.length &&
        profile.ruleIds.every((ruleId) => evidence.ruleIds.includes(ruleId)) &&
        profile.activeRuleIds.length === activeRuleIds.size &&
        profile.activeRuleIds.every((ruleId) => activeRuleIds.has(ruleId)),
    )
  ) {
    return null;
  }
  return {
    activeRuleIds,
    baselineMigrationId: evidence.baselineMigrationId,
  };
}

export function parseAntiSlopManagedActiveRuleIds(
  manifestJson: string,
  configJson: string,
): Set<string> | null {
  return parseAntiSlopManagedActivationEvidence(manifestJson, configJson)?.activeRuleIds ?? null;
}

const ANTI_SLOP_CONFIG_DISABLE_PATTERNS = ANTI_SLOP_IGNORE_PATTERNS.flatMap((pattern) =>
  pattern === '.devkit/anti-slop/**' ? ['.devkit/anti-slop/plugin/**'] : [pattern],
);

/** Render the config fragment inherited by Devkit's managed Oxlint base. */
export function renderAntiSlopConfig(pluginEntry: string): string {
  return `${JSON.stringify(
    {
      jsPlugins: [{ name: 'anti-slop', specifier: pluginEntry }],
      overrides: [
        {
          files: ANTI_SLOP_CONFIG_DISABLE_PATTERNS,
          rules: Object.fromEntries(ANTI_SLOP_RULE_IDS.map((id) => [id, 'off'])),
        },
      ],
      rules: Object.fromEntries(ANTI_SLOP_RULE_IDS.map((id) => [id, 'error'])),
    },
    null,
    2,
  )}\n`;
}
