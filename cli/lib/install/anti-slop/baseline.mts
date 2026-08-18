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
  entries: BaselineEntry[];
}

export interface BaselineComparison {
  newGroups: Array<FindingGroup & { additionalCount: number }>;
  currentCount: number;
  debtCount: number;
  resolvedCount: number;
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

export function readBaseline(cwd: string): AntiSlopBaseline | null {
  const path = join(cwd, ANTI_SLOP_BASELINE_REL);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    throw new Error(
      `invalid ${ANTI_SLOP_BASELINE_REL}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const baseline = value as Partial<AntiSlopBaseline>;
  if (
    baseline.schemaVersion !== 1 ||
    baseline.upstreamCommit !== ANTI_SLOP_UPSTREAM ||
    !Array.isArray(baseline.entries) ||
    !baseline.entries.every(validateEntry)
  ) {
    throw new Error(
      `invalid or stale ${ANTI_SLOP_BASELINE_REL}; inspect it, then explicitly recreate it`,
    );
  }
  const sorted = [...baseline.entries].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  if (new Set(sorted.map((entry) => entry.fingerprint)).size !== sorted.length) {
    throw new Error(`invalid ${ANTI_SLOP_BASELINE_REL}: duplicate fingerprints`);
  }
  return { schemaVersion: 1, upstreamCommit: baseline.upstreamCommit, entries: sorted };
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
