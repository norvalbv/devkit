/** The bench measures un-chunked; a row production would chunk at the shipped cap is refused, and
 * every current corpus row sits under the trigger (sc-2494 AC1). */
import { describe, expect, it } from 'vitest';
import { chunkPlanFacts } from '../../../lens/chunk-tasks.mts';
import { resolveLensGroups } from '../../../lens/groups.mts';
import { BENCH_REVIEWERS, validateRow } from '../bench.mts';
import { preflightChunkRefusals } from '../corpus/chunk-guard.mts';
import { loadRows } from '../corpus.mts';

const correctness = BENCH_REVIEWERS.find((r) => r.name === 'correctness-reviewer');
// Chunks pack whole FILES, so a diff only chunks when several files together exceed the trigger.
const FILES = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
const bigStaged = Array.from(
  { length: 300 },
  (_, i) => `export const v${i} = compute(${i}, 'value-${i}');`,
).join('\n');
const tree = (staged: string) => Object.fromEntries(FILES.map((f) => [f, `${staged}\n`]));
const row = (staged: string) => ({
  id: 'corr-test-chunk-guard',
  reviewer: 'correctness-reviewer',
  expected: 'PASS',
  repo: { base: tree('export const v0 = 1;'), staged: tree(staged) },
  note: 'test',
  difficulty: 'clear',
  provenance: 'authored',
  variantOf: null,
  holdout: false,
});
const diffOf = (staged: string) =>
  FILES.map(
    (f) =>
      `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1,${staged.split('\n').length} @@\n-export const v0 = 1;\n${staged
        .split('\n')
        .map((l) => `+${l}`)
        .join('\n')}\n`,
  ).join('');

describe('chunk guard', () => {
  it('a diff over the trigger plans ≥2 chunks; a small one plans none', () => {
    const groups = resolveLensGroups();
    if (!groups || !correctness) return; // split off: chunking never applies
    const sel = { reviewer: correctness, files: FILES };
    expect(chunkPlanFacts(sel, diffOf(bigStaged), groups, 400)?.count).toBeGreaterThanOrEqual(2);
    expect(chunkPlanFacts(sel, diffOf('export const v0 = 2;'), groups, 400)).toBeNull();
  });
  it('the run preflight names every row production would chunk, and only those', () => {
    if (!resolveLensGroups()) return;
    const refusals = preflightChunkRefusals(
      [row(bigStaged), { ...row('export const v0 = 2;'), id: 'small' }],
      400,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(
      /^corr-test-chunk-guard: production would judge this diff in \d+ chunks at cap 400 LOC/,
    );
    expect(
      preflightChunkRefusals([{ ...row(bigStaged), reviewer: 'api-security-reviewer' }], 400),
    ).toEqual([]);
  });
  it('validate (0 LLM calls) reports the same refusal as a problem', () => {
    if (!resolveLensGroups()) return;
    expect(validateRow(row(bigStaged)).problems.join('\n')).toMatch(
      /would judge this diff in \d+ chunks/,
    );
    expect(validateRow(row('export const v0 = 2;')).problems).toEqual([]);
  });
  it('no committed correctness row crosses the trigger (staged bytes are an upper bound on diff identity bytes)', () => {
    const trigger = 400 * 40 * 1.5;
    const over = loadRows(correctness).filter(
      (r) =>
        Object.values(r.repo.staged).reduce((n, v) => n + Buffer.byteLength(String(v)), 0) >
        trigger,
    );
    expect(over.map((r) => r.id)).toEqual([]);
  });
});
