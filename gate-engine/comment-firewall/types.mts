export interface CommentFinding {
  id: string;
  path: string;
  extension: string;
  adapterVersion: string;
  kind: 'line' | 'block';
  startLine: number;
  endLine: number;
  comment: string;
  context: string;
  relevantDiff: string;
}

export interface DetectionResult {
  findings: CommentFinding[];
  unsupported: Array<{ extension: string; path: string }>;
}

/** Explicit evidence supplied by the author. It is pending until the judge returns PASS. */
export interface CommentRationale {
  rationale: string;
  ticket?: string;
  at: string;
  worktrees?: string[];
}

export interface RationaleStore {
  version: 1;
  entries: Record<string, CommentRationale>;
  migratedWorktrees?: string[];
}

export interface CommentJudgeResult {
  verdict: 'PASS' | 'FAIL';
  reason: string;
}

export type CommentJudgeBatchResult = Record<string, CommentJudgeResult>;

/** Why one review batch produced no verdict — `malformed` means the judge ran and answered, so
 * only the batch size or the staged change can fix it, never CLI auth/quota (sc-2195). */
export type CommentJudgeFailure = 'disabled' | 'timeout' | 'outage' | 'empty' | 'malformed';

export interface CommentJudgeChunkFailure {
  kind: CommentJudgeFailure;
  /** 0-based batch index; -1 for `disabled`, where no batch ever ran. */
  batch: number;
  /** Finding ids the failed batch carried, in input order. */
  findingIds: string[];
  /** `malformed` only: the reply opened a verdict set and stopped mid-stream. */
  truncated?: boolean;
  /** `malformed` only: reply length in characters — the number that makes an output cap legible. */
  replyChars?: number;
}

export interface CommentJudgeOutcome {
  /** Verdicts from every batch that parsed; empty when nothing was judged. */
  results: CommentJudgeBatchResult;
  /** Finding ids left without a verdict, in input order. */
  unjudged: string[];
  failures: CommentJudgeChunkFailure[];
  /** Batches planned vs actually spawned — they differ when a dark judge aborts the remainder. */
  planned: number;
  spawned: number;
  /** The binary the resolved model routes to, carried from the spawn rather than re-derived. */
  bin: string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export function parseJson(raw: string): JsonValue {
  return JSON.parse(raw);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === '[object String]';
}

export function isJsonInteger(value: JsonValue | undefined): value is number {
  return Number.isInteger(value);
}
