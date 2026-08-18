import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerdictMeta } from '../../judge/verdict-store.mts';
import { runCommentFirewall } from '../gate.mts';
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
  adapterVersion: 'typescript-scanner-v1',
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

afterEach(() => vi.restoreAllMocks());

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
        judge: () => ({ verdict: 'PASS', reason: 'Documents an external protocol invariant.' }),
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
        judge: () => ({ verdict: 'PASS', reason: 'Documents an external protocol invariant.' }),
      }),
    ).toBe(4);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'PASS receipt could not be persisted',
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
        judge: () => ({ verdict: 'FAIL', reason: 'The comment defends a removable workaround.' }),
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

  it('discards PASS when staged evidence changes during the model call', () => {
    quiet();
    const saveReceipt = vi.fn(() => true);
    let calls = 0;
    expect(
      runCommentFirewall('/repo', {
        detect: () => (calls++ === 0 ? detection() : detection([])),
        loadRationales: () => store({ [finding.id]: rationale }),
        loadReceipts: () => ({}),
        saveReceipt,
        judge: () => ({ verdict: 'PASS', reason: 'Valid.' }),
      }),
    ).toBe(1);
    expect(saveReceipt).not.toHaveBeenCalled();
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
