import { describe, expect, it, vi } from 'vitest';
import { claudeCommandLines } from '../../judge/claude-result.mts';
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

describe('a recorded ok is checked against the calls the gate measured (sc-6118)', () => {
  const ok = { files, retrieval: { status: 'ok' } };
  const tool = 'mcp__codebase__searchCode';
  const search = `[ok] ${tool}: {"query":"parse a semver range"}`;
  const check = (evidence: Parameters<typeof retrievalDegradation>[3]) =>
    retrievalDegradation('commit-guard', ok, 'pass', { searchTool: tool, ...evidence });
  const unobserved = {
    cause: `retrieval recorded ok, but no ${tool} call returned in this review`,
    kind: 'unobserved',
  };

  it.each([
    ['a returned search', [search]],
    ['a subagent search', [`[ok] (subagent) ${tool}: {"query":"x"}`]],
    ['a search among other calls', ['[ok] Read: {"file_path":"a.ts"}', search]],
  ])('%s keeps ok clean', (_, calls) => {
    expect(check({ calls })).toBeUndefined();
  });

  it.each([
    ['no tool call at all', []],
    ['only checklist and grep calls', ['[ok] Bash: node checklist.mjs finalize', '[ok] Grep: {}']],
    ['an errored search', [`[error] ${tool}: {"query":"x"}`]],
    ['a refused search', [`[denied] ${tool}: {"query":"x"}`]],
    ['a search that never returned', [`[no result] ${tool}: {"query":"x"}`]],
    ['a prose mention of the tool', [`[ok] Bash: echo ${tool}: done`]],
  ])('%s degrades a recorded ok as unobserved', (_, calls) => {
    expect(check({ calls })).toEqual(unobserved);
  });

  it('matches only the configured searchTool', () => {
    const custom = { calls: [search], searchTool: 'mcp__acme__semanticSearch' };
    expect(check(custom)?.kind).toBe('unobserved');
    const own = { calls: ['[ok] mcp__acme__semanticSearch: {}'], searchTool: custom.searchTool };
    expect(check(own)).toBeUndefined();
  });

  it('a missing MCP alone leaves ok to its own channel; measured calls still decide', () => {
    expect(check({ mcpCause: 'MCP codebase unavailable' })).toBeUndefined();
    expect(check({ mcpCause: 'missing', calls: [] })).toEqual(unobserved);
    expect(check({ mcpCause: 'missing', calls: [search] })).toBeUndefined();
  });

  it('trusts ok when nothing was measured (codex, a test double)', () => {
    expect(check({ calls: null })).toBeUndefined();
    expect(check({})).toBeUndefined();
  });

  it('reads the exact line format claudeCommandLines renders', () => {
    const stream = [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: tool, input: { query: 'x' } }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hits' }] },
      },
    ];
    const calls = claudeCommandLines(stream.map((e) => JSON.stringify(e)).join('\n'));
    expect(check({ calls })).toBeUndefined();
  });

  it('prints an unverified retrieval as unverified, never unavailable', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
      lines.push(line);
    });
    reportRetrievalDegraded('commit-guard', unobserved.cause, 'unobserved');
    spy.mockRestore();
    expect(lines[0]).toContain('semantic retrieval unverified: retrieval recorded ok');
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
