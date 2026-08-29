import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerdictMeta } from '../../judge/verdict-store.mts';
import { runCommentFirewall } from '../gate.mts';
import type { RationaleStoreLocation } from '../rationales.mts';
import { receiptKey } from '../judge.mts';
import type {
  CommentFinding,
  CommentJudgeBatchResult,
  CommentJudgeChunkFailure,
  CommentJudgeOutcome,
  CommentRationale,
  DetectionResult,
  RationaleStore,
} from '../types.mts';

/** A complete review: every supplied verdict landed, nothing was left unjudged. */
const judged = (results: CommentJudgeBatchResult): CommentJudgeOutcome => ({
  results,
  unjudged: [],
  failures: [],
  planned: 1,
  spawned: 1,
  bin: 'claude',
});

/** The failing batch is the last one planned, so its 0-based index fixes the plan size. Deriving it
 * from the verdict COUNT instead would fabricate a batch per finding on any multi-finding batch. */
const failed = (
  failure: CommentJudgeChunkFailure,
  results: CommentJudgeBatchResult = {},
  bin = 'claude',
): CommentJudgeOutcome => ({
  results,
  unjudged: failure.findingIds,
  failures: [failure],
  planned: failure.batch + 1,
  spawned: failure.batch + 1,
  bin,
});

