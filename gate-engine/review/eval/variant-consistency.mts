interface VariantRow {
  id: string;
  variantOf?: string | null;
  variantKind?: 'invariance' | 'directional' | null;
  gold: Array<{ id: string }>;
  decoys: Array<{ id: string }>;
}

interface VariantSummary {
  slots: Record<string, { ok: boolean }>;
}

interface MetricSlot {
  slotId: string;
  kind: 'gold' | 'decoy';
  got: string;
  ok: boolean;
  stable: boolean;
  outage: boolean;
}

interface SlotSummaryTarget {
  slotOutages: number;
  gold: { total: number; hit: number };
  rows: Record<string, { ok: boolean; stable: boolean }>;
  slots: Record<
    string,
    { kind: 'gold' | 'decoy'; got: string; ok: boolean; stable: boolean; expected: string }
  >;
}

interface OpenEndedSummaryTarget extends SlotSummaryTarget {
  caseOutages: number;
  findings: { total: number; matched: number; spurious: number };
}

interface FinalSummaryTarget extends OpenEndedSummaryTarget {
  outages: number;
  gapRecall: number;
  falseFlagRate: number;
  decoys: { total: number; flagged: number };
  verdicts: { total: number; correct: number };
}

/** Collision-free record/checkpoint key for corpus ids, which may contain any string content. */
export const completenessSlotKey = (caseId: string, slotId: string): string =>
  JSON.stringify([caseId, slotId]);

/** Common zero state for the two open-ended reviewer benchmark summaries. */
export function openEndedSummary(cases: number) {
  const rows: Record<string, { ok: boolean; stable: boolean }> = Object.create(null);
  return {
    cases,
    caseOutages: 0,
    slotOutages: 0,
    outages: 0,
    gold: { total: 0, hit: 0 },
    findings: { total: 0, matched: 0, spurious: 0 },
    verdicts: { total: 0, correct: 0 },
    gapRecall: 0,
    falseFlagRate: 0,
    rows,
    slots: {},
  };
}

/** Accumulate the slot metrics shared by open-ended reviewer benchmarks. */
export function accumulateSlotMetrics(
  caseId: string,
  slots: readonly MetricSlot[],
  summary: SlotSummaryTarget,
): MetricSlot[] {
  let caseOk = true;
  let caseStable = true;
  const measured: MetricSlot[] = [];
  for (const slot of slots) {
    if (slot.outage) {
      summary.slotOutages += 1;
      continue;
    }
    summary.slots[completenessSlotKey(caseId, slot.slotId)] = {
      kind: slot.kind,
      got: slot.got,
      ok: slot.ok,
      stable: slot.stable,
      expected: slot.kind === 'gold' ? 'hit' : 'clean',
    };
    caseOk &&= slot.ok;
    caseStable &&= slot.stable;
    if (slot.kind === 'gold') {
      summary.gold.total += 1;
      if (slot.ok) summary.gold.hit += 1;
    }
    measured.push(slot);
  }
  summary.rows[caseId] = { ok: caseOk, stable: caseStable };
  return measured;
}

/** Join rows/results, count case outages, and accumulate every measured slot once. */
export function measuredCaseMetrics<
  Row extends { id: string },
  Score extends { slots: readonly MetricSlot[] },
  Result extends { id: string; outage: boolean; score: Score | null },
>(rows: readonly Row[], results: readonly Result[], summary: OpenEndedSummaryTarget) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const measured: Array<{ row: Row; result: Result; score: Score; slots: MetricSlot[] }> = [];
  for (const result of results) {
    const row = byId.get(result.id);
    if (!row) continue;
    const score = result.score;
    if (result.outage || !score) {
      summary.caseOutages += 1;
      continue;
    }
    measured.push({
      row,
      result,
      score,
      slots: accumulateSlotMetrics(result.id, score.slots, summary),
    });
  }
  return measured;
}

/** Count raw, matched, and spurious findings from one measured case. */
export function accumulateFindingMetrics(
  score: { findingCount: number; spurious: readonly number[] },
  summary: OpenEndedSummaryTarget,
): void {
  summary.findings.total += score.findingCount;
  summary.findings.spurious += score.spurious.length;
  summary.findings.matched += score.findingCount - score.spurious.length;
}

/** Count an informational verdict, matching the gates' null-verdict-as-PASS behavior. */
export function accumulateVerdictMetric(
  expected: 'PASS' | 'FAIL' | undefined,
  observed: string | null,
  summary: FinalSummaryTarget,
): void {
  if (!expected) return;
  summary.verdicts.total += 1;
  if ((observed ?? 'PASS') === expected) summary.verdicts.correct += 1;
}

/** Finalize the headline rates shared by open-ended reviewer benchmarks. */
export function finalizeOpenEndedSummary(summary: FinalSummaryTarget): void {
  const rate = (numerator: number, denominator: number) =>
    denominator ? numerator / denominator : 0;
  summary.outages = summary.caseOutages + summary.slotOutages;
  summary.gapRecall = rate(summary.gold.hit, summary.gold.total);
  summary.falseFlagRate = rate(summary.decoys.flagged, summary.decoys.total);
}

/** Compare invariance variants by semantic slot outcome at each shared kind/ordinal position. */
export function variantConsistency(rows: VariantRow[], summary: VariantSummary) {
  const groups = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.variantOf || row.variantKind !== 'invariance') continue;
    const members = groups.get(row.variantOf) ?? new Set([row.variantOf]);
    members.add(row.id);
    groups.set(row.variantOf, members);
  }
  if (!groups.size) return null;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pattern = (caseId: string) => {
    const row = byId.get(caseId);
    if (!row) return null;
    const outcomes = [
      ...row.gold.map((slot, index) => ({ key: `gold[${index}]`, slotId: slot.id })),
      ...row.decoys.map((slot, index) => ({ key: `decoy[${index}]`, slotId: slot.id })),
    ];
    const values = outcomes.map(({ key, slotId }) => {
      const outcome = summary.slots[completenessSlotKey(caseId, slotId)];
      return outcome === undefined ? null : `${key}=${outcome.ok ? 'ok' : 'not-ok'}`;
    });
    if (values.some((value) => value === null)) return null;
    return values.sort().join(',');
  };
  let consistent = 0;
  const broken: string[] = [];
  for (const [group, members] of groups) {
    const values = [...members].map(pattern);
    const patterns = new Set(values);
    if (!values.includes(null) && patterns.size === 1) consistent += 1;
    else broken.push(group);
  }
  return { consistent, total: groups.size, broken };
}
