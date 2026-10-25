import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { lintRows, runRow, summarize, validateRow } from '../bench.mts';
import { scoreRow, symbolsNamed } from '../corpus/row.mts';
import { queueRows } from '../propose/propose-telemetry.mts';

const helper = "export const quote = (w: string): string => `'${w}'`;\n";

// Test-only fixture in the shape of a commit-guard corpus row: real-style .mts paths under
// gate-engine/, a new file copying a helper the base already exports.
const cgRow = (over = {}) => ({
  id: 'cg-test-copied-helper',
  reviewer: 'commit-guard',
  expected: 'FAIL',
  expectItems: ['gate-engine/b/new.mts'],
  expectSymbols: ['quote', 'canonical'],
  repo: {
    base: { 'gate-engine/a/quote.mts': helper },
    staged: { 'gate-engine/b/new.mts': `const quote = (w: string): string => \`'\${w}'\`;\n` },
  },
  note: 'new.mts re-implements quote',
  ...over,
});

function fakeCommitGuard(issues) {
  const artifact = {
    files: [{ path: 'gate-engine/b/new.mts', status: 'fail', issues }],
  };
  return vi.fn(async (opts) => {
    mkdirSync(join(opts.cwd, '.claude'), { recursive: true });
    writeFileSync(join(opts.cwd, '.claude/.pre-commit-review.json'), JSON.stringify(artifact));
    return `VERDICT: FAIL — ${issues.join('; ')}`;
  });
}

describe('commit-guard rows in the reviewer bench', () => {
  it('selects commit-guard on a .mts fixture and attributes a files[] FAIL to the right item', async () => {
    const exec = fakeCommitGuard([
      'quote duplicates the exported quote in gate-engine/a/quote.mts',
    ]);
    const res = await runRow(cgRow(), { model: 'sonnet', cascade: true, exec });
    expect(res.finalStatus).toBe('fail');
    expect(res.reasonClass).toBe('right-item');
    expect(res.symbols).toEqual({ named: 1, expected: 2 });
  });

  it.each([
    ['a string items field', { items: 'junk' }],
    ['an object files field', { files: {} }],
  ])('a malformed artifact (%s) scores fail-unattributed instead of throwing', (_n, snapshot) => {
    const res = scoreRow(
      cgRow(),
      [{ label: 'review:commit-guard', out: 'VERDICT: FAIL — x', snapshot }],
      { status: 'fail' },
    );
    expect(res.reasonClass).toBe('fail-unattributed');
    expect(res.symbols).toEqual({ named: 0, expected: 2 });
  });

  it('validateRow finds expectItems among the per-file items commit-guard init generates', () => {
    expect(validateRow(cgRow()).problems).toEqual([]);
    expect(validateRow(cgRow({ expectItems: ['gate-engine/b/other.mts'] })).problems).toEqual([
      'expectItems: gate-engine/b/other.mts not in generated [gate-engine/b/new.mts]',
    ]);
  });

  it('summarize reports symbols named per blocked FAIL row', () => {
    const blocked = {
      id: 'g',
      expected: 'FAIL',
      okFinal: true,
      symbols: { named: 1, expected: 2 },
    };
    const missed = { id: 'm', expected: 'FAIL', okFinal: false, symbols: null };
    expect(summarize([blocked, missed]).symbols).toEqual([{ id: 'g', named: 1, expected: 2 }]);
  });

  it.each([
    ['an empty list', []],
    ['a non-array', 'shellWord'],
    ['a blank name', ['']],
    ['a non-identifier', ['a.b']],
  ])('lintRows rejects expectSymbols as %s', (_name, expectSymbols) => {
    expect(() => lintRows([cgRow({ expectSymbols })], 'commit-guard')).toThrow(/expectSymbols/);
  });
});

describe('symbolsNamed', () => {
  it('matches an identifier containing $ literally', () => {
    expect(symbolsNamed(['copies $shellWord'], ['$shellWord'])).toEqual({ named: 1, expected: 1 });
  });

  it('credits whole identifiers only', () => {
    const issues = ['duplicates canonicalPath', 'shellWord is a near-copy'];
    expect(symbolsNamed(issues, ['shellWord', 'canonical'])).toEqual({ named: 1, expected: 2 });
    expect(symbolsNamed(['canonical() copies it'], ['canonical'])).toEqual({
      named: 1,
      expected: 1,
    });
  });
});

describe('propose-telemetry queueRows', () => {
  const candidate = (reviewer, i) => ({
    reviewer,
    kind: 'fail-fix',
    failReason: `reason ${i}`,
    bytesAvailable: true,
    tsFail: `2026-10-0${i}T00:00:00Z`,
  });

  it('routes each reviewer to its suite and caps each suite separately', () => {
    const kept = [
      ...[1, 2, 3].map((i) => candidate('correctness-reviewer', i)),
      ...[1, 2, 3].map((i) => candidate('commit-guard', i)),
    ];
    const bump = vi.fn();
    const rows = queueRows(kept, 2, bump);
    expect(rows.map((r) => [r.suite, r.queueId.split('-reason')[0]])).toEqual([
      ['correctness', 'corr-tel'],
      ['correctness', 'corr-tel'],
      ['commit-guard', 'cg-tel'],
      ['commit-guard', 'cg-tel'],
    ]);
    expect(bump.mock.calls).toEqual([['over-max:correctness:1'], ['over-max:commit-guard:1']]);
  });
});
