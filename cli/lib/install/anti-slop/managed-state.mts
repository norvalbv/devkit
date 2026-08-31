/** Read managed anti-slop identity and preserve baseline activation evidence across upgrades. */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeFileAtomic } from '../../atomic-write.mts';
import { digest, packageDir } from '../../fs-helpers.mts';
import { adoptBaselineRuleFindings, readBaseline, writeBaseline } from './baseline.mts';
import {
  ANTI_SLOP_BASELINE_LOCK_REL,
  ANTI_SLOP_BASELINE_REL,
  ANTI_SLOP_BASELINE_UPGRADE_REL,
  ANTI_SLOP_CONFIG_REL,
  ANTI_SLOP_LOCK_REL,
  ANTI_SLOP_MANIFEST_REL,
  ANTI_SLOP_PLUGIN_API_VERSION,
  ANTI_SLOP_RULE_IDS,
  ANTI_SLOP_UPSTREAM,
  antiSlopBaselineMigrationId,
  parseAntiSlopManifestEnvelope,
  parseAntiSlopManagedActivationEvidence,
  renderAntiSlopConfig,
} from './constants.mts';
import type { AntiSlopManagedActivationEvidence } from './constants.mts';
import type { FindingGroup } from './diagnostics.mts';

export interface AntiSlopManifest {
  schemaVersion: 1;
  devkitVersion: string;
  upstreamCommit: string;
  pluginApiVersion: string;
  ruleIds: string[];
  pluginDigest: string;
  configDigest: string;
  probeDigest: string;
  probeConfigDigest: string;
}

interface PendingAntiSlopBaselineUpgradeFile {
  schemaVersion: 1;
  migrationId: string;
  activatedRuleIds: string[];
}

export interface PendingAntiSlopBaselineActivation {
  migrationId: string;
  activatedRuleIds: Set<string>;
}

export function antiSlopPluginSource() {
  const root = join(packageDir(), 'anti-slop', 'src');
  if (existsSync(join(root, 'index.mjs'))) return { root, entry: './plugin/index.mjs' };
  if (existsSync(join(root, 'index.js'))) return { root, entry: './plugin/index.js' };
  if (existsSync(join(root, 'index.ts'))) return { root, entry: './plugin/index.ts' };
  throw new Error('bundled anti-slop plugin entry is missing');
}

