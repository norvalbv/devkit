import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache } from '../cache.mts';
import { reportCachedHitNotes } from '../contracts/checklist.mts';
import { parseAdvisories, parseSeverityFindings } from '../contracts/response.mts';
import { cachedAdvisories, resetReviewBaseContext } from '../evidence/base-context.mts';
import { emitMergedLensResults } from '../lens/merge-results.mts';
import { type LensPart, planReviewWork } from '../lens/split.mts';
import { settleReviewOutcome, type SettleCtx } from '../recovery/settle.mts';
import { REVIEWERS } from '../reviewers.mts';
import type { ReviewOutcome } from '../runtime.mts';
import { ReviewGateTiming } from '../telemetry/timing.mts';

const REVIEWER = 'commit-guard';
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+let shared = 0;\n';
const reviewer = REVIEWERS.find((r) => r.name === REVIEWER);
if (!reviewer) throw new Error('commit-guard must exist');
const sel = { reviewer, files: ['src/a.ts'] };
const keyOf = (name: string, diff: string, salt: string) => `${name}|${diff}|${salt}`;
const plan = (cwd: string) =>
  planReviewWork([sel], [DIFF], loadCache(cwd), new Map(), keyOf, null, null);

const ADVISED =
  '- `src/a.ts:1`: reasoning narration, not an advisory.\n' +
  'ADVISORY: `src/a.ts:1` — mobile passes the display status, unlike desktop\n' +
  'VERDICT: PASS — no finding blocks this commit; the divergence is the item to resolve before merge.';

const outcome = (status: 'pass' | 'fail', transcript: string): ReviewOutcome => ({
  name: REVIEWER,
  status,
  reason: 'r',
  escalated: false,
  transcript,
});

const ctx = (cwd: string): SettleCtx => ({
  cwd,
  firstModel: 'haiku',
  progressFile: null,
  running: [],
  completed: [],
  splitParts: new Map(),
  timing: new ReviewGateTiming(),
  verifyAssets: (o) => o,
});

let cwd = '';
const savedSink = process.env.DEVKIT_GATE_EVENTS;
beforeEach(() => {
  vi.stubEnv('DEVKIT_SHIP_ID', 'ship-test'); // a run id, so the transcript (and its ref) is written
  cwd = mkdtempSync(join(tmpdir(), 'pass-advisories-'));
  execSync('git init -q', { cwd });
  process.env.DEVKIT_GATE_EVENTS = join(cwd, 'events.jsonl'); // keep emits off live telemetry
  resetReviewBaseContext();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
  if (savedSink === undefined) delete process.env.DEVKIT_GATE_EVENTS;
  else process.env.DEVKIT_GATE_EVENTS = savedSink;
});

const printed = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
const advisoryRows = () => {
  const file = join(cwd, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'advisory_result');
};

describe('parseAdvisories', () => {
  it('reads marker lines through markdown dressing and CRLF, never a mention inside prose', () => {
    const raw =
      '- **ADVISORY:** a.ts:1 — first\r\n> ADVISORY: b.ts:2 — second\r\n' +
      'The word ADVISORY: inside a sentence is prose.\r\nADVISORY: b.ts:2 — second\r\n';
    expect(parseAdvisories(raw)).toEqual(['a.ts:1 — first', 'b.ts:2 — second']);
  });

  it('keeps every line whole; the print cap belongs to reportAdvisories', () => {
    const raw = Array.from({ length: 8 }, (_, i) => `ADVISORY: a.ts:${i} ${'x'.repeat(300)}`).join(
      '\n',
    );
    const got = parseAdvisories(raw);
    expect(got).toHaveLength(8);
    expect(got.every((a) => a.endsWith('x'.repeat(300)))).toBe(true);
  });
});

describe('parseSeverityFindings', () => {
  it('reads a finding ending in CRLF or a lone CR, which an unnormalized line regex drops', () => {
    expect(
      parseSeverityFindings('LOW: a gap | a.ts\r\nIMPORTANT: another | b.ts\rVERDICT: PASS'),
    ).toEqual(['LOW: a gap | a.ts', 'IMPORTANT: another | b.ts']);
  });

  it('never reads the self-tally or a severity word in prose as a finding', () => {
    // Real judge shapes: a mixed-case tally line and the brief's uppercase one.
    const raw =
      'Critical: 1, Important: 0, Low: 1.\nISSUES: 0 critical, 0 important, 1 low\n' +
      'This is a CRITICAL: gap in prose.\nVERDICT: PASS — complete';
    expect(parseSeverityFindings(raw)).toEqual([]);
  });
});

describe('parseAdvisories — the marker without a finding behind it', () => {
  it('drops a line citing no code location, so a judge writing "none" or echoing the format stays silent', () => {
    const raw =
      'ADVISORY: none\nADVISORY: N/A — nothing to resolve\n' +
      'ADVISORY: <file:line> — <one-line finding>\nVERDICT: PASS — clean';
    expect(parseAdvisories(raw)).toEqual([]);
  });

  it('never lets a bare marker borrow the next line as its finding', () => {
    expect(
      parseAdvisories('ADVISORY:\n- `a.ts:1` reasoning, not an advisory\nVERDICT: PASS'),
    ).toEqual([]);
  });
});

