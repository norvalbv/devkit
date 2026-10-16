import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregate, regressionFlips } from '../eval/bench.mts';
import { loadRows } from '../eval/cases.mts';

// The prior-art bench is excluded from every tsconfig project (`**/eval/**`), so its scoring
// arithmetic has no other guard: these cover the classifications that decide whether a baseline
// counts as evidence — unmeasured rows, the anti-"cry solved" positive list, corpus coverage, and
// the flip table the regression gate runs on.

const AGENT = { body: 'agent body', model: 'opus', raw: '---\nmodel: opus\n---\nagent body' };
const HASHES = {
  agentHash: 'a'.repeat(16),
  runnerHash: 'r'.repeat(16),
  corpusHash: 'c'.repeat(16),
};

const row = (overrides: Partial<Parameters<typeof aggregate>[0][number]> = {}) => ({
  id: 'int-row',
  verdict: 'SOLVED_ELSEWHERE',
  verdictOk: true,
  framing: 'DISSOLVES',
  framingOk: true,
  unanimous: true,
  valid: { ok: 1, total: 1 },
  gold: [{ slotId: 'g1', hit: true }],
  decoys: [{ slotId: 'd1', endorsed: false }],
  genuineClean: null,
  outages: 0,
  ...overrides,
});

describe('aggregate', () => {
  it('reports executed rows against the loaded corpus so a --only subset is visible', () => {
    const summary = aggregate([row()], AGENT, HASHES, 15);
    expect(summary.priorArt.corpus).toEqual({ executed: 1, total: 15 });
  });

  it('excludes slots on rows with zero valid runs from both gold and decoy denominators', () => {
    const dark = row({
      id: 'int-dark',
      valid: { ok: 0, total: 1 },
      gold: [{ slotId: 'g2', hit: false }],
      decoys: [{ slotId: 'd2', endorsed: false }],
      outages: 1,
    });
    const summary = aggregate([row(), dark], AGENT, HASHES, 2);
    expect(summary.priorArt.goldRecall).toEqual({ hits: 1, total: 1 });
    expect(summary.priorArt.decoyEndorsements).toEqual({ endorsed: 0, total: 1 });
    expect(summary.priorArt.outages).toBe(1);
  });

  it('counts only rows that carry the metric into framing and genuine-control denominators', () => {
    const summary = aggregate(
      [
        row({ framingOk: null, genuineClean: true }),
        row({ id: 'int-b', framingOk: false, genuineClean: false }),
      ],
      AGENT,
      HASHES,
      2,
    );
    expect(summary.priorArt.framingAccuracy).toEqual({ correct: 0, total: 1 });
    expect(summary.priorArt.genuineControls).toEqual({ clean: 1, total: 2 });
  });
});

describe('regressionFlips', () => {
  const baseline = (rows: ReturnType<typeof row>[]) =>
    JSON.stringify(aggregate(rows, AGENT, HASHES, rows.length));

  it('reports a verdict that passed the baseline and now fails, and gold hit→miss', () => {
    const before = baseline([row()]);
    const after = aggregate(
      [
        row({
          verdictOk: false,
          verdict: 'GENUINE_NEW_WORK',
          gold: [{ slotId: 'g1', hit: false }],
        }),
      ],
      AGENT,
      HASHES,
      1,
    );
    expect(regressionFlips(after, before)).toEqual([
      'int-row: verdict ok→fail (GENUINE_NEW_WORK)',
      'int-row: gold g1 hit→miss',
    ]);
  });

  it('reports a decoy going clean→endorsed and stays silent on improvements', () => {
    const before = baseline([row({ verdictOk: false })]);
    const after = aggregate(
      [row({ decoys: [{ slotId: 'd1', endorsed: true }] })],
      AGENT,
      HASHES,
      1,
    );
    expect(regressionFlips(after, before)).toEqual(['int-row: decoy d1 clean→endorsed']);
  });

  it('ignores baseline rows absent from the current run', () => {
    const before = baseline([row(), row({ id: 'int-gone' })]);
    expect(regressionFlips(aggregate([row()], AGENT, HASHES, 2), before)).toEqual([]);
  });
});

describe('committed corpus', () => {
  it('lints clean and keeps the partial-fix row from accepting SOLVED_ELSEWHERE', () => {
    // A trigger-only fix scored as solved is the exact miss this row exists to catch.
    const row = loadRows().find((candidate) => candidate.id === 'int-ship-resume-partial-fix');
    expect(row?.expectVerdict).not.toContain('SOLVED_ELSEWHERE');
    expect(row?.expectFraming).toEqual(['NARROWS']);
    expect(row?.legs.local).toMatchObject({ status: 'reached', resolved: 1 });
  });
});

describe('CLI argument wiring (no LLM call on either path)', () => {
  const bench = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../eval/bench.mts', import.meta.url)), ...args],
      {
        encoding: 'utf8',
      },
    );

  it('feeds a comma-separated --only into the run as one corpus', () => {
    const result = bench('coverage', '--only', 'int-qavis-visual-qa,int-vendored-adhd');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('prior-art-eval corpus: 2 rows');
  });

  it('exits 2 with usage when --only has no value, instead of a stack trace or a full run', () => {
    const result = bench('--dev', '--only');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: node bench.mts');
    expect(result.stderr).not.toContain('    at ');
  });
});
