import { describe, expect, it, vi } from 'vitest';
import {
  RETRIEVAL_UNRECORDED,
  reportRetrievalDegraded,
  retrievalDegradation,
} from '../contracts/checklist.mts';
import {
  CACHED_RETRIEVAL_UNPROVEN,
  cachedPassLine,
  cachedRetrievalDegradation,
} from '../evidence/base-context.mts';

const files = [{ path: 'src/a.ts', status: 'pass', issues: [] }];

describe('retrievalDegradation (sc-2317)', () => {
  it.each([
    ['ok', { files, retrieval: { status: 'ok' } }, undefined],
    [
      'unavailable',
      { files, retrieval: { status: 'unavailable', cause: 'index missing' } },
      { cause: 'index missing' },
    ],
    ['absent', { files }, { cause: RETRIEVAL_UNRECORDED }],
    ['null artifact', null, { cause: RETRIEVAL_UNRECORDED }],
    [
      'unknown status',
      { files, retrieval: { status: 'skipped' } },
      { cause: RETRIEVAL_UNRECORDED },
    ],
    [
      'unavailable, no cause',
      { files, retrieval: { status: 'unavailable' } },
      { cause: RETRIEVAL_UNRECORDED },
    ],
    [
      'non-string cause',
      { files, retrieval: { status: 'unavailable', cause: 7 } },
      { cause: RETRIEVAL_UNRECORDED },
    ],
    ['named skip (nothing reviewable)', { files: [], skipped: 'all deletions' }, undefined],
  ])('%s', (_, state, expected) => {
    expect(retrievalDegradation('commit-guard', state, 'pass')).toEqual(expected);
  });

  it.each(['fail', 'inconclusive', 'error'] as const)('a %s is never degraded', (status) => {
    expect(retrievalDegradation('commit-guard', { files }, status)).toBeUndefined();
  });

  it('other reviewers never degrade, even with no retrieval record', () => {
    expect(retrievalDegradation('correctness-reviewer', { items: [] }, 'pass')).toBeUndefined();
    expect(retrievalDegradation('conventions-reviewer', null, 'pass')).toBeUndefined();
  });

  it('flattens a multi-line judge cause onto one line', () => {
    const state = {
      files,
      retrieval: { status: 'unavailable', cause: '  embeddings\n\treturned 503\r\n  twice ' },
    };
    expect(retrievalDegradation('commit-guard', state, 'pass')).toEqual({
      cause: 'embeddings returned 503 twice',
    });
  });

  it('bounds a runaway cause so one judge cannot flood the log, cache and event', () => {
    const state = { files, retrieval: { status: 'unavailable', cause: 'x'.repeat(5000) } };
    const cause = retrievalDegradation('commit-guard', state, 'pass')?.cause ?? '';
    expect(cause.length).toBe(200);
    expect(cause.endsWith('…')).toBe(true);
  });

  it('keeps a cause exactly at the bound untouched', () => {
    const exact = 'y'.repeat(200);
    const state = { files, retrieval: { status: 'unavailable', cause: exact } };
    expect(retrievalDegradation('commit-guard', state, 'pass')?.cause).toBe(exact);
  });
});

describe('cachedPassLine DEGRADED marker', () => {
  const current = { state: 'current', current: 'a'.repeat(40), judged: ['a'.repeat(40)] } as const;

  it('marks a degraded replay and leaves the clean wording byte-identical', () => {
    expect(cachedPassLine('commit-guard', current, 'identical diff', true)).toBe(
      'guard-review: commit-guard — cached PASS (DEGRADED) (identical diff)',
    );
    expect(cachedPassLine('commit-guard', current)).toBe(
      'guard-review: commit-guard — cached PASS (identical diff)',
    );
  });

  it('keeps the base-provenance suffix on a degraded replay', () => {
    const moved = {
      state: 'moved-clear',
      current: 'b'.repeat(40),
      judged: ['a'.repeat(40)],
    } as const;
    const line = cachedPassLine('commit-guard', moved, 'identical diff', true);
    expect(
      line.startsWith(
        'guard-review: commit-guard — cached PASS (DEGRADED) (identical diff; judged against',
      ),
    ).toBe(true);
  });
});

describe('cachedRetrievalDegradation — a replay must prove retrieval ran (sc-2317)', () => {
  it.each([
    ['stamped ok', { retrieval: 'ok' }, undefined],
    ['stamped degraded', { degraded_cause: 'index missing' }, 'index missing'],
    ['legacy entry with neither field', { model: 'haiku' }, CACHED_RETRIEVAL_UNPROVEN],
    ['non-string degraded_cause', { degraded_cause: 42 }, CACHED_RETRIEVAL_UNPROVEN],
    ['blank degraded_cause', { degraded_cause: '  ' }, CACHED_RETRIEVAL_UNPROVEN],
    ['retrieval not literally ok', { retrieval: 'OK' }, CACHED_RETRIEVAL_UNPROVEN],
  ])('commit-guard, %s', (_, meta, expected) => {
    expect(cachedRetrievalDegradation('commit-guard', meta)).toBe(expected);
  });

  it('a replayed cause is normalised like a fresh one: one line, bounded', () => {
    expect(cachedRetrievalDegradation('commit-guard', { degraded_cause: 'a\n\tb\r\n c' })).toBe(
      'a b c',
    );
    const long = cachedRetrievalDegradation('commit-guard', { degraded_cause: 'x'.repeat(5000) });
    expect(long?.length).toBe(200);
  });

  it('other reviewers replay clean without any retrieval record', () => {
    expect(cachedRetrievalDegradation('correctness-reviewer', {})).toBeUndefined();
  });
});

describe('reportRetrievalDegraded — the sink bounds whatever cause reaches it', () => {
  it('prints exactly one line, even for an injected multi-line cause', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
      lines.push(line);
    });
    reportRetrievalDegraded('commit-guard', 'down\nguard-review: commit-guard — PASS in 1s');
    spy.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0].split('\n')).toHaveLength(1);
  });
});
