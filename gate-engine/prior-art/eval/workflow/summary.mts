// prior-art workflow tier: K runs per case into the adapter's results block, per condition. Right when
// supplied but wrong when searching is a retrieval failure; wrong both ways, an interpretation one.

import type { Member } from './families.mts';
import type { Condition } from './run.mts';
import {
  addClaims,
  type ClaimCounts,
  emptyClaims,
  type RunScore,
  type SpanStatus,
} from './score.mts';

/** Member id → condition → its aggregated case. */
export type CaseRows = Record<string, Record<Condition, CaseResult>>;

export interface ScoredRun {
  score: RunScore;
  /** Decoy slot id → whether the matcher judged this run to endorse it. */
  endorsed: Record<string, boolean>;
}

export interface CaseResult {
  runs: number;
  outages: number;
  faults: number;
  valid: { ok: number; total: number };
  verdict: string;
  verdictOk: boolean;
  framing: string;
  framingOk: boolean | null;
  legHonest: boolean | null;
  recalled: Record<string, boolean>;
  spans: Record<string, string>;
  claims: ClaimCounts;
  decoyEndorsed: Record<string, boolean>;
}

type Count = { ok: number; total: number };

export interface ConditionMetrics {
  valid: Count;
  verdict: Count;
  framing: Count;
  legHonesty: Count;
  recallOwn: Count;
  recallRef: Count;
  spansRead: Count;
  /** Spans whose file was at least found, read or not. */
  spansLocated: Count;
  claims: ClaimCounts;
  decoyEndorsements: Count;
  genuineAccepted: Count;
  insufficientNatural: Count;
  insufficientArtificial: Count;
  familiesBothSides: Count;
}

export interface WorkflowBlock {
  model: string;
  claudeVersion: string;
  scorerHash: string;
  runs: number;
  matchRuns: number;
  outages: number;
  faults: number;
  cases: { executed: number; total: number };
  conditions: Record<Condition, ConditionMetrics>;
  paired: {
    bothCorrect: number;
    retrievalFailure: number;
    searchOnly: number;
    interpretationFailure: number;
    total: number;
  };
  families: Record<string, Record<Condition, boolean>>;
  rows: CaseRows;
}

/** Run-level facts the summary carries through; `total` is the full corpus case count. */
export type SummaryMeta = Pick<
  WorkflowBlock,
  'model' | 'claudeVersion' | 'scorerHash' | 'runs' | 'matchRuns'
> & {
  total: number;
};

export interface WorkflowResults {
  priorArtWorkflow: WorkflowBlock;
}

const majority = (flags: boolean[]) => flags.filter(Boolean).length * 2 > flags.length;

/** The most frequent value, or 'NULL' on a tie for first: the intrinsic tier's majority rule. */
export function plurality(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const [first, second] = [...counts].sort((a, b) => b[1] - a[1]);
  return !first || (second && second[1] === first[1]) ? 'NULL' : first[0];
}

/** Per key, the majority over the runs that measured it; a run without the key abstains. */
function majorityFlags(maps: Record<string, boolean>[]): Record<string, boolean> {
  const keys = new Set(maps.flatMap((map) => Object.keys(map)));
  return Object.fromEntries(
    [...keys].map((key) => [
      key,
      majority(maps.filter((map) => key in map).map((map) => map[key])),
    ]),
  );
}

function pluralitySpans(maps: Record<string, SpanStatus>[]): Record<string, string> {
  const keys = new Set(maps.flatMap((map) => Object.keys(map)));
  return Object.fromEntries([...keys].map((key) => [key, plurality(maps.map((map) => map[key]))]));
}

export function aggregateCase(
  member: Member,
  runs: (ScoredRun | null)[],
  outages: number,
): CaseResult {
  const scored = runs.filter((run): run is ScoredRun => run !== null && run.score.fault === null);
  const verdict = plurality(
    runs.map((run) => (run && !run.score.fault ? run.score.verdict : 'DARK')),
  );
  const framing = plurality(scored.map((run) => run.score.framing));
  const honesty = scored.flatMap((run) =>
    run.score.legHonest === null ? [] : [run.score.legHonest],
  );
  const claims = emptyClaims();
  for (const run of scored) addClaims(claims, run.score.claims);
  const valid = scored.filter((run) => run.score.valid);
  return {
    runs: runs.length,
    outages,
    faults: runs.filter((run) => run?.score.fault).length,
    valid: { ok: valid.length, total: runs.length },
    verdict,
    verdictOk: member.expectVerdict.some((expected) => expected === verdict),
    framing,
    framingOk: member.expectFraming.length
      ? member.expectFraming.some((expected) => expected === framing)
      : null,
    legHonest: honesty.length ? majority(honesty) : null,
    recalled: majorityFlags(valid.map((run) => run.score.recalled)),
    spans: pluralitySpans(scored.map((run) => run.score.spans)),
    claims,
    decoyEndorsed: majorityFlags(valid.map((run) => run.endorsed)),
  };
}

