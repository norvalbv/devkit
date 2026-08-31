/** Deterministic, explicit, shrink-only anti-slop baseline model. */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mts';
import { ANTI_SLOP_BASELINE_REL, ANTI_SLOP_UPSTREAM } from './constants.mts';
import type { FindingGroup } from './diagnostics.mts';

export interface BaselineEntry {
  fingerprint: string;
  ruleId: string;
  file: string;
  diagnostic: string;
  context: string;
  count: number;
}

export interface AntiSlopBaseline {
  schemaVersion: 1;
  upstreamCommit: string;
  /** Durable transition receipts for activation migrations, including zero-finding rules. */
  migrationReceipts?: string[];
  entries: BaselineEntry[];
}

export interface BaselineComparison {
  newGroups: Array<FindingGroup & { additionalCount: number }>;
  currentCount: number;
  debtCount: number;
  resolvedCount: number;
}

export interface BaselineIncrease extends BaselineEntry {
  additionalCount: number;
}

/** Completion receipts are append-only; removing one reopens a finished zero-debt migration. */
export function removedBaselineMigrationReceipts(
  base: AntiSlopBaseline,
  candidate: AntiSlopBaseline,
): string[] {
  const candidateReceipts = new Set(candidate.migrationReceipts ?? []);
  return (base.migrationReceipts ?? []).filter((receipt) => !candidateReceipts.has(receipt));
}

function newlyActivatedRuleIdsWithoutDebt(
  entries: readonly BaselineEntry[],
  activatedRuleIds: ReadonlySet<string>,
): Set<string> {
  const existingRuleIds = new Set(entries.map((entry) => entry.ruleId));
  return new Set([...activatedRuleIds].filter((ruleId) => !existingRuleIds.has(ruleId)));
}

function expectedFingerprint(entry: Omit<BaselineEntry, 'fingerprint' | 'count'>): string {
  return createHash('sha256')
    .update(JSON.stringify([entry.ruleId, entry.file, entry.diagnostic, entry.context]))
    .digest('hex');
}

function validateEntry(value: unknown): value is BaselineEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<BaselineEntry>;
  if (
    typeof entry.fingerprint !== 'string' ||
    typeof entry.ruleId !== 'string' ||
    typeof entry.file !== 'string' ||
    typeof entry.diagnostic !== 'string' ||
    typeof entry.context !== 'string' ||
    !Number.isSafeInteger(entry.count) ||
    (entry.count ?? 0) < 1
  ) {
    return false;
  }
  return (
    expectedFingerprint({
      ruleId: entry.ruleId,
      file: entry.file,
      diagnostic: entry.diagnostic,
      context: entry.context,
    }) === entry.fingerprint
  );
}

export function baselineFromGroups(groups: readonly FindingGroup[]): AntiSlopBaseline {
  return {
    schemaVersion: 1,
    upstreamCommit: ANTI_SLOP_UPSTREAM,
    entries: [...groups]
      .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
      .map(({ severity: _severity, line: _line, column: _column, ...entry }) => entry),
  };
}

