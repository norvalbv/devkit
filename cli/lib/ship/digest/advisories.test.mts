import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeTranscript } from '../../../../gate-engine/judge/transcript-store.mts';
import {
  branchNarration,
  citedLine,
  citedStatus,
  listBranchAdvisories,
  renderAdvisories,
  unionAdvisories,
} from './advisories.mts';
import { attemptsOf, type TrendRow } from './trend.mts';

const where = { repo: 'demo', branch: 'feat/x' };
type Row = Omit<TrendRow, 'ship_id'> & { ship_id?: string };

const LONG =
  `src/a.ts:3 — ${'the fixture leaves maxLines at 0 so the ratchet never runs '.repeat(5)}`.trim();
const SHORT = 'src/b.ts:7 — a missing trace file reads as zero';
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -0,0 +1,4 @@',
  '+const config = { scanRoots: [] };',
  '++++ not a file header',
  '+const fixture = { maxLines: 0 };',
  ' ADVISORY: src/a.ts:1 — a diff line, not a finding',
  '+═══ AGENT OUTPUT ═══',
].join('\n');

/** One finished attempt: marker, rows stamped with the ship's envelope, then the result row. */
function attempt(id: string, rows: Row[], n = 1): TrendRow[] {
  const ts = `2026-10-14T0${n}:00:00Z`;
  return [
    { type: 'ship_attempt', ship_id: id, ...where, ts },
    ...rows.map((r) => ({ ship_id: id, ...where, ...r })),
    { type: 'ship_result', ship_id: id, ...where, exit_code: 0, ts },
  ];
}

/** The row base-context.mts emits: 200-char slices joined, then the 500-char sink cap. */
function advisory(reviewer: string, texts: string[], suffix = ''): Row {
  const joined = texts.map((t) => t.slice(0, 200)).join(' | ');
  const detail = joined.length > 500 ? `${joined.slice(0, 499)}…` : joined;
  return { type: 'advisory_result', gate: `review:${reviewer}${suffix}`, detail };
}
const verdict = (reviewer: string, status: string, ref?: string): Row => ({
  type: 'review_result',
  reviewer,
  status,
  transcript_ref: ref,
});
const output = (texts: string[]) =>
  composeTranscript(DIFF, `${texts.map((t) => `ADVISORY: ${t}`).join('\n')}\nVERDICT: PASS`);

function union(rows: TrendRow[], transcripts: Record<string, string> = {}) {
  return unionAdvisories(attemptsOf(rows, where) ?? [], (ref) => transcripts[ref] ?? null);
}