/** Stable across clones of one release, distinct again when a later Devkit release activates rules. */
export function devkitPackageVersion(): string {
  // SAFETY: The equality and non-empty checks below validate the only consumed manifest field.
  const manifest = JSON.parse(readFileSync(join(packageDir(), 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  const version = String(manifest.version);
  if (version !== manifest.version || version.length === 0) {
    throw new Error('devkit package version is missing; cannot identify anti-slop migration');
  }
  return version;
}

function baselineMigrationId(): string {
  const source = antiSlopPluginSource();
  return antiSlopBaselineMigrationId(
    devkitPackageVersion(),
    digest(renderAntiSlopConfig(source.entry)),
  );
}

export function readAntiSlopManifest(cwd: string): AntiSlopManifest | null {
  const path = join(cwd, ANTI_SLOP_MANIFEST_REL);
  if (!existsSync(path)) return null;
  const manifest = parseAntiSlopManifestEnvelope(readFileSync(path, 'utf8'));
  return manifest !== null &&
    manifest.devkitVersion !== null &&
    manifest.upstreamCommit === ANTI_SLOP_UPSTREAM &&
    manifest.pluginApiVersion === ANTI_SLOP_PLUGIN_API_VERSION &&
    manifest.pluginDigest !== null &&
    manifest.probeDigest !== null &&
    manifest.probeConfigDigest !== null
    ? {
        schemaVersion: 1,
        devkitVersion: manifest.devkitVersion,
        upstreamCommit: ANTI_SLOP_UPSTREAM,
        pluginApiVersion: ANTI_SLOP_PLUGIN_API_VERSION,
        ruleIds: manifest.ruleIds,
        pluginDigest: manifest.pluginDigest,
        configDigest: manifest.configDigest,
        probeDigest: manifest.probeDigest,
        probeConfigDigest: manifest.probeConfigDigest,
      }
    : null;
}

/** Read a previous install's active managed rules without requiring its pins to match this Devkit. */
function readManagedAntiSlopActivationEvidence(
  cwd: string,
): AntiSlopManagedActivationEvidence | null {
  const manifestPath = join(cwd, ANTI_SLOP_MANIFEST_REL);
  const configPath = join(cwd, ANTI_SLOP_CONFIG_REL);
  if (!existsSync(manifestPath) || !existsSync(configPath)) return null;
  return parseAntiSlopManagedActivationEvidence(
    readFileSync(manifestPath, 'utf8'),
    readFileSync(configPath, 'utf8'),
  );
}

export function readActiveAntiSlopRuleIds(cwd: string): Set<string> | null {
  return readManagedAntiSlopActivationEvidence(cwd)?.activeRuleIds ?? null;
}

/** A pending marker is consumable only by the exact installed managed config that issued it. */
export function readInstalledAntiSlopBaselineMigrationId(cwd: string): string | null {
  return readManagedAntiSlopActivationEvidence(cwd)?.baselineMigrationId ?? null;
}

export function readPendingAntiSlopBaselineActivation(
  cwd: string,
): PendingAntiSlopBaselineActivation | null {
  const path = join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL);
  if (!existsSync(path)) return null;
  try {
    // SAFETY: The schema, rule IDs, and membership in the current managed surface are checked below.
    const value = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as Partial<PendingAntiSlopBaselineUpgradeFile>;
    const migrationId = String(value.migrationId);
    if (
      value.schemaVersion !== 1 ||
      migrationId !== value.migrationId ||
      migrationId.length === 0 ||
      !Array.isArray(value.activatedRuleIds) ||
      !value.activatedRuleIds.every(
        (ruleId) => String(ruleId) === ruleId && ANTI_SLOP_RULE_IDS.includes(ruleId),
      ) ||
      new Set(value.activatedRuleIds).size !== value.activatedRuleIds.length
    ) {
      throw new Error('invalid shape');
    }
    return { migrationId, activatedRuleIds: new Set(value.activatedRuleIds) };
  } catch (error: unknown) {
    throw new Error(
      `invalid ${ANTI_SLOP_BASELINE_UPGRADE_REL}; inspect or remove it before retrying managed anti-slop sync: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Remove only the transition the caller completed; caller must already hold the baseline lock. */
export function clearPendingAntiSlopBaselineActivation(cwd: string, migrationId: string): boolean {
  const pending = readPendingAntiSlopBaselineActivation(cwd);
  if (pending?.migrationId !== migrationId) return false;
  rmSync(join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL), { force: true });
  return true;
}

/** Finish one captured activation while holding the baseline lock through collection and receipt. */
export function adoptActivatedAntiSlopFindings(
  cwd: string,
  previewActivation: PendingAntiSlopBaselineActivation | null,
  dryRun: boolean,
  collectGroups: () => readonly FindingGroup[],
): boolean {
  if (previewActivation === null) {
    if (dryRun) return true;
    if (existsSync(join(cwd, ANTI_SLOP_BASELINE_REL))) return true;
    console.error(
      `devkit upgrade: ${ANTI_SLOP_BASELINE_REL} disappeared during reconciliation. Run \`devkit anti-slop create\` to recreate the baseline, then retry \`devkit upgrade\`.`,
    );
    return false;
  }
  if (dryRun) {
    if (previewActivation.activatedRuleIds.size === 0) {
      console.log(
        `  [dry-run] would record the anti-slop release transition without adopting unproven findings into ${ANTI_SLOP_BASELINE_REL}`,
      );
    } else {
      console.log(
        `  [dry-run] would adopt existing findings for ${previewActivation.activatedRuleIds.size} newly activated rule(s) into ${ANTI_SLOP_BASELINE_REL}`,
      );
    }
    return true;
  }
  return withLock(join(cwd, ANTI_SLOP_BASELINE_LOCK_REL), () => {
    // Re-read while holding the baseline lock: another capability sync may have extended the
    // pending transition after this upgrade captured its preview but before adoption began.
    const activation = readPendingAntiSlopBaselineActivation(cwd);
    const baseline = readBaseline(cwd);
    if (activation === null) {
      if (baseline?.migrationReceipts?.includes(previewActivation.migrationId)) return true;
      console.error(
        `devkit upgrade: anti-slop activation evidence disappeared before adoption completed; retry \`devkit upgrade\``,
      );
      return false;
    }
    if (activation.migrationId !== previewActivation.migrationId) {
      console.error(
        `devkit upgrade: anti-slop activation changed during reconciliation; retry \`devkit upgrade\``,
      );
      return false;
    }
    if (baseline === null) {
      console.error(
        `devkit upgrade: ${ANTI_SLOP_BASELINE_REL} is missing; activation evidence remains in ${ANTI_SLOP_BASELINE_UPGRADE_REL}. Run \`devkit anti-slop create\` to recreate the baseline, then retry \`devkit upgrade\`.`,
      );
      return false;
    }
    const groups = activation.activatedRuleIds.size === 0 ? [] : collectGroups();
    const next = adoptBaselineRuleFindings(
      baseline,
      groups,
      activation.activatedRuleIds,
      activation.migrationId,
    );
    const adopted =
      next.entries.reduce((sum, entry) => sum + entry.count, 0) -
      baseline.entries.reduce((sum, entry) => sum + entry.count, 0);
    if (JSON.stringify(next) !== JSON.stringify(baseline)) writeBaseline(cwd, next);
    clearPendingAntiSlopBaselineActivation(cwd, activation.migrationId);
    if (activation.activatedRuleIds.size === 0) {
      console.log('  ✓ anti-slop baseline: recorded release transition; adopted no unproven debt');
    } else {
      console.log(
        `  ✓ anti-slop baseline: adopted ${adopted} existing finding(s) for ${activation.activatedRuleIds.size} newly activated rule(s)`,
      );
    }
    return true;
  });
}

function currentReleaseActivation(
  cwd: string,
  activatedRuleIds: ReadonlySet<string>,
  dryRun: boolean,
) {
  const activation: PendingAntiSlopBaselineActivation = {
    migrationId: baselineMigrationId(),
    activatedRuleIds: new Set(activatedRuleIds),
  };
  if (!dryRun) {
    const marker: PendingAntiSlopBaselineUpgradeFile = {
      schemaVersion: 1,
      migrationId: activation.migrationId,
      activatedRuleIds: [...activation.activatedRuleIds],
    };
    writeFileAtomic(
      join(cwd, ANTI_SLOP_BASELINE_UPGRADE_REL),
      `${JSON.stringify(marker, null, 2)}\n`,
    );
  }
  return activation;
}

export function captureAntiSlopBaselineActivationUnlocked(
  cwd: string,
  dryRun: boolean,
  recordMissingBaselineTransition = false,
): PendingAntiSlopBaselineActivation | null {
  let pending = readPendingAntiSlopBaselineActivation(cwd);
  const baselineMissing = !existsSync(join(cwd, ANTI_SLOP_BASELINE_REL));
  if (pending !== null) {
    const baseline = readBaseline(cwd);
    if (baseline?.migrationReceipts?.includes(pending.migrationId)) {
      if (!dryRun) clearPendingAntiSlopBaselineActivation(cwd, pending.migrationId);
      pending = null;
    }
  }
  const previousActiveRuleIds = readActiveAntiSlopRuleIds(cwd);
  if (previousActiveRuleIds === null) {
    if (pending === null) {
      const managedEvidenceExists =
        existsSync(join(cwd, ANTI_SLOP_MANIFEST_REL)) ||
        existsSync(join(cwd, ANTI_SLOP_CONFIG_REL));
      if (baselineMissing && !managedEvidenceExists && !recordMissingBaselineTransition) {
        return null;
      }
      console.log(
        `  ! anti-slop rule debt unchanged — the previous managed manifest or config is missing or invalid; recording the release transition without adopting unproven findings`,
      );
      return currentReleaseActivation(cwd, new Set(), dryRun);
    }
    console.log(
      `  ! anti-slop activation evidence is missing or invalid; preserving ${pending.activatedRuleIds.size} pending rule(s) without adding unproven rules`,
    );
    return currentReleaseActivation(cwd, pending.activatedRuleIds, dryRun);
  }
  const activatedRuleIds = new Set([
    ...(pending?.activatedRuleIds ?? []),
    ...ANTI_SLOP_RULE_IDS.filter((ruleId) => !previousActiveRuleIds.has(ruleId)),
  ]);
  if (activatedRuleIds.size === 0 && pending === null && !baselineMissing) return null;
  return currentReleaseActivation(cwd, activatedRuleIds, dryRun);
}

/** Preserve activation evidence before any command can replace the previous managed capability. */
export function captureAntiSlopBaselineActivation(
  cwd: string,
  dryRun = false,
  recordMissingBaselineTransition = false,
): PendingAntiSlopBaselineActivation | null {
  if (dryRun) {
    return captureAntiSlopBaselineActivationUnlocked(cwd, true, recordMissingBaselineTransition);
  }
  mkdirSync(join(cwd, '.devkit'), { recursive: true });
  return withLock(join(cwd, ANTI_SLOP_BASELINE_LOCK_REL), () =>
    withLock(join(cwd, ANTI_SLOP_LOCK_REL), () =>
      captureAntiSlopBaselineActivationUnlocked(cwd, false, recordMissingBaselineTransition),
    ),
  );
}
