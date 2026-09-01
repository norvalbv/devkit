import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  isJsonObject,
  isJsonString,
  parseJson,
  type JsonValue,
} from '../../comment-firewall/types.mts';
import { BenchAbort } from '../../decisions/eval/bench.mts';
import { runSlotQuestions, type SlotOutcome } from '../../judge/matcher-core.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { AUDIT_RUBRIC, MATCH_CONCURRENCY } from './benchmark-config.mts';
import { decodeSlotOutcome, type CaseResult } from './case-runner.mts';
import type { CheckpointStore } from './checkpoint.mts';
import type { CompletenessCase } from './cases.mts';
import { sha12 } from './benchmark-identity.mts';
import { type DecoySlot, type Finding, type GoldSlot, kappa } from './matcher.mts';
import { type BenchSummary, CEILING_FALSE_FLAG, FLOOR_GAP_RECALL } from './scoring.mts';
import { completenessSlotKey } from './variant-consistency.mts';

interface AuditLabel {
  caseId: string;
  slotId: string;
  match: string;
}

interface TranscriptAudit {
  reviewerModel?: string;
  outcomes: { slotId: string; match: number }[];
}

const AUDIT_MATCH_RE = /^(?:NONE|F[1-9]\d*)$/i;

export interface MatcherAuditResult {
  n: number;
  agree: number;
  kappa: number;
  missing: string[];
}

function parseAuditLabels(labelsText: string): AuditLabel[] {
  return labelsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const value = parseJson(line);
      if (
        !isJsonObject(value) ||
        !isJsonString(value.caseId) ||
        !isJsonString(value.slotId) ||
        !isJsonString(value.match) ||
        !AUDIT_MATCH_RE.test(value.match)
      )
        throw new BenchAbort(2, `completeness-eval: malformed audit label on row ${index + 1}`);
      return { caseId: value.caseId, slotId: value.slotId, match: value.match };
    });
}

export function matcherAudit(
  labelsText: string,
  readTranscript: (caseId: string) => TranscriptAudit | null,
  expectedReviewerModel?: string,
): MatcherAuditResult {
  const labels = parseAuditLabels(labelsText);
  if (!labels.length) throw new BenchAbort(2, 'completeness-eval: no audit labels');
  const a: string[] = [];
  const b: string[] = [];
  const missing: string[] = [];
  for (const l of labels) {
    const t = readTranscript(l.caseId);
    if (t && expectedReviewerModel && t.reviewerModel !== expectedReviewerModel)
      throw new BenchAbort(
        2,
        `completeness-eval: legacy matcher-audit labels are bound to reviewer=${expectedReviewerModel}, but transcript ${l.caseId} records reviewer=${t.reviewerModel ?? 'unknown'} — refusing transcript-local F<n> comparison`,
      );
    const o = t?.outcomes.find((x) => x.slotId === l.slotId);
    if (!o) {
      missing.push(`${l.caseId}::${l.slotId}`);
      continue;
    }
    a.push(l.match.toUpperCase());
    b.push(o.match === 0 ? 'NONE' : `F${o.match}`);
  }
  const agree = a.filter((x, i) => x === b[i]).length;
  return { n: a.length, agree, kappa: kappa(a, b), missing };
}

// ─── Orchestration ────────────────────────────────────────────────────────────────

function independentAuditPrompt(
  row: CompletenessCase,
  slot: GoldSlot | DecoySlot,
  findings: Finding[],
): string {
  const rendered = findings
    .map(
      (finding, i) =>
        `F${i + 1}: ${finding.severity}: ${finding.desc} | ${finding.paths || '(no paths)'} | ${finding.impact || '(no impact)'}${finding.context.length ? `\n  Context: ${finding.context.join(' ')}` : ''}`,
    )
    .join('\n');
  const paths =
    'paths' in slot && slot.paths?.length ? `\nPATH HINTS: ${slot.paths.join(', ')}` : '';
  return [
    'You are calibrating another LLM matcher, not reviewing the code change.',
    AUDIT_RUBRIC,
    `CASE: ${row.id}`,
    'NUMBERED FINDINGS:',
    rendered,
    `AUDIT SLOT: ${slot.desc}${paths}`,
  ].join('\n\n');
}

export interface AuditCheckpointValue {
  outcome: SlotOutcome;
}

export function reusableAuditCheckpoint(value: JsonValue): AuditCheckpointValue | undefined {
  if (!isJsonObject(value)) return undefined;
  const outcome = decodeSlotOutcome(value.outcome);
  return outcome ? { outcome } : undefined;
}

export const completenessAuditInputHash = (
  row: CompletenessCase,
  result: Pick<CaseResult, 'findings' | 'auditOutcomes'>,
): string =>
  sha12(JSON.stringify({ row, findings: result.findings, primary: result.auditOutcomes }));