export function parseBaseline(json: string, source = ANTI_SLOP_BASELINE_REL): AntiSlopBaseline {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error: unknown) {
    throw new Error(`invalid ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const baseline = value as Partial<AntiSlopBaseline>;
  if (
    baseline.schemaVersion !== 1 ||
    baseline.upstreamCommit !== ANTI_SLOP_UPSTREAM ||
    (baseline.migrationReceipts !== undefined &&
      (!Array.isArray(baseline.migrationReceipts) ||
        !baseline.migrationReceipts.every(
          (receipt) => String(receipt) === receipt && String(receipt).length > 0,
        ) ||
        new Set(baseline.migrationReceipts).size !== baseline.migrationReceipts.length)) ||
    !Array.isArray(baseline.entries) ||
    !baseline.entries.every(validateEntry)
  ) {
    throw new Error(`invalid or stale ${source}; inspect it, then explicitly recreate it`);
  }
  const sorted = [...baseline.entries].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  if (new Set(sorted.map((entry) => entry.fingerprint)).size !== sorted.length) {
    throw new Error(`invalid ${source}: duplicate fingerprints`);
  }
  const migrationReceipts = [...(baseline.migrationReceipts ?? [])].sort((a, b) =>
    a.localeCompare(b),
  );
  const parsed: AntiSlopBaseline = {
    schemaVersion: 1,
    upstreamCommit: baseline.upstreamCommit,
    entries: sorted,
  };
  if (migrationReceipts.length > 0) parsed.migrationReceipts = migrationReceipts;
  return parsed;
}

export function readBaseline(cwd: string): AntiSlopBaseline | null {
  const path = join(cwd, ANTI_SLOP_BASELINE_REL);
  return existsSync(path) ? parseBaseline(readFileSync(path, 'utf8')) : null;
}

export function writeBaseline(cwd: string, baseline: AntiSlopBaseline): void {
  writeFileAtomic(join(cwd, ANTI_SLOP_BASELINE_REL), `${JSON.stringify(baseline, null, 2)}\n`);
}

export function compareBaseline(
  baseline: AntiSlopBaseline,
  groups: readonly FindingGroup[],
): BaselineComparison {
  const allowed = new Map(baseline.entries.map((entry) => [entry.fingerprint, entry.count]));
  const current = new Map(groups.map((group) => [group.fingerprint, group.count]));
  return {
    newGroups: groups.flatMap((group) => {
      const additionalCount = Math.max(0, group.count - (allowed.get(group.fingerprint) ?? 0));
      return additionalCount > 0 ? [{ ...group, additionalCount }] : [];
    }),
    currentCount: groups.reduce((sum, group) => sum + group.count, 0),
    debtCount: baseline.entries.reduce((sum, entry) => sum + entry.count, 0),
    resolvedCount: baseline.entries.reduce(
      (sum, entry) => sum + Math.max(0, entry.count - (current.get(entry.fingerprint) ?? 0)),
      0,
    ),
  };
}

/**
 * Adopt current findings for rules activated by a capability upgrade. Existing rule debt is never
 * touched: if a supposedly activated rule already has any baseline entry, it is treated as
 * existing and remains shrink-only.
 */
export function adoptBaselineRuleFindings(
  baseline: AntiSlopBaseline,
  groups: readonly FindingGroup[],
  activatedRuleIds: ReadonlySet<string>,
  migrationId: string,
): AntiSlopBaseline {
  const eligibleRuleIds = (baseline.migrationReceipts ?? []).includes(migrationId)
    ? new Set<string>()
    : newlyActivatedRuleIdsWithoutDebt(baseline.entries, activatedRuleIds);
  const adopted = baselineFromGroups(groups).entries.filter((entry) =>
    eligibleRuleIds.has(entry.ruleId),
  );
  return {
    ...baseline,
    migrationReceipts: [...new Set([...(baseline.migrationReceipts ?? []), migrationId])].sort(
      (a, b) => a.localeCompare(b),
    ),
    entries: [...baseline.entries, ...adopted].sort((a, b) =>
      a.fingerprint.localeCompare(b.fingerprint),
    ),
  };
}

/**
 * Move adopted debt across Git-detected file renames without allowing its rule/message/context or
 * count to change. Multiple entries that converge on one fingerprint are deliberately combined.
 */
export function migrateBaselineRenames(
  baseline: AntiSlopBaseline,
  renames: ReadonlyMap<string, string>,
): AntiSlopBaseline {
  const migrated = new Map<string, BaselineEntry>();
  for (const entry of baseline.entries) {
    const file = renames.get(entry.file) ?? entry.file;
    const stable = {
      ruleId: entry.ruleId,
      file,
      diagnostic: entry.diagnostic,
      context: entry.context,
    };
    const fingerprint = expectedFingerprint(stable);
    const current = migrated.get(fingerprint);
    if (current) current.count += entry.count;
    else migrated.set(fingerprint, { fingerprint, ...stable, count: entry.count });
  }
  return {
    ...baseline,
    entries: [...migrated.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
  };
}

/** Return only candidate debt that exceeds the base commit's count envelope. */
export function baselineIncreases(
  base: AntiSlopBaseline,
  candidate: AntiSlopBaseline,
  renames: ReadonlyMap<string, string> = new Map(),
  activatedRuleIds: ReadonlySet<string> = new Set(),
  currentGroups: readonly FindingGroup[] = [],
): BaselineIncrease[] {
  const migratedBase = migrateBaselineRenames(base, renames);
  const eligibleRuleIds = newlyActivatedRuleIdsWithoutDebt(migratedBase.entries, activatedRuleIds);
  const allowed = new Map(migratedBase.entries.map((entry) => [entry.fingerprint, entry.count]));
  const current = new Map(currentGroups.map((group) => [group.fingerprint, group.count]));
  return candidate.entries.flatMap((entry) => {
    const baseCount = allowed.get(entry.fingerprint) ?? 0;
    const allowedCount = eligibleRuleIds.has(entry.ruleId)
      ? Math.max(baseCount, current.get(entry.fingerprint) ?? 0)
      : baseCount;
    const additionalCount = Math.max(0, entry.count - allowedCount);
    return additionalCount > 0 ? [{ ...entry, additionalCount }] : [];
  });
}

/** Return only still-present baseline debt; never add an unbaselined current finding. */
export function pruneBaseline(
  baseline: AntiSlopBaseline,
  groups: readonly FindingGroup[],
): AntiSlopBaseline {
  const current = new Map(groups.map((group) => [group.fingerprint, group.count]));
  return {
    ...baseline,
    entries: baseline.entries.flatMap((entry) => {
      const count = Math.min(entry.count, current.get(entry.fingerprint) ?? 0);
      return count > 0 ? [{ ...entry, count }] : [];
    }),
  };
}
