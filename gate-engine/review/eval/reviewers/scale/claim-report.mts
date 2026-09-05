/** Sanitized, occurrence-weighted descriptive results for a selected historical replay cohort. */
import { z } from 'zod';
import {
  sha256,
  type ClaimInventory,
  type ClaimOccurrence,
  type ClaimTask,
} from './claim-inventory.mts';
import { validateClaimJudgments, type ClaimJudgment } from './claim-judgments.mts';
import { isCodexModel } from '../../../../judge/codex/result.mts';

const ADJUDICATION_BASES = [
  'HUMAN',
  'CROSS_FAMILY',
  'SAME_FAMILY',
  'UNKNOWN_FAMILY',
  'UNADJUDICATED',
] as const;
function modelFamily(model: string | null | undefined): 'openai' | 'anthropic' | null {
  if (!model) return null;
  if (isCodexModel(model.replace(/^openai\//, ''))) return 'openai';
  return /^(?:claude-|(?:sonnet|opus|haiku)(?:$|[-@:]))/.test(model.replace(/^anthropic\//, ''))
    ? 'anthropic'
    : null;
}
function adjudicationBasis(
  judgment: ClaimJudgment | undefined,
  sourceModel: string | null,
): (typeof ADJUDICATION_BASES)[number] {
  if (!judgment) return 'UNADJUDICATED';
  if (judgment.adjudicator.tier === 'HUMAN') return 'HUMAN';
  const source = modelFamily(sourceModel);
  const adjudicator = modelFamily(judgment.adjudicator.model);
  if (!source || !adjudicator) return 'UNKNOWN_FAMILY';
  return source === adjudicator ? 'SAME_FAMILY' : 'CROSS_FAMILY';
}

type Assessment = 'valid' | 'invalid' | 'unresolved';
interface PrecisionCounts {
  valid: number;
  invalid: number;
  unresolved: number;
  captured: number;
  resolvedPrecision: number | null;
  resolvedCoverage: number | null;
  bounds: [number, number] | null;
}

function exactForJudgment(task: ClaimTask): boolean {
  return (
    task.captureExact &&
    !task.errors.some((e) =>
      [
        'missing-diff',
        'unreadable-diff-archive',
        'invalid-diff-archive',
        'diff-hash-mismatch',
        'task-diff-mismatch',
        'invalid-capture',
        'legacy-identity',
      ].includes(e),
    )
  );
}

function supportedContext(judgment: ClaimJudgment | undefined): boolean {
  return (
    judgment?.contextBasis === 'PROVEN_ORIGINAL_INPUT' ||
    judgment?.contextBasis === 'RECONSTRUCTED_FROM_VERIFIED_BASE'
  );
}

function assess(j: ClaimJudgment | undefined, exact: boolean, scoped: boolean): Assessment {
  if (!exact || !j || !supportedContext(j) || j.truth === 'UNSURE') return 'unresolved';
  if (j.truth === 'NOT') return 'invalid';
  if (!scoped) return 'valid';
  if (j.changeScope === 'PRE_EXISTING' || j.charterScope === 'OUT_OF_CHARTER') return 'invalid';
  return j.changeScope === 'INTRODUCED' && j.charterScope === 'IN_CHARTER' ? 'valid' : 'unresolved';
}

function precision(states: Assessment[]): PrecisionCounts {
  const valid = states.filter((s) => s === 'valid').length;
  const invalid = states.filter((s) => s === 'invalid').length;
  const unresolved = states.length - valid - invalid;
  return {
    valid,
    invalid,
    unresolved,
    captured: states.length,
    resolvedPrecision: valid + invalid ? valid / (valid + invalid) : null,
    resolvedCoverage: states.length ? (valid + invalid) / states.length : null,
    bounds: states.length ? [valid / states.length, (valid + unresolved) / states.length] : null,
  };
}

function isBlocking(claim: ClaimOccurrence): boolean {
  return (
    claim.itemStatus.toLowerCase() === 'fail' &&
    claim.disposition !== 'waived' &&
    claim.disposition !== 'dropped_out_of_charter'
  );
}

const rank = new Map([
  ['pass', 0],
  ['inconclusive', 1],
  ['error', 2],
  ['unknown', 2],
  ['fail', 3],
]);
interface ParentResult {
  idHash: string;
  status: string;
  category: 'known-only' | 'extra-only' | 'both' | 'unresolved' | 'not-blocked';
  removingExtrasClearsParent: boolean | null;
  invalidOnly: boolean | null;
  completeRoster: boolean;
  supersededTasks: number;
  ambiguousRetryTasks: number;
}

function parentResult(
  tasks: ClaimTask[],
  inventory: ClaimInventory,
  judgments: Map<string, ClaimJudgment>,
): ParentResult {
  const parent = tasks[0].parentReplay!;
  const expected = [...parent.expectedTaskKeys].sort();
  const result: ParentResult = {
    idHash: sha256(parent.id),
    status: 'unknown',
    category: 'unresolved',
    removingExtrasClearsParent: null,
    invalidOnly: null,
    completeRoster: false,
    supersededTasks: 0,
    ambiguousRetryTasks: 0,
  };
  const same = tasks.every(
    (task) =>
      JSON.stringify([...task.parentReplay!.expectedTaskKeys].sort()) ===
        JSON.stringify(expected) &&
      task.namespace === tasks[0].namespace &&
      task.diffSha256 === tasks[0].diffSha256 &&
      task.model === tasks[0].model &&
      task.arm === tasks[0].arm &&
      task.identity === tasks[0].identity,
  );
  const selected = new Map<string, { at: number | null; tasks: ClaimTask[] }>();
  for (const task of tasks) {
    const timestamp = z.iso.datetime({ offset: true }).safeParse(task.at);
    const at = timestamp.success ? Date.parse(timestamp.data) : null;
    const previous = selected.get(task.key);
    if (!previous || (at !== null && (previous.at === null || at > previous.at)))
      selected.set(task.key, { at, tasks: [task] });
    else if (at === previous.at) previous.tasks.push(task);
  }
  const active = [...selected.values()].flatMap((selected) => selected.tasks);
  result.supersededTasks = tasks.length - active.length;
  result.ambiguousRetryTasks = [...selected.values()].filter(
    (selected) => selected.tasks.length > 1,
  ).length;
  result.status = active.reduce((status, task) => {
    const normalized = rank.has(task.status) ? task.status : 'unknown';
    return (rank.get(normalized) ?? 2) > (rank.get(status) ?? 2) ? normalized : status;
  }, 'pass');
  result.completeRoster =
    same && expected.length === selected.size && expected.every((key) => selected.has(key));
  if (result.ambiguousRetryTasks) {
    result.status = 'unknown';
    return result;
  }
  if (
    !result.completeRoster ||
    active.some(
      (task) =>
        !task.terminal ||
        task.errors.includes('invalid-scope') ||
        task.errors.includes('invalid-capture'),
    )
  )
    return result;
  if (result.status === 'pass') {
    result.category = 'not-blocked';
    result.removingExtrasClearsParent = false;
    result.invalidOnly = false;
    return result;
  }
  if (active.some((task) => !['complete', 'skipped'].includes(task.coverage))) return result;
  const failing = active.filter((task) => task.status === 'fail');
  if (failing.some((task) => !exactForJudgment(task) || task.missingClaims)) return result;
  const failingIds = new Set(failing.map((task) => task.taskId));
  const claims = inventory.occurrences.filter(
    (claim) => failingIds.has(claim.taskId) && isBlocking(claim),
  );
  if (!claims.length) return result;
  if (claims.some((claim) => !supportedContext(judgments.get(claim.occurrenceId)))) return result;
  const states = claims.map((claim) => {
    const task = failing.find((t) => t.taskId === claim.taskId)!;
    return assess(judgments.get(claim.occurrenceId), exactForJudgment(task), true);
  });
  result.invalidOnly = states.includes('unresolved') ? null : states.every((s) => s === 'invalid');
  if (
    claims.some(
      (claim) =>
        judgments.get(claim.occurrenceId)?.labelComparison?.basis !== 'FULL_DEFECT_EVIDENCE',
    )
  )
    return result;
  const relations = claims.map((claim) => judgments.get(claim.occurrenceId)?.knownLabelRelation);
  if (relations.some((r) => r !== 'SAME_DEFECT' && r !== 'DISTINCT')) return result;
  const known = relations.includes('SAME_DEFECT');
  const extra = relations.includes('DISTINCT');
  result.category = known && extra ? 'both' : known ? 'known-only' : 'extra-only';
  result.removingExtrasClearsParent = result.category === 'extra-only';
  return result;
}

function repeatBurden(
  claims: ClaimOccurrence[],
  judgments: Map<string, ClaimJudgment>,
  invalid: Set<string>,
) {
  const groups = new Map<string, number>();
  let ungrouped = 0;
  for (const claim of claims)
    if (invalid.has(claim.occurrenceId)) {
      const group = judgments.get(claim.occurrenceId)?.duplicateGroup;
      if (!group) ungrouped += 1;
      else groups.set(group, (groups.get(group) ?? 0) + 1);
    }
  return {
    invalidOccurrences: invalid.size,
    adjudicatedSemanticGroups: groups.size,
    ungroupedInvalidOccurrences: ungrouped,
    repeatedInvalidOccurrences: [...groups.values()].reduce((n, count) => n + count - 1, 0),
  };
}

function dimensionCounts<Field extends 'truth' | 'changeScope' | 'charterScope' | 'contextBasis'>(
  claims: ClaimOccurrence[],
  judgments: Map<string, ClaimJudgment>,
  field: Field,
  values: readonly ClaimJudgment[Field][],
) {
  return Object.fromEntries(
    [...values, 'UNADJUDICATED'].map((value) => [
      value,
      claims.filter(
        (claim) => (judgments.get(claim.occurrenceId)?.[field] ?? 'UNADJUDICATED') === value,
      ).length,
    ]),
  );
}

export function claimReport(inventory: ClaimInventory, judgmentJson: string) {
  const judgments = new Map(
    validateClaimJudgments(judgmentJson, inventory).map((j) => [j.occurrenceId, j]),
  );
  const tasks = new Map(inventory.tasks.map((task) => [task.taskId, task]));
  const bases = new Map(
    inventory.occurrences.map((claim) => [
      claim.occurrenceId,
      adjudicationBasis(judgments.get(claim.occurrenceId), tasks.get(claim.taskId)?.model ?? null),
    ]),
  );
  const eligibleJudgments = new Map(
    [...judgments].filter(([id]) => bases.get(id) === 'HUMAN' || bases.get(id) === 'CROSS_FAMILY'),
  );
  const claims = inventory.occurrences.filter((claim) => tasks.get(claim.taskId)?.terminal);
  const states = (scoped: boolean) =>
    claims.map((claim) =>
      assess(
        eligibleJudgments.get(claim.occurrenceId),
        exactForJudgment(tasks.get(claim.taskId)!),
        scoped,
      ),
    );
  const scoped = states(true);
  const invalid = new Set(
    claims.filter((_, i) => scoped[i] === 'invalid').map((c) => c.occurrenceId),
  );
  const parents = new Map<string, ClaimTask[]>();
  for (const task of inventory.tasks)
    if (task.parentReplay) {
      const key = JSON.stringify([task.namespace, task.parentReplay.id]);
      parents.set(key, [...(parents.get(key) ?? []), task]);
    }
  const parentResults = [...parents.values()].map((group) =>
    parentResult(group, inventory, eligibleJudgments),
  );
  const byCode: Record<string, number> = {};
  for (const error of inventory.errors) byCode[error.code] = (byCode[error.code] ?? 0) + 1;
  return {
    schemaVersion: 1,
    cohort: inventory.cohort,
    interpretation:
      'Conditional on historical FAIL-selected replay inputs; not production precision or repeat-block frequency. Extras are not false positives. Captured-only bounds exclude tasks with unknown claim counts.',
    inventoryHash: sha256(JSON.stringify(inventory)),
    adjudication: {
      eligibility:
        'Human or known cross-family AI judgments with verified context can qualify precision and parent attribution. Same-family and unknown-family AI judgments remain unresolved; all raw judgments remain recorded.',
      primaryTerminalBasisCounts: Object.fromEntries(
        ADJUDICATION_BASES.map((basis) => [
          basis,
          claims.filter((claim) => bases.get(claim.occurrenceId) === basis).length,
        ]),
      ),
      judgmentSetHash: sha256(
        JSON.stringify(
          [...judgments.values()].sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId)),
        ),
      ),
      tiers: Object.fromEntries(
        ['AI', 'HUMAN', 'HUMAN_WITH_AI'].map((tier) => [
          tier,
          [...judgments.values()].filter((judgment) => judgment.adjudicator.tier === tier).length,
        ]),
      ),
      primaryTerminalTiers: Object.fromEntries(
        ['AI', 'HUMAN', 'HUMAN_WITH_AI'].map((tier) => [
          tier,
          claims.filter((claim) => judgments.get(claim.occurrenceId)?.adjudicator.tier === tier)
            .length,
        ]),
      ),
    },
    diffHashes: [...new Set(inventory.tasks.map((t) => t.diffSha256))].sort(),
    counts: {
      tasks: inventory.tasks.length,
      terminalTasks: inventory.tasks.filter((t) => t.terminal).length,
      capturedOccurrences: inventory.occurrences.length,
      primaryTerminalOccurrences: claims.length,
      nonterminalOccurrences: inventory.occurrences.length - claims.length,
      copiedTasks: inventory.copiedTasks,
      missingUnknownClaimTasks: inventory.tasks.filter((t) => t.missingClaims).length,
      terminalMissingUnknownClaimTasks: inventory.tasks.filter((t) => t.terminal && t.missingClaims)
        .length,
      exactCaptureTasks: inventory.tasks.filter((t) => t.captureExact).length,
      coverageCompleteTasks: inventory.tasks.filter((t) => t.coverage === 'complete').length,
      coverageIncompleteTasks: inventory.tasks.filter((t) => t.coverage === 'incomplete').length,
      coverageUnknownTasks: inventory.tasks.filter((t) => t.coverage === 'unknown').length,
      coverageSkippedTasks: inventory.tasks.filter((t) => t.coverage === 'skipped').length,
      unparentedTasks: inventory.tasks.filter((t) => !t.parentReplay).length,
    },
    factualPrecision: precision(states(false)),
    introducedInCharterPrecision: precision(scoped),
    recordedDimensionCounts: {
      population: 'primary-terminal-captured-occurrences',
      truth: dimensionCounts(claims, judgments, 'truth', ['REAL', 'NOT', 'UNSURE']),
      changeScope: dimensionCounts(claims, judgments, 'changeScope', [
        'INTRODUCED',
        'PRE_EXISTING',
        'NOT_APPLICABLE',
        'UNSURE',
      ]),
      charterScope: dimensionCounts(claims, judgments, 'charterScope', [
        'IN_CHARTER',
        'OUT_OF_CHARTER',
        'NOT_APPLICABLE',
        'UNSURE',
      ]),
      contextBasis: dimensionCounts(claims, judgments, 'contextBasis', [
        'PROVEN_ORIGINAL_INPUT',
        'RECONSTRUCTED_FROM_VERIFIED_BASE',
        'PATCH_APPLICATION_ONLY',
        'UNVERIFIED',
      ]),
    },
    repeatedInvalidBurden: repeatBurden(claims, judgments, invalid),
    semanticRelationCounts: Object.fromEntries(
      ['SAME_DEFECT', 'DISTINCT', 'PARTIAL_OVERLAP', 'UNSURE', 'NOT_COMPARED'].map((relation) => [
        relation,
        claims.filter(
          (c) => (judgments.get(c.occurrenceId)?.knownLabelRelation ?? 'NOT_COMPARED') === relation,
        ).length,
      ]),
    ),
    parents: {
      total: parentResults.length,
      categories: Object.fromEntries(
        ['known-only', 'extra-only', 'both', 'unresolved', 'not-blocked'].map((category) => [
          category,
          parentResults.filter((p) => p.category === category).length,
        ]),
      ),
      removingExtrasClears: parentResults.filter((p) => p.removingExtrasClearsParent === true)
        .length,
      invalidOnlyBlocks: parentResults.filter((p) => p.invalidOnly === true).length,
      invalidOnlyUnresolved: parentResults.filter((p) => p.invalidOnly === null).length,
      results: parentResults,
    },
    completenessErrors: byCode,
    uncertainty:
      'Descriptive occurrence counts and unresolved-label bounds; no independent-occurrence confidence interval. Any sampling interval must cluster by source diff or episode.',
  };
}