/** Cross-model audit over the CURRENT findings, so F<n> labels can never refer to an old run. */
export async function runIndependentMatcherAudit(
  rows: CompletenessCase[],
  results: CaseResult[],
  {
    model,
    exec = execJudgeAsync,
    checkpoint,
  }: {
    model: string;
    exec?: typeof execJudgeAsync;
    checkpoint?: CheckpointStore<AuditCheckpointValue>;
  },
): Promise<{ model: string; n: number; agree: number; kappa: number; missing: string[] }> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const independent: string[] = [];
  const primary: string[] = [];
  const missing: string[] = [];
  for (const result of results) {
    if (result.outage || !result.score) continue;
    if (!result.findings) {
      missing.push(result.id);
      continue;
    }
    const row = byId.get(result.id);
    if (!row) {
      missing.push(result.id);
      continue;
    }
    const slots = [
      ...row.gold.map((slot) => ({
        slotId: completenessSlotKey(result.id, slot.id),
        kind: 'gold' as const,
        prompt: independentAuditPrompt(row, slot, result.findings!),
      })),
      ...row.decoys.map((slot) => ({
        slotId: completenessSlotKey(result.id, slot.id),
        kind: 'decoy' as const,
        prompt: independentAuditPrompt(row, slot, result.findings!),
      })),
    ];
    const inputHash = completenessAuditInputHash(row, result);
    const resumeOutcomes = slots.flatMap((slot) => {
      const saved = checkpoint?.take(slot.slotId, inputHash);
      return saved ? [saved.outcome] : [];
    });
    const audited = await runSlotQuestions(slots, result.findings.length, {
      model,
      runs: 1,
      concurrency: MATCH_CONCURRENCY,
      exec,
      labelPrefix: 'completeness-eval-audit',
      resumeOutcomes,
      onSlotComplete: (outcome) => {
        if (!outcome.outage) checkpoint?.record(outcome.slotId, inputHash, { outcome });
      },
    });
    const primaryBySlot = new Map(
      (result.auditOutcomes ?? []).map((outcome) => [
        completenessSlotKey(result.id, outcome.slotId),
        outcome,
      ]),
    );
    for (const audit of audited) {
      const match = primaryBySlot.get(audit.slotId);
      if (audit.outage || !match || match.outage) {
        missing.push(audit.slotId);
        continue;
      }
      independent.push(audit.match === 0 ? 'NONE' : `F${audit.match}`);
      primary.push(match.match === 0 ? 'NONE' : `F${match.match}`);
    }
  }
  const agree = independent.filter((value, i) => value === primary[i]).length;
  return {
    model,
    n: independent.length,
    agree,
    kappa: kappa(independent, primary),
    missing,
  };
}

