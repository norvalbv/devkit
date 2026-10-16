import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATE_REASON_ENV, readGateReason } from '../../../../gate-engine/deterministic/reason.mts';
import { printNewAntiSlopFindings, recordErrorLocations } from './baseline-envelope.mts';
import type { FindingGroup } from './diagnostics.mts';
import {
  classifyRelocations,
  printRelocatedAntiSlopFindings,
  relocationKey,
  reportRelocatedFailure,
} from './relocations.mts';

const group = (file: string, ...lines: number[]): FindingGroup => ({
  ruleId: 'anti-slop/no-unknown-returns',
  file,
  diagnostic: 'Return type is unknown.',
  context: 'export function f(): unknown {',
  fingerprint: `fp-${file}`,
  severity: 'error',
  line: lines[0] ?? 1,
  column: 39,
  count: lines.length,
  locations: lines.map((line) => ({ line, column: 39 })),
});

function reasonFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'anti-slop-reason-')), 'reason.txt');
  vi.stubEnv(GATE_REASON_ENV, file);
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('anti-slop failure reasons', () => {
  it('records the rule and every location of each new error', () => {
    const file = reasonFile();
    recordErrorLocations([
      { ...group('src/a.mts', 93, 120), additionalCount: 2 },
      { ...group('src/b.mts', 4), additionalCount: 1 },
    ]);
    expect(readGateReason(file)).toEqual([
      'ERROR anti-slop/no-unknown-returns src/a.mts:93:39, src/a.mts:120:39 (2 new of 2 identical)',
      'ERROR anti-slop/no-unknown-returns src/b.mts:4:39 (1 new)',
    ]);
  });

  it('labels a partly relocated group by count without claiming which identical site moved', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const found = group('src/b.mts', 7, 9);
    const vacated = new Map([
      [relocationKey(found), [{ source: 'src/a.mts', fingerprint: 'fp-src/a.mts', count: 1 }]],
    ]);
    const split = classifyRelocations([{ ...found, additionalCount: 2 }], vacated);
    printNewAntiSlopFindings(split.newGroups);
    printRelocatedAntiSlopFindings(split.relocated);
    const lines = log.mock.calls.map(([line]) => String(line));
    const sites = 'src/b.mts:7:39, src/b.mts:9:39';
    expect(lines).toContain(`ERROR anti-slop/no-unknown-returns ${sites} (1 new of 2 identical)`);
    expect(lines).toContain(
      `RELOCATED anti-slop/no-unknown-returns ${sites} (1 relocated of 2 identical) <- src/a.mts`,
    );
  });

  it('records the relocated summary, the re-anchor command and every relocated location', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = reasonFile();
    const relocated = {
      ...group('src/b.mts', 7),
      relocatedCount: 1,
      from: [],
      sources: ['src/a.mts'],
    };
    reportRelocatedFailure(0, [relocated]);
    const [summary, remedy, ...locations] = readGateReason(file);
    expect(summary).toBe('anti-slop: FAIL — 0 new, 1 relocated from src/a.mts; baseline unchanged');
    expect(remedy).toContain('anti-slop: re-anchor relocated debt with `');
    expect(locations).toEqual([
      'RELOCATED anti-slop/no-unknown-returns src/b.mts:7:39 (1 relocated)',
    ]);
  });
});
