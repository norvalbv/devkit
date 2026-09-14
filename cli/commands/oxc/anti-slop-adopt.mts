/** `devkit anti-slop adopt-renames|adopt-relocations` — re-anchor moved debt, never re-snapshot. */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../../lib/atomic-write.mts';
import {
  type AntiSlopBaseline,
  compareBaseline,
  migrateBaselineRenames,
  readBaseline,
  writeBaseline,
} from '../../lib/install/anti-slop/baseline.mts';
import {
  inheritedBaseAllowance,
  relocationBound,
  relocationEvidence,
} from '../../lib/install/anti-slop/baseline-envelope.mts';
import {
  ANTI_SLOP_BASELINE_LOCK_REL,
  ANTI_SLOP_BASELINE_REL,
} from '../../lib/install/anti-slop/constants.mts';
import {
  gitBaselineEnvelope,
  withStableGitIndex,
  withStagedAntiSlopSnapshot,
} from '../../lib/install/anti-slop/git-snapshot.mts';
import {
  classifyRelocations,
  formatSources,
  printRelocatedAntiSlopFindings,
  reanchorBaseline,
  type RelocatedGroup,
  relocationKey,
} from '../../lib/install/anti-slop/relocations.mts';
import {
  collectAntiSlopGroups,
  resolveAntiSlopScope,
} from '../../lib/install/anti-slop/runner.mts';

export function baselineOrExplain(cwd: string): AntiSlopBaseline | null {
  const baseline = readBaseline(cwd);
  if (!baseline) {
    console.error(
      `anti-slop: ${ANTI_SLOP_BASELINE_REL} is missing; run \`devkit anti-slop create\` explicitly`,
    );
  }
  return baseline;
}

export function count(groups: readonly { count: number }[]): number {
  return groups.reduce((sum, group) => sum + group.count, 0);
}

export function capabilityReady(cwd: string): boolean {
  if (existsSync(join(cwd, '.devkit', 'anti-slop', 'manifest.json'))) return true;
  console.error('anti-slop: not installed — run `devkit init --anti-slop`');
  return false;
}

/** A base a write can be locked to: a symbolic ref, a full object ID, or HEAD ancestry. */
function lockableBase(baseRef: string, baseRefName: string | null): boolean {
  return baseRefName !== null || /^(?:HEAD(?:[~^]\d*)*|[0-9a-f]{40}|[0-9a-f]{64})$/u.test(baseRef);
}

export function adoptRenames(cwd: string, baseRef = 'HEAD', requireRenames = false): number {
  if (!capabilityReady(cwd)) return 2;
  return withLock(join(cwd, ANTI_SLOP_BASELINE_LOCK_REL), () => {
    const baseline = baselineOrExplain(cwd);
    if (!baseline) return 2;
    const { baseOid, baseRefName, candidateTree, headOid, headRef, renames } = gitBaselineEnvelope(
      cwd,
      baseRef,
    );
    if (requireRenames && !lockableBase(baseRef, baseRefName)) {
      console.error('anti-slop: --base cannot be locked; use a direct ref, full OID, or HEAD~n');
      return 2;
    }
    if (requireRenames && renames.size === 0) {
      console.error(`anti-slop: no Git renames from ${baseRef} to the index; baseline unchanged`);
      console.error(
        'anti-slop: use the same --base ref as the failing check; if history no longer contains the rename, fix the findings at the new path or re-anchor lint-evidenced moves with `devkit anti-slop adopt-relocations` — create and both gates refuse unevidenced growth',
      );
      return 2;
    }
    const affected = baseline.entries.filter((entry) => renames.has(entry.file));
    const next = migrateBaselineRenames(baseline, renames);
    if (JSON.stringify(next) === JSON.stringify(baseline)) {
      console.log('anti-slop: adopted 0 finding(s) across 0 staged rename(s); baseline unchanged');
      return 0;
    }
    return withStableGitIndex(
      cwd,
      { oid: headOid, symbolicRef: headRef },
      { expression: baseRef, oid: baseOid, symbolicRef: baseRefName },
      candidateTree,
      () => {
        writeBaseline(cwd, next);
        console.log(
          `anti-slop: adopted ${count(affected)} finding(s) across ${new Set(affected.map((entry) => entry.file)).size} staged rename(s); stage ${ANTI_SLOP_BASELINE_REL}`,
        );
        return 0;
      },
    );
  });
}

interface RelocationPlan {
  relocated: RelocatedGroup[];
  bound: AntiSlopBaseline;
  staged: boolean;
}

/**
 * Pair the index's new findings with lint-evidenced vacated debt. Judged against the WORKING-TREE
 * baseline, so a repeated adopt before the baseline is staged finds nothing left to move.
 */
