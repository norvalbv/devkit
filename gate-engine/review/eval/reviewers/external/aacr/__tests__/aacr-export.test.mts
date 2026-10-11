/** AACR-Bench export: unlocated findings, outages and reference order are the scoring traps. */
import { describe, expect, it } from 'vitest';
import type { CheckpointRow } from '../../../scale/lens-run.mts';
import {
  type AacrSample,
  cellStat,
  evaluatorFinished,
  type RefVerdict,
  exportAacrResult,
  refVerdicts,
  selectAacr,
  toStandardJsonl,
} from '../aacr-export.mts';

const comment = (over: Partial<AacrSample['comments'][number]>) => ({
  note: 'null deref',
  path: 'src/a.ts',
  side: 'right',
  from_line: 10,
  to_line: 12,
  category: 'Code Defect',
  context: 'Diff Level',
  source_model: 'GPT-5.2',
  ...over,
});
const sample = (over: Partial<AacrSample>): AacrSample => ({
  project_main_language: 'TypeScript',
  source_commit: 'b'.repeat(40),
  target_commit: 'abcdef1234',
  githubPrUrl: 'https://github.com/o/r/pull/7',
  change_line_count: 100,
  comments: [],
  ...over,
});
const row = (over: Partial<CheckpointRow>): CheckpointRow => ({
  key: 'k',
  diff: 'd',
  arm: 'whole',
  chunk: -1,
  group: 'g',
  status: 'fail',
  reason: '',
  issues: [],
  ms: 1,
  at: '2026-10-11T00:00:00Z',
  ...over,
});
const langs = { languages: new Set(['TypeScript']), category: 'Code Defect' };

describe('selectAacr', () => {
  it('keeps Code Defect references in the chosen languages and counts left-side ones out', () => {
    const got = selectAacr(
      [
        sample({
          comments: [
            comment({}),
            comment({ category: 'Performance' }),
            comment({ side: 'left', context: 'File Level' }),
          ],
        }),
        sample({ project_main_language: 'Go', comments: [comment({})] }),
        sample({ comments: [comment({ category: 'Performance' })] }),
      ],
      langs,
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      instanceId: 'o__r@abcdef1',
      repo: 'o/r',
      excludedLeft: 1,
    });
    expect(got[0].refs.map((r) => r.level)).toEqual(['Diff Level']);
  });

  it('writes the upstream standard JSONL without the level field', () => {
    const line = JSON.parse(
      toStandardJsonl(selectAacr([sample({ comments: [comment({})] })], langs)),
    );
    expect(line).toEqual({
      instance_id: 'o__r@abcdef1',
      repo: 'o/r',
      base_commit: 'b'.repeat(40),
      head_commit: 'abcdef1234',
      reference_comments: [
        {
          path: 'src/a.ts',
          text: 'null deref',
          start_line: 10,
          end_line: 12,
          side: 'right',
        },
      ],
    });
  });
});

describe('exportAacrResult', () => {
  const staged = ['src/a.ts', 'src/b.ts'];
  it('exports a cited range and withholds findings without a resolvable file and line', () => {
    const got = exportAacrResult(
      [
        row({
          issues: [
            { lens: 'state', text: 'a.ts:124-139 forgets to reset the flag' },
            { lens: 'state', text: 'src/b.ts:~40-52 leaks the timer' },
            { lens: 'state', text: 'src/b.ts never closes the handle' },
            { lens: 'race', text: 'somewhere a lock is missing' },
            { lens: 'race', text: 'missing.ts:4 is wrong' },
            {
              lens: 'race',
              text: 'src/a.ts and src/b.ts:9 disagree on the key',
            },
          ],
        }),
      ],
      staged,
    );
    expect(got).toEqual({
      review_output: [
        {
          file: 'src/a.ts',
          start_line: 124,
          end_line: 139,
          summary: '[state] a.ts:124-139 forgets to reset the flag',
          description: '',
        },
        {
          file: 'src/b.ts',
          start_line: 40,
          end_line: 52,
          summary: '[state] src/b.ts:~40-52 leaks the timer',
          description: '',
        },
        {
          file: 'src/b.ts',
          start_line: 9,
          end_line: 9,
          summary: '[race] src/a.ts and src/b.ts:9 disagree on the key',
          description: '',
        },
      ],
      withheld: 3,
      multiFile: 1,
    });
  });

  it('returns undefined when no lens task reached a verdict', () => {
    expect(exportAacrResult([row({ status: 'error' })], staged)).toBeUndefined();
    expect(exportAacrResult([row({ status: 'pass' })], staged)).toEqual({
      review_output: [],
      withheld: 0,
      multiFile: 0,
    });
  });
});

