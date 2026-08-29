// Batch planning + failure wording for the changed-comment firewall's reviewer (sc-2195).

import { strictRemedy } from '../judge/run-judge.mts';
import type { CommentJudgeChunkFailure, CommentJudgeFailure } from './types.mts';

/** Findings per model call; see batch.test.mts and judge.test.mts for the bounds this must hold. */
export const COMMENT_BATCH_CHUNK = 5;

/** The deterministic ceiling on a single run, enforced on the TOTAL before any batch is planned so
 * chunking cannot make it unreachable. */
export const MAX_BATCH_FINDINGS = 200;

/** Longest reason the reviewer may spend characters on; over-budget text is clamped, not rejected. */
export const MAX_REASON_CHARS = 400;

const TRUNCATION_HINT = 'GUARD_COMMENTS_DEBUG=1 prints the reply with its length and tail';

export const COMMENT_BATCH_REMEDY =
  'the reviewer ran and replied, so this is NOT an auth/quota problem and a plain retry reproduces ' +
  `it. Review fewer findings per call (GUARD_COMMENTS_BATCH=3; default ${COMMENT_BATCH_CHUNK}) or ` +
  `stage a smaller change; ${TRUNCATION_HINT}`;

export const COMMENT_DISABLED_REMEDY =
  'unset GUARD_NO_LLM and re-run — the comment firewall cannot approve a rationale without its ' +
  'independent reviewer. This is NOT an auth/quota problem';

/** Plain decimal digits only. `Number()` alone would silently read `1e2` as 100, `0x10` as 16 and
 * `+12` as 12 — a typo becoming a batch size no operator asked for. */
const DECIMAL_COUNT = /^\d+$/;

export function resolveCommentBatchChunk(raw = process.env.GUARD_COMMENTS_BATCH): number | null {
  const spec = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (spec === '') return COMMENT_BATCH_CHUNK;
  if (spec === '0' || spec === 'off') return null;
  const size = DECIMAL_COUNT.test(spec) ? Number(spec) : Number.NaN;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(
      `GUARD_COMMENTS_BATCH: expected 'off' or a positive finding count, got '${spec}'`,
    );
  }
  if (size > MAX_BATCH_FINDINGS) {
    throw new Error(
      `GUARD_COMMENTS_BATCH: '${spec}' exceeds the ${MAX_BATCH_FINDINGS}-finding ceiling for one run`,
    );
  }
  return size;
}

/** The overflow throw is a RangeError so the gate's catch reports it as deterministic overflow
 * (exit 4), never as a reviewer outage. It is checked on the TOTAL, before any plan. */
export function planCommentBatches<T>(
  items: readonly T[],
  chunk: number | null = resolveCommentBatchChunk(),
): T[][] {
  if (items.length > MAX_BATCH_FINDINGS) {
    throw new RangeError(`comment review batch exceeds ${MAX_BATCH_FINDINGS} findings`);
  }
  // No findings, no batches — one empty batch here would spend a whole model call reviewing nothing.
  if (items.length === 0) return [];
  const size = chunk ?? items.length;
  const count = Math.ceil(items.length / size);
  return Array.from({ length: count }, (_, index) => items.slice(index * size, (index + 1) * size));
}

/** A reply that opened the verdict set and stopped mid-stream — the signature of an output-cap cut,
 * as opposed to a complete reply the schema rejected. */
export function looksTruncated(raw: string): boolean {
  const text = raw.trim();
  if (!text.includes('"results"')) return false;
  let depth = 0;
  let opened = false;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') {
      depth += 1;
      opened = true;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      // The value closed, so the model reached the end of it. Anything after is trailing prose or a
      // code fence — schema-invalid, but not an output-cap cut, and it must not read as one.
      if (opened && depth <= 0) return false;
    }
  }
  return inString || depth > 0;
}

const PRECEDENCE: CommentJudgeFailure[] = ['disabled', 'timeout', 'malformed', 'outage', 'empty'];

/** Worst-first; the ordering contract is pinned in batch.test.mts. */
export function dominantFailure(
  failures: readonly CommentJudgeChunkFailure[],
): CommentJudgeChunkFailure | null {
  for (const kind of PRECEDENCE) {
    const match = failures.find((failure) => failure.kind === kind);
    if (match) return match;
  }
  return null;
}

export function commentFailureCause(failure: CommentJudgeChunkFailure, bin: string): string {
  switch (failure.kind) {
    case 'disabled':
      return 'GUARD_NO_LLM is set, so the independent reviewer never ran';
    case 'timeout':
      return 'the reviewer hit its 120s cap';
    case 'outage':
      return `the \`${bin}\` reviewer could not run`;
    case 'empty':
      return `the \`${bin}\` reviewer exited cleanly with no output`;
    default:
      return failure.truncated
        ? `the reviewer's reply was cut off mid-verdict after ${failure.replyChars} characters (model output cap)`
        : `the reviewer's reply did not match the verdict schema (${failure.replyChars} characters)`;
  }
}

export function commentFailureRemedy(failure: CommentJudgeChunkFailure, bin: string): string {
  switch (failure.kind) {
    case 'disabled':
      return COMMENT_DISABLED_REMEDY;
    case 'timeout':
      return strictRemedy('timeout');
    case 'malformed':
      return COMMENT_BATCH_REMEDY;
    default:
      return strictRemedy('outage', bin);
  }
}