function planRelocations(
  cwd: string,
  baseline: AntiSlopBaseline,
  overlay: boolean,
  baseRef: string,
  expectedTree: string,
): RelocationPlan | null {
  return withStagedAntiSlopSnapshot(
    cwd,
    (snapshot): RelocationPlan | null => {
      // Plan against exactly the tree the write guard re-verifies: a stage-then-revert between the
      // two reads would otherwise persist a re-anchor judged on a tree that is never committed.
      if (snapshot.candidateTree !== expectedTree) {
        throw new Error(
          'anti-slop: Git index changed while relocations were being planned; baseline unchanged; retry',
        );
      }
      const bound = relocationBound(snapshot, baseline);
      if (snapshot.skipped) {
        return { relocated: [], bound, staged: snapshot.changedFiles.length > 0 };
      }
      const pin =
        snapshot.base && snapshot.baseTree
          ? mkdtempSync(join(tmpdir(), 'devkit-anti-slop-capability-'))
          : null;
      try {
        const groups = collectAntiSlopGroups(snapshot.cwd, snapshot.paths, pin ?? undefined);
        const scope = resolveAntiSlopScope(snapshot.cwd, snapshot.paths);
        const selected: AntiSlopBaseline = {
          ...baseline,
          entries: baseline.entries.filter((entry) => scope.includes(entry.file)),
        };
        const allowance = inheritedBaseAllowance(snapshot.cwd, pin, selected, groups, snapshot);
        const { newGroups } = compareBaseline(allowance, groups);
        const vacated = relocationEvidence(
          { cwd: snapshot.cwd, capabilityCwd: pin, inLintScope: scope.includes },
          snapshot,
          baseline,
          groups,
          new Set(newGroups.map(relocationKey)),
        );
        if (vacated === null) return null;
        return {
          relocated: classifyRelocations(newGroups, vacated).relocated,
          bound,
          staged: true,
        };
      } finally {
        if (pin) rmSync(pin, { recursive: true, force: true });
      }
    },
    { overlay, baseRef },
  );
}

export function adoptRelocations(
  cwd: string,
  overlay: boolean,
  baseRef = 'HEAD',
  explicitBase = false,
): number {
  if (!capabilityReady(cwd)) return 2;
  return withLock(join(cwd, ANTI_SLOP_BASELINE_LOCK_REL), () => {
    const baseline = baselineOrExplain(cwd);
    if (!baseline) return 2;
    const identity = gitBaselineEnvelope(cwd, baseRef);
    if (explicitBase && !lockableBase(baseRef, identity.baseRefName)) {
      console.error('anti-slop: --base cannot be locked; use a direct ref, full OID, or HEAD~n');
      return 2;
    }
    if (identity.base && baseline.entries.some((entry) => identity.renames.has(entry.file))) {
      console.error(
        `anti-slop: the baseline still carries debt under renamed path(s); run \`devkit anti-slop adopt-renames${explicitBase ? ` --base ${baseRef}` : ''}\` first; baseline unchanged`,
      );
      return 2;
    }
    const plan = planRelocations(
      cwd,
      baseline,
      overlay,
      identity.baseOid ?? baseRef,
      identity.candidateTree,
    );
    if (plan === null) {
      console.error(
        'anti-slop: relocation evidence unavailable — the base tree could not be linted; baseline unchanged',
      );
      return 2;
    }
    if (plan.relocated.length === 0) {
      if (explicitBase) {
        console.error(
          `anti-slop: no lint-evidenced relocations from ${baseRef} to the index; baseline unchanged`,
        );
        return 2;
      }
      console.log(
        `anti-slop: adopted 0 relocated finding(s); baseline unchanged${plan.staged ? '' : ' — nothing is staged, so stage the moved files first'}`,
      );
      return 0;
    }
    const next = reanchorBaseline(baseline, plan.bound, plan.relocated);
    printRelocatedAntiSlopFindings(plan.relocated);
    return withStableGitIndex(
      cwd,
      { oid: identity.headOid, symbolicRef: identity.headRef },
      { expression: baseRef, oid: identity.baseOid, symbolicRef: identity.baseRefName },
      identity.candidateTree,
      () => {
        writeBaseline(cwd, next);
        const moved = plan.relocated.reduce((sum, group) => sum + group.relocatedCount, 0);
        const sources = plan.relocated.flatMap((group) =>
          group.from.map((credit) => credit.source),
        );
        console.log(
          `anti-slop: re-anchored ${moved} relocated finding(s) from ${formatSources(sources)} into ${formatSources(plan.relocated.map((group) => group.file))}; stage ${ANTI_SLOP_BASELINE_REL}`,
        );
        return 0;
      },
    );
  });
}