describe('unionAdvisories', () => {
  it('upgrades a cut text from the PASS transcript that reproduces it, reading only its output', () => {
    const rows = attempt('s1', [verdict('cg', 'pass', 't1'), advisory('cg', [LONG])]);
    const [only] = union(rows, { t1: output([LONG]) });
    expect(only).toMatchObject({ text: LONG, cut: false, attempts: [1], reviewers: ['cg'] });
    expect(only.diff).toContain('+const fixture');
  });

  it('flags a 200-char sink text as cut when no transcript survives', () => {
    const [only] = union(attempt('s1', [verdict('cg', 'pass', 'gone'), advisory('cg', [LONG])]));
    expect(only).toMatchObject({ text: LONG.slice(0, 200), cut: true });
  });

  it('lists nothing for a FAIL transcript that carries ADVISORY lines but no advisory row', () => {
    const rows = attempt('s1', [verdict('cg', 'fail', 't1')]);
    expect(union(rows, { t1: output([SHORT]) })).toEqual([]);
  });

  it('merges a cache replay into its first-seen attempt', () => {
    const rows = [
      ...attempt('s1', [verdict('cr', 'pass', 't1'), advisory('cr', [SHORT])], 1),
      ...attempt('s2', [{ type: 'cache_hit', judge: 'review:cr' }, advisory('cr', [SHORT])], 2),
    ];
    expect(union(rows, { t1: output([SHORT]) })).toEqual([
      expect.objectContaining({ text: SHORT, attempts: [1, 2], reviewers: ['cr'] }),
    ]);
  });

  it('keeps every cached lens part of a FAILed split reviewer under the reviewer name', () => {
    const rows = attempt('s1', [
      verdict('cr', 'fail', 't1'),
      advisory('cr', [SHORT], ' [state-transitions #c7]'),
      advisory('cr', ['src/c.ts:2 — another part'], ' [error-handling #c8]'),
    ]);
    const all = union(rows, { t1: output([LONG]) });
    expect(all.map((a) => [a.text, a.reviewers])).toEqual([
      [SHORT, ['cr']],
      ['src/c.ts:2 — another part', ['cr']],
    ]);
  });

  it('refuses a transcript holding more than an uncut row (an overwritten, inherited ship id)', () => {
    const rows = attempt('s1', [verdict('cg', 'pass', 't1'), advisory('cg', [SHORT])]);
    expect(union(rows, { t1: output([SHORT, LONG]) }).map((a) => a.text)).toEqual([SHORT]);
  });

  it('accepts a prefix match only for a row the sink cap cut, and folds the stub into its advisory', () => {
    const many = [LONG, `${LONG} two`, `${LONG} three`];
    const cutRow = attempt('s1', [verdict('cg', 'pass', 't1'), advisory('cg', many)], 1);
    expect(union(cutRow, { t1: output(many) }).every((a) => !a.cut)).toBe(true);
    const third = `src/d.ts:4 — ${'z'.repeat(150)}`;
    const rows = [
      ...attempt(
        's1',
        [verdict('cg', 'pass', 'gone'), advisory('cg', [LONG, `${LONG}!`, third])],
        1,
      ),
      ...attempt('s2', [verdict('cg', 'pass', 't2'), advisory('cg', [third])], 2),
    ];
    const folded = union(rows, { t2: output([third]) }).find((a) => a.text === third);
    expect(folded).toMatchObject({ attempts: [1, 2], cut: false });
  });

  it('keeps an advisory quoting a ` | ` union type whole when only the sink text survives', () => {
    const typed = 'src/e.ts:5 — `value: string | null` is never narrowed before use';
    const rows = [
      ...attempt('s1', [verdict('cg', 'pass', 't1'), advisory('cg', [typed, SHORT])], 1),
      ...attempt(
        's2',
        [{ type: 'cache_hit', judge: 'review:cg' }, advisory('cg', [typed, SHORT])],
        2,
      ),
    ];
    expect(union(rows, { t1: output([typed, SHORT]) }).map((a) => [a.text, a.attempts])).toEqual([
      [typed, [1, 2]],
      [SHORT, [1, 2]],
    ]);
  });

  it('ignores advisory rows that do not come from a reviewer', () => {
    const rows = attempt('s1', [
      { type: 'advisory_result', gate: 'fallow-advisory', detail: SHORT },
    ]);
    expect(union(rows)).toEqual([]);
  });
});

describe('citedLine / citedStatus', () => {
  it('reads a basename citation at the path the reviewed diff names, not at the repo root', () => {
    const root = mkdtempSync(join(tmpdir(), 'advisory-root-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'const fixture = { maxLines: 0 };\n');
    const cited = {
      key: 'a.ts:3',
      text: 'a.ts:3 — the ratchet is off',
      cut: false,
      attempts: [1],
      reviewers: ['bp'],
    };
    const text = renderAdvisories('feat/x', [], [{ ...cited, diff: DIFF }], root);
    expect(text).toContain('cited line: still in this working tree');
  });

  it('finds the new-side text of a cited line, past an added line that looks like a header', () => {
    expect(citedLine(DIFF, 'src/a.ts', 3)).toEqual({
      file: 'src/a.ts',
      text: 'const fixture = { maxLines: 0 };',
    });
    expect(citedLine(DIFF, 'a.ts', 1)).toEqual({
      file: 'src/a.ts',
      text: 'const config = { scanRoots: [] };',
    });
    expect(citedLine(DIFF, 'src/a.ts', 9)).toBeUndefined();
    expect(citedLine(DIFF, 'src/other.ts', 1)).toBeUndefined();
  });

  it('reports present only for a unique, non-trivial line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'advisory-cite-'));
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const fixture = { maxLines: 0 };\n});\nlet x = 1;\nlet x = 1;\n');
    expect(citedStatus('  const fixture = { maxLines: 0 };', file)).toBe(
      'still in this working tree',
    );
    expect(citedStatus('const fixture = { maxLines: 500 };', file)).toBe(
      'gone from this working tree',
    );
    expect(citedStatus('});', file)).toBe('unknown');
    expect(citedStatus('let x = 1;', file)).toBe('unknown');
    expect(citedStatus(undefined, file)).toBe('unknown');
    writeFileSync(join(dir, 'crlf.ts'), 'const fixture = { maxLines: 0 };\r\nnext();\r\n');
    expect(citedStatus('const fixture = { maxLines: 0 };', join(dir, 'crlf.ts'))).toBe(
      'still in this working tree',
    );
    expect(citedStatus('const fixture = { maxLines: 0 };', join(dir, 'deleted.ts'))).toBe(
      'gone from this working tree',
    );
  });
});

