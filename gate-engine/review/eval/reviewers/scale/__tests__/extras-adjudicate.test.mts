/** sc-2493: extras dedupe across models AND arms on (diff12, lens, file, line//10), family tiers,
 * hand-tier precision (UNSURE reported, never averaged), and a stratified sample with tier floors. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectExtras,
  hunkFor,
  reportTiers,
  stratifiedSample,
  tierOf,
  type Extra,
} from '../extras-adjudicate.mts';

const SHA = 'a'.repeat(64);
const DIFF = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,3 @@\n line1\n+added\n line3\ndiff --git a/src/y.ts b/src/y.ts\n--- a/src/y.ts\n+++ b/src/y.ts\n@@ -1 +1,2 @@\n one\n+two\n`;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function bank(
  name: string,
  rows: Array<{ model?: string; arm: string; issues: Array<{ lens: string; text: string }> }>,
  labels: Array<{ file: string; line: number | null }> = [],
) {
  const root = mkdtempSync(join(tmpdir(), 'extras-'));
  dirs.push(root);
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(
    join(dir, `results-${SHA.slice(0, 12)}.json`),
    JSON.stringify({ diff: SHA, labels, rows }),
  );
  return dir;
}
const readDiff = () => DIFF;

describe('collectExtras', () => {
  it('merges the same finding across models and arms into one key and records every raiser', () => {
    const codex = bank('gpt-5.6-sol', [
      {
        model: 'gpt-5.6-sol',
        arm: 'whole',
        issues: [{ lens: 'state-transitions', text: 'src/x.ts:12 never re-driven' }],
      },
      {
        model: 'gpt-5.6-sol',
        arm: 'chunk:400',
        issues: [{ lens: 'state-transitions', text: 'src/x.ts:18 same thing, other wording' }],
      },
    ]);
    const claude = bank('probe', [
      { arm: 'chunk:400', issues: [{ lens: 'state-transitions', text: 'x.ts:15 also this' }] },
    ]);
    const { extras, skipped } = collectExtras([codex, claude], readDiff);
    expect(skipped).toEqual([]);
    expect(extras).toHaveLength(1);
    expect(extras[0].key).toBe(`${SHA.slice(0, 12)}|state-transitions|src/x.ts|1`);
    expect(extras[0].raisers).toEqual([
      'claude:sonnet:chunk:400',
      'codex:gpt-5.6-sol:chunk:400',
      'codex:gpt-5.6-sol:whole',
    ]);
    expect(tierOf(extras[0])).toBe('cross-family');
  });
  it('drops a finding that matches a telemetry label, an unlocatable one, and a non-terminal row', () => {
    const dir = bank(
      'gpt-5.6-terra',
      [
        {
          model: 'gpt-5.6-terra',
          arm: 'whole',
          issues: [{ lens: 'concurrency-races', text: 'src/y.ts:2 labelled already' }],
        },
        {
          model: 'gpt-5.6-terra',
          arm: 'whole',
          issues: [{ lens: 'concurrency-races', text: 'no file named here' }],
        },
        {
          model: 'gpt-5.6-terra',
          arm: 'chunk:400',
          status: 'error',
          issues: [{ lens: 'concurrency-races', text: 'src/x.ts:1 from an errored row' }],
        },
        {
          model: 'gpt-5.6-terra',
          arm: 'whole',
          issues: [{ lens: 'concurrency-races', text: 'src/nope.ts:3 not in the diff' }],
        },
      ],
      [{ file: 'src/y.ts', line: 5 }],
    );
    expect(collectExtras([dir], readDiff).extras).toEqual([]);
  });
  it('names a bank whose archived diff is missing instead of silently narrowing', () => {
    const dir = bank('probe-haiku', [
      { arm: 'chunk:400', issues: [{ lens: 'state-transitions', text: 'src/x.ts:1 x' }] },
    ]);
    const { extras, skipped } = collectExtras([dir], () => null);
    expect(extras).toEqual([]);
    expect(skipped[0]).toMatch(/archived diff missing/);
  });
});

const extra = (i: number, raisers: string[]): Extra => ({
  key: `k${i}`,
  diff: SHA,
  lens: 'state-transitions',
  file: 'src/x.ts',
  line: 2,
  text: `finding ${i}`,
  raisers,
});

describe('reportTiers', () => {
  it('computes precision over REAL+NOT only, per tier and overall, with a Wilson interval', () => {
    const extras = [
      extra(1, ['codex:m:whole', 'claude:sonnet:whole']),
      extra(2, ['codex:m:whole']),
      extra(3, ['codex:m:whole']),
      extra(4, ['claude:haiku:whole']),
    ];
    const verdicts = new Map([
      ['k1', { key: 'k1', verdict: 'REAL' as const }],
      ['k2', { key: 'k2', verdict: 'NOT' as const }],
      ['k3', { key: 'k3', verdict: 'UNSURE' as const }],
    ]);
    const r = Object.fromEntries(reportTiers(extras, verdicts).map((t) => [t.tier, t]));
    expect(r['cross-family']).toMatchObject({ extras: 1, judged: 1, real: 1, not: 0 });
    expect(r['codex-only']).toMatchObject({
      extras: 2,
      judged: 2,
      real: 0,
      not: 1,
      unsure: 1,
      precision: { value: 0 },
    });
    expect(r['claude-only'].precision).toBeNull();
    expect(r.all).toMatchObject({ extras: 4, judged: 3, real: 1, not: 1, unsure: 1 });
    expect(r.all.precision?.value).toBe(0.5);
    expect(r.all.precision?.lower).toBeLessThan(0.5);
  });
});

describe('stratifiedSample', () => {
  it('keeps every member of a tier smaller than the floor, is reproducible, and trims only the largest tier', () => {
    const extras = [
      ...Array.from({ length: 3 }, (_, i) => extra(i, ['codex:m:whole', 'claude:sonnet:whole'])),
      ...Array.from({ length: 50 }, (_, i) => extra(100 + i, ['codex:m:whole'])),
      ...Array.from({ length: 5 }, (_, i) => extra(200 + i, ['claude:haiku:whole'])),
    ];
    const a = stratifiedSample(extras, 20, 7, 3);
    expect(a).toHaveLength(20);
    expect(a.filter((e) => tierOf(e) === 'cross-family')).toHaveLength(3);
    expect(a.filter((e) => tierOf(e) === 'claude-only').length).toBeGreaterThanOrEqual(3);
    expect(stratifiedSample(extras, 20, 7, 3).map((e) => e.key)).toEqual(a.map((e) => e.key));
    expect(stratifiedSample(extras, 20, 8, 3).map((e) => e.key)).not.toEqual(a.map((e) => e.key));
  });
});

describe('hunkFor', () => {
  it("returns the finding file's own hunk and says so when the file is absent", () => {
    expect(hunkFor(extra(1, ['codex:m:whole']), DIFF)).toContain('+added');
    expect(hunkFor(extra(1, ['codex:m:whole']), DIFF)).not.toContain('+two');
    expect(hunkFor({ ...extra(1, []), file: 'src/z.ts' }, DIFF)).toMatch(/not found/);
  });
});
