import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  isJsonInteger,
  isJsonObject,
  isJsonString,
  type JsonValue,
} from '../../comment-firewall/types.mts';
import { resolveGuardConfig, type GuardConfig } from '../../config.mts';
import { BenchAbort } from '../../decisions/eval/bench.mts';
import { type SlotOutcome } from '../../judge/matcher-core.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { completenessJudgeSetup, runCompleteness } from '../completeness.mts';
import { parseReviewVerdict } from '../reviewers.mts';
import {
  AGENTS_DIR,
  MATCH_CONCURRENCY,
  MATCH_MODEL,
  MATCH_RUNS,
  transcriptPath,
} from './benchmark-config.mts';
import type { CheckpointStore } from './checkpoint.mts';
import { type CompletenessCase, materializeCompletenessFixture } from './cases.mts';
import { completenessMatcherInputHash } from './benchmark-identity.mts';
import {
  type CaseScore,
  type Finding,
  parseFindings,
  runMatcher,
  scoreCase,
  SEVERITIES,
} from './matcher.mts';
import { completenessSlotKey } from './variant-consistency.mts';

interface SpyCapture {
  called: boolean;
  args: string[] | null;
  raw: string | null;
  mcpCapabilityFingerprint: string | null;
}

/** Spy exec: delegates to the real judge runner (or a test stub), records what the gate sent and
 * what came back. Drift-proof by construction — the gate builds everything, the spy observes. */
function spyExec(capture: SpyCapture, delegate: typeof execJudgeAsync): typeof execJudgeAsync {
  return async (opts) => {
    capture.called = true;
    capture.args = opts.args;
    const upstreamObserver = opts.onMcpPrepared;
    capture.raw = await delegate({
      ...opts,
      onMcpPrepared: (fingerprint) => {
        capture.mcpCapabilityFingerprint = fingerprint;
        upstreamObserver?.(fingerprint);
      },
    });
    return capture.raw;
  };
}

export interface CaseResult {
  id: string;
  /** Exact value observed after `--model` in the gate's real judge argv. */
  reviewerModel: string;
  /** Current-run matcher assignments used by baseline audit; never recovered from stale files. */
  auditOutcomes?: { slotId: string; match: number; outage: boolean }[];
  /** Parsed current-run findings supplied to the independent baseline audit. */
  findings?: Finding[];
  outage: boolean;
  score: CaseScore | null;
  verdict: string | null;
  exit: number;
  warnings: string[];
}

/** Durable row state. A paid primary can be banked before its required retry; it is not final
 * evidence until retryComplete is true, but a resumed run can finish the retry without repaying
 * the primary reviewer and matcher calls. */
export interface CaseCheckpointValue {
  result: CaseResult;
  retryComplete: boolean;
}

/** The expensive gate invocation, persisted before any matcher work begins. `args` retains the
 * exact observed model/prompt argv so a resumed case never invents model provenance. */
export interface ReviewerCheckpointValue {
  reviewerModel: string;
  mcpCapabilityFingerprint?: string;
  args: string[];
  raw: string;
  exit: number;
}

const isJsonBoolean = (value: JsonValue | undefined): value is boolean =>
  value === true || value === false;

export function reusableReviewerCheckpoint(
  value: JsonValue,
  expectedReviewerModel: string,
  expectedCapabilityFingerprint?: string,
): ReviewerCheckpointValue | undefined {
  if (!isJsonObject(value)) return undefined;
  if (
    value.reviewerModel !== expectedReviewerModel ||
    (expectedCapabilityFingerprint &&
      value.mcpCapabilityFingerprint !== expectedCapabilityFingerprint) ||
    !Array.isArray(value.args) ||
    value.args.some((arg) => !isJsonString(arg)) ||
    !isJsonString(value.raw) ||
    !value.raw.trim() ||
    !isJsonInteger(value.exit)
  )
    return undefined;
  const args = value.args.filter(isJsonString);
  if (modelFromArgv(args) !== expectedReviewerModel) return undefined;
  const checkpoint: ReviewerCheckpointValue = {
    reviewerModel: expectedReviewerModel,
    args,
    raw: value.raw,
    exit: value.exit,
  };
  if (isJsonString(value.mcpCapabilityFingerprint))
    checkpoint.mcpCapabilityFingerprint = value.mcpCapabilityFingerprint;
  return checkpoint;
}

export interface MatcherCheckpointValue {
  outcome: SlotOutcome;
}

