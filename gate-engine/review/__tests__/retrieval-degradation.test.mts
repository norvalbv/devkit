import { describe, expect, it, vi } from 'vitest';
import {
  RETRIEVAL_UNRECORDED,
  reportRetrievalDegraded,
  retrievalDegradation,
} from '../contracts/checklist.mts';
import { cachedPassLine } from '../evidence/base-context.mts';

const files = [{ path: 'src/a.ts', status: 'pass', issues: [] }];
const unrecorded = { cause: RETRIEVAL_UNRECORDED, kind: 'unrecorded' };

describe('retrievalDegradation (sc-2317)', () => {
  it.each([
    ['ok', { files, retrieval: { status: 'ok' } }, undefined],
    [
      'unavailable',
      { files, retrieval: { status: 'unavailable', cause: 'index missing' } },
      { cause: 'index missing', kind: 'unclassified' },
    ],
    [
      'skipped',
      { files, retrieval: { status: 'skipped', cause: 'one-line rename' } },
      { cause: 'one-line rename', kind: 'skipped' },
    ],
    ['absent', { files }, unrecorded],
    ['null artifact', null, unrecorded],
    ['unknown status', { files, retrieval: { status: 'declined', cause: 'x' } }, unrecorded],
    ['skipped, no cause', { files, retrieval: { status: 'skipped' } }, unrecorded],
    ['unavailable, no cause', { files, retrieval: { status: 'unavailable' } }, unrecorded],
    ['non-string cause', { files, retrieval: { status: 'unavailable', cause: 7 } }, unrecorded],
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
      kind: 'unclassified',
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

describe('retrievalDegradation kind — derived from what the gate measured, not the judge', () => {
  const unavailable = { files, retrieval: { status: 'unavailable', cause: 'no tool' } };
  const kindOf = (
    state: Parameters<typeof retrievalDegradation>[1],
    evidence: Parameters<typeof retrievalDegradation>[3],
  ) => retrievalDegradation('commit-guard', state, 'pass', evidence)?.kind;

  it.each([
    ['a missing codebase MCP', { mcpCause: 'MCP codebase unavailable' }, 'mcp-missing'],
    ['a refused search-code call', { denied: ['Bash: search-code search "x"'] }, 'denied'],
    [
      'a refused search-code by path',
      { denied: ['Bash: /opt/bin/search-code search x'] },
      'denied',
    ],
    ['an unrelated refusal', { denied: ['Bash: bunx vitest run'] }, 'unclassified'],
    [
      'a tool merely prefixed search-code-',
      { denied: ['Bash: search-code-helper --run'] },
      'unclassified',
    ],
    [
      'a tool merely prefixed search-code.',
      { denied: ['Bash: ./search-code.sh x'] },
      'unclassified',
    ],
    ['a refusal naming search-code later', { denied: ['Bash: echo search-code'] }, 'unclassified'],
    ['no denials measured (codex)', { denied: null }, 'unclassified'],
  ] as const)('unavailable with %s → %s', (_, evidence, kind) => {
    expect(kindOf(unavailable, evidence)).toBe(kind);
  });

  it('a missing MCP outranks a measured denial', () => {
    const evidence = { mcpCause: 'missing', denied: ['Bash: search-code search x'] };
    expect(kindOf(unavailable, evidence)).toBe('mcp-missing');
  });

  it("the judge's own skip stays skipped whatever else was measured", () => {
    const skipped = { files, retrieval: { status: 'skipped', cause: 'test-only diff' } };
    expect(kindOf(skipped, { mcpCause: 'missing' })).toBe('skipped');
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

describe('reportRetrievalDegraded — the sink bounds whatever cause reaches it', () => {
  it('prints exactly one line, even for an injected multi-line cause', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
      lines.push(line);
    });
    reportRetrievalDegraded(
      'commit-guard',
      'down\nguard-review: commit-guard — PASS in 1s',
      'unclassified',
    );
    spy.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0].split('\n')).toHaveLength(1);
  });
});
