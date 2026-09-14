import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AntiSlopBaseline,
  baselineFromGroups,
  baselineIncreases,
  compareBaseline,
  parseBaseline,
} from './baseline.mts';
import type { FindingGroup } from './diagnostics.mts';
import {
  classifyRelocations,
  creditRelocatedGrowth,
  formatSources,
  reanchorBaseline,
  relocationBasePaths,
  relocationKey,
  type RelocationSource,
  vacatedDebt,
} from './relocations.mts';

const RULE = 'anti-slop/no-object-parameters';
const DIAGNOSTIC = 'Parameter `value` accepts an unshaped object.';
const CONTEXT = 'export function widen(value: object) {';

interface Variant {
  ruleId?: string;
  context?: string;
  severity?: FindingGroup['severity'];
}

/** A finding group with the REAL fingerprint, so re-anchored baselines survive `parseBaseline`. */
function finding(file: string, count = 1, variant: Variant = {}): FindingGroup {
  const identity = {
    ruleId: variant.ruleId ?? RULE,
    file,
    diagnostic: DIAGNOSTIC,
    context: variant.context ?? CONTEXT,
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([identity.ruleId, file, identity.diagnostic, identity.context]))
    .digest('hex');
  return {
    ...identity,
    fingerprint,
    severity: variant.severity ?? 'error',
    line: 1,
    column: 1,
    count,
  };
}

const baselineOf = (...groups: FindingGroup[]): AntiSlopBaseline => baselineFromGroups(groups);
const newGroupsOf = (baseline: AntiSlopBaseline, groups: FindingGroup[]) =>
  compareBaseline(baseline, groups).newGroups;
const changed = (...paths: string[]): Map<string, RelocationSource> =>
  new Map(paths.map((path) => [path, { basePath: path, deleted: false }]));
const everywhere = () => true;
const total = (baseline: AntiSlopBaseline) =>
  baseline.entries.reduce((sum, entry) => sum + entry.count, 0);

describe('vacated relocation debt', () => {
  it('credits only debt the base lint confirms and the candidate no longer carries', () => {
    // The baseline claims 3 (1 stale, unpruned); the base bytes prove 2; the candidate keeps 1.
    const vacated = vacatedDebt(
      baselineOf(finding('src/a.ts', 3)),
      baselineOf(finding('src/a.ts', 2)),
      [finding('src/a.ts', 1)],
      changed('src/a.ts'),
      everywhere,
    );

    expect(vacated.get(relocationKey(finding('src/a.ts')))).toEqual([
      { source: 'src/a.ts', fingerprint: finding('src/a.ts').fingerprint, count: 1 },
    ]);
  });

  it('never credits stale baseline debt the base bytes no longer contain', () => {
    const vacated = vacatedDebt(
      baselineOf(finding('src/a.ts', 2)),
      baselineOf(),
      [],
      changed('src/a.ts'),
      everywhere,
    );

    expect(vacated.size).toBe(0);
  });

  it('never credits a copy whose source still carries the finding', () => {
    const vacated = vacatedDebt(
      baselineOf(finding('src/a.ts')),
      baselineOf(finding('src/a.ts')),
      [finding('src/a.ts'), finding('src/b.ts')],
      changed('src/a.ts'),
      everywhere,
    );

    expect(vacated.size).toBe(0);
  });

  it('counts a deleted source as vacated without linting it, but never an unlinted survivor', () => {
    const bound = baselineOf(finding('src/a.ts'));
    const inherited = baselineOf(finding('src/a.ts'));
    const outOfScope = (file: string) => file !== 'src/a.ts';

    const deleted = new Map([['src/a.ts', { basePath: 'src/a.ts', deleted: true }]]);
    expect(vacatedDebt(bound, inherited, [], deleted, outOfScope).size).toBe(1);
    expect(vacatedDebt(bound, inherited, [], changed('src/a.ts'), outOfScope).size).toBe(0);
  });

  it('ignores unchanged files, unbaselined base debt, and newly activated rules', () => {
    const inherited = baselineOf(finding('src/a.ts'));

    expect(
      vacatedDebt(baselineOf(finding('src/a.ts')), inherited, [], changed(), everywhere).size,
    ).toBe(0);
    expect(vacatedDebt(baselineOf(), inherited, [], changed('src/a.ts'), everywhere).size).toBe(0);
    expect(
      vacatedDebt(
        baselineOf(finding('src/a.ts')),
        inherited,
        [],
        changed('src/a.ts'),
        everywhere,
        new Set([RULE]),
      ).size,
    ).toBe(0);
  });

  it('lints each renamed source at its base path, once, for matching keys only', () => {
    const bound = baselineOf(
      finding('src/renamed.ts'),
      finding('src/renamed.ts', 1, { context: 'unrelated line' }),
      finding('src/b.ts'),
    );
    const sources = new Map([
      ['src/renamed.ts', { basePath: 'src/original.ts', deleted: false }],
      ['src/b.ts', { basePath: 'src/b.ts', deleted: false }],
    ]);

    expect(relocationBasePaths(bound, sources, new Set([relocationKey(finding('x'))]))).toEqual([
      'src/b.ts',
      'src/original.ts',
    ]);
    expect(relocationBasePaths(bound, sources, new Set(['["other"]']))).toEqual([]);
  });
});