describe('refVerdicts', () => {
  const insts = selectAacr(
    [
      sample({
        comments: [
          comment({ source_model: 'Claude-Code/Claude-4.5-Sonnet' }),
          comment({ context: 'Repo Level' }),
        ],
      }),
    ],
    langs,
  );
  it('keeps level and label family per reference, line-only never as a catch', () => {
    const got = refVerdicts(
      [
        {
          instance_id: 'o__r@abcdef1',
          comments: [
            { semantic_match: true, line_match: true },
            { semantic_match: false, line_match: true },
          ],
        },
      ],
      insts,
    );
    expect(
      got.map(({ level, family, caught, lineOnly }) => [level, family, caught, lineOnly]),
    ).toEqual([
      ['Diff Level', 'claude', true, false],
      ['Repo Level', 'other', false, true],
    ]);
    expect(got.map((x) => x.dupKey)).toEqual(['o__r@abcdef1#0', 'o__r@abcdef1#0']);
  });

  it('refuses a reference list that does not align with the selection', () => {
    expect(() => refVerdicts([{ instance_id: 'o__r@abcdef1', comments: [] }], insts)).toThrow(
      /do not align/,
    );
  });
});

describe('cellStat', () => {
  const v = (level: string, caught: boolean, dupKey = level): RefVerdict => ({
    key: level,
    dupKey,
    instanceId: 'i',
    path: 'a.ts',
    repo: 'o/r',
    level,
    family: 'other',
    caught,
    lineOnly: !caught,
  });
  it('counts per run and round and flags a reference whose majority outcome flips between runs', () => {
    const run1 = [
      [v('Diff Level', true), v('Repo Level', false)],
      [v('Diff Level', true), v('Repo Level', false)],
      [v('Diff Level', false), v('Repo Level', false)],
    ];
    const run2 = run1.map(() => [v('Diff Level', false), v('Repo Level', false)]);
    expect(cellStat([run1, run2], () => true)).toEqual({
      refs: 2,
      caught: [1, 1, 0, 0, 0, 0],
      lineOnly: [1, 1, 2, 2, 2, 2],
      distinct: 2,
      distinctCaught: [1, 1, 0, 0, 0, 0],
      flipped: 1,
    });
    expect(cellStat([run1], (x) => x.level === 'Repo Level')).toMatchObject({
      refs: 1,
      flipped: null,
    });
  });
  it('counts a duplicated reference once, caught when any copy is', () => {
    const run = [[v('Diff Level', true, 'd'), v('File Level', false, 'd')]];
    expect(cellStat([run], () => true)).toMatchObject({
      refs: 2,
      distinct: 1,
      distinctCaught: [1],
    });
  });
});

describe('evaluatorFinished', () => {
  const llm = 'mode: LLM (qwen/qwen3-235b-a22b-2507)';
  it('reuses a scoring only when the evaluator finished every round in LLM mode', () => {
    expect(evaluatorFinished(llm, 3, 3)).toBe(true);
  });
  it('rejects a run interrupted before its log was written', () => {
    expect(evaluatorFinished(null, 1, 3)).toBe(false);
  });
  it('rejects a log with fewer round files than the run asked for', () => {
    expect(evaluatorFinished(llm, 1, 3)).toBe(false);
  });
  it('rejects mock-mode output', () => {
    expect(evaluatorFinished('mode: LLM unavailable, Mock fallback', 3, 3)).toBe(false);
  });
});