const sinkWith = (rows: TrendRow[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'advisory-sink-'));
  const file = join(dir, 'gate-events.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  return file;
};

describe('branchNarration', () => {
  const key = { shipId: 's2', ...where };

  it('points at the command when an earlier attempt raised an advisory this ship did not show', () => {
    const sink = sinkWith([
      ...attempt('s1', [advisory('cg', [SHORT, LONG])], 1),
      ...attempt('s2', [advisory('cg', [SHORT])], 2),
    ]);
    expect(branchNarration(sink, key)).toBe(
      '   ↳ 1 advisory was raised on earlier attempts of this branch but not shown this run — devkit ship --advisories feat/x',
    );
  });

  it('stays silent when this ship re-raised an advisory inside a row the 500-char sink cap cut', () => {
    const third = `src/d.ts:4 — ${'z'.repeat(150)}`;
    const sink = sinkWith([
      ...attempt('s1', [advisory('cg', [third])], 1),
      ...attempt('s2', [advisory('cg', [LONG, `${LONG}!`, third])], 2),
    ]);
    expect(branchNarration(sink, key)).toBe('');
  });

  it('stays silent when this ship re-raised everything, on a first attempt, and on an unreadable sink', () => {
    const sink = sinkWith([
      ...attempt('s1', [advisory('cg', [SHORT])], 1),
      ...attempt('s2', [advisory('cg', [SHORT])], 2),
    ]);
    expect(branchNarration(sink, key)).toBe('');
    expect(branchNarration(sinkWith(attempt('s2', [advisory('cg', [SHORT])])), key)).toBe('');
    expect(branchNarration(join(tmpdir(), 'no-such-sink.jsonl'), key)).toBe('');
  });
});

describe('listBranchAdvisories', () => {
  afterEach(() => vi.unstubAllEnvs());

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'advisory-repo-'));
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@example.com:acme/demo.git']);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'const fixture = { maxLines: 0 };\n');
    return dir;
  }

  it('prints each distinct advisory once with its attempts, reviewers and cited-line status', () => {
    const rows = [
      ...attempt(
        's1',
        [verdict('cg', 'pass', 'transcripts/s1/review-cg.txt'), advisory('cg', [LONG])],
        1,
      ),
      ...attempt('s2', [verdict('bp', 'pass'), advisory('bp', [LONG, SHORT])], 2),
    ];
    const sink = sinkWith(rows);
    vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
    mkdirSync(join(sink, '..', 'transcripts/s1'), { recursive: true });
    writeFileSync(join(sink, '..', 'transcripts/s1/review-cg.txt'), output([LONG]));

    const { text, code } = listBranchAdvisories(repo(), 'feat/x', sink);
    expect(code).toBe(0);
    expect(text).toContain('2 distinct reviewer advisories on feat/x over 2 ship attempts');
    expect(text).toContain(
      `1. [attempts 1,2 of 2 · cg, bp] ${LONG}\n   cited line: still in this working tree`,
    );
    expect(text).toContain(`2. [attempt 2 of 2 · bp] ${SHORT}\n   cited line: unknown`);
  });

  it('says the history is unreadable, never empty, when two ships on the branch overlap', () => {
    const [a1, ...rest1] = attempt('s1', [advisory('cg', [SHORT])], 1);
    const sink = sinkWith([a1, ...attempt('s2', [], 2), ...rest1]);
    expect(listBranchAdvisories(repo(), 'feat/x', sink)).toEqual({
      text: 'History unreadable: overlapping ships on feat/x interleave their rows.',
      code: 1,
    });
  });

  it('names the read window when the branch has no attempts, and says when telemetry is off', () => {
    const sink = sinkWith(attempt('s1', [advisory('cg', [SHORT])]));
    expect(listBranchAdvisories(repo(), 'feat/other', sink).text).toBe(
      `No ship attempts for demo feat/other in the newest 16 MB of ${sink}.`,
    );
    expect(listBranchAdvisories(repo(), 'feat/x', '').text).toContain('Telemetry is off');
  });
});