describe('relocation classification', () => {
  it('pairs a moved finding with vacated debt and keeps the excess and other keys new', () => {
    const base = baselineOf(finding('src/a.ts'));
    const groups = [
      finding('src/b.ts', 2),
      finding('src/b.ts', 1, { context: 'export function other(value: object) {' }),
    ];
    const vacated = vacatedDebt(base, base, groups, changed('src/a.ts'), everywhere);

    const { newGroups, relocated } = classifyRelocations(newGroupsOf(base, groups), vacated);

    expect(relocated).toHaveLength(1);
    expect(relocated[0]).toMatchObject({
      file: 'src/b.ts',
      relocatedCount: 1,
      sources: ['src/a.ts'],
    });
    expect(newGroups.map((group) => [group.context, group.additionalCount])).toEqual([
      [CONTEXT, 1],
      ['export function other(value: object) {', 1],
    ]);
  });

  it('pairs sources in path order, names every candidate, and spends each credit once', () => {
    const base = baselineOf(finding('src/z.ts'), finding('src/a.ts'));
    const groups = [finding('src/b.ts'), finding('src/c.ts', 2)];
    const vacated = vacatedDebt(base, base, groups, changed('src/a.ts', 'src/z.ts'), everywhere);

    const { newGroups, relocated } = classifyRelocations(newGroupsOf(base, groups), vacated);

    expect(
      relocated.map((group) => [group.file, group.sources, group.from.map((c) => c.source)]),
    ).toEqual([
      ['src/b.ts', ['src/a.ts', 'src/z.ts'], ['src/a.ts']],
      ['src/c.ts', ['src/z.ts'], ['src/z.ts']],
    ]);
    expect(newGroups.map((group) => [group.file, group.additionalCount])).toEqual([
      ['src/c.ts', 1],
    ]);
  });

  it('never pairs a finding with credit vacated by its own file', () => {
    const vacated = new Map([
      [relocationKey(finding('src/a.ts')), [{ source: 'src/a.ts', fingerprint: 'x', count: 1 }]],
    ]);

    const { newGroups, relocated } = classifyRelocations(
      [{ ...finding('src/a.ts'), additionalCount: 1 }],
      vacated,
    );

    expect(relocated).toEqual([]);
    expect(newGroups).toHaveLength(1);
  });

  it('classifies warnings as relocated debt too', () => {
    const base = baselineOf(finding('src/a.ts', 1, { severity: 'warning' }));
    const groups = [finding('src/b.ts', 1, { severity: 'warning' })];
    const vacated = vacatedDebt(base, base, groups, changed('src/a.ts'), everywhere);

    const { relocated } = classifyRelocations(newGroupsOf(base, groups), vacated);

    expect(relocated.map((group) => group.severity)).toEqual(['warning']);
  });
});

