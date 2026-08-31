/** Baseline growth, activation migration, and inherited-debt checks for anti-slop gates. */

import { AntiSlopCapabilityError } from './base-capability.mts';
import {
  type AntiSlopBaseline,
  baselineFromGroups,
  baselineIncreases,
  compareBaseline,
  migrateBaselineRenames,
  removedBaselineMigrationReceipts,
} from './baseline.mts';
import type { FindingGroup } from './diagnostics.mts';
import { type GitBaselineEnvelope, withBaseAntiSlopSnapshot } from './git-snapshot.mts';
import { collectAntiSlopGroups } from './runner.mts';

export function printNewAntiSlopFindings(
  groups: ReadonlyArray<FindingGroup & { additionalCount: number }>,
): void {
  for (const group of groups) {
    const tag = group.severity === 'error' ? 'ERROR' : 'WARN';
    console.log(
      `${tag} ${group.ruleId} ${group.file}:${group.line}:${group.column} (+${group.additionalCount})`,
    );
    console.log(`      ${group.diagnostic}`);
  }
}

export function checkBaselineEnvelope(
  candidate: AntiSlopBaseline,
  envelope: GitBaselineEnvelope | null,
  candidateGroups: readonly FindingGroup[],
  baseRef?: string,
): number {
  if (!envelope?.base) return 0; // one-time bootstrap: the base commit has no baseline
  const removedMigrationReceipts = removedBaselineMigrationReceipts(envelope.base, candidate);
  if (removedMigrationReceipts.length > 0) {
    for (const receipt of removedMigrationReceipts) {
      console.error(`BASELINE-MIGRATION-RECEIPT ${receipt} removed`);
    }
    console.error(
      'anti-slop: FAIL — completed rule-migration receipts are append-only; restore the base receipt',
    );
    return 1;
  }
  const requiredReceipt = envelope.candidateMigrationReceipt;
  const baseReceipts = new Set(envelope.base.migrationReceipts ?? []);
  const candidateReceipts = new Set(candidate.migrationReceipts ?? []);
  const addedReceipts = [...candidateReceipts].filter((receipt) => !baseReceipts.has(receipt));
  if (
    addedReceipts.length > 0 &&
    (requiredReceipt === null || addedReceipts.some((receipt) => receipt !== requiredReceipt))
  ) {
    for (const receipt of addedReceipts) {
      console.error(`BASELINE-MIGRATION-RECEIPT ${receipt} does not match candidate capability`);
    }
    console.error(
      'anti-slop: FAIL — add a migration receipt only with the managed capability state that issued it',
    );
    return 1;
  }
  if (envelope.activatedRuleIds.size > 0 && requiredReceipt === null) {
    console.error(
      'anti-slop: FAIL — newly activated managed rules lack a release-bound baseline migration identity',
    );
    return 1;
  }
  if (
    envelope.activatedRuleIds.size > 0 &&
    requiredReceipt !== null &&
    !candidateReceipts.has(requiredReceipt)
  ) {
    console.error(`BASELINE-MIGRATION-RECEIPT ${requiredReceipt} missing`);
    console.error(
      'anti-slop: FAIL — record the release activation receipt even when the newly activated rules have zero findings',
    );
    return 1;
  }
  const staleRenames = candidate.entries.flatMap((entry) => {
    const nextFile = envelope.renames.get(entry.file);
    return nextFile ? [{ ...entry, nextFile }] : [];
  });
  if (staleRenames.length > 0) {
    for (const entry of staleRenames) {
      console.error(
        `BASELINE-RENAME ${entry.ruleId} ${entry.file} -> ${entry.nextFile} (${entry.count} adopted finding(s))`,
      );
    }
    const remedy = baseRef
      ? `devkit anti-slop adopt-renames --base ${baseRef}`
      : 'devkit anti-slop adopt-renames';
    console.error(
      `anti-slop: FAIL — persist renamed debt with \`${remedy}\`, then stage the baseline`,
    );
    return 1;
  }
  const omittedActivatedFindings = compareBaseline(candidate, candidateGroups).newGroups.filter(
    (group) => envelope.activatedRuleIds.has(group.ruleId) && group.severity === 'error',
  );
  if (omittedActivatedFindings.length > 0) {
    printNewAntiSlopFindings(omittedActivatedFindings);
    console.error(
      'anti-slop: FAIL — newly activated error finding(s) must be fixed or recorded in the release baseline',
    );
    return 1;
  }
  const allIncreases = baselineIncreases(envelope.base, candidate, envelope.renames);
  const migratableRuleIds =
    requiredReceipt !== null && !baseReceipts.has(requiredReceipt)
      ? envelope.activatedRuleIds
      : new Set<string>();
  const increases = baselineIncreases(
    envelope.base,
    candidate,
    envelope.renames,
    migratableRuleIds,
    candidateGroups,
  );
  const blocked = new Map(increases.map((entry) => [entry.fingerprint, entry.additionalCount]));
  const adopted = allIncreases.flatMap((entry) => {
    const additionalCount = entry.additionalCount - (blocked.get(entry.fingerprint) ?? 0);
    return additionalCount > 0 ? [{ ...entry, additionalCount }] : [];
  });
  if (adopted.length > 0) {
    const rules = [...new Set(adopted.map((entry) => entry.ruleId))].sort((a, b) =>
      a.localeCompare(b),
    );
    console.log(
      `anti-slop: accepted ${adopted.reduce((sum, entry) => sum + entry.additionalCount, 0)} baseline finding(s) for newly activated rule(s): ${rules.join(', ')}`,
    );
  }
  if (increases.length === 0) return 0;
  for (const entry of increases) {
    console.error(
      `BASELINE-GROWTH ${entry.ruleId} ${entry.file} (+${entry.additionalCount} adopted finding(s))`,
    );
  }
  console.error(
    'anti-slop: FAIL — the committed baseline may only shrink; fix the finding instead of adopting it',
  );
  return 1;
}