export interface BaselineEligibility {
  eligible: boolean;
  floorBreached: boolean;
  reasons: string[];
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function rateMatches(value: number, numerator: number, denominator: number): boolean {
  const expected = denominator === 0 ? 0 : numerator / denominator;
  return Math.abs(value - expected) <= Number.EPSILON;
}

/** Baseline evidence is admissible only when quality floors and measurement integrity all hold. */
export function completenessBaselineEligibility(summary: BenchSummary): BaselineEligibility {
  const reasons: string[] = [];
  const recallInvalid =
    !Number.isFinite(summary.gapRecall) || summary.gapRecall < 0 || summary.gapRecall > 1;
  const falseFlagInvalid =
    !Number.isFinite(summary.falseFlagRate) ||
    summary.falseFlagRate < 0 ||
    summary.falseFlagRate > 1;
  const floorBreached =
    recallInvalid ||
    falseFlagInvalid ||
    summary.gapRecall < FLOOR_GAP_RECALL ||
    summary.falseFlagRate > CEILING_FALSE_FLAG;
  if (recallInvalid) reasons.push('gap recall is not a finite rate between 0 and 1');
  else if (summary.gapRecall < FLOOR_GAP_RECALL)
    reasons.push(`gap recall ${summary.gapRecall.toFixed(2)} is below ${FLOOR_GAP_RECALL}`);
  if (falseFlagInvalid) reasons.push('false-flag rate is not a finite rate between 0 and 1');
  else if (summary.falseFlagRate > CEILING_FALSE_FLAG)
    reasons.push(
      `false-flag rate ${summary.falseFlagRate.toFixed(2)} exceeds ${CEILING_FALSE_FLAG}`,
    );
  for (const [label, value] of [
    ['reviewer model', summary.reviewerModel],
    ['matcher model', summary.matchModel],
    ['completeness MCP capability fingerprint', summary.mcpCapabilityFingerprint],
    ['gate hash', summary.gateHash],
    ['matcher hash', summary.matcherHash],
    ['corpus hash', summary.corpusHash],
  ] as const)
    if (!isJsonString(value) || !value.trim()) reasons.push(`${label} was not recorded`);
  if (!Number.isInteger(summary.matchRuns) || summary.matchRuns <= 0)
    reasons.push('matcher run count is not a positive integer');

  const countPairs = [
    ['case outages', summary.cases, summary.caseOutages],
    ['gold hits', summary.gold.total, summary.gold.hit],
    ['decoy flags', summary.decoys.total, summary.decoys.flagged],
    ['recorded-decision flags', summary.decoys.recorded.total, summary.decoys.recorded.flagged],
    ['finding matches', summary.findings.total, summary.findings.matched],
    ['finding spurious count', summary.findings.total, summary.findings.spurious],
    ['severity exact count', summary.severity.total, summary.severity.exact],
    ['verdict correct count', summary.verdicts.total, summary.verdicts.correct],
  ] as const;
  for (const [label, total, part] of countPairs) {
    if (!isNonNegativeInteger(total) || !isNonNegativeInteger(part) || part > total)
      reasons.push(`${label} is outside its non-negative total`);
  }
  if (!isNonNegativeInteger(summary.slotOutages))
    reasons.push('slot outage count is not a non-negative integer');
  if (!isNonNegativeInteger(summary.outages))
    reasons.push('outage count is not a non-negative integer');
  else {
    if (summary.outages !== summary.caseOutages + summary.slotOutages)
      reasons.push('outage count does not equal case plus slot outages');
    if (summary.outages > 0) reasons.push(`${summary.outages} outage(s) taint the run`);
  }
  if (
    isNonNegativeInteger(summary.cases) &&
    isNonNegativeInteger(summary.caseOutages) &&
    Object.keys(summary.rows).length + summary.caseOutages !== summary.cases
  )
    reasons.push('case count does not equal measured rows plus case outages');
  if (
    isNonNegativeInteger(summary.findings.total) &&
    isNonNegativeInteger(summary.findings.matched) &&
    isNonNegativeInteger(summary.findings.spurious) &&
    summary.findings.matched + summary.findings.spurious !== summary.findings.total
  )
    reasons.push('finding matches plus spurious findings do not equal total findings');
  if (
    isNonNegativeInteger(summary.decoys.total) &&
    isNonNegativeInteger(summary.decoys.flagged) &&
    isNonNegativeInteger(summary.decoys.recorded.total) &&
    isNonNegativeInteger(summary.decoys.recorded.flagged) &&
    (summary.decoys.recorded.total > summary.decoys.total ||
      summary.decoys.recorded.flagged > summary.decoys.flagged)
  )
    reasons.push('recorded-decision counts exceed their enclosing decoy counts');
  if (
    !recallInvalid &&
    isNonNegativeInteger(summary.gold.total) &&
    isNonNegativeInteger(summary.gold.hit) &&
    summary.gold.hit <= summary.gold.total &&
    !rateMatches(summary.gapRecall, summary.gold.hit, summary.gold.total)
  )
    reasons.push('gap recall does not match gold hit/total counts');
  if (
    !falseFlagInvalid &&
    isNonNegativeInteger(summary.decoys.total) &&
    isNonNegativeInteger(summary.decoys.flagged) &&
    summary.decoys.flagged <= summary.decoys.total &&
    !rateMatches(summary.falseFlagRate, summary.decoys.flagged, summary.decoys.total)
  )
    reasons.push('false-flag rate does not match decoy flagged/total counts');
  if (!summary.matcherAudit) reasons.push('matcher audit was not recorded');
  else {
    if (!isJsonString(summary.matcherAudit.model) || !summary.matcherAudit.model.trim())
      reasons.push('matcher audit model was not recorded');
    else if (summary.matcherAudit.model !== summary.reviewerModel)
      reasons.push(
        `matcher audit model ${summary.matcherAudit.model} does not match reviewer ${summary.reviewerModel}`,
      );
    if (!Number.isInteger(summary.matcherAudit.missing) || summary.matcherAudit.missing < 0)
      reasons.push('matcher-audit missing count is not a non-negative integer');
    else if (summary.matcherAudit.missing !== 0)
      reasons.push(`${summary.matcherAudit.missing} matcher-audit slot(s) lack fresh outcomes`);
    if (
      !Number.isInteger(summary.matcherAudit.agree) ||
      summary.matcherAudit.agree < 0 ||
      summary.matcherAudit.agree > summary.matcherAudit.n
    )
      reasons.push('matcher-audit agreement count is outside its measured sample');
    if (
      !Number.isInteger(summary.matcherAudit.n) ||
      summary.matcherAudit.n <= 0 ||
      !Number.isFinite(summary.matcherAudit.kappa) ||
      summary.matcherAudit.kappa > 1 ||
      summary.matcherAudit.kappa < 0.7
    )
      reasons.push('matcher audit sample or κ is invalid or below 0.700');
  }
  return { eligible: reasons.length === 0, floorBreached, reasons };
}

/** Refuses before touching the file, then atomically replaces it so a failed write cannot erase
 * previously accepted evidence. */
export function writeCompletenessBaseline(
  file: string,
  baseline: { completeness?: BenchSummary },
  summary: BenchSummary,
): void {
  const eligibility = completenessBaselineEligibility(summary);
  if (!eligibility.eligible)
    throw new BenchAbort(
      eligibility.floorBreached ? 1 : 2,
      `completeness-eval: refusing baseline write — ${eligibility.reasons.join('; ')}`,
    );
  const contents = `${JSON.stringify({ ...baseline, completeness: summary }, null, 2)}\n`;
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