const finding: CommentFinding = {
  id: 'a1b2c3d4e5f6',
  path: 'src/a.ts',
  extension: 'ts',
  adapterVersion: 'typescript-scanner-v2',
  kind: 'line',
  startLine: 2,
  endLine: 2,
  comment: '// The wire format uses UTF-16 code units.',
  context: 'const width = input.length;\n// The wire format uses UTF-16 code units.',
  relevantDiff: '@@ -1 +1,2 @@\n+// The wire format uses UTF-16 code units.',
};
const rationale: CommentRationale = {
  rationale: 'The external protocol defines offsets in UTF-16 code units, unlike byte length.',
  at: '2026-08-15T00:00:00.000Z',
};
const detection = (findings: CommentFinding[] = [finding]): DetectionResult => ({
  findings,
  unsupported: [],
});
const store = (entries: RationaleStore['entries'] = {}): RationaleStore => ({
  version: 1,
  entries,
});
const location = (over: Partial<RationaleStoreLocation> = {}): RationaleStoreLocation => ({
  sharedFile: '/repo/.git/devkit/comment-firewall-rationales.json',
  writableFile: '/repo/.git/devkit/comment-firewall-rationales.json',
  sharedExists: true,
  sharedFindingIds: [],
  privateReview: false,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function quiet(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('runCommentFirewall', () => {
  it('blocks deterministically before invoking a judge when rationale is missing', () => {
    quiet();
    const judge = vi.fn();
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection(),
        loadRationales: () => store(),
        loadReceipts: () => ({}),
        judge,
      }),
    ).toBe(1);
    expect(judge).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'create/link its cleanup ticket',
    );
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('--from-ship-log');
  });

  it('prints the retained ship log as one shell-safe recovery argument', () => {
    quiet();
    vi.stubEnv('DEVKIT_SHIP_GATE_LOG', "/tmp/repo's $gate;log/.devkit/last-ship-gates-feat.log");

    expect(
      runCommentFirewall('/repo', {
        detect: () => detection(),
        loadRationales: () => store(),
        loadReceipts: () => ({}),
      }),
    ).toBe(1);
    const output = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(output.match(/--from-ship-log/g)).toHaveLength(2);
    expect(output).toContain(
      `--from-ship-log '/tmp/repo'"'"'s $gate;log/.devkit/last-ship-gates-feat.log'`,
    );
  });

  it('names the evidence store it consulted and how many rationales it held', () => {
    quiet();
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection(),
        loadRationales: () => store(),
        loadReceipts: () => ({}),
        describeStore: () => location({ sharedFindingIds: ['a1', 'b2', 'c3'] }),
      }),
    ).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'Evidence store: /repo/.git/devkit/comment-firewall-rationales.json — 3 recorded rationales',
    );
  });

  it('distinguishes an absent store from one that loaded zero entries', () => {
    quiet();
    runCommentFirewall('/repo', {
      detect: () => detection(),
      loadRationales: () => store(),
      loadReceipts: () => ({}),
      describeStore: () => location({ sharedExists: false }),
    });
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'comment-firewall-rationales.json — file does not exist',
    );
  });

  it('warns that a managed-review data root is invisible to ship', () => {
    quiet();
    runCommentFirewall('/repo', {
      detect: () => detection(),
      loadRationales: () => store(),
      loadReceipts: () => ({}),
      describeStore: () =>
        location({ writableFile: '/private/review/rationales.json', privateReview: true }),
    });
    const output = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(output).toContain(
      'A managed-review data root is in effect: /private/review/rationales.json',
    );
    expect(output).toContain('devkit ship reads ONLY the shared store above');
  });

  it.each([
    ['an absent store', { sharedExists: false }, 'file does not exist'],
    ['an existing empty store', { sharedFindingIds: [] }, '0 recorded rationales'],
    ['a single entry', { sharedFindingIds: ['a1'] }, '1 recorded rationale'],
    ['several entries', { sharedFindingIds: ['a1', 'b2'] }, '2 recorded rationales'],
  ])('describes %s', (_label, over, expected) => {
    quiet();
    runCommentFirewall('/repo', {
      detect: () => detection(),
      loadRationales: () => store(),
      loadReceipts: () => ({}),
      describeStore: () => location(over),
    });
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      `comment-firewall-rationales.json — ${expected}`,
    );
  });

  it('never renders a single entry with a plural noun', () => {
    quiet();
    runCommentFirewall('/repo', {
      detect: () => detection(),
      loadRationales: () => store(),
      loadReceipts: () => ({}),
      describeStore: () => location({ sharedFindingIds: ['a1'] }),
    });
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain(
      '1 recorded rationales',
    );
  });

  it('says a present store is unreadable rather than silently calling it empty', () => {
    quiet();
    runCommentFirewall('/repo', {
      detect: () => detection(),
      loadRationales: () => store(),
      loadReceipts: () => ({}),
      describeStore: () => location({ sharedFindingIds: null }),
    });
    const output = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(output).toContain('comment-firewall-rationales.json — unreadable');
    expect(output).not.toContain('0 recorded');
  });

  it('still blocks cleanly when the store cannot be described at all', () => {
    quiet();
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection(),
        loadRationales: () => store(),
        loadReceipts: () => ({}),
        describeStore: () => {
          throw new Error('git is unavailable');
        },
      }),
    ).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('Evidence store:');
  });

  it('lets Haiku downgrade the block and writes a content-addressed PASS receipt', () => {
    quiet();
    const saved: Record<string, VerdictMeta> = {};
    const rationales = store({ [finding.id]: rationale });
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection(),
        loadRationales: () => rationales,
        loadReceipts: () => ({}),
        saveReceipt: (_file, entries) => {
          Object.assign(saved, entries);
          return true;
        },
        judge: () =>
          judged({
            [finding.id]: {
              verdict: 'PASS',
              reason: 'Documents an external protocol invariant.',
            },
          }),
        model: () => 'haiku',
      }),
    ).toBe(0);
    const key = receiptKey(finding, rationale, 'haiku');
    expect(saved[key]).toMatchObject({ verdict: 'PASS', findingId: finding.id, model: 'haiku' });
  });

  it('reuses an exact PASS receipt without another model call', () => {
    quiet();
    const judge = vi.fn();
    const rationales = store({ [finding.id]: rationale });
    const key = receiptKey(finding, rationale, 'haiku');
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection(),
        loadRationales: () => rationales,
        loadReceipts: () => ({ [key]: { verdict: 'PASS' } }),
        judge,
        model: () => 'haiku',
      }),
    ).toBe(0);
    expect(judge).not.toHaveBeenCalled();
  });

  it('blocks when an approved PASS receipt cannot be persisted', () => {
    quiet();
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection(),
        loadRationales: () => store({ [finding.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt: () => false,
        judge: () =>
          judged({
            [finding.id]: {
              verdict: 'PASS',
              reason: 'Documents an external protocol invariant.',
            },
          }),
      }),
    ).toBe(4);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'PASS receipts could not be persisted',
    );
  });

  it('keeps a rejected explanation blocking and writes no receipt', () => {
    quiet();
    const saveReceipt = vi.fn(() => true);
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection(),
        loadRationales: () => store({ [finding.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt,
        judge: () =>
          judged({
            [finding.id]: {
              verdict: 'FAIL',
              reason: 'The comment defends a removable workaround.',
            },
          }),
      }),
    ).toBe(1);
    expect(saveReceipt).not.toHaveBeenCalled();
  });

  it('distinguishes ordinary and strict judge outages', () => {
    quiet();
    const base = {
      detect: () => detection(),
      loadRationales: () => store({ [finding.id]: rationale }),
      loadReceipts: () => ({}),
      judge: () => failed({ kind: 'outage', batch: 0, findingIds: [finding.id] }),
    };
    expect(runCommentFirewall('/repo', { ...base, strict: () => false })).toBe(2);
    expect(runCommentFirewall('/repo', { ...base, strict: () => true })).toBe(3);
  });

  it('names the reviewer failure that actually happened, never the old disjunction', () => {
    const cases = [
      {
        failure: { kind: 'malformed' as const, truncated: true, replyChars: 41_233 },
        expect: /cut off mid-verdict after 41233 characters/,
        remedy: /GUARD_COMMENTS_BATCH/,
      },
      {
        failure: { kind: 'timeout' as const },
        expect: /hit its 120s cap/,
        remedy: /NOT an auth\/quota problem/,
      },
      {
        failure: { kind: 'disabled' as const },
        expect: /GUARD_NO_LLM is set/,
        remedy: /unset GUARD_NO_LLM/,
      },
    ];
    for (const item of cases) {
      quiet();
      expect(
        runCommentFirewall('/repo', {
          detect: () => detection(),
          loadRationales: () => store({ [finding.id]: rationale }),
          loadReceipts: () => ({}),
          judge: () => failed({ ...item.failure, batch: 0, findingIds: [finding.id] }),
          strict: () => true,
        }),
      ).toBe(3);
      const output = vi.mocked(console.error).mock.calls.flat().join('\n');
      expect(output).toMatch(item.expect);
      expect(output).toMatch(item.remedy);
      expect(output).not.toContain('unavailable or returned malformed evidence');
      expect(output).not.toMatch(/auth\/quota, then re-run/);
      vi.restoreAllMocks();
    }
  });

  it('sends a genuine outage to the binary that went dark, not always claude', () => {
    quiet();
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection(),
        loadRationales: () => store({ [finding.id]: rationale }),
        loadReceipts: () => ({}),
        judge: () => failed({ kind: 'outage', batch: 0, findingIds: [finding.id] }, {}, 'codex'),
        strict: () => true,
      }),
    ).toBe(3);
    const output = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(output).toContain('check `codex` CLI auth/quota');
    expect(output).not.toContain('claude');
  });

  it('classifies deterministic batch overflow as unsafe evidence, not a reviewer outage', () => {
    quiet();
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection(),
        loadRationales: () => store({ [finding.id]: rationale }),
        loadReceipts: () => ({}),
        judge: () => {
          throw new RangeError('comment review batch exceeds 200 findings');
        },
      }),
    ).toBe(4);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'deterministic review-batch limit exceeded',
    );
  });

  it('discards PASS when local evidence changes during the model call', () => {
    quiet();
    const saveReceipt = vi.fn(() => true);
    let calls = 0;
    expect(
      runCommentFirewall('/repo', {
        detect: () => (calls++ === 0 ? detection() : detection([])),
        loadRationales: () => store({ [finding.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt,
        judge: () => judged({ [finding.id]: { verdict: 'PASS', reason: 'Valid.' } }),
      }),
    ).toBe(1);
    expect(saveReceipt).not.toHaveBeenCalled();
  });

  it('persists PASS when only hunk start coordinates shift during the model call', () => {
    quiet();
    const shifted = {
      ...finding,
      startLine: 102,
      endLine: 102,
      relevantDiff: '@@ -101 +101,2 @@\n+// The wire format uses UTF-16 code units.',
    };
    const saveReceipt = vi.fn(() => true);
    let calls = 0;
    expect(
      runCommentFirewall('/repo', {
        detect: () => (calls++ === 0 ? detection() : detection([shifted])),
        loadRationales: () => store({ [finding.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt,
        judge: () => judged({ [finding.id]: { verdict: 'PASS', reason: 'Valid.' } }),
        model: () => 'haiku',
      }),
    ).toBe(0);
    expect(saveReceipt).toHaveBeenCalledTimes(1);
  });

  it('discards PASS when a new finding appears during the model call', () => {
    quiet();
    const shifted = {
      ...finding,
      startLine: 102,
      endLine: 102,
      relevantDiff: '@@ -101 +101,2 @@\n+// The wire format uses UTF-16 code units.',
    };
    const added = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts' };
    const saveReceipt = vi.fn(() => true);
    let calls = 0;
    expect(
      runCommentFirewall('/repo', {
        detect: () => (calls++ === 0 ? detection() : detection([shifted, added])),
        loadRationales: () => store({ [finding.id]: rationale, [added.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt,
        judge: () => judged({ [finding.id]: { verdict: 'PASS', reason: 'Valid.' } }),
        model: () => 'haiku',
      }),
    ).toBe(1);
    expect(saveReceipt).not.toHaveBeenCalled();
  });

  it('discards PASS when unsupported staged source appears during the model call', () => {
    quiet();
    const saveReceipt = vi.fn(() => true);
    let calls = 0;
    expect(
      runCommentFirewall('/repo', {
        detect: () =>
          calls++ === 0
            ? detection()
            : {
                findings: [finding],
                unsupported: [{ extension: 'py', path: 'src/new.py' }],
              },
        loadRationales: () => store({ [finding.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt,
        judge: () => judged({ [finding.id]: { verdict: 'PASS', reason: 'Valid.' } }),
        model: () => 'haiku',
      }),
    ).toBe(1);
    expect(saveReceipt).not.toHaveBeenCalled();
  });

  it('discards PASS when an already-receipted finding changes during another review', () => {
    quiet();
    const cached = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts' };
    const changedCached = {
      ...cached,
      relevantDiff: `${cached.relevantDiff}\n+const changed = true;`,
    };
    const cachedKey = receiptKey(cached, rationale, 'haiku');
    const saveReceipt = vi.fn(() => true);
    let calls = 0;
    expect(
      runCommentFirewall('/repo', {
        detect: () =>
          calls++ === 0 ? detection([finding, cached]) : detection([finding, changedCached]),
        loadRationales: () => store({ [finding.id]: rationale, [cached.id]: rationale }),
        loadReceipts: () => ({ [cachedKey]: { verdict: 'PASS' } }),
        saveReceipt,
        judge: () => judged({ [finding.id]: { verdict: 'PASS', reason: 'Valid.' } }),
        model: () => 'haiku',
      }),
    ).toBe(1);
    expect(saveReceipt).not.toHaveBeenCalled();
  });

  it('reviews all pending rationales in one batch and persists both decisions together', () => {
    quiet();
    const second = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts' };
    const rationales = store({ [finding.id]: rationale, [second.id]: rationale });
    const judge = vi.fn(() =>
      judged({
        [finding.id]: { verdict: 'PASS' as const, reason: 'First invariant.' },
        [second.id]: { verdict: 'PASS' as const, reason: 'Second invariant.' },
      }),
    );
    const saveReceipt = vi.fn(() => true);

    expect(
      runCommentFirewall('/repo', {
        detect: () => detection([finding, second]),
        loadRationales: () => rationales,
        loadReceipts: () => ({}),
        saveReceipt,
        judge,
      }),
    ).toBe(0);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]?.[1]).toHaveLength(2);
    expect(Object.keys(saveReceipt.mock.calls[0]?.[1] ?? {})).toHaveLength(2);
  });

  it('receipts the batches that parsed so the retry reviews only the remainder', () => {
    quiet();
    const second = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts' };
    const rationales = store({ [finding.id]: rationale, [second.id]: rationale });
    const persisted: Record<string, VerdictMeta> = {};
    const saveReceipt = vi.fn((_file: string, entries: Record<string, VerdictMeta>) => {
      Object.assign(persisted, entries);
      return true;
    });
    const first = vi.fn(() =>
      failed(
        {
          kind: 'malformed',
          batch: 1,
          findingIds: [second.id],
          truncated: true,
          replyChars: 8_192,
        },
        { [finding.id]: { verdict: 'PASS' as const, reason: 'First invariant.' } },
      ),
    );

    expect(
      runCommentFirewall('/repo', {
        detect: () => detection([finding, second]),
        loadRationales: () => rationales,
        loadReceipts: () => ({}),
        saveReceipt,
        judge: first,
        model: () => 'haiku',
        strict: () => false,
      }),
    ).toBe(2);
    expect(Object.keys(saveReceipt.mock.calls[0]?.[1] ?? {})).toEqual([
      receiptKey(finding, rationale, 'haiku'),
    ]);
    const output = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(output).toContain('judged 1 of 2 pending findings in 1 of 2 batches');
    expect(output).toContain(second.id);
    expect(output).toContain('re-running reviews only the 1');

    const retry = vi.fn(() => judged({ [second.id]: { verdict: 'PASS', reason: 'Second.' } }));
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection([finding, second]),
        loadRationales: () => rationales,
        loadReceipts: () => persisted,
        saveReceipt: () => true,
        judge: retry,
        model: () => 'haiku',
      }),
    ).toBe(0);
    expect(retry.mock.calls[0]?.[1]).toHaveLength(1);
    expect(retry.mock.calls[0]?.[1]?.[0]?.finding.id).toBe(second.id);
  });

  it('lets a judged rejection outrank an incomplete review, after receipting its sibling', () => {
    quiet();
    const second = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts' };
    const third = { ...finding, id: 'c1d2e3f4a5b6', path: 'src/c.ts' };
    const saveReceipt = vi.fn(() => true);
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection([finding, second, third]),
        loadRationales: () =>
          store({ [finding.id]: rationale, [second.id]: rationale, [third.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt,
        judge: () =>
          failed(
            { kind: 'malformed', batch: 1, findingIds: [third.id], replyChars: 900 },
            {
              [finding.id]: { verdict: 'PASS' as const, reason: 'Invariant.' },
              [second.id]: { verdict: 'FAIL' as const, reason: 'Defends a workaround.' },
            },
          ),
        strict: () => false,
      }),
    ).toBe(1);
    expect(saveReceipt).toHaveBeenCalledTimes(1);
  });

  it('blocks a partial publish when local evidence changed during the review', () => {
    quiet();
    const second = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts' };
    const saveReceipt = vi.fn(() => true);
    let calls = 0;
    expect(
      runCommentFirewall('/repo', {
        detect: () => (calls++ === 0 ? detection([finding, second]) : detection([finding])),
        loadRationales: () => store({ [finding.id]: rationale, [second.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt,
        judge: () =>
          failed(
            { kind: 'malformed', batch: 1, findingIds: [second.id], replyChars: 900 },
            {
              [finding.id]: { verdict: 'PASS' as const, reason: 'Invariant.' },
            },
          ),
      }),
    ).toBe(1);
    expect(saveReceipt).not.toHaveBeenCalled();
  });

  it('blocks when a partial run cannot persist the receipts it did earn', () => {
    quiet();
    const second = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts' };
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection([finding, second]),
        loadRationales: () => store({ [finding.id]: rationale, [second.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt: () => false,
        judge: () =>
          failed(
            { kind: 'malformed', batch: 1, findingIds: [second.id], replyChars: 900 },
            {
              [finding.id]: { verdict: 'PASS' as const, reason: 'Invariant.' },
            },
          ),
        strict: () => false,
      }),
    ).toBe(4);
    const output = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(output).toContain('PASS receipts could not be persisted');
    expect(output).not.toContain('re-running reviews only');
  });

  it('keeps the fail-open contract for an unjudged remainder on a plain commit', () => {
    quiet();
    const second = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts' };
    const deps = {
      detect: () => detection([finding, second]),
      loadRationales: () => store({ [finding.id]: rationale, [second.id]: rationale }),
      loadReceipts: () => ({}),
      saveReceipt: () => true,
      judge: () =>
        failed(
          { kind: 'timeout', batch: 1, findingIds: [second.id] },
          {
            [finding.id]: { verdict: 'PASS' as const, reason: 'Invariant.' },
          },
        ),
    };
    expect(runCommentFirewall('/repo', { ...deps, strict: () => false })).toBe(2);
    expect(runCommentFirewall('/repo', { ...deps, strict: () => true })).toBe(3);
  });

  it('still reports a cause when an injected judge leaves findings unjudged silently', () => {
    quiet();
    const second = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts' };
    expect(
      runCommentFirewall('/repo', {
        detect: () => detection([finding, second]),
        loadRationales: () => store({ [finding.id]: rationale, [second.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt: () => true,
        judge: () => ({
          results: { [finding.id]: { verdict: 'PASS' as const, reason: 'Invariant.' } },
          unjudged: [second.id],
          failures: [],
          planned: 1,
          spawned: 1,
          bin: 'claude',
        }),
        strict: () => false,
      }),
    ).toBe(2);
    const output = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(output).toContain('the reviewer returned no verdict');
    expect(output).toContain(second.id);
  });

  it('fails visibly when a configured changed language has no lexer adapter', () => {
    quiet();
    expect(
      runCommentFirewall('/repo', {
        detect: () => ({ findings: [], unsupported: [{ extension: 'py', path: 'src/a.py' }] }),
        loadRationales: () => store(),
      }),
    ).toBe(4);
  });
});
