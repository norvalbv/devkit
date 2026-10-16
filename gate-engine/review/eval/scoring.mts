import { wilson } from '../../decisions/eval/bench.mts';
import { MATCH_MODEL, MATCH_RUNS } from './benchmark-config.mts';
import { consistentReviewerModel, type CaseResult } from './case-runner.mts';
import type { CompletenessCase } from './cases.mts';
import {
  accumulateFindingMetrics,
  accumulateVerdictMetric,
  compareCaseFlips,
  finalizeOpenEndedSummary,
  measuredCaseMetrics,
  openEndedSummary,
} from './variant-consistency.mts';

export { completenessSlotKey, variantConsistency } from './variant-consistency.mts';

// Hard floors on the safety metrics. Point estimates, not Wilson bounds: the lower bound is too
// wide at this n. Set once from the first honest baseline; never retro-tune a red run green.
export const FLOOR_GAP_RECALL = 0.7;
export const CEILING_FALSE_FLAG = 0.25;

interface SlotRow {
  kind: 'gold' | 'decoy';
  got: string;
  ok: boolean;
  stable: boolean;
  expected: string;
}

export interface BenchSummary {
  reviewerModel: string;
  /** Secret-safe identity of the exact MCP servers/tools available to the completeness judge. */
  mcpCapabilityFingerprint?: string;
  matchModel: string;
  matchRuns: number;
  cases: number;
  caseOutages: number;
  slotOutages: number;
  outages: number;
  gold: { total: number; hit: number };
  decoys: { total: number; flagged: number; recorded: { total: number; flagged: number } };
  findings: { total: number; matched: number; spurious: number };
  severity: { total: number; exact: number; confusion: Record<string, Record<string, number>> };
  verdicts: { total: number; correct: number };
  gapRecall: number;
  falseFlagRate: number;
  rows: Record<string, { ok: boolean; stable: boolean }>;
  slots: Record<string, SlotRow>;
  gateHash?: string;
  matcherHash?: string;
  corpusHash?: string;
  matcherAudit?: { model: string; n: number; agree: number; kappa: number; missing: number };
}

export const fmtCi = (k: number, n: number) => {
  const { lo, hi } = wilson(k, n);
  return `${k}/${n} = ${n ? (k / n).toFixed(2) : '—'} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
};

/** Aggregate per-case results into the summary. Pure — unit-tested on synthetic results. */
export function summarize(
  rows: CompletenessCase[],
  results: CaseResult[],
  {
    reviewerModel = consistentReviewerModel(results),
    matchModel = MATCH_MODEL,
    matchRuns = MATCH_RUNS,
  }: { reviewerModel?: string; matchModel?: string; matchRuns?: number } = {},
): BenchSummary {
  const s: BenchSummary = {
    ...openEndedSummary(results.length),
    reviewerModel,
    matchModel,
    matchRuns,
    decoys: { total: 0, flagged: 0, recorded: { total: 0, flagged: 0 } },
    severity: { total: 0, exact: 0, confusion: {} },
  };
  for (const { row, result, score, slots } of measuredCaseMetrics(rows, results, s)) {
    for (const slot of slots) {
      if (slot.kind === 'gold') continue;
      s.decoys.total += 1;
      const decoy = row.decoys.find((d) => d.id === slot.slotId);
      const flagged = !slot.ok;
      if (flagged) s.decoys.flagged += 1;
      if (decoy?.kind === 'recorded-decision') {
        s.decoys.recorded.total += 1;
        if (flagged) s.decoys.recorded.flagged += 1;
      }
    }
    accumulateFindingMetrics(score, s);
    for (const p of score.severity) {
      s.severity.total += 1;
      if (p.expected === p.got) s.severity.exact += 1;
      s.severity.confusion[p.expected] ??= {};
      s.severity.confusion[p.expected][p.got] = (s.severity.confusion[p.expected][p.got] ?? 0) + 1;
    }
    accumulateVerdictMetric(row.expectedVerdict, result.verdict, s);
  }
  finalizeOpenEndedSummary(s);
  return s;
}

// ─── Baseline comparison — floors + case-level flip gate ──────────────────────────

export function compareCompleteness(summary: BenchSummary, base: BenchSummary | undefined) {
  const lines: string[] = [];
  let regressed = false;
  if (!Number.isFinite(summary.gapRecall) || summary.gapRecall < FLOOR_GAP_RECALL) {
    regressed = true;
    lines.push(
      Number.isFinite(summary.gapRecall)
        ? `  FLOOR BREACH — gap recall ${summary.gapRecall.toFixed(2)} < ${FLOOR_GAP_RECALL} (catastrophic; fails regardless of flip statistics)`
        : '  FLOOR BREACH — gap recall is not finite (catastrophic; fails regardless of flip statistics)',
    );
  }
  if (!Number.isFinite(summary.falseFlagRate) || summary.falseFlagRate > CEILING_FALSE_FLAG) {
    regressed = true;
    lines.push(
      Number.isFinite(summary.falseFlagRate)
        ? `  CEILING BREACH — false-flag rate ${summary.falseFlagRate.toFixed(2)} > ${CEILING_FALSE_FLAG} (catastrophic; fails regardless of flip statistics)`
        : '  CEILING BREACH — false-flag rate is not finite (catastrophic; fails regardless of flip statistics)',
    );
  }
  const finishSkip = (why: string) => {
    lines.push(`  ${why} — regenerate with --baseline; comparison skipped`);
    return { regressed, lines };
  };
  if (summary.outages > 0)
    return finishSkip(`${summary.outages} outage(s) this run — score is suspect`);
  if (!base) return finishSkip('no baseline');
  const skip = (why: string) => ({
    regressed,
    lines: [...lines, `  ${why} — regenerate with --baseline; comparison skipped`],
  });
  for (const k of ['reviewerModel', 'matchModel', 'matchRuns'] as const)
    if (summary[k] !== base[k]) return skip(`baseline config differs (${k})`);
  if (summary.mcpCapabilityFingerprint !== base.mcpCapabilityFingerprint)
    return skip('completeness MCP capabilities differ from the baseline');
  if (base.gateHash && summary.gateHash && base.gateHash !== summary.gateHash)
    return skip('gate code / agent brief changed since the baseline');
  if (base.matcherHash && summary.matcherHash && base.matcherHash !== summary.matcherHash)
    return skip('matcher changed since the baseline');
  if (base.corpusHash && summary.corpusHash && base.corpusHash !== summary.corpusHash)
    return skip('corpus changed since the baseline');
  return { regressed: compareCaseFlips(summary, base, lines) || regressed, lines };
}
