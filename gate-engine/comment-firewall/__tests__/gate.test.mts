import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerdictMeta } from '../../judge/verdict-store.mts';
import { runCommentFirewall } from '../gate.mts';
import type { RationaleStoreLocation } from '../rationales.mts';
import { receiptKey } from '../judge.mts';
import type {
  CommentFinding,
  CommentRationale,
  DetectionResult,
  RationaleStore,
} from '../types.mts';

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
        judge: () => ({
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
        judge: () => ({
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
        judge: () => ({
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
      judge: () => null,
    };
    expect(runCommentFirewall('/repo', { ...base, strict: () => false })).toBe(2);
    expect(runCommentFirewall('/repo', { ...base, strict: () => true })).toBe(3);
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
        judge: () => ({ [finding.id]: { verdict: 'PASS', reason: 'Valid.' } }),
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
        judge: () => ({ [finding.id]: { verdict: 'PASS', reason: 'Valid.' } }),
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
        judge: () => ({ [finding.id]: { verdict: 'PASS', reason: 'Valid.' } }),
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
        judge: () => ({ [finding.id]: { verdict: 'PASS', reason: 'Valid.' } }),
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
        judge: () => ({ [finding.id]: { verdict: 'PASS', reason: 'Valid.' } }),
        model: () => 'haiku',
      }),
    ).toBe(1);
    expect(saveReceipt).not.toHaveBeenCalled();
  });

  it('reviews all pending rationales in one batch and persists both decisions together', () => {
    quiet();
    const second = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts' };
    const rationales = store({ [finding.id]: rationale, [second.id]: rationale });
    const judge = vi.fn(() => ({
      [finding.id]: { verdict: 'PASS' as const, reason: 'First invariant.' },
      [second.id]: { verdict: 'PASS' as const, reason: 'Second invariant.' },
    }));
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