describe('a PASS carrying advisories', () => {
  it('prints them with the transcript ref, emits one advisory row, and replays them from cache', () => {
    settleReviewOutcome(ctx(cwd), plan(cwd).tasks[0], outcome('pass', ADVISED), 1000);
    const lines = printed();
    expect(lines[0]).toMatch(/ — PASS .* · transcript transcripts\/.+\/review-commit-guard\.txt$/);
    expect(lines).toContain(
      'guard-review: commit-guard — advisory (non-blocking): `src/a.ts:1` — mobile passes the display status, unlike desktop',
    );
    expect(
      lines.some((l) => l.includes('full reasoning: guard-review transcript transcripts/')),
    ).toBe(true);
    expect(advisoryRows()).toEqual([
      expect.objectContaining({ gate: 'review:commit-guard', status: 'finding' }),
    ]);
    expect(advisoryRows()[0]).not.toHaveProperty('family');

    vi.mocked(console.error).mockClear();
    const replay = plan(cwd);
    expect(replay.tasks).toHaveLength(0);
    reportCachedHitNotes(replay.cachedHits[0]);
    expect(printed()).toEqual([
      'guard-review: commit-guard — advisory (non-blocking): `src/a.ts:1` — mobile passes the display status, unlike desktop',
    ]);
    expect(advisoryRows()).toHaveLength(2);
  });
});

describe('a PASS off a run (a plain commit with telemetry off)', () => {
  it('still prints its advisories, but names no transcript it never wrote', () => {
    vi.stubEnv('DEVKIT_SHIP_ID', '');
    vi.stubEnv('DEVKIT_NO_TELEMETRY', '1');
    delete process.env.DEVKIT_GATE_EVENTS;
    settleReviewOutcome(ctx(cwd), plan(cwd).tasks[0], outcome('pass', ADVISED), 1);
    expect(printed()).toEqual([
      'guard-review: commit-guard — PASS in 0s (checkpointed) — r',
      'guard-review: commit-guard — advisory (non-blocking): `src/a.ts:1` — mobile passes the display status, unlike desktop',
    ]);
  });
});

describe('outcomes that carry no advisory', () => {
  it('a clean PASS adds only the transcript ref to its line, and emits nothing advisory', () => {
    settleReviewOutcome(ctx(cwd), plan(cwd).tasks[0], outcome('pass', 'VERDICT: PASS — clean'), 1);
    expect(printed()).toEqual([
      'guard-review: commit-guard — PASS in 0s (checkpointed) — r · transcript transcripts/ship-test/review-commit-guard.txt',
    ]);
    expect(advisoryRows()).toEqual([]);
  });

  it('a FAIL never reports its advisory lines as advisories', () => {
    settleReviewOutcome(ctx(cwd), plan(cwd).tasks[0], outcome('fail', ADVISED), 1);
    expect(printed().some((l) => l.includes('advisory'))).toBe(false);
    expect(advisoryRows()).toEqual([]);
  });

  it('a malformed cached field reads as none; parts dedupe like a live PASS', () => {
    expect(cachedAdvisories({ advisories: 'not-an-array' })).toBeUndefined();
    expect(cachedAdvisories({ advisories: [] })).toBeUndefined();
    // Split parts judge the same diff, so their stored advisories overlap.
    const many = Array.from({ length: 6 }, (_, i) => `a.ts:${i} — finding`);
    expect(cachedAdvisories({ advisories: many }, { advisories: many })).toEqual(many);
  });
});

describe('a lens-split reviewer', () => {
  it('reports its live parts once, at the merge', () => {
    const task = { ...plan(cwd).tasks[0], splitOf: REVIEWER, group: 'g' };
    const part = (transcript: string): LensPart =>
      // SAFETY: merge reads only res/secs/task, which this literal supplies.
      ({ res: outcome('pass', transcript), secs: 1, task }) as LensPart;
    const parts = [part(ADVISED), part('ADVISORY: c.ts:3 — third\nVERDICT: PASS')];
    emitMergedLensResults(new Map([[REVIEWER, parts]]), 'sonnet');
    expect(advisoryRows().map((r) => r.detail)).toEqual([
      '`src/a.ts:1` — mobile passes the display status, unlike desktop',
      'c.ts:3 — third',
    ]);
  });
});

describe('a PASS with several long advisories', () => {
  it('emits one row per advisory, so none falls past the sink cap of a joined detail', () => {
    const long = (i: number) => `src/a.ts:${i} — ${'consequence '.repeat(33)}end ${i}`;
    const raw = [1, 2, 3, 4, 5].map((i) => `ADVISORY: ${long(i)}`).join('\n');
    settleReviewOutcome(ctx(cwd), plan(cwd).tasks[0], outcome('pass', `${raw}\nVERDICT: PASS`), 1);
    const details = advisoryRows().map((r) => r.detail);
    expect(details).toEqual([1, 2, 3, 4, 5].map((i) => long(i).trim()));
    expect(details.every((d) => d.length > 400 && d.length <= 500)).toBe(true);
  });
});
