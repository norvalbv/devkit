/** The run banner prices per EFFECTIVE model and names what it cannot price (sc-2494 probe-first). */
import { describe, expect, it } from 'vitest';
import { estimateMinutes, firstPassMeanSecs, runBannerLines } from '../stats.mts';

const TABLE = { haiku: 60, sonnet: 120 };

describe('estimateMinutes', () => {
  it('prices each reviewer on its own effective model and names an unpriced pin instead of defaulting it', () => {
    const b = estimateMinutes(
      [
        { model: 'gpt-5.6-sol', rows: 140 },
        { model: 'haiku', rows: 13 },
        { model: 'haiku', rows: 44 },
      ],
      { estEscalations: 10, escalateSecs: 60, concurrency: 2, table: TABLE },
    );
    expect(b.unpriced).toEqual(['gpt-5.6-sol']);
    expect(b.unpricedRows).toBe(140);
    expect(b.minutes).toBe(Math.round(((13 + 44) * 60 + 10 * 60) / 60 / 2));
  });
  it('reports no unpriced model when every pin is in the table', () => {
    const b = estimateMinutes([{ model: 'sonnet', rows: 10 }], { concurrency: 1, table: TABLE });
    expect(b).toEqual({ minutes: 20, unpriced: [], unpricedRows: 0 });
  });
});

describe('firstPassMeanSecs', () => {
  it('averages only rows that ran, per model', () => {
    const m = firstPassMeanSecs([
      {
        model: 'gpt-5.6-sol',
        results: [{ ms: { first: 90_000 } }, { ms: { first: 30_000 } }, { ms: { first: 0 } }],
      },
      { model: 'haiku', results: [{ ms: { first: 0 } }, { finalStatus: 'paused-skipped' }] },
    ]);
    expect([...m]).toEqual([['gpt-5.6-sol', 60]]);
  });
});

describe('runBannerLines', () => {
  const rows = (n: number, gold: number) =>
    Array.from({ length: n }, (_, i) => ({ expected: i < gold ? 'FAIL' : 'PASS' }));
  it('names the shipped pin as unpriced on a second line and never costs it as the default', () => {
    const lines = runBannerLines(
      [
        { reviewer: { name: 'correctness-reviewer', model: 'gpt-5.6-sol' }, rows: rows(140, 75) },
        { reviewer: { name: 'backend-performance-reviewer' }, rows: rows(13, 7) },
      ],
      {
        model: 'haiku',
        cascade: true,
        concurrency: 2,
        dev: false,
        resuming: 0,
        table: TABLE,
        escalateSecs: 60,
      },
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/153 rows \(82 gold\) · model haiku · cascade on/);
    // 13 rows × 60s + (7 gold + round(6×0.15)=1) escalations × 60s = 1260s, over 2 workers → 10.5 → 11 min
    expect(lines[0]).toMatch(/est ≈ 11 min/);
    expect(lines[1]).toMatch(/no cost entry for gpt-5.6-sol — estimate excludes 140 row\(s\)/);
  });
  it('prints single-pass and the pin as the model label when every reviewer is pinned', () => {
    const [line, ...rest] = runBannerLines(
      [{ reviewer: { name: 'correctness-reviewer', model: 'sonnet' }, rows: rows(2, 1) }],
      {
        model: 'haiku',
        cascade: true,
        concurrency: 1,
        dev: true,
        resuming: 3,
        table: TABLE,
        escalateSecs: 60,
      },
    );
    expect(rest).toEqual([]);
    expect(line).toMatch(/model sonnet · cascade single-pass · concurrency 1 · est ≈ 4 min/);
    expect(line).toMatch(
      /--dev \(holdouts excluded\) · resuming \(3 checkpointed row\(s\) on disk\)/,
    );
  });
});