function tally(target: Count, ok: boolean): void {
  target.total += 1;
  if (ok) target.ok += 1;
}

function emptyMetrics(): ConditionMetrics {
  const count = (): Count => ({ ok: 0, total: 0 });
  return {
    valid: count(),
    verdict: count(),
    framing: count(),
    legHonesty: count(),
    recallOwn: count(),
    recallRef: count(),
    spansRead: count(),
    spansLocated: count(),
    claims: emptyClaims(),
    decoyEndorsements: count(),
    genuineAccepted: count(),
    insufficientNatural: count(),
    insufficientArtificial: count(),
    familiesBothSides: count(),
  };
}

function tallyResponse(metrics: ConditionMetrics, result: CaseResult): void {
  metrics.valid.ok += result.valid.ok;
  metrics.valid.total += result.valid.total;
  tally(metrics.verdict, result.verdictOk);
  if (result.framingOk !== null) tally(metrics.framing, result.framingOk);
  if (result.legHonest !== null) tally(metrics.legHonesty, result.legHonest);
  addClaims(metrics.claims, result.claims);
  for (const endorsed of Object.values(result.decoyEndorsed))
    tally(metrics.decoyEndorsements, endorsed);
}

function tallyEvidence(
  metrics: ConditionMetrics,
  member: Member,
  result: CaseResult,
  condition: Condition,
): void {
  for (const slot of member.gold) {
    const own = slot.spans.every((span) => span.root === 'consumer');
    tally(own ? metrics.recallOwn : metrics.recallRef, result.recalled[slot.id] === true);
  }
  // Spans are read only by searching; the supplied condition has no tools to read them with.
  for (const status of condition === 'search' ? Object.values(result.spans) : []) {
    tally(metrics.spansRead, status === 'read');
    tally(metrics.spansLocated, status === 'read' || status === 'located');
  }
}

function tallyCalibration(metrics: ConditionMetrics, member: Member, result: CaseResult): void {
  const expects = (verdict: string) =>
    member.expectVerdict.some((expected) => expected === verdict);
  if (expects('GENUINE_NEW_WORK'))
    tally(
      metrics.genuineAccepted,
      ['GENUINE_NEW_WORK', 'INSUFFICIENT_EVIDENCE'].includes(result.verdict),
    );
  if (expects('INSUFFICIENT_EVIDENCE'))
    tally(
      member.kind === 'natural' ? metrics.insufficientNatural : metrics.insufficientArtificial,
      result.verdictOk,
    );
}

function conditionMetrics(
  members: Member[],
  rows: CaseRows,
  condition: Condition,
): ConditionMetrics {
  const metrics = emptyMetrics();
  for (const member of members) {
    const result = rows[member.id][condition];
    tallyResponse(metrics, result);
    tallyEvidence(metrics, member, result, condition);
    tallyCalibration(metrics, member, result);
  }
  for (const caseId of new Set(members.map((member) => member.caseId)))
    tally(
      metrics.familiesBothSides,
      members.filter((m) => m.caseId === caseId).every((m) => rows[m.id][condition].verdictOk),
    );
  return metrics;
}

export function summarise(members: Member[], rows: CaseRows, meta: SummaryMeta): WorkflowResults {
  const paired = {
    bothCorrect: 0,
    retrievalFailure: 0,
    searchOnly: 0,
    interpretationFailure: 0,
    total: 0,
  };
  const families: Record<string, Record<Condition, boolean>> = {};
  for (const member of members) {
    const supplied = rows[member.id].supplied.verdictOk;
    const search = rows[member.id].search.verdictOk;
    paired.total += 1;
    if (supplied && search) paired.bothCorrect += 1;
    else if (supplied) paired.retrievalFailure += 1;
    else if (search) paired.searchOnly += 1;
    else paired.interpretationFailure += 1;
  }
  for (const caseId of new Set(members.map((member) => member.caseId))) {
    const family = members.filter((member) => member.caseId === caseId);
    families[caseId] = {
      search: family.every((member) => rows[member.id].search.verdictOk),
      supplied: family.every((member) => rows[member.id].supplied.verdictOk),
    };
  }
  const cases = Object.values(rows).flatMap((byCondition) => Object.values(byCondition));
  const { total, ...rest } = meta;
  return {
    priorArtWorkflow: {
      ...rest,
      outages: cases.reduce((sum, result) => sum + result.outages, 0),
      faults: cases.reduce((sum, result) => sum + result.faults, 0),
      cases: { executed: cases.length, total },
      conditions: {
        search: conditionMetrics(members, rows, 'search'),
        supplied: conditionMetrics(members, rows, 'supplied'),
      },
      paired,
      families,
      rows,
    },
  };
}
