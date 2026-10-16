import { describe, expect, it } from 'vitest';
import { BenchAbort } from '../../decisions/eval/bench.mts';
import { loadRows } from '../eval/cases.mts';
import type { SlotOutcome } from '../eval/matcher.mts';
import { formatRow, type RowResult, type RunMatch, selectRows } from '../eval/report.mts';

const ITEMS = [
  {
    desc: 'CONCLUSION (SOLVED_ELSEWHERE): adopt the existing tool',
    body: 'Do not build a harness.',
  },
  { desc: 'claim one', body: 'Kind: local · Source: a.mts' },
  { desc: 'claim two', body: 'Kind: web · Source: b.dev' },
];

const outcome = (overrides: Partial<SlotOutcome> = {}): SlotOutcome => ({
  slotId: 'd1',
  kind: 'decoy',
  match: 0,
  stable: true,
  outage: false,
  ...overrides,
});

const runMatch = (run: number, outcomes: SlotOutcome[]): RunMatch => ({
  run,
  items: ITEMS,
  outcomes,
});

const row = (overrides: Partial<Omit<RowResult, 'id'>> = {}): Omit<RowResult, 'id'> => ({
  verdict: 'SOLVED_ELSEWHERE',
  verdictOk: true,
  framing: 'DISSOLVES',
  framingOk: true,
  unanimous: true,
  valid: { ok: 1, total: 1 },
  gold: [],
  decoys: [],
  genuineClean: null,
  outages: 0,
  ...overrides,
});

describe('selectRows', () => {
  const corpus = loadRows();

  it('runs every id of a comma-separated --only as one corpus, in corpus order', () => {
    const rows = selectRows(corpus, 'int-qavis-visual-qa,int-vendored-adhd');
    expect(rows.map((entry) => entry.id)).toEqual(['int-vendored-adhd', 'int-qavis-visual-qa']);
  });

  it('aborts naming every unknown id instead of silently running a smaller subset', () => {
    expect(() => selectRows(corpus, 'int-qavis-visual-qa,int-typo,int-nope')).toThrow(
      'no row matches --only int-typo, int-nope',
    );
  });

  it('ignores duplicate ids and empty segments, and keeps the corpus without --only', () => {
    expect(selectRows(corpus, ' int-legs-dark,int-legs-dark,').map((entry) => entry.id)).toEqual([
      'int-legs-dark',
    ]);
    expect(selectRows(corpus, undefined)).toBe(corpus);
  });

  it('aborts on an empty --only rather than falling through to a paid full-corpus run', () => {
    // The old `if (only)` treated '' as absent and ran every row.
    for (const only of ['', ',', ' , ']) expect(() => selectRows(corpus, only)).toThrow(BenchAbort);
  });
});

describe('formatRow', () => {
  it('shows the item an endorsed decoy matched, 1-based, beside the conclusion', () => {
    const lines = formatRow('int-row', row({ decoys: [{ slotId: 'd1', endorsed: true }] }), [
      runMatch(0, [outcome({ match: 3 })]),
    ]);
    expect(lines).toEqual([
      '    int-row: V✓ F✓ DECOY-ENDORSED',
      '      decoy d1 endorsed 1/1 runs',
      '        run#0 ← F3: "claim two — Kind: web · Source: b.dev"',
      '        run#0 conclusion: "CONCLUSION (SOLVED_ELSEWHERE): adopt the existing tool — Do not build a harness."',
    ]);
  });

  it('marks a split matcher vote unstable and does not repeat the conclusion for F1', () => {
    const lines = formatRow('int-row', row({ decoys: [{ slotId: 'd1', endorsed: true }] }), [
      runMatch(0, [outcome({ match: 1, stable: false })]),
    ]);
    expect(lines.slice(2)).toEqual([
      '        run#0 ← F1 (unstable): "CONCLUSION (SOLVED_ELSEWHERE): adopt the existing tool — Do not build a harness."',
    ]);
  });

  it('shows the conclusion for a missed gold slot, and a dark matcher as dark', () => {
    const gold = (match: Partial<SlotOutcome>) => outcome({ slotId: 'g1', kind: 'gold', ...match });
    const lines = formatRow(
      'int-row',
      row({ valid: { ok: 2, total: 2 }, gold: [{ slotId: 'g1', hit: false }] }),
      [runMatch(0, [gold({})]), runMatch(1, [gold({ outage: true })])],
    );
    expect(lines.slice(1)).toEqual([
      '      gold g1 missed 2/2 runs',
      '        run#0 conclusion: "CONCLUSION (SOLVED_ELSEWHERE): adopt the existing tool — Do not build a harness."',
      '        run#1: matcher dark',
    ]);
  });

  it('marks a gold miss from a split matcher vote unstable, so it is not read as an agent miss', () => {
    // voteSlot turns a tied or dissenting vote into match 0 + stable false, not an outage.
    const lines = formatRow('int-row', row({ gold: [{ slotId: 'g1', hit: false }] }), [
      runMatch(0, [outcome({ slotId: 'g1', kind: 'gold', stable: false })]),
    ]);
    expect(lines[2]).toBe(
      '        run#0 conclusion (unstable): "CONCLUSION (SOLVED_ELSEWHERE): adopt the existing tool — Do not build a harness."',
    );
  });

  it('prints only the runs that agree with the row majority, under their checkpoint run index', () => {
    // Run 0 was invalid, so the valid runs are 1..3 and the minority run 2 must stay silent.
    const lines = formatRow(
      'int-row',
      row({ valid: { ok: 3, total: 4 }, decoys: [{ slotId: 'd1', endorsed: true }] }),
      [
        runMatch(1, [outcome({ match: 1 })]),
        runMatch(2, [outcome()]),
        runMatch(3, [outcome({ match: 1 })]),
      ],
    );
    expect(lines[1]).toBe('      decoy d1 endorsed 2/3 runs');
    expect(lines.slice(2).map((text) => text.trim().split(' ')[0])).toEqual(['run#1', 'run#3']);
  });

  it('prints nothing under a slot the majority did not flag', () => {
    const lines = formatRow('int-row', row({ decoys: [{ slotId: 'd1', endorsed: false }] }), [
      runMatch(0, [outcome({ match: 2 })]),
    ]);
    expect(lines).toEqual(['    int-row: V✓ F✓']);
  });

  it('says a row with no valid response was unmeasured rather than a gold miss', () => {
    const lines = formatRow(
      'int-dark',
      row({
        verdict: 'DARK',
        verdictOk: false,
        framingOk: null,
        valid: { ok: 0, total: 3 },
        gold: [{ slotId: 'g1', hit: false }],
      }),
      [],
    );
    expect(lines).toEqual(['    int-dark: V✗(DARK) no valid response (0/3)']);
  });

  it('keeps every excerpt on one line and within 240 characters', () => {
    const long = { desc: `CONCLUSION:\n${'word '.repeat(80)}`, body: 'tail' };
    const [, , picked = ''] = formatRow(
      'int-row',
      row({ decoys: [{ slotId: 'd1', endorsed: true }] }),
      [{ run: 0, items: [long], outcomes: [outcome({ match: 1 })] }],
    );
    const quoted = picked.slice(picked.indexOf('"') + 1, -1);
    expect(quoted).not.toContain('\n');
    expect(quoted).toHaveLength(240);
    expect(quoted.endsWith('…')).toBe(true);
  });
});
