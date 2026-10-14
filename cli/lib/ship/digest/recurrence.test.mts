import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DigestRow } from './gate-digest.mts';
import { annotateRecurrence, readRepoHistory, summariseRecurrence } from './recurrence.mts';

const REPO = 'acme/app';
const CG = 'commit-guard';

/** A sink row as the gate writes it; `kind` stays a plain string so a malformed one can be written. */
interface Row {
  type: string;
  ship_id?: string;
  repo?: string;
  judge?: string;
  reviewer?: string;
  gate?: string;
  status?: string;
  kind?: string;
  detail?: string;
}

/** One ship attempt's rows in sink order: its marker, then whatever the gates emitted. */
function attempt(shipId: string, rows: Row[], repo = REPO): Row[] {
  return [{ type: 'ship_attempt', ship_id: shipId, repo }, ...rows].map((r) => ({
    ship_id: shipId,
    repo,
    ...r,
  }));
}
const pass = (reviewer = CG): Row => ({ type: 'review_result', reviewer, status: 'pass' });
const degraded = (kind?: string, judge = CG): Row => ({ type: 'gate_degraded', judge, kind });
/** A commit-guard PASS degraded by `kinds` (one gate_degraded row each). */
const cgDegraded = (...kinds: (string | undefined)[]): Row[] => [
  pass(),
  ...kinds.map((k) => degraded(k)),
];

const sinkWith = (rows: Row[]): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-recurrence-')), 'gate-events.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  return file;
};

/** `n` earlier attempts built by `make`, then the current one. */
function history(n: number, make: (i: number) => Row[], current: Row[]): Row[] {
  const earlier = Array.from({ length: n }, (_, i) => attempt(`s${i}`, make(i)));
  return [...earlier.flat(), ...attempt('now', current)];
}

const key = { shipId: 'now', repo: REPO, branch: 'b' };
const found = (rows: Row[], k = key) => summariseRecurrence(readRepoHistory(sinkWith(rows), k), k);

describe('summariseRecurrence', () => {
  it("names a judge degraded on most recent attempts, with this ship's kind", () => {
    const rows = history(9, () => cgDegraded('unclassified'), cgDegraded('unclassified'));
    expect(found(rows).get(CG)).toEqual({ degraded: 10, window: 10, kind: 'unclassified' });
  });

  it('stays silent below the threshold', () => {
    const rows = history(
      9,
      (i) => (i < 3 ? cgDegraded('skipped') : [pass()]),
      cgDegraded('skipped'),
    );
    expect(found(rows).size).toBe(0);
  });

  it('fires at exactly five of the window', () => {
    const rows = history(
      9,
      (i) => (i < 4 ? cgDegraded('skipped') : [pass()]),
      cgDegraded('skipped'),
    );
    expect(found(rows).get(CG)).toEqual({ degraded: 5, window: 10, kind: 'skipped' });
  });

  it("stays silent when this ship's verdict was clean, whatever the history", () => {
    expect(found(history(9, () => cgDegraded('mcp-missing'), [pass()])).size).toBe(0);
  });

  it('counts the double row (retrieval + MCP) as ONE attempt of kind mcp-missing', () => {
    const rows = history(4, () => cgDegraded('skipped', 'mcp-missing'), cgDegraded('mcp-missing'));
    expect(found(rows).get(CG)).toEqual({ degraded: 5, window: 5, kind: 'mcp-missing' });
  });

  it('leaves a kind-less (sentry) downgrade on this ship unannotated', () => {
    const sentry = [degraded(undefined, 'sentry-advisory')];
    const rows = history(9, () => sentry, sentry);
    expect(found(rows).size).toBe(0);
  });

  it('counts legacy kind-less history, but never lets it choose the kind', () => {
    const rows = history(9, () => cgDegraded(undefined), cgDegraded('denied'));
    expect(found(rows).get(CG)).toEqual({ degraded: 10, window: 10, kind: 'denied' });
  });

  it("names THIS ship's kind, so the hint never contradicts the cause on its row", () => {
    // The registry was fixed after nine MCP misses; this ship's judge merely skipped.
    const rows = history(9, () => cgDegraded('mcp-missing'), cgDegraded('skipped'));
    expect(found(rows).get(CG)).toEqual({ degraded: 10, window: 10, kind: 'skipped' });
  });

  it("resolves this ship's own double row to the more specific kind", () => {
    const rows = history(4, () => cgDegraded('unclassified'), cgDegraded('skipped', 'mcp-missing'));
    expect(found(rows).get(CG)?.kind).toBe('mcp-missing');
  });

  it('reads a kind this version does not know (a newer emitter) as legacy, never throwing', () => {
    const rows = history(9, () => cgDegraded('quota-exhausted'), cgDegraded('denied'));
    expect(found(rows).get(CG)).toEqual({ degraded: 10, window: 10, kind: 'denied' });
    expect(found(history(9, () => cgDegraded('skipped'), cgDegraded('quota-exhausted'))).size).toBe(
      0,
    );
  });

  it('takes the window over attempts that judged this reviewer, not ones that skipped it', () => {
    const skipped: Row[] = [
      { type: 'review_skipped', reviewer: CG },
      { type: 'judge_exec', judge: `review:${CG}` },
    ];
    const rows = history(
      9,
      (i) => (i < 4 ? cgDegraded('skipped') : skipped),
      cgDegraded('skipped'),
    );
    expect(found(rows).get(CG)).toEqual({ degraded: 5, window: 5, kind: 'skipped' });
  });

  it('a cached verdict and a completeness gate_result both count as judged attempts', () => {
    const cached = attempt('c', [{ type: 'cache_hit', judge: `review:${CG}` }]);
    const done = attempt('g', [{ type: 'gate_result', gate: 'completeness', status: 'pass' }]);
    const deg = (id: string) =>
      attempt(id, [
        { type: 'gate_result', gate: 'completeness' },
        degraded('mcp-missing', 'completeness'),
      ]);
    const rows = [...cached, ...done, ...['a', 'b', 'c2', 'd'].flatMap(deg), ...deg('now')];
    expect(found(rows).get('completeness')).toEqual({
      degraded: 5,
      window: 6,
      kind: 'mcp-missing',
    });
  });

  it('keeps only the newest ten judged attempts', () => {
    const rows = history(
      15,
      (i) => (i < 5 ? cgDegraded('denied') : [pass()]),
      cgDegraded('denied'),
    );
    expect(found(rows).size).toBe(0);
  });

  it('ignores other repos interleaved in the per-machine sink', () => {
    const other = Array.from({ length: 9 }, (_, i) =>
      attempt(`o${i}`, cgDegraded('skipped'), 'acme/other'),
    );
    const mine = Array.from({ length: 3 }, (_, i) => attempt(`m${i}`, cgDegraded('skipped')));
    const rows = [...other.flat(), ...mine.flat(), ...attempt('now', cgDegraded('skipped'))];
    expect(found(rows).size).toBe(0);
  });

  it('counts interleaved concurrent attempts of one repo separately', () => {
    const a = attempt('a', cgDegraded('skipped'));
    const b = attempt('b', cgDegraded('skipped'));
    const interleaved = a.flatMap((row, i) => [row, b[i]]);
    const rows = [
      ...interleaved,
      ...attempt('c', cgDegraded('skipped')),
      ...attempt('d', cgDegraded('skipped')),
      ...attempt('now', cgDegraded('skipped')),
    ];
    expect(found(rows).get(CG)).toEqual({ degraded: 5, window: 5, kind: 'skipped' });
  });

  it('a resumed attempt reusing its ship_id is its own attempt, named by its own kind', () => {
    // An inherited DEVKIT_SHIP_ID: the first attempt hit the MCP miss, the resumed one only skipped.
    const first = attempt('now', cgDegraded('mcp-missing'));
    const rows = history(3, () => cgDegraded('unclassified'), cgDegraded('skipped'));
    const resumed = [...rows.slice(0, -3), ...first, ...rows.slice(-3)];
    expect(found(resumed).get(CG)).toEqual({ degraded: 5, window: 5, kind: 'skipped' });
  });

  it('is silent when the ship cannot be keyed or the sink holds nothing', () => {
    const rows = history(9, () => cgDegraded('skipped'), cgDegraded('skipped'));
    expect(found(rows, { ...key, repo: '' }).size).toBe(0);
    expect(found(rows, { ...key, shipId: 'unknown' }).size).toBe(0);
    expect(readRepoHistory(join(tmpdir(), 'no-such-sink.jsonl'), key)).toEqual([]);
  });
});