export function decodeSlotOutcome(value: JsonValue | undefined): SlotOutcome | undefined {
  if (
    !isJsonObject(value) ||
    !isJsonString(value.slotId) ||
    (value.kind !== 'gold' && value.kind !== 'decoy') ||
    !isJsonInteger(value.match) ||
    value.match < 0 ||
    !isJsonBoolean(value.stable) ||
    value.outage !== false
  )
    return undefined;
  return {
    slotId: value.slotId,
    kind: value.kind,
    match: value.match,
    stable: value.stable,
    outage: false,
  };
}

export function reusableMatcherCheckpoint(value: JsonValue): MatcherCheckpointValue | undefined {
  if (!isJsonObject(value)) return undefined;
  const outcome = decodeSlotOutcome(value.outcome);
  return outcome ? { outcome } : undefined;
}

function isSerializedFinding(value: JsonValue): boolean {
  return Boolean(
    isJsonObject(value) &&
    SEVERITIES.some((severity) => severity === value.severity) &&
    isJsonString(value.desc) &&
    isJsonString(value.paths) &&
    isJsonString(value.impact) &&
    Array.isArray(value.context) &&
    value.context.every(isJsonString),
  );
}

export function reusableCaseCheckpoint(
  value: JsonValue,
  expectedReviewerModel: string,
): CaseCheckpointValue | undefined {
  if (!isJsonObject(value) || !isJsonBoolean(value.retryComplete)) return undefined;
  const result = value.result;
  if (
    !isJsonObject(result) ||
    result.reviewerModel !== expectedReviewerModel ||
    result.outage !== false ||
    !isJsonObject(result.score) ||
    !Array.isArray(result.score.slots) ||
    result.score.slots.some((slot) => !isJsonObject(slot) || slot.outage !== false) ||
    !Array.isArray(result.findings) ||
    result.findings.some((finding) => !isSerializedFinding(finding)) ||
    !Array.isArray(result.auditOutcomes) ||
    result.auditOutcomes.some((slot) => !isJsonObject(slot) || slot.outage !== false)
  )
    return undefined;
  // SAFETY: the JSON boundary checks above establish the reusable checkpoint envelope; the
  // row-bound validator below reconstructs and byte-compares its complete domain score.
  const checkpoint = value as CaseCheckpointValue;
  return caseCheckpointIsReusable(checkpoint, expectedReviewerModel) ? checkpoint : undefined;
}

export function caseCheckpointIsReusable(
  value: CaseCheckpointValue,
  expectedReviewerModel: string,
): boolean {
  const { result } = value;
  return Boolean(
    result.reviewerModel === expectedReviewerModel &&
    !result.outage &&
    result.score &&
    result.score.slots.every((slot) => !slot.outage) &&
    Array.isArray(result.findings) &&
    Array.isArray(result.auditOutcomes) &&
    result.auditOutcomes.every((slot) => !slot.outage),
  );
}

/** Bind a structurally safe checkpoint to the exact corpus row and reconstruct its score. This
 * prevents a parseable-but-empty/cross-row value from silently shrinking metric denominators. */
export function reusableCaseCheckpointForRow(
  value: CaseCheckpointValue | undefined,
  row: CompletenessCase,
  expectedReviewerModel: string,
): boolean {
  if (!value || value.result.reviewerModel !== expectedReviewerModel) return false;
  const { result } = value;
  if (result.id !== row.id || result.score!.findingCount !== result.findings!.length) return false;
  const expected = [
    ...row.gold.map((slot) => ({ id: slot.id, kind: 'gold' as const })),
    ...row.decoys.map((slot) => ({ id: slot.id, kind: 'decoy' as const })),
  ];
  if (
    result.score!.slots.length !== expected.length ||
    result.auditOutcomes!.length !== expected.length
  )
    return false;
  const outcomes: SlotOutcome[] = [];
  for (const [index, slot] of expected.entries()) {
    const scored = result.score!.slots[index];
    const matched = result.auditOutcomes![index];
    if (
      scored.slotId !== slot.id ||
      scored.kind !== slot.kind ||
      matched.slotId !== slot.id ||
      !Number.isInteger(matched.match) ||
      matched.match < 0 ||
      matched.match > result.findings!.length
    )
      return false;
    outcomes.push({
      slotId: slot.id,
      kind: slot.kind,
      match: matched.match,
      stable: scored.stable,
      outage: false,
    });
  }
  return (
    JSON.stringify(result.score) ===
    JSON.stringify(scoreCase(row.gold, row.decoys, result.findings!, outcomes))
  );
}

