import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBranchHistory, renderTrend, summariseTrend, type TrendRow } from './trend.mts';

const CR = 'correctness-reviewer';
const where = { repo: 'acme/app', branch: 'feat/x' };
/** A review row before attempt() stamps the ship's envelope (ship_id, repo, branch) on it. */
type Row = Omit<TrendRow, 'ship_id'> & { ship_id?: string };

/** One finished ship attempt: its marker, the review rows, then the shell's result row. */
function attempt(
  id: string,
  review: Row[],
  result: Partial<Row> = { exit_code: 1 },
  at: Partial<Row> = where,
): TrendRow[] {
  return [
    { type: 'ship_attempt', ship_id: id, ...at },
    ...review.map((r) => ({ ship_id: id, ...at, ...r })),
    { type: 'ship_result', ship_id: id, ...at, ...result },
  ];
}

/** A blocking correctness verdict carrying `n` findings on one lens. */
const fail = (n: number, reviewer = CR): Row => ({
  type: 'review_result',
  reviewer,
  status: 'fail',
  items: [
    {
      status: 'fail',
      disposition: 'blocking',
      issues: Array.from({ length: n }, (_, i) => `x${i}`),
    },
  ],
});
const pass = (reviewer = CR): Row => ({ type: 'review_result', reviewer, status: 'pass' });

/** Ships s1..sN, each correctness-blocked with the given counts; the last is the current ship. */
function series(counts: number[]) {
  const events = counts.flatMap((n, i) => attempt(`s${i + 1}`, [fail(n)]));
  return { events, current: `s${counts.length}` };
}

/** The ship key a real digest gets: its id plus the repo/branch its envelope exports. */
const keyOf = (shipId: string, at: { repo?: string; branch?: string } = where) => ({
  shipId,
  repo: at.repo ?? '',
  branch: at.branch ?? '',
});
const trendOf = (events: TrendRow[], current: string, at = where) =>
  renderTrend(summariseTrend(events, keyOf(current, at)));

const sinkWith = (lines: string[]): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-trend-')), 'gate-events.jsonl');
  writeFileSync(file, lines.join('\n'));
  return file;
};
const jsonl = (events: TrendRow[]) => events.map((e) => JSON.stringify(e));

