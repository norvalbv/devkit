import { describe, expect, it } from 'vitest';
import {
  type AntiSlopBaseline,
  adoptBaselineRuleFindings,
  baselineFromGroups,
  hasCurrentIdentity,
  parseBaseline,
  rekeyBaseline,
} from './baseline.mts';
import { ANTI_SLOP_IDENTITY, ANTI_SLOP_UPSTREAM } from './constants.mts';
import type { AntiSlopFinding } from './diagnostics.mts';

const legacy = (...entries: Array<[string, number]>): AntiSlopBaseline => ({
  schemaVersion: 1,
  upstreamCommit: ANTI_SLOP_UPSTREAM,
  migrationReceipts: ['migration-a'],
  entries: entries.map(([fingerprint, count]) => ({
    fingerprint,
    ruleId: 'anti-slop/no-unknown-parameters',
    file: 'src/a.ts',
    diagnostic: 'Parameter `model` leaves input unparsed.',
    context: `export function line(${fingerprint}) {`,
    count,
  })),
});

const finding = (legacyFingerprint: string, fingerprint: string): AntiSlopFinding => ({
  fingerprint,
  legacyFingerprint,
  ruleId: 'anti-slop/no-unknown-parameters',
  file: 'src/a.ts',
  diagnostic: 'Parameter `model` leaves input unparsed.',
  context: 'unknown',
  severity: 'error',
  line: 1,
  column: 1,
});

const counts = (baseline: AntiSlopBaseline) =>
  Object.fromEntries(baseline.entries.map((entry) => [entry.fingerprint, entry.count]));

describe('anti-slop identity re-key', () => {
  it('moves each legacy entry onto the span fingerprints its lint observed', () => {
    const next = rekeyBaseline(legacy(['L1', 2]), [finding('L1', 'N1'), finding('L1', 'N2')]);

    expect(counts(next)).toEqual({ N1: 1, N2: 1 });
    expect(next.entries[0]).toMatchObject({ context: 'unknown', file: 'src/a.ts' });
    expect(next.identity).toBe(ANTI_SLOP_IDENTITY);
    expect(next.migrationReceipts).toEqual(['migration-a']);
  });

  it('never moves more than the legacy count, and drops debt no finding still carries', () => {
    const next = rekeyBaseline(legacy(['L1', 1], ['L2', 3]), [
      finding('L1', 'N1'),
      finding('L1', 'N1'),
      finding('L9', 'N9'),
    ]);

    expect(counts(next)).toEqual({ N1: 1 });
  });

  it('merges legacy entries that now share one span fingerprint', () => {
    const next = rekeyBaseline(legacy(['L1', 1], ['L2', 1]), [
      finding('L1', 'N1'),
      finding('L2', 'N1'),
    ]);

    expect(counts(next)).toEqual({ N1: 2 });
  });

  it('leaves a current or empty baseline untouched', () => {
    const current = rekeyBaseline(legacy(['L1', 1]), [finding('L1', 'N1')]);
    const empty = legacy();

    expect(hasCurrentIdentity(empty)).toBe(true);
    expect(hasCurrentIdentity(baselineFromGroups([]))).toBe(true);
    expect(hasCurrentIdentity(legacy(['L1', 1]))).toBe(false);
    expect(rekeyBaseline(current, [finding('N1', 'X')])).toBe(current);
    expect(rekeyBaseline(empty, [finding('L1', 'N1')])).toBe(empty);
  });

  it('stamps a parsed empty baseline current, so debt adopted into it is never read as legacy', () => {
    const { legacyFingerprint: _legacy, ...group } = finding('L1', 'N1');
    const parsed = parseBaseline(JSON.stringify(legacy()));
    const adopted = adoptBaselineRuleFindings(
      parsed,
      [{ ...group, count: 1 }],
      new Set([group.ruleId]),
      'migration-b',
    );

    expect(adopted.entries).toHaveLength(1);
    expect(hasCurrentIdentity(adopted)).toBe(true);
  });
});