function modelFromArgv(args: string[] | null): string | null {
  if (!args) return null;
  const i = args.indexOf('--model');
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

/** A benchmark run is attributable only when every paid reviewer invocation used one model. */
export function consistentReviewerModel(
  results: Pick<CaseResult, 'id' | 'reviewerModel'>[],
): string {
  const missing = results.filter((r) => !r.reviewerModel).map((r) => r.id);
  const models = [...new Set(results.map((r) => r.reviewerModel).filter(Boolean))];
  if (missing.length)
    throw new BenchAbort(
      2,
      `completeness-eval: reviewer model missing from judge argv for [${missing.join(', ')}]`,
    );
  if (models.length !== 1)
    throw new BenchAbort(
      2,
      `completeness-eval: inconsistent reviewer models observed in judge argv: [${models.join(', ')}]`,
    );
  return models[0];
}

/**
 * Run one corpus row through runCompleteness() and the matcher. Exported with an injectable exec
 * chain so the tests drive it without judge CLIs. Throws BenchAbort on fixture bugs (free-skip) —
 * "the gate didn't run" must never score as a pass.
 */
export async function runCase(
  row: CompletenessCase,
  {
    reviewerExec = execJudgeAsync,
    matcherExec = execJudgeAsync,
    matchModel = MATCH_MODEL,
    matchRuns = MATCH_RUNS,
    agentsDir = AGENTS_DIR,
    saveTranscript = true,
    reviewerResume,
    onReviewerComplete,
    matcherCheckpoint,
    expectedCapabilityFingerprint,
    consumerConfig = resolveGuardConfig(process.cwd()),
  }: {
    reviewerExec?: typeof execJudgeAsync;
    matcherExec?: typeof execJudgeAsync;
    matchModel?: string;
    matchRuns?: number;
    agentsDir?: string;
    saveTranscript?: boolean;
    reviewerResume?: ReviewerCheckpointValue;
    onReviewerComplete?: (value: ReviewerCheckpointValue) => void;
    matcherCheckpoint?: CheckpointStore<MatcherCheckpointValue>;
    expectedCapabilityFingerprint?: string;
    consumerConfig?: GuardConfig;
  } = {},
): Promise<CaseResult> {
  const fx = materializeCompletenessFixture(row, agentsDir, writeFileSync, consumerConfig);
  activeCleanup = fx.cleanup;
  try {
    const assertExpectedCapabilities = () => {
      if (!expectedCapabilityFingerprint) return;
      const actualCapabilityFingerprint = completenessJudgeSetup(
        resolveGuardConfig(fx.repo),
        fx.repo,
        { mcpProjectRoots: [fx.consumerRoot] },
      ).capabilityFingerprint;
      if (actualCapabilityFingerprint !== expectedCapabilityFingerprint)
        throw new BenchAbort(
          2,
          `completeness-eval: MCP capabilities changed during the run for ${row.id} — refusing mixed-capability evidence`,
        );
    };
    assertExpectedCapabilities();
    if (
      reviewerResume &&
      expectedCapabilityFingerprint &&
      reviewerResume.mcpCapabilityFingerprint !== expectedCapabilityFingerprint
    )
      throw new BenchAbort(
        2,
        `completeness-eval: reviewer checkpoint for ${row.id} lacks the planned MCP capability identity`,
      );
    if (fx.staged.length === 0)
      throw new BenchAbort(2, `completeness-eval: fixture bug in ${row.id} — nothing staged`);
    const capture: SpyCapture = {
      called: false,
      args: null,
      raw: null,
      mcpCapabilityFingerprint: reviewerResume?.mcpCapabilityFingerprint ?? null,
    };
    // The injectable exec is the seam runCompleteness's own tests use; everything else is the gate.
    let exit: number;
    if (reviewerResume) {
      capture.called = true;
      capture.args = reviewerResume.args;
      capture.raw = reviewerResume.raw;
      exit = reviewerResume.exit;
    } else {
      try {
        exit = await runCompleteness(fx.msgFile, fx.repo, {
          exec: spyExec(capture, reviewerExec),
          mcpProjectRoots: [fx.consumerRoot],
        });
      } catch (e) {
        throw new BenchAbort(2, `completeness-eval: gate threw on ${row.id} — ${e}`);
      }
    }
    if (!capture.called)
      throw new BenchAbort(
        2,
        `completeness-eval: gate free-skipped ${row.id} (exit ${exit}) — fixture bug, not a pass`,
      );
    // The registry is external mutable state. Re-check after the gate's judge returns and before
    // any paid response is checkpointed, closing the plan→spawn race for persistent changes.
    assertExpectedCapabilities();
    if (
      expectedCapabilityFingerprint &&
      capture.mcpCapabilityFingerprint !== expectedCapabilityFingerprint
    )
      throw new BenchAbort(
        2,
        `completeness-eval: judge prepared unexpected MCP capabilities for ${row.id} — refusing mixed-capability evidence`,
      );
    const reviewerModel = modelFromArgv(capture.args);
    if (!reviewerModel)
      throw new BenchAbort(2, `completeness-eval: gate judge argv omitted --model for ${row.id}`);
    // Fixture-sanity: every recorded-decision decoy's Target must have reached the prompt. An
    // unloaded decoy means the reviewer was never tempted and the slot would measure nothing.
    const prompt = capture.args?.[1] ?? '';
    for (const d of row.decoys)
      if (d.kind === 'recorded-decision' && d.targetSlug && !prompt.includes(d.targetSlug))
        throw new BenchAbort(
          2,
          `completeness-eval: fixture bug in ${row.id} — decoy Target ${d.targetSlug} not in the gate prompt (scope mismatch?)`,
        );
    if (capture.raw === null)
      return {
        id: row.id,
        reviewerModel,
        outage: true,
        score: null,
        verdict: null,
        exit,
        warnings: [],
      };

    if (!reviewerResume)
      onReviewerComplete?.({
        reviewerModel,
        mcpCapabilityFingerprint: capture.mcpCapabilityFingerprint ?? undefined,
        args: capture.args!,
        raw: capture.raw,
        exit,
      });

    const parsed = parseFindings(capture.raw);
    const matcherInputHash = completenessMatcherInputHash(row, parsed.findings);
    const resumeOutcomes = [...row.gold, ...row.decoys].flatMap((slot) => {
      const saved = matcherCheckpoint?.take(completenessSlotKey(row.id, slot.id), matcherInputHash);
      return saved ? [saved.outcome] : [];
    });
    const outcomes = await runMatcher(row.gold, row.decoys, parsed.findings, {
      model: matchModel,
      runs: matchRuns,
      concurrency: MATCH_CONCURRENCY,
      exec: matcherExec,
      resumeOutcomes,
      onSlotComplete: (outcome) =>
        matcherCheckpoint?.record(completenessSlotKey(row.id, outcome.slotId), matcherInputHash, {
          outcome,
        }),
    });
    const score = scoreCase(row.gold, row.decoys, parsed.findings, outcomes);
    const verdict = parseReviewVerdict(capture.raw).verdict;
    if (saveTranscript) {
      try {
        const file = transcriptPath(row.id);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
          file,
          `${JSON.stringify({ id: row.id, reviewerModel, findings: parsed.findings, gold: row.gold, decoys: row.decoys, outcomes, verdict, raw: capture.raw }, null, 2)}\n`,
        );
      } catch {
        // Transcripts are audit material, not scoring input — never fail a paid run on them.
      }
    }
    return {
      id: row.id,
      reviewerModel,
      auditOutcomes: outcomes.map(({ slotId, match, outage }) => ({ slotId, match, outage })),
      findings: parsed.findings,
      outage: false,
      score,
      verdict,
      exit,
      warnings: parsed.warnings,
    };
  } finally {
    activeCleanup = null;
    fx.cleanup();
  }
}

/** Fold a paid baseline-discordance retry back into evidence eligibility and flip stability. */
export function applyRetryEvidence(first: CaseResult, retry: CaseResult): RetryEvidence {
  if (!first.score) return { caseOutages: 0, slotOutages: 0 };
  if (retry.outage || !retry.score) {
    for (const slot of first.score.slots) slot.stable = false;
    return { caseOutages: 1, slotOutages: 0 };
  }
  const byId = new Map(retry.score.slots.map((slot) => [slot.slotId, slot]));
  let slotOutages = 0;
  for (const slot of first.score.slots) {
    const again = byId.get(slot.slotId);
    if (!again || again.outage) {
      slot.stable = false;
      slotOutages += 1;
    } else if (again.ok !== slot.ok) {
      slot.stable = false;
    }
  }
  return { caseOutages: 0, slotOutages };
}

export interface RetryEvidence {
  caseOutages: number;
  slotOutages: number;
}

// Best-effort ^C cleanup: the imported materializeFixture keeps its own module-private handle that
// only the DECISIONS bench's main() registers — this bench must hold its own.
let activeCleanup: (() => void) | null = null;

export function cleanupActiveFixture(): void {
  activeCleanup?.();
}
