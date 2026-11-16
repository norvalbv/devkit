import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache } from '../cache.mts';
import { reportCachedHitNotes } from '../contracts/checklist.mts';
import {
  PASS_ADVISORY_RULE,
  parseAdvisories,
  parseSeverityFindings,
} from '../contracts/response.mts';
import { cachedAdvisories, resetReviewBaseContext } from '../evidence/base-context.mts';
import { emitMergedLensResults } from '../lens/merge-results.mts';
import { type LensPart, planReviewWork } from '../lens/split.mts';
import { settleReviewOutcome, type SettleCtx } from '../recovery/settle.mts';
import { escalatePrompt } from '../cascade/escalation.mts';
import { hasChecklist, REVIEWERS, wrapPrompt } from '../reviewers.mts';
import type { ReviewOutcome } from '../runtime.mts';
import { ReviewGateTiming } from '../telemetry/timing.mts';
import { reportLensPartAdvisories } from '../valve/recheck.mts';

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

const outcome = (status: ReviewOutcome['status'], transcript: string): ReviewOutcome => ({
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
const rowsOf = (type: string) => {
  const file = join(cwd, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === type);
};
const advisoryRows = () => rowsOf('advisory_result');

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

describe('the PASS advisory rule', () => {
  it('closes every checklist reviewer prompt, so a PASS names its defect on a parsed line', () => {
    const checklisted = REVIEWERS.filter(hasChecklist);
    expect(checklisted.length).toBeGreaterThan(0);
    for (const r of checklisted)
      expect(wrapPrompt('body', r, ['a.ts']).endsWith(PASS_ADVISORY_RULE)).toBe(true);
  });

  it('survives escalation, so an overturned FAIL that PASSes still reports its advisories', () => {
    const [r] = REVIEWERS.filter(hasChecklist);
    expect(escalatePrompt(wrapPrompt('body', r, ['a.ts']), 'notes')).toContain(PASS_ADVISORY_RULE);
  });

  it('still reads the line range the reported PASS cited', () => {
    expect(parseAdvisories('ADVISORY: `cli/lib/fs-helpers.mts:99-103` — stale comment')).toEqual([
      '`cli/lib/fs-helpers.mts:99-103` — stale comment',
    ]);
  });

  it('asks for exactly the line shape the parser reads', () => {
    const template = /ADVISORY: <file:line> — <finding>/.exec(PASS_ADVISORY_RULE)?.[0] ?? '';
    const line = template
      .replace('<file:line>', 'cli/lib/fs-helpers.mts:99')
      .replace('<finding>', 'stale comment');
    expect(parseAdvisories(`${line}\nVERDICT: PASS — clean`)).toEqual([
      'cli/lib/fs-helpers.mts:99 — stale comment',
    ]);
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

  it('an escalated outcome archives both labelled passes, not only the escalation', () => {
    const res = { ...outcome('fail', 'VERDICT: FAIL — holds'), fullTranscript: 'BOTH-PASSES' };
    settleReviewOutcome(ctx(cwd), plan(cwd).tasks[0], res, 1);
    const saved = join(cwd, 'transcripts', 'ship-test', 'review-commit-guard.txt');
    expect(readFileSync(saved, 'utf8')).toMatch(/BOTH-PASSES$/);
  });

  it('a malformed cached field reads as none; parts dedupe and cap like a live PASS', () => {
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
    expect(advisoryRows()).toHaveLength(1);
    expect(advisoryRows()[0].detail).toContain('c.ts:3 — third');
  });

  it('on a lens recheck, reports each live PASS part under its part label', () => {
    const task = { ...plan(cwd).tasks[0], splitOf: REVIEWER, group: 'g' };
    const part = (transcript?: string): LensPart =>
      // SAFETY: the report reads only res/secs/task, which this literal supplies.
      ({ res: { ...outcome('pass', ''), transcript }, secs: 1, task }) as LensPart;
    reportLensPartAdvisories(new Map([[REVIEWER, [part(ADVISED), part()]]])); // part() = cached
    expect(printed().filter((l) => l.includes('advisory (non-blocking)'))).toEqual([
      'guard-review: commit-guard [g] — advisory (non-blocking): `src/a.ts:1` — mobile passes the display status, unlike desktop',
    ]);
    expect(advisoryRows().map((r) => r.gate)).toEqual(['review:commit-guard']); // reviewer key
  });

  it("gives each chunk part its own transcript, and the reviewer ONE row holding every chunk's advisory", () => {
    const task = { ...plan(cwd).tasks[0], splitOf: REVIEWER, group: 'g' };
    const chunk = (index: number): LensPart =>
      // SAFETY: the report reads only res/task (task.chunk.index for the label), supplied here.
      ({
        res: outcome('pass', `ADVISORY: c${index}.ts:1 — chunk ${index}\nVERDICT: PASS`),
        secs: 1,
        task: { ...task, chunk: { index } },
      }) as LensPart;
    reportLensPartAdvisories(new Map([[REVIEWER, [chunk(0), chunk(1)]]]));
    const refs = printed()
      .filter((l) => l.includes('full reasoning'))
      .map((l) => l.split('guard-review transcript ')[1]);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
    // The digest keeps the first row per gate, so a row per chunk would hide chunk 1's advisory.
    expect(advisoryRows()).toHaveLength(1);
    expect(advisoryRows()[0]).toMatchObject({ gate: 'review:commit-guard' });
    expect(advisoryRows()[0].detail).toContain('chunk 0');
    expect(advisoryRows()[0].detail).toContain('chunk 1');
  });
});

const FAIL_ADVISED =
  'ADVISORY: `src/b.ts:9` — the buffer cap reads the whole staged set\n' +
  'VERDICT: FAIL — `src/a.ts:1` duplicates an existing helper.';
const FAIL_LINE =
  'guard-review: commit-guard — advisory (non-blocking): `src/b.ts:9` — the buffer cap reads the whole staged set';

describe('a FAIL carrying advisories', () => {
  it('reports them like a PASS does, but caches nothing', () => {
    settleReviewOutcome(ctx(cwd), plan(cwd).tasks[0], outcome('fail', FAIL_ADVISED), 1);
    expect(printed()).toContain(FAIL_LINE);
    expect(advisoryRows()).toEqual([
      expect.objectContaining({ gate: 'review:commit-guard', status: 'finding' }),
    ]);
    expect(advisoryRows()[0]).not.toHaveProperty('family');
    expect(plan(cwd).tasks).toHaveLength(1);
  });

  it('a clean FAIL, or one whose marker names no location, reports no advisory', () => {
    for (const transcript of ['VERDICT: FAIL — x', 'ADVISORY: none\nVERDICT: FAIL — x'])
      settleReviewOutcome(ctx(cwd), plan(cwd).tasks[0], outcome('fail', transcript), 1);
    expect(printed().some((l) => l.includes('advisory'))).toBe(false);
    expect(advisoryRows()).toEqual([]);
  });

  it('an INCONCLUSIVE outcome judged nothing, so its advisory lines stay unreported', () => {
    settleReviewOutcome(ctx(cwd), plan(cwd).tasks[0], outcome('inconclusive', ADVISED), 1);
    expect(advisoryRows()).toEqual([]);
  });
});

describe('a lens-split reviewer whose merge FAILs', () => {
  const task = () => ({ ...plan(cwd).tasks[0], splitOf: REVIEWER, group: 'g' });
  // SAFETY: merge reads only res/secs/task, which these literals supply.
  const part = (res: ReviewOutcome): LensPart => ({ res, secs: 1, task: task() }) as LensPart;

  it('reports the failing lens and the passing lens advisories in one row', () => {
    const parts = [part(outcome('fail', FAIL_ADVISED)), part(outcome('pass', ADVISED))];
    emitMergedLensResults(new Map([[REVIEWER, parts]]), 'sonnet');
    expect(rowsOf('review_result')).toEqual([expect.objectContaining({ status: 'fail' })]);
    expect(advisoryRows()).toHaveLength(1);
    expect(advisoryRows()[0].detail).toContain('src/b.ts:9');
    expect(advisoryRows()[0].detail).toContain('mobile passes the display status');
  });

  it('dedupes advisories the lenses share and holds the live cap across parts', () => {
    const lines = (from: number) =>
      [0, 1, 2, 3].map((i) => `ADVISORY: c.ts:${from + i} — finding`).join('\n');
    const parts = [part(outcome('fail', lines(1))), part(outcome('pass', lines(3)))];
    emitMergedLensResults(new Map([[REVIEWER, parts]]), 'sonnet');
    expect(advisoryRows()[0].detail.split('\n')).toEqual(
      [1, 2, 3, 4, 5].map((i) => `c.ts:${i} — finding`),
    );
  });

  // A cache-seeded part carries no live transcript; its advisories replay on its own cache line.
  it.each([
    ['a cached PASS', outcome('pass', '')],
    ['an INCONCLUSIVE', outcome('inconclusive', ADVISED)],
    ['an errored', outcome('error', ADVISED)],
  ])('reports only the judged parts beside %s part', (_name, other) => {
    emitMergedLensResults(
      new Map([[REVIEWER, [part(outcome('fail', FAIL_ADVISED)), part(other)]]]),
      'sonnet',
    );
    expect(advisoryRows()).toHaveLength(1);
    expect(advisoryRows()[0].detail).toBe(
      '`src/b.ts:9` — the buffer cap reads the whole staged set',
    );
  });
});
