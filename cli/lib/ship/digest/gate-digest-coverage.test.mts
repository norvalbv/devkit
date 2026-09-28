import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GateEvent, readShipEvents, render, summarise } from './gate-digest.mts';

// sc-2305: a PASS over a capped packet that left files out reads as unverified, never as ✓.
const SHIP = 'ship-1';
const sinkWith = (lines: string[]): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-digest-coverage-')), 'gate-events.jsonl');
  writeFileSync(file, lines.join('\n'));
  return file;
};
const ev = (o: GateEvent): GateEvent => ({ ship_id: SHIP, ...o });
const partial = {
  evidence_file_count: 32,
  evidence_omitted_files: 14,
  evidence_truncated_files: 2,
  evidence_omitted_paths: ['src/a.mts', 'src/b.mts', 'src/c.mts', 'src/d.mts'],
};

describe('summarise — partial evidence packets', () => {
  it('flags only the reviewer whose packet was partial (PR #502 shape)', () => {
    const rows = summarise(
      [
        ev({ type: 'ship_attempt' }),
        ev({ type: 'review_result', reviewer: 'correctness-reviewer', status: 'pass' }),
        ev({ type: 'review_result', reviewer: 'conventions-reviewer', status: 'pass', ...partial }),
        ev({ type: 'ship_result', blocked_gate: null, exit_code: 0 }),
      ],
      SHIP,
    );
    expect(rows).toEqual([
      {
        gate: 'review:conventions-reviewer',
        state: 'unverified',
        blocking: false,
        detail:
          'PASS over an incomplete packet: 14/32 file(s) omitted, 2 truncated — not shown: src/a.mts, src/b.mts, src/c.mts, …',
      },
    ]);
  });

  it('names the lens when the partial packet was one lens of a fanned-out reviewer', () => {
    const [row] = summarise(
      [
        ev({
          type: 'review_result',
          reviewer: 'correctness-reviewer',
          status: 'pass',
          ...partial,
          evidence_lens: 'writer-reader-contracts',
        }),
      ],
      SHIP,
    );
    expect(row.detail).toContain('(writer-reader-contracts lens)');
  });

  it('reports a cached PASS over a partial packet as unverified, not as a cache ✓', () => {
    const rows = summarise(
      [ev({ type: 'cache_hit', judge: 'review:api-security-reviewer', ...partial })],
      SHIP,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gate: 'review:api-security-reviewer', state: 'unverified' });
    expect(rows[0].detail).toMatch(/^cached PASS over an incomplete packet/);
  });

  it('leaves a FAIL over a partial packet a blocking finding — coverage never softens a block', () => {
    const rows = summarise(
      [
        ev({ type: 'review_result', reviewer: 'conventions-reviewer', status: 'fail', ...partial }),
        ev({ type: 'ship_result', blocked_gate: 'review' }),
      ],
      SHIP,
    );
    expect(rows).toEqual([
      expect.objectContaining({ gate: 'review:conventions-reviewer', state: 'finding', blocking: true }),
    ]);
  });

  it('adds nothing for clean PASSes or a zero-valued field, and a clean cache hit stays ✓', () => {
    const rows = summarise(
      [
        ev({ type: 'review_result', reviewer: 'x', status: 'pass', evidence_omitted_files: 0 }),
        ev({ type: 'cache_hit', judge: 'review:y' }),
      ],
      SHIP,
    );
    expect(rows).toEqual([{ gate: 'review:y', state: 'cached', blocking: false, detail: '' }]);
  });

  it('renders on an otherwise green run — the run a reader stops tailing', () => {
    const text = render(
      summarise(
        [ev({ type: 'review_result', reviewer: 'commit-guard', status: 'pass', ...partial })],
        SHIP,
      ),
    );
    expect(text).toContain('· review:commit-guard — PASS over an incomplete packet: 14/32');
  });

  it('never throws on hostile JSON field shapes — the digest holds no authority to fail a run', () => {
    // Raw sink lines, read through the real I/O boundary: the shapes a typed fixture cannot express.
    const hostile = '{"toString":1,"valueOf":1}';
    const sink = sinkWith([
      `{"ship_id":"${SHIP}","type":"review_result","reviewer":"conventions-reviewer","status":"pass","evidence_omitted_files":${hostile},"evidence_truncated_files":"3","evidence_file_count":${hostile},"evidence_omitted_paths":[{"toString":1},42,"src/ok.mts"],"evidence_lens":{"toString":1}}`,
      `{"ship_id":"${SHIP}","type":"review_result","reviewer":"commit-guard","status":"pass","evidence_omitted_files":2,"evidence_omitted_paths":"src/a.mts","evidence_lens":["x"]}`,
      `{"ship_id":"${SHIP}","type":"review_result","reviewer":"api-security-reviewer","status":"pass","evidence_omitted_files":1.5,"evidence_truncated_files":1,"evidence_omitted_paths":[{"toString":1},"src/b.mts"]}`,
    ]);
    // Non-integer counts read as absent, so the first row adds nothing; the others keep their real
    // counts, drop the non-string paths, and never name a non-string lens.
    expect(summarise(readShipEvents(sink, SHIP), SHIP)).toEqual([
      {
        gate: 'review:commit-guard',
        state: 'unverified',
        blocking: false,
        detail: 'PASS over an incomplete packet: 2 file(s) omitted, 0 truncated',
      },
      {
        gate: 'review:api-security-reviewer',
        state: 'unverified',
        blocking: false,
        detail: 'PASS over an incomplete packet: 0 file(s) omitted, 1 truncated — not shown: src/b.mts',
      },
    ]);
  });

  it('keeps a cached PASS\'s base-drift reason when its packet was also partial', () => {
    const [row] = summarise(
      [
        ev({
          type: 'cache_hit',
          judge: 'review:conventions-reviewer',
          base_state: 'moved-overlap',
          judged_base_sha: 'abcdef1234567890',
          ...partial,
        }),
      ],
      SHIP,
    );
    expect(row.state).toBe('unverified');
    expect(row.detail).toContain('incomplete packet');
    expect(row.detail).toContain('judged against abcdef123456');
  });

  it('keeps the earlier-diff warning when a reused cached PASS was also partial', () => {
    const [row] = summarise(
      [ev({ type: 'cache_hit', judge: 'review:conventions-reviewer', diff_matches: false, ...partial })],
      SHIP,
    );
    expect(row.detail).toContain('incomplete packet');
    expect(row.detail).toContain('cached PASS judged an earlier diff — this diff was not re-judged');
  });

  it('emits one row per reviewer when pre-commit and commit-msg both replay the partial PASS', () => {
    const rows = summarise(
      [
        ev({ type: 'review_result', reviewer: 'conventions-reviewer', status: 'pass', ...partial }),
        ev({ type: 'cache_hit', judge: 'review:conventions-reviewer', ...partial }),
      ],
      SHIP,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].gate).toBe('review:conventions-reviewer');
  });

  it('reports a truncation-only packet without a "not shown" list', () => {
    const [row] = summarise(
      [
        ev({
          type: 'review_result',
          reviewer: 'backend-performance-reviewer',
          status: 'pass',
          evidence_file_count: 5,
          evidence_omitted_files: 0,
          evidence_truncated_files: 1,
          evidence_omitted_paths: [],
        }),
      ],
      SHIP,
    );
    expect(row.detail).toBe('PASS over an incomplete packet: 0/5 file(s) omitted, 1 truncated');
  });

  it('ignores a partial PASS from the previous attempt under an inherited ship id', () => {
    const rows = summarise(
      [
        ev({ type: 'ship_attempt' }),
        ev({ type: 'review_result', reviewer: 'conventions-reviewer', status: 'pass', ...partial }),
        ev({ type: 'ship_attempt' }),
        ev({ type: 'review_result', reviewer: 'conventions-reviewer', status: 'pass' }),
      ],
      SHIP,
    );
    expect(rows).toEqual([]);
  });
});