describe('relocated baseline growth', () => {
  it('accepts growth that re-anchors debt the candidate baseline released at its source', () => {
    const base = baselineOf(finding('src/a.ts'));
    const candidate = baselineOf(finding('src/b.ts'));
    const groups = [finding('src/b.ts')];
    const vacated = vacatedDebt(base, base, groups, changed('src/a.ts'), everywhere);

    const growth = creditRelocatedGrowth(
      baselineIncreases(base, candidate),
      base,
      candidate,
      groups,
      vacated,
      everywhere,
    );

    expect(growth.blocked).toEqual([]);
    expect(
      growth.accepted.map((entry) => [entry.file, entry.additionalCount, entry.sources]),
    ).toEqual([['src/b.ts', 1, ['src/a.ts']]]);
  });

  it('blocks a baseline-only edit while the source finding survives', () => {
    const base = baselineOf(finding('src/a.ts'));
    const candidate = baselineOf(finding('src/b.ts'));
    const groups = [finding('src/a.ts'), finding('src/b.ts')];
    const vacated = vacatedDebt(base, base, groups, changed('src/a.ts'), everywhere);

    const growth = creditRelocatedGrowth(
      baselineIncreases(base, candidate),
      base,
      candidate,
      groups,
      vacated,
      everywhere,
    );

    expect(growth.accepted).toEqual([]);
    expect(growth.blocked.map((entry) => entry.file)).toEqual(['src/b.ts']);
  });

  it('blocks growth when the candidate baseline never decremented the source', () => {
    const base = baselineOf(finding('src/a.ts'));
    const candidate = baselineOf(finding('src/a.ts'), finding('src/b.ts'));
    const groups = [finding('src/b.ts')];
    const vacated = vacatedDebt(base, base, groups, changed('src/a.ts'), everywhere);

    const growth = creditRelocatedGrowth(
      baselineIncreases(base, candidate),
      base,
      candidate,
      groups,
      vacated,
      everywhere,
    );

    expect(growth.accepted).toEqual([]);
    expect(growth.blocked).toHaveLength(1);
  });

  it('caps accepted growth at what the destination lint observed and its lint scope', () => {
    const base = baselineOf(finding('src/a.ts', 2));
    const candidate = baselineOf(finding('src/b.ts', 2));
    const groups = [finding('src/b.ts', 1)];
    const vacated = vacatedDebt(base, base, groups, changed('src/a.ts'), everywhere);
    const increases = baselineIncreases(base, candidate);

    const observed = creditRelocatedGrowth(increases, base, candidate, groups, vacated, everywhere);
    expect(observed.accepted.map((entry) => entry.additionalCount)).toEqual([1]);
    expect(observed.blocked.map((entry) => entry.additionalCount)).toEqual([1]);

    const unscoped = creditRelocatedGrowth(
      increases,
      base,
      candidate,
      groups,
      vacated,
      () => false,
    );
    expect(unscoped.accepted).toEqual([]);
  });
});

describe('relocation re-anchoring', () => {
  it('moves exactly the paired counts into a parseable baseline the growth check accepts', () => {
    const base = baselineOf(finding('src/a.ts', 3), finding('src/keep.ts'));
    const groups = [finding('src/a.ts', 1), finding('src/b.ts', 2), finding('src/keep.ts')];
    const vacated = vacatedDebt(base, base, groups, changed('src/a.ts'), everywhere);
    const { relocated } = classifyRelocations(newGroupsOf(base, groups), vacated);

    const next = reanchorBaseline(base, base, relocated);

    expect(parseBaseline(JSON.stringify(next))).toEqual(next);
    expect(next.entries.map((entry) => [entry.file, entry.count])).toEqual(
      expect.arrayContaining([
        ['src/a.ts', 1],
        ['src/b.ts', 2],
        ['src/keep.ts', 1],
      ]),
    );
    expect(total(next)).toBe(total(base));
    const growth = creditRelocatedGrowth(
      baselineIncreases(base, next),
      base,
      next,
      groups,
      vacated,
      everywhere,
    );
    expect(growth.blocked).toEqual([]);
    // Idempotent by construction: judged against the re-anchored baseline, nothing is left to move.
    expect(classifyRelocations(newGroupsOf(next, groups), vacated).relocated).toEqual([]);
  });

  it('drops a fully vacated source entry and adds to debt the destination already carried', () => {
    const base = baselineOf(finding('src/a.ts'), finding('src/b.ts'));
    const groups = [finding('src/b.ts', 2)];
    const vacated = vacatedDebt(base, base, groups, changed('src/a.ts'), everywhere);
    const { relocated } = classifyRelocations(newGroupsOf(base, groups), vacated);

    const next = reanchorBaseline(base, base, relocated);

    expect(next.entries.map((entry) => [entry.file, entry.count])).toEqual([['src/b.ts', 2]]);
  });
});

describe('relocation source formatting', () => {
  it('lists up to three sources, then counts the rest, without duplicates', () => {
    expect(formatSources(['c.ts', 'a.ts', 'b.ts', 'a.ts'])).toBe('a.ts, b.ts, c.ts');
    expect(formatSources(['d.ts', 'c.ts', 'a.ts', 'b.ts'])).toBe('a.ts, b.ts, c.ts +1 more');
  });
});