/** Name what the allowance forgave: it is transient, so silence would hide adopted debt. */
export function reportInheritedForgiveness(
  before: ReadonlyArray<FindingGroup & { additionalCount: number }>,
  after: ReadonlyArray<FindingGroup & { additionalCount: number }>,
): void {
  // Keyed by fingerprint, the baseline's own identity: a location key collides when one rule
  // reports two messages at one span.
  const remaining = new Map(after.map((group) => [group.fingerprint, group.additionalCount]));
  const perRule = new Map<string, number>();
  for (const group of before) {
    const forgiven = group.additionalCount - (remaining.get(group.fingerprint) ?? 0);
    if (forgiven > 0) perRule.set(group.ruleId, (perRule.get(group.ruleId) ?? 0) + forgiven);
  }
  if (perRule.size === 0) return;
  const total = [...perRule.values()].reduce((sum, count) => sum + count, 0);
  const rules = [...perRule.keys()].sort((a, b) => a.localeCompare(b));
  console.log(
    `anti-slop: base allowance forgave ${total} inherited finding(s) across ${rules.length} rule(s): ${rules.join(', ')}`,
  );
}

export function inheritedBaseAllowance(
  cwd: string,
  capabilityCwd: string | null,
  selected: AntiSlopBaseline,
  candidateGroups: readonly FindingGroup[],
  envelope: GitBaselineEnvelope | null,
): AntiSlopBaseline {
  if (!envelope?.base || !envelope.baseTree) return selected;
  const candidateNew = compareBaseline(selected, candidateGroups).newGroups.filter(
    (group) => !envelope.activatedRuleIds.has(group.ruleId),
  );
  if (candidateNew.length === 0) return selected;

  const reverseRenames = new Map(
    [...envelope.renames].map(([basePath, candidatePath]) => [candidatePath, basePath]),
  );
  const basePaths = [
    ...new Set(
      candidateNew.flatMap((group) =>
        envelope.introducedPaths.has(group.file)
          ? []
          : [reverseRenames.get(group.file) ?? group.file],
      ),
    ),
  ];
  return withBaseAntiSlopSnapshot(
    envelope.baseCheckoutCwd ?? cwd,
    capabilityCwd ?? cwd,
    envelope.baseTree,
    basePaths,
    (snapshot) => {
      if (snapshot.paths.length === 0) return selected;
      let baseGroups: FindingGroup[];
      try {
        baseGroups = collectAntiSlopGroups(snapshot.cwd, snapshot.paths);
      } catch (error: unknown) {
        // Residual failure is the base tree's own consumer state. Skipping the allowance blames
        // MORE, never less, so degrade loudly instead of hiding the finding (sc-2084).
        if (!(error instanceof AntiSlopCapabilityError)) throw error;
        console.error(
          `anti-slop: inherited base allowance skipped — ${error.issue}; inherited findings may be reported as new`,
        );
        return selected;
      }
      const inherited = migrateBaselineRenames(
        baselineFromGroups(
          baseGroups.filter((group) => !envelope.activatedRuleIds.has(group.ruleId)),
        ),
        envelope.renames,
      );
      const entries = new Map(selected.entries.map((entry) => [entry.fingerprint, entry]));
      for (const entry of inherited.entries) {
        const committed = entries.get(entry.fingerprint);
        if (!committed || entry.count > committed.count) entries.set(entry.fingerprint, entry);
      }
      return {
        ...selected,
        entries: [...entries.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
      };
    },
  );
}