describe('annotateRecurrence', () => {
  const row = (gate: string, state: DigestRow['state'] = 'unverified'): DigestRow => ({
    gate,
    state,
    blocking: false,
    detail: 'cause',
  });
  const rec = (kind: 'mcp-missing' | 'unrecorded') => ({ degraded: 7, window: 7, kind });

  it('prints the kind hint once, however many judges share it', () => {
    const recurrences = new Map([
      [CG, rec('mcp-missing')],
      ['completeness', rec('mcp-missing')],
    ]);
    const out = annotateRecurrence([row(CG), row('completeness')], recurrences);
    expect(out[0].detail).toBe(
      'cause · degraded on 7 of the last 7 ships in this repo (mcp-missing) — codebase MCP did not reach the judge — the environment, not this diff',
    );
    expect(out[1].detail).toBe(
      'cause · degraded on 7 of the last 7 ships in this repo (mcp-missing)',
    );
  });

  it('names no remedy for a kind without a known one', () => {
    const out = annotateRecurrence([row(CG)], new Map([[CG, rec('unrecorded')]]));
    expect(out[0].detail).toBe(
      'cause · degraded on 7 of the last 7 ships in this repo (unrecorded)',
    );
  });

  it('touches only the matching unverified row', () => {
    const rows = [row(CG, 'finding'), row(`review:${CG}`), row('sentry-advisory')];
    expect(annotateRecurrence(rows, new Map([[CG, rec('mcp-missing')]]))).toEqual(rows);
  });
});

const CLI = join(import.meta.dirname, 'gate-digest.mts');
const digest = (rows: Row[], repo: string) =>
  execFileSync('node', [CLI, 'digest', sinkWith(rows), 'now'], {
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_SHIP_REPO: repo, DEVKIT_SHIP_BRANCH: 'b' },
  });

describe('gate-digest CLI — recurrence as a ship prints it', () => {
  const detail = { detail: 'semantic retrieval skipped by the judge: small diff' };
  const current = [pass(), { ...degraded('skipped'), ...detail }];
  const rows = history(9, () => cgDegraded('skipped'), current);

  it('appends the recurrence to the unverified row the digest already prints', () => {
    expect(digest(rows, REPO)).toContain(
      `   · ${CG} — semantic retrieval skipped by the judge: small diff · degraded on 10 of the last 10 ships in this repo (skipped) — the judge chose not to search`,
    );
  });

  it('prints the row unchanged when the ship envelope is not exported', () => {
    const out = digest(rows, '');
    expect(out).toContain(`   · ${CG} — semantic retrieval skipped by the judge: small diff\n`);
    expect(out).not.toContain('degraded on');
  });
});
