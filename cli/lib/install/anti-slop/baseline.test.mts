import { describe, expect, it } from 'vitest';
import {
  adoptBaselineRuleFindings,
  baselineFromGroups,
  baselineIncreases,
  compareBaseline,
  migrateBaselineRenames,
  pruneBaseline,
  removedBaselineMigrationReceipts,
} from './baseline.mts';
import type { FindingGroup } from './diagnostics.mts';

const group = (
  fingerprint: string,
  count: number,
  severity: 'error' | 'warning' = 'error',
): FindingGroup => ({
  fingerprint,
  ruleId: `anti-slop/rule-${fingerprint}`,
  file: 'src/file.ts',
  diagnostic: `diagnostic ${fingerprint}`,
  context: `context ${fingerprint}`,
  severity,
  line: 1,
  column: 1,
  count,
});

describe('anti-slop shrink-only baseline', () => {
  it('allows existing debt but surfaces only counts above the baseline', () => {
    const baseline = baselineFromGroups([group('a', 2), group('b', 1)]);
    const compared = compareBaseline(baseline, [group('a', 3), group('c', 1, 'warning')]);

    expect(compared.newGroups).toEqual([
      expect.objectContaining({ fingerprint: 'a', additionalCount: 1 }),
      expect.objectContaining({ fingerprint: 'c', additionalCount: 1, severity: 'warning' }),
    ]);
    expect(compared.resolvedCount).toBe(1);
  });

  it('prunes absent/decreased debt and never adds a current unbaselined finding', () => {
    const baseline = baselineFromGroups([group('a', 3), group('b', 1)]);
    const next = pruneBaseline(baseline, [group('a', 2), group('c', 5)]);

    expect(next.entries).toEqual([expect.objectContaining({ fingerprint: 'a', count: 2 })]);
  });

  it('serializes deterministically in fingerprint order', () => {
    const baseline = baselineFromGroups([group('b', 1), group('a', 1)]);
    expect(baseline.entries.map((entry) => entry.fingerprint)).toEqual(['a', 'b']);
    expect(baseline.entries[0]).not.toHaveProperty('severity');
    expect(baseline.entries[0]).not.toHaveProperty('line');
  });

  it('forbids baseline growth while allowing shrinkage', () => {
    const base = migrateBaselineRenames(baselineFromGroups([group('a', 2)]), new Map());
    const [entry] = base.entries;
    if (!entry) throw new Error('expected one baseline entry');
    const smaller = { ...base, entries: [{ ...entry, count: 1 }] };
    const larger = { ...base, entries: [{ ...entry, count: 3 }] };

    expect(baselineIncreases(base, smaller)).toEqual([]);
    expect(baselineIncreases(base, larger)).toEqual([
      expect.objectContaining({ additionalCount: 1, count: 3 }),
    ]);
  });

  it('adopts findings only for wholly new rules and preserves existing debt byte-for-byte', () => {
    const baseline = baselineFromGroups([group('a', 2)]);
    const existing = structuredClone(baseline.entries);

    const next = adoptBaselineRuleFindings(
      baseline,
      [group('a', 9), group('b', 3), group('c', 1)],
      new Set(['anti-slop/rule-a', 'anti-slop/rule-b']),
      'migration-a-b',
    );

    expect(next.entries.filter((entry) => entry.ruleId === 'anti-slop/rule-a')).toEqual(existing);
    expect(next.entries).toContainEqual(
      expect.objectContaining({ ruleId: 'anti-slop/rule-b', count: 3 }),
    );
    expect(next.entries).not.toContainEqual(
      expect.objectContaining({ ruleId: 'anti-slop/rule-c' }),
    );
  });

  it('records zero-finding migrations so a retry cannot adopt later violations', () => {
    const activatedRuleIds = new Set(['anti-slop/rule-b']);
    const migrated = adoptBaselineRuleFindings(
      baselineFromGroups([]),
      [],
      activatedRuleIds,
      'migration-b',
    );

    expect(migrated.migrationReceipts).toEqual(['migration-b']);
    expect(
      adoptBaselineRuleFindings(migrated, [group('b', 1)], activatedRuleIds, 'migration-b').entries,
    ).toEqual([]);
  });

  it('treats completed migration receipts as append-only', () => {
    const base = { ...baselineFromGroups([]), migrationReceipts: ['migration-b'] };

    expect(removedBaselineMigrationReceipts(base, baselineFromGroups([]))).toEqual(['migration-b']);
    expect(
      removedBaselineMigrationReceipts(base, {
        ...baselineFromGroups([]),
        migrationReceipts: ['migration-b', 'migration-c'],
      }),
    ).toEqual([]);
  });

  it('permits baseline growth only for observed findings from newly activated rules', () => {
    const base = migrateBaselineRenames(baselineFromGroups([group('a', 2)]), new Map());
    const [existing] = base.entries;
    const [introducedEntry] = baselineFromGroups([group('b', 4)]).entries;
    if (!existing || !introducedEntry) throw new Error('expected baseline entries');
    const candidate = { ...base, entries: [{ ...existing, count: 3 }, introducedEntry] };
    const activatedRuleIds = new Set(['anti-slop/rule-a', 'anti-slop/rule-b']);

    expect(
      baselineIncreases(base, candidate, new Map(), activatedRuleIds, [group('b', 4)]),
    ).toEqual([expect.objectContaining({ ruleId: 'anti-slop/rule-a', additionalCount: 1 })]);
  });

  it('rejects fabricated or inflated debt for a newly activated rule', () => {
    const base = baselineFromGroups([]);
    const candidate = baselineFromGroups([group('b', 4), group('c', 1)]);
    const activatedRuleIds = new Set(['anti-slop/rule-b', 'anti-slop/rule-c']);

    expect(
      baselineIncreases(base, candidate, new Map(), activatedRuleIds, [group('b', 1)]),
    ).toEqual([
      expect.objectContaining({ ruleId: 'anti-slop/rule-b', additionalCount: 3 }),
      expect.objectContaining({ ruleId: 'anti-slop/rule-c', additionalCount: 1 }),
    ]);
  });

  it('migrates debt across a Git rename without increasing its count envelope', () => {
    const base = baselineFromGroups([group('a', 2)]);
    const renames = new Map([['src/file.ts', 'src/renamed.ts']]);
    const renamed = migrateBaselineRenames(base, renames);
    const [baseEntry] = base.entries;
    const [renamedEntry] = renamed.entries;
    if (!baseEntry || !renamedEntry) throw new Error('expected one renamed baseline entry');

    expect(renamedEntry).toMatchObject({ file: 'src/renamed.ts', count: 2 });
    expect(renamedEntry.fingerprint).not.toBe(base.entries[0]?.fingerprint);
    expect(baselineIncreases(base, base, renames)).toEqual([
      expect.objectContaining({ additionalCount: 2, file: 'src/file.ts' }),
    ]);
    expect(baselineIncreases(base, renamed, renames)).toEqual([]);
    expect(
      baselineIncreases(base, { ...renamed, entries: [{ ...renamedEntry, count: 3 }] }, renames),
    ).toEqual([expect.objectContaining({ additionalCount: 1, file: 'src/renamed.ts' })]);
  });
});
