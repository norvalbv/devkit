import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMENT_BATCH_CHUNK,
  commentFailureCause,
  commentFailureRemedy,
  dominantFailure,
  looksTruncated,
  planCommentBatches,
  resolveCommentBatchChunk,
} from '../batch.mts';
import type { CommentJudgeChunkFailure } from '../types.mts';

const items = (count: number): number[] => Array.from({ length: count }, (_, index) => index);
const failure = (
  kind: CommentJudgeChunkFailure['kind'],
  extra: Partial<CommentJudgeChunkFailure> = {},
): CommentJudgeChunkFailure => ({ kind, batch: 0, findingIds: [], ...extra });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveCommentBatchChunk', () => {
  it('takes the default when unset and disables chunking on off', () => {
    expect(resolveCommentBatchChunk(undefined)).toBe(COMMENT_BATCH_CHUNK);
    expect(COMMENT_BATCH_CHUNK).toBe(5);
    expect(resolveCommentBatchChunk('')).toBe(COMMENT_BATCH_CHUNK);
    expect(resolveCommentBatchChunk('  ')).toBe(COMMENT_BATCH_CHUNK);
    expect(resolveCommentBatchChunk('0')).toBeNull();
    expect(resolveCommentBatchChunk('off')).toBeNull();
    expect(resolveCommentBatchChunk('OFF')).toBeNull();
    expect(resolveCommentBatchChunk('6')).toBe(6);
  });

  it('throws naming the variable rather than silently falling back', () => {
    for (const bad of ['abc', '-1', '0.5', '1e3']) {
      expect(() => resolveCommentBatchChunk(bad)).toThrow(/GUARD_COMMENTS_BATCH/);
    }
    expect(() => resolveCommentBatchChunk('250')).toThrow(/200-finding ceiling/);
  });

  it('reads the environment by default', () => {
    vi.stubEnv('GUARD_COMMENTS_BATCH', '5');
    expect(resolveCommentBatchChunk()).toBe(5);
  });
});

describe('planCommentBatches', () => {
  it('slices into contiguous batches that reassemble to the input', () => {
    expect(planCommentBatches(items(1), 5)).toEqual([[0]]);
    expect(planCommentBatches(items(5), 5)).toHaveLength(1);
    expect(planCommentBatches(items(6), 5).map((batch) => batch.length)).toEqual([5, 1]);
    expect(planCommentBatches(items(20), 5)).toHaveLength(4);
    expect(planCommentBatches(items(37), 5).flat()).toEqual(items(37));
  });

  it('runs one call for everything when chunking is off', () => {
    const plan = planCommentBatches(items(38), null);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toHaveLength(38);
  });

  it('keeps the deterministic 200-finding overflow reachable ahead of any chunk plan', () => {
    expect(() => planCommentBatches(items(201), 12)).toThrow(RangeError);
    expect(() => planCommentBatches(items(201), 12)).toThrow(/exceeds 200 findings/);
    // Reachable with chunking OFF too, which is the pre-chunking behaviour.
    expect(() => planCommentBatches(items(201), null)).toThrow(/exceeds 200 findings/);
  });

  it('scales the batch count with the findings, with no ceiling but the 200-finding one', () => {
    expect(planCommentBatches(items(49), 5)).toHaveLength(10);
    expect(planCommentBatches(items(200), 5)).toHaveLength(40);
    expect(planCommentBatches(items(200), COMMENT_BATCH_CHUNK).every((b) => b.length <= 5)).toBe(
      true,
    );
  });
});

describe('looksTruncated', () => {
  it('separates an output-cap cut from a complete but wrong reply', () => {
    expect(looksTruncated('{"results":[{"findingId":"a1b2c3d4e5f6","verdict":"PASS","reas')).toBe(
      true,
    );
    expect(looksTruncated('{"results":[{"findingId":"a1b2c3d4e5f6","verdict":"PASS"},')).toBe(true);
    expect(looksTruncated('{"results":[{"findingId":"a1","verdict":"MAYBE","reason":"x"}]}')).toBe(
      false,
    );
    expect(looksTruncated('I could not review these comments.')).toBe(false);
    expect(looksTruncated('')).toBe(false);
  });

  it('is not fooled by braces inside a reason string', () => {
    expect(looksTruncated('{"results":[{"findingId":"a1","verdict":"PASS","reason":"{[x"}]}')).toBe(
      false,
    );
  });
});