describe('summariseTrend — when it fires', () => {
  it('fires on the reported 7→6→2→7→4 shape and names the series', () => {
    const { events, current } = series([7, 6, 2, 7, 4]);
    const text = trendOf(events, current);
    expect(text).toContain(`${CR}: 5 blocking rounds on this branch with no pass between`);
    expect(text).toContain('7 → 6 → 2 → 7 → 4 findings');
    expect(text).toContain('not converging');
    expect(text).toContain(
      'cut or narrow the change if the failing code is not an acceptance criterion',
    );
  });

  it('fires at exactly 3 and stays silent at 2 (boundary)', () => {
    const three = series([2, 2, 2]);
    const two = series([2, 2]);
    expect(trendOf(three.events, three.current)).toContain(': 3 blocking rounds');
    expect(trendOf(two.events, two.current)).toBe('');
  });

  it('stays silent while the count strictly decreases — that IS converging', () => {
    const { events, current } = series([7, 4, 2]);
    expect(trendOf(events, current)).toBe('');
  });

  it('fires on a flat series (equal counts are not progress)', () => {
    const { events, current } = series([1, 1, 1]);
    expect(trendOf(events, current)).toContain('1 → 1 → 1 findings');
  });

  it('never mentions --no-verify and points at the remedies already printed', () => {
    const { events, current } = series([3, 3, 3]);
    const text = trendOf(events, current);
    expect(text).not.toContain('--no-verify');
    expect(text).toMatch(/waive/);
    expect(text).toContain('blocking-finding count is not falling');
    expect(text.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('is silent when the current ship did not block on that reviewer', () => {
    const events = [...series([5, 5]).events, ...attempt('s3', [pass()], { exit_code: 1 })];
    expect(trendOf(events, 's3')).toBe('');
  });

  it('is silent when the current ship has no ship_result (a --dry-gates rehearsal)', () => {
    const events = [
      ...series([5, 5]).events,
      { type: 'ship_attempt', ship_id: 's3', ...where },
      { ship_id: 's3', ...where, ...fail(5) },
    ];
    expect(trendOf(events, 's3')).toBe('');
  });

  it('caps a long series and keeps the newest counts visible', () => {
    const { events, current } = series([9, 8, 7, 6, 5, 4, 3, 2, 2, 2, 2, 2, 2]);
    const text = trendOf(events, current);
    expect(text).toContain(': 13 blocking rounds');
    expect(text).toContain('… → ');
    expect(text).toMatch(/2 findings/);
  });
});

describe('summariseTrend — streak boundaries', () => {
  it('skips an attempt another gate blocked first — the streak is not broken', () => {
    const events = [
      ...attempt('s1', [fail(4)]),
      ...attempt('s2', [], { exit_code: 1 }),
      ...attempt('s3', [fail(5)]),
      ...attempt('s4', [fail(4)]),
    ];
    expect(trendOf(events, 's4')).toContain('4 → 5 → 4 findings');
  });

  it('skips an inconclusive round (a judge outage is not a verdict)', () => {
    const events = [
      ...attempt('s1', [fail(4)]),
      ...attempt('s2', [{ type: 'review_result', reviewer: CR, status: 'inconclusive' }]),
      ...attempt('s3', [fail(4)]),
      ...attempt('s4', [fail(4)]),
    ];
    expect(trendOf(events, 's4')).toContain(': 3 blocking rounds');
  });

  it('resets on a correctness pass', () => {
    const events = [
      ...series([5, 5, 5]).events,
      ...attempt('s4', [pass()], { exit_code: 1 }),
      ...attempt('s5', [fail(5)]),
      ...attempt('s6', [fail(5)]),
    ];
    expect(trendOf(events, 's6')).toBe('');
  });

  it('resets on a cached whole-reviewer PASS', () => {
    const events = [
      ...series([5, 5, 5]).events,
      ...attempt('s4', [{ type: 'cache_hit', judge: `review:${CR}` }], {
        exit_code: 1,
      }),
      ...attempt('s5', [fail(5)]),
      ...attempt('s6', [fail(5)]),
    ];
    expect(trendOf(events, 's6')).toBe('');
  });

  it('a fail verdict in the same attempt outranks a cache_hit row for the reviewer', () => {
    const cachedThenFail = [{ type: 'cache_hit', judge: `review:${CR}` }, fail(5)];
    const events = [
      ...attempt('s1', [fail(5)]),
      ...attempt('s2', cachedThenFail),
      ...attempt('s3', [fail(5)]),
    ];
    expect(trendOf(events, 's3')).toContain(': 3 blocking rounds');
  });

  it('resets after a successful ship on the same branch name (branch reused after a merge)', () => {
    const events = [
      ...series([5, 5, 5]).events,
      ...attempt('s4', [pass()], { exit_code: 0 }),
      ...attempt('s5', [fail(5)]),
      ...attempt('s6', [fail(5)]),
    ];
    expect(trendOf(events, 's6')).toBe('');
  });

  it('ignores another repo that shares the branch name in the per-machine sink', () => {
    const other = { repo: 'acme/other', branch: 'feat/x' };
    const events = [
      ...attempt('o1', [fail(9)], undefined, other),
      ...attempt('o2', [fail(9)], undefined, other),
      ...attempt('s1', [fail(5)]),
      ...attempt('o3', [fail(9)], undefined, other),
      ...attempt('s2', [fail(5)]),
    ];
    expect(trendOf(events, 's2')).toBe('');
  });

  it('keeps counting across a concurrent ship of another branch interleaved mid-attempt', () => {
    const elsewhere = { repo: 'acme/app', branch: 'feat/y' };
    const events = [
      ...attempt('s1', [fail(3)]),
      { type: 'ship_attempt', ship_id: 's2', ...where },
      ...attempt('y1', [pass()], { exit_code: 0 }, elsewhere),
      { ship_id: 's2', ...where, ...fail(3) },
      { type: 'ship_result', ship_id: 's2', ...where, exit_code: 1 },
      ...attempt('s3', [fail(3)]),
    ];
    expect(trendOf(events, 's3')).toContain('3 → 3 → 3 findings');
  });

  it('splits attempts that share one inherited DEVKIT_SHIP_ID by their ship_attempt markers', () => {
    const events = [
      ...attempt('same', [fail(4)]),
      ...attempt('same', [fail(4)]),
      ...attempt('same', [fail(4)]),
    ];
    expect(trendOf(events, 'same')).toContain(': 3 blocking rounds');
  });

  it('keeps two overlapping attempts apart when they inherit one DEVKIT_SHIP_ID on different branches', () => {
    const other = { repo: 'acme/app', branch: 'feat/y' };
    const overlapped = (n: number) => [
      { type: 'ship_attempt', ship_id: 'same', ...where },
      { type: 'ship_attempt', ship_id: 'same', ...other },
      { ship_id: 'same', ...where, ...fail(n) },
      { ship_id: 'same', ...other, ...pass() },
      { type: 'ship_result', ship_id: 'same', ...other, exit_code: 1 },
      { type: 'ship_result', ship_id: 'same', ...where, exit_code: 1 },
    ];
    const events = [...overlapped(4), ...overlapped(4), ...overlapped(4)];
    expect(trendOf(events, 'same')).toContain(': 3 blocking rounds');
  });

  it('goes silent when two same-branch attempts sharing one inherited id overlap and both close', () => {
    const overlapped = [
      { type: 'ship_attempt', ship_id: 'same', ...where },
      { type: 'ship_attempt', ship_id: 'same', ...where },
      { ship_id: 'same', ...where, ...fail(4) },
      { ship_id: 'same', ...where, ...fail(4) },
      { type: 'ship_result', ship_id: 'same', ...where, exit_code: 1 },
      { type: 'ship_result', ship_id: 'same', ...where, exit_code: 1 },
    ];
    const events = [...attempt('same', [fail(4)]), ...overlapped, ...attempt('same', [fail(4)])];
    expect(trendOf(events, 'same')).toBe('');
  });

  it('goes silent after a killed attempt whose retry reuses its inherited id — rows are ambiguous', () => {
    const killed = [
      { type: 'ship_attempt', ship_id: 'same', ...where },
      { ship_id: 'same', ...where, ...fail(9) },
    ];
    const events = [
      ...attempt('same', [fail(4)]),
      ...killed,
      ...attempt('same', [fail(4)]),
      ...attempt('same', [fail(4)]),
    ];
    expect(trendOf(events, 'same')).toBe('');
  });

  it('goes silent when two same-branch attempts with DISTINCT ids overlap — they are not rounds in order', () => {
    const events = [
      ...attempt('s1', [fail(4)]),
      { type: 'ship_attempt', ship_id: 's2', ...where },
      { type: 'ship_attempt', ship_id: 's3', ...where },
      { ship_id: 's2', ...where, ...fail(4) },
      { ship_id: 's3', ...where, ...fail(4) },
      { type: 'ship_result', ship_id: 's2', ...where, exit_code: 1 },
      { type: 'ship_result', ship_id: 's3', ...where, exit_code: 1 },
    ];
    expect(trendOf(events, 's3')).toBe('');
  });

  it('goes silent when a cut-off attempt keeps writing inside a later attempt on the branch', () => {
    const events = [
      { ship_id: 's0', ...where, ...fail(4) },
      ...attempt('s1', [fail(4)]),
      { type: 'ship_attempt', ship_id: 's2', ...where },
      { type: 'ship_result', ship_id: 's0', ...where, exit_code: 1 },
      { ship_id: 's2', ...where, ...fail(4) },
      { type: 'ship_result', ship_id: 's2', ...where, exit_code: 1 },
      ...attempt('s3', [fail(4)]),
    ];
    expect(trendOf(events, 's3')).toBe('');
  });

  it('goes silent when a displaced attempt finishes first (its result would close the other)', () => {
    const events = [
      ...attempt('same', [fail(4)]),
      ...attempt('same', [fail(4)]),
      { type: 'ship_attempt', ship_id: 'same', ...where },
      { ship_id: 'same', ...where, ...fail(4) },
      { type: 'ship_attempt', ship_id: 'same', ...where },
      { type: 'ship_result', ship_id: 'same', ...where, exit_code: 1 },
    ];
    expect(trendOf(events, 'same')).toBe('');
  });

  it('ignores rows with no open marker (an attempt cut by the backward read) instead of guessing', () => {
    const cut = attempt('s1', [fail(4)]).slice(1);
    const events = [...cut, ...attempt('s2', [fail(4)]), ...attempt('s3', [fail(4)])];
    expect(trendOf(events, 's3')).toBe('');
  });

  it('is silent when the current ship carries no repo or branch (never blends unkeyed ships)', () => {
    const blank = { repo: '', branch: '' };
    const events = [
      ...attempt('s1', [fail(4)], undefined, blank),
      ...attempt('s2', [fail(4)], undefined, blank),
      ...attempt('s3', [fail(4)], undefined, blank),
    ];
    expect(trendOf(events, 's3', blank)).toBe('');
  });

  it('reports each blocking reviewer separately', () => {
    const both = (n: number) => [fail(n), fail(1, 'conventions-reviewer')];
    const events = [
      ...attempt('s1', both(3)),
      ...attempt('s2', both(3)),
      ...attempt('s3', both(3)),
    ];
    const text = trendOf(events, 's3');
    expect(text).toContain(`${CR}: 3 blocking rounds`);
    expect(text).toContain('conventions-reviewer: 3 blocking rounds');
  });
});

describe('summariseTrend — what counts as a finding', () => {
  const withItems = (items: TrendRow['items']): Row => ({
    type: 'review_result',
    reviewer: CR,
    status: 'fail',
    items,
  });

  it('excludes waived and out-of-charter lenses and passing lenses', () => {
    const mixed = withItems([
      { status: 'fail', disposition: 'blocking', issues: ['a', 'b'] },
      { status: 'fail', disposition: 'waived', issues: ['c', 'd', 'e'] },
      { status: 'fail', disposition: 'dropped_out_of_charter', issues: ['f'] },
      { status: 'pass', issues: [] },
    ]);
    const events = [
      ...attempt('s1', [mixed]),
      ...attempt('s2', [mixed]),
      ...attempt('s3', [mixed]),
    ];
    expect(trendOf(events, 's3')).toContain('2 → 2 → 2 findings');
  });

  it('treats a round as unknown when a lens field has the wrong type, never as blocking', () => {
    const wrong = [
      { status: 'fail', disposition: 7, issues: ['x'] },
      { status: 'fail', disposition: 'blocking', issues: 'abc' },
      { status: 7, disposition: 'blocking', issues: ['x'] },
      { status: 'fail', disposition: 'blocking', issues: [7] },
      'not-a-lens',
    ];
    for (const lens of wrong) {
      const row = (id: string) =>
        JSON.stringify({ ship_id: id, ...where, ...withItems([]), items: [lens] });
      const raw = ['s1', 's2', 's3'].flatMap((id) => {
        const [marker, result] = jsonl(attempt(id, []));
        return [marker, row(id), result];
      });
      expect(trendOf(readBranchHistory(sinkWith(raw), keyOf('s3')), 's3')).toBe('');
    }
  });

  it('does not treat an unrecognised disposition string as blocking', () => {
    const odd = withItems([{ status: 'fail', disposition: 'deferred', issues: ['a'] }]);
    const events = [...attempt('s1', [odd]), ...attempt('s2', [odd]), ...attempt('s3', [odd])];
    expect(trendOf(events, 's3')).toBe('');
  });

  it('counts a failing lens from an emitter that predates `disposition`', () => {
    const legacy = withItems([{ status: 'fail', issues: ['a', 'b', 'c'] }]);
    const events = [
      ...attempt('s1', [legacy]),
      ...attempt('s2', [legacy]),
      ...attempt('s3', [legacy]),
    ];
    expect(trendOf(events, 's3')).toContain('3 → 3 → 3 findings');
  });

  it('counts a blocking lens with no issue text as one finding, never zero', () => {
    const bare = withItems([{ status: 'fail', disposition: 'blocking' }]);
    const events = [...attempt('s1', [bare]), ...attempt('s2', [bare]), ...attempt('s3', [bare])];
    expect(trendOf(events, 's3')).toContain('1 → 1 → 1 findings');
  });

  // The tally that survives a spill counts waived and out-of-charter lenses too, so it is not used.
  const spilled: Row = {
    type: 'review_result',
    reviewer: CR,
    status: 'fail',
  };

  it('shows a spilled round as ? and still fires when known rounds bracket it', () => {
    const events = [
      ...attempt('s1', [fail(2)]),
      ...attempt('s2', [spilled]),
      ...attempt('s3', [fail(2)]),
    ];
    expect(trendOf(events, 's3')).toContain('2 → ? → 2 findings');
  });

  it('stays silent when the latest round count is unknown — nothing to compare', () => {
    const events = [
      ...attempt('s1', [fail(1)]),
      ...attempt('s2', [fail(1)]),
      ...attempt('s3', [spilled]),
    ];
    expect(trendOf(events, 's3')).toBe('');
  });

  it('stays silent when no earlier round count is known', () => {
    const events = [
      ...attempt('s1', [spilled]),
      ...attempt('s2', [spilled]),
      ...attempt('s3', [fail(9)]),
    ];
    expect(trendOf(events, 's3')).toBe('');
  });

  it('does not count waived lenses from the spill tally (1 blocking + 2 waived is not 3)', () => {
    const tallied = JSON.stringify({
      ship_id: 's2',
      ...where,
      type: 'review_result',
      reviewer: CR,
      status: 'fail',
      items_ref: 'items-correctness.json',
      item_tally: { fail: 3 },
    });
    const two = jsonl(attempt('s2', []));
    const raw = [
      ...jsonl(attempt('s1', [fail(2)])),
      two[0],
      tallied,
      two[1],
      ...jsonl(attempt('s3', [fail(1)])),
    ];
    expect(trendOf(readBranchHistory(sinkWith(raw), keyOf('s3')), 's3')).toBe('');
  });

  it('treats a round with wrong-typed lens fields as unknown, without throwing', () => {
    const raw = [
      ...jsonl(attempt('s1', [])).slice(0, 1),
      JSON.stringify({
        ship_id: 's1',
        ...where,
        type: 'review_result',
        reviewer: CR,
        status: 'fail',
        items: 'not-an-array',
        item_tally: { fail: 'two' },
        items_ref: 7,
      }),
      ...jsonl(attempt('s1', [])).slice(1),
      ...jsonl(attempt('s2', [])).slice(0, 1),
      JSON.stringify({
        ship_id: 's2',
        ...where,
        type: 'review_result',
        reviewer: CR,
        status: 'fail',
        items: [null, 5, { status: 'fail', disposition: 'blocking', issues: 'abc' }],
      }),
      ...jsonl(attempt('s2', [])).slice(1),
      ...jsonl(attempt('s3', [fail(2)])),
    ];
    const history = readBranchHistory(sinkWith(raw), keyOf('s3'));
    // Neither round can be counted, so there is no known earlier round to compare against.
    expect(trendOf(history, 's3')).toBe('');
  });
});

describe('readBranchHistory — the sink read', () => {
  it('returns [] for a missing, empty or unnamed sink', () => {
    expect(readBranchHistory('/nonexistent/gate-events.jsonl', keyOf('s1'))).toEqual([]);
    expect(readBranchHistory('', keyOf('s1'))).toEqual([]);
    expect(readBranchHistory(sinkWith([]), keyOf('s1'))).toEqual([]);
    expect(readBranchHistory(sinkWith(['{}']), keyOf(''))).toEqual([]);
  });

  it('skips torn and non-object lines (a concurrent append mid-read)', () => {
    const { events, current } = series([4, 4, 4]);
    const lines = jsonl(events);
    lines.splice(3, 0, '{"type":"review_res', '42', 'null', '[1,2]');
    const history = readBranchHistory(sinkWith(lines), keyOf(current));
    expect(trendOf(history, current)).toContain('4 → 4 → 4 findings');
  });

  it('reaches attempts older than one read chunk', () => {
    const { events, current } = series([4, 4, 4]);
    const lines = jsonl(events);
    // ~1MB of another repo's traffic between the first attempt and the rest.
    const noise = JSON.stringify({
      type: 'judge_exec',
      ship_id: 'zz',
      repo: 'acme/other',
      detail: 'n'.repeat(1000),
    });
    const filler = Array.from({ length: 1000 }, () => noise);
    const sink = sinkWith([...lines.slice(0, 3), ...filler, ...lines.slice(3)]);
    expect(trendOf(readBranchHistory(sink, keyOf(current)), current)).toContain(
      ': 3 blocking rounds',
    );
  });
});

/** The shell's ship_result also names the blocking gate family, which the findings digest reads. */
const shellLines = (events: TrendRow[]) =>
  events.map((e) =>
    JSON.stringify(e.type === 'ship_result' ? { ...e, blocked_gate: 'review' } : e),
  );

const CLI = join(import.meta.dirname, 'gate-digest.mts');
/** Runs the digest the way commit-with-gate-capture.sh does, with the ship's exported envelope. */
const digest = (lines: string[], shipId: string, env: Record<string, string> = {}) =>
  execFileSync('node', [CLI, 'digest', sinkWith(lines), shipId], {
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_SHIP_REPO: '', DEVKIT_SHIP_BRANCH: '', ...env },
  });
const shipEnv = { DEVKIT_SHIP_REPO: where.repo, DEVKIT_SHIP_BRANCH: where.branch };

describe('gate-digest CLI — the wiring a ship actually runs', () => {
  it('prints the findings block and the trend line from one invocation', () => {
    const { events, current } = series([5, 5, 5]);
    const out = digest(shellLines(events), current, shipEnv);
    expect(out).toContain(`review:${CR} — BLOCKED this run`);
    expect(out).toContain(`${CR}: 3 blocking rounds on this branch`);
  });

  it('prints no trend for a ship whose per-ship sink holds only itself', () => {
    const out = digest(shellLines(attempt('solo', [fail(5)])), 'solo', shipEnv);
    expect(out).toContain('BLOCKED this run');
    expect(out).not.toContain('blocking rounds');
  });

  it('prints no trend when the ship envelope is not exported (an ad-hoc digest call)', () => {
    const { events, current } = series([5, 5, 5]);
    const out = digest(shellLines(events), current);
    expect(out).toContain('BLOCKED this run');
    expect(out).not.toContain('blocking rounds');
  });
});
