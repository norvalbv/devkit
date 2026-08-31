import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { JsonObject } from '../../comment-firewall/types.mts';
import { AGENT_MD, here, MATCH_CONCURRENCY, MATCH_MODEL, MATCH_RUNS } from './benchmark-config.mts';
import type { CompletenessCase } from './cases.mts';
import { hashLocalModuleClosure } from './module-closure-hash.mts';
import type { Finding } from './matcher.mts';
import type { BenchSummary } from './scoring.mts';

export const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
const reviewerExecutionHash = () =>
  sha12(
    [
      hashLocalModuleClosure([
        path.join(here, `../completeness${SELF_EXT}`),
        path.join(here, `../../decisions/eval/bench${SELF_EXT}`),
        path.join(here, `case-runner${SELF_EXT}`),
      ]),
      readFileSync(AGENT_MD, 'utf8'),
    ].join('\0'),
  );

const matcherExecutionHash = () => hashLocalModuleClosure([path.join(here, `matcher${SELF_EXT}`)]);

// The agent brief and the exact execution closure ARE gate identity here: the prompt and routing
// are what the run measures, not just completeness.mts's top-level bytes.
export const gateHash = (mcpCapabilityFingerprint: string) =>
  sha12([reviewerExecutionHash(), mcpCapabilityFingerprint].join('\0'));

export const matcherHash = () =>
  sha12(
    [
      matcherExecutionHash(),
      hashLocalModuleClosure([
        path.join(here, `checkpoint${SELF_EXT}`),
        path.join(here, `module-closure-hash${SELF_EXT}`),
        path.join(here, `bench${SELF_EXT}`),
      ]),
    ].join('\0'),
  );

/** Narrow identity for paid per-case execution. Persistence/orchestration-only edits in main()
 * must not discard work; reviewer/matcher closures and the exact result-shaping wrapper must. */
const caseExecutionHash = () =>
  sha12(
    [
      reviewerExecutionHash(),
      matcherExecutionHash(),
      hashLocalModuleClosure([
        path.join(here, `case-runner${SELF_EXT}`),
        path.join(here, `checkpoint${SELF_EXT}`),
      ]),
    ].join('\0'),
  );

export const completenessCaseInputHash = (
  row: CompletenessCase,
  mcpCapabilityFingerprint: string,
): string => sha12(JSON.stringify({ row, mcpCapabilityFingerprint }));

export const completenessMatcherInputHash = (row: CompletenessCase, findings: Finding[]): string =>
  sha12(JSON.stringify({ row, findings }));

export interface CompletenessCaseCheckpointIdentity extends JsonObject {
  schema: number;
  noLlm: boolean;
  reviewerModel: string;
  mcpCapabilityFingerprint: string;
  matchModel: string;
  matchRuns: number;
  matchConcurrency: number;
  gateHash: string;
  caseExecutionHash: string;
  retryBaselineHash: string;
}

export interface CompletenessReviewerCheckpointIdentity extends JsonObject {
  schema: number;
  noLlm: boolean;
  reviewerModel: string;
  mcpCapabilityFingerprint: string;
  reviewerExecutionHash: string;
}

export interface CompletenessMatcherCheckpointIdentity extends JsonObject {
  schema: number;
  matchModel: string;
  matchRuns: number;
  matchConcurrency: number;
  matcherExecutionHash: string;
}

export interface CompletenessAuditCheckpointIdentity extends JsonObject {
  schema: number;
  reviewerModel: string;
  mcpCapabilityFingerprint: string;
  matcherHash: string;
}

export function completenessCaseCheckpointIdentity({
  reviewerModel,
  mcpCapabilityFingerprint,
  retryBaselineHash,
  noLlm,
  matchModel = MATCH_MODEL,
  matchRuns = MATCH_RUNS,
}: {
  reviewerModel: string;
  mcpCapabilityFingerprint: string;
  retryBaselineHash: string;
  noLlm: boolean;
  matchModel?: string;
  matchRuns?: number;
}): CompletenessCaseCheckpointIdentity {
  return {
    schema: 1,
    noLlm,
    reviewerModel,
    mcpCapabilityFingerprint,
    matchModel,
    matchRuns,
    matchConcurrency: MATCH_CONCURRENCY,
    gateHash: gateHash(mcpCapabilityFingerprint),
    caseExecutionHash: caseExecutionHash(),
    retryBaselineHash,
  };
}

export function completenessReviewerCheckpointIdentity(
  reviewerModel: string,
  mcpCapabilityFingerprint: string,
  noLlm: boolean,
): CompletenessReviewerCheckpointIdentity {
  return {
    schema: 1,
    noLlm,
    reviewerModel,
    mcpCapabilityFingerprint,
    reviewerExecutionHash: reviewerExecutionHash(),
  };
}

export function completenessMatcherCheckpointIdentity({
  matchModel = MATCH_MODEL,
  matchRuns = MATCH_RUNS,
}: {
  matchModel?: string;
  matchRuns?: number;
} = {}): CompletenessMatcherCheckpointIdentity {
  return {
    schema: 1,
    matchModel,
    matchRuns,
    matchConcurrency: MATCH_CONCURRENCY,
    matcherExecutionHash: matcherExecutionHash(),
  };
}

export function completenessAuditCheckpointIdentity(
  reviewerModel: string,
  mcpCapabilityFingerprint: string,
): CompletenessAuditCheckpointIdentity {
  return { schema: 1, reviewerModel, mcpCapabilityFingerprint, matcherHash: matcherHash() };
}

export const retryBaselineFingerprint = (summary: BenchSummary | null): string =>
  summary
    ? sha12(
        JSON.stringify({
          reviewerModel: summary.reviewerModel,
          mcpCapabilityFingerprint: summary.mcpCapabilityFingerprint,
          gateHash: summary.gateHash,
          matcherHash: summary.matcherHash,
          corpusHash: summary.corpusHash,
          rows: summary.rows,
        }),
      )
    : 'none';