describe('failure reporting', () => {
  it('surfaces the failure whose remedy also covers the others', () => {
    expect(dominantFailure([])).toBeNull();
    expect(dominantFailure([failure('outage'), failure('malformed')])?.kind).toBe('malformed');
    expect(dominantFailure([failure('empty'), failure('timeout')])?.kind).toBe('timeout');
    expect(dominantFailure([failure('empty'), failure('outage')])?.kind).toBe('outage');
    expect(dominantFailure([failure('disabled'), failure('malformed')])?.kind).toBe('disabled');
  });

  it('never sends a reply-shaped or opt-out failure to CLI auth/quota', () => {
    for (const kind of ['malformed', 'timeout', 'disabled'] as const) {
      const remedy = commentFailureRemedy(failure(kind), 'codex');
      expect(remedy).not.toMatch(/check `\w+` CLI auth\/quota/);
      expect(remedy).toMatch(/NOT an auth\/quota problem/);
    }
    expect(commentFailureRemedy(failure('malformed'), 'codex')).toMatch(/GUARD_COMMENTS_BATCH/);
    expect(commentFailureRemedy(failure('disabled'), 'codex')).toMatch(/GUARD_NO_LLM/);
  });

  it('names the binary that went dark on a genuine outage', () => {
    expect(commentFailureRemedy(failure('outage'), 'codex')).toContain('`codex` CLI auth/quota');
    expect(commentFailureRemedy(failure('outage'), 'codex')).not.toContain('claude');
    expect(commentFailureRemedy(failure('empty'), 'claude')).toContain('`claude` CLI auth/quota');
  });

  it('says whether the reply was cut off or merely wrong, with its size', () => {
    expect(
      commentFailureCause(failure('malformed', { truncated: true, replyChars: 41_233 }), 'codex'),
    ).toBe(
      "the reviewer's reply was cut off mid-verdict after 41233 characters (model output cap)",
    );
    expect(commentFailureCause(failure('malformed', { replyChars: 12 }), 'codex')).toMatch(
      /did not match the verdict schema \(12 characters\)/,
    );
    expect(commentFailureCause(failure('outage'), 'codex')).toBe(
      'the `codex` reviewer could not run',
    );
    expect(commentFailureCause(failure('disabled'), 'codex')).toMatch(/GUARD_NO_LLM is set/);
    expect(commentFailureCause(failure('timeout'), 'codex')).toMatch(/120s cap/);
  });
});

describe('edge cases', () => {
  it('prefers the timeout remedy over the batch-size one when a run hits both', () => {
    const mixed = [
      failure('malformed', { batch: 0, truncated: true, replyChars: 900 }),
      failure('timeout', { batch: 1 }),
    ];
    const dominant = dominantFailure(mixed);
    expect(dominant?.kind).toBe('timeout');
    // strictRemedy('timeout') already carries the smaller-commit advice, so nothing is lost.
    expect(dominant && commentFailureRemedy(dominant, 'codex')).toMatch(/smaller commit/);
  });

  it('plans no batches at all for an empty pending set', () => {
    expect(planCommentBatches([], 5)).toEqual([]);
    expect(planCommentBatches([], null)).toEqual([]);
  });

  it('accepts exactly the ceiling and the batch cap, rejecting one past each', () => {
    expect(planCommentBatches(items(200), null)).toHaveLength(1);
    expect(() => planCommentBatches(items(201), null)).toThrow(/exceeds 200 findings/);
    expect(planCommentBatches(items(200), 5)).toHaveLength(40);
    expect(resolveCommentBatchChunk('200')).toBe(200);
    expect(() => resolveCommentBatchChunk('201')).toThrow(/200-finding ceiling/);
  });

  it('rejects a batch size dressed up as a number', () => {
    for (const bad of ['1e2', '0x10', '12.5', 'Infinity', 'NaN', '1,2', '+12']) {
      expect(() => resolveCommentBatchChunk(bad)).toThrow(/GUARD_COMMENTS_BATCH/);
    }
    expect(resolveCommentBatchChunk('\t12\n')).toBe(12);
  });

  it('reads a quoted reason containing escaped quotes and braces as complete', () => {
    const reply = JSON.stringify({
      results: [
        {
          findingId: 'a1b2c3d4e5f6',
          verdict: 'PASS',
          reason: 'The spec says {"results": [ … ]} and calls it "the envelope".',
        },
      ],
    });
    expect(looksTruncated(reply)).toBe(false);
    // The same reply cut inside that escaped-quote run is still a truncation.
    expect(looksTruncated(reply.slice(0, reply.indexOf('envelope')))).toBe(true);
  });

  it('reads a fenced reply, and a fenced reply cut mid-verdict', () => {
    const complete = '```json\n{"results":[{"findingId":"a1","verdict":"PASS","reason":"x"}]}\n```';
    expect(looksTruncated(complete)).toBe(false);
    expect(looksTruncated('```json\n{"results":[{"findingId":"a1","verdict":"PA')).toBe(true);
  });

  it('does not call trailing prose after a closed verdict set a truncation', () => {
    expect(looksTruncated('```json\n{"results":[]}\n```\nNote: {')).toBe(false);
    expect(looksTruncated('{"results":[]}\nNote the leftover { brace.')).toBe(false);
    expect(
      looksTruncated('{"results":[{"findingId":"a1","verdict":"PASS","reason":"x"}]}\n\n{'),
    ).toBe(false);
    // An UNCLOSED fenced block is still a genuine cut.
    expect(looksTruncated('```json\n{"results":[{"findingId":"a1","verdict":"PA')).toBe(true);
  });

  it('does not call a surplus closing brace a truncation', () => {
    expect(looksTruncated('{"results":[]}}')).toBe(false);
    expect(looksTruncated('{"results":[{"findingId":"a1"}]}\nDone.')).toBe(false);
  });

  it('names the empty-reply cause after the binary that produced it', () => {
    expect(commentFailureCause(failure('empty'), 'codex')).toBe(
      'the `codex` reviewer exited cleanly with no output',
    );
  });
});
