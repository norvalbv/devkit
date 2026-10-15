import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseTrendRow,
  renderBranchHistory,
  renderVersionChange,
  type TrendRow,
} from './trend.mts';

const where = { repo: 'acme/app', branch: 'feat/x' };
const key = (shipId: string) => ({ shipId, ...where });

/** One ship attempt on `version`; `exitCode` undefined = killed before its result row. */
function attempt(
  id: string,
  version: string | undefined,
  exitCode?: number,
  at: Partial<TrendRow> = where,
): TrendRow[] {
  const marker: TrendRow = { type: 'ship_attempt', ship_id: id, devkit_version: version, ...at };
  if (exitCode === undefined) return [marker];
  return [
    marker,
    { type: 'ship_result', ship_id: id, devkit_version: version, exit_code: exitCode, ...at },
  ];
}

const line = (from: string, to: string) =>
  `   ↑ devkit ${from} → ${to} since this branch's last ship attempt — gate rules may differ: https://github.com/norvalbv/devkit/compare/v${from}...v${to}`;

describe('renderVersionChange — when it fires', () => {
  it('names the upgrade on a blocked attempt after an older-release attempt', () => {
    const rows = [...attempt('s1', '0.64.0', 1), ...attempt('s2', '0.67.0', 1)];
    expect(renderVersionChange(rows, key('s2'))).toBe(line('0.64.0', '0.67.0'));
  });

  it('compares against a killed prior attempt, which wrote no result row', () => {
    const rows = [...attempt('s1', '0.64.0'), ...attempt('s2', '0.67.0', 1)];
    expect(renderVersionChange(rows, key('s2'))).toBe(line('0.64.0', '0.67.0'));
  });

  it('orders versions numerically, not as text', () => {
    const rows = [...attempt('s1', '0.9.0', 1), ...attempt('s2', '0.10.0', 1)];
    expect(renderVersionChange(rows, key('s2'))).toBe(line('0.9.0', '0.10.0'));
  });

  it('keeps a green prior attempt as the baseline, unlike the trend streak', () => {
    const rows = [...attempt('s1', '0.66.0', 0), ...attempt('s2', '0.67.0', 1)];
    expect(renderVersionChange(rows, key('s2'))).toBe(line('0.66.0', '0.67.0'));
  });

  it('compares with the newest prior attempt only', () => {
    const rows = [
      ...attempt('s1', '0.64.0', 1),
      ...attempt('s2', '0.67.0', 1),
      ...attempt('s3', '0.67.0', 1),
    ];
    expect(renderVersionChange(rows, key('s3'))).toBe('');
  });
});

describe('renderVersionChange — silence', () => {
  it.each([
    ['a green attempt', [...attempt('s1', '0.64.0', 1), ...attempt('s2', '0.67.0', 0)]],
    ['a downgrade', [...attempt('s1', '0.63.4', 1), ...attempt('s2', '0.63.3', 1)]],
    ['the same version', [...attempt('s1', '0.67.0', 1), ...attempt('s2', '0.67.0', 1)]],
    ['a legacy prior version', [...attempt('s1', '<0.47.2', 1), ...attempt('s2', '0.67.0', 1)]],
    ['an empty prior version', [...attempt('s1', '', 1), ...attempt('s2', '0.67.0', 1)]],
    ['a missing prior version', [...attempt('s1', undefined, 1), ...attempt('s2', '0.67.0', 1)]],
    ['a first attempt', attempt('s2', '0.67.0', 1)],
    [
      'an attempt with no result row yet',
      [...attempt('s1', '0.64.0', 1), ...attempt('s2', '0.67.0')],
    ],
    [
      "another repo's older attempt",
      [
        ...attempt('s1', '0.64.0', 1, { ...where, repo: 'acme/other' }),
        ...attempt('s2', '0.67.0', 1),
      ],
    ],
    [
      "another branch's older attempt",
      [
        ...attempt('s1', '0.64.0', 1, { ...where, branch: 'feat/y' }),
        ...attempt('s2', '0.67.0', 1),
      ],
    ],
  ])('stays silent for %s', (_, rows) => {
    expect(renderVersionChange(rows, key('s2'))).toBe('');
  });

  it('stays silent for an unkeyed ship', () => {
    const rows = [...attempt('s1', '0.64.0', 1), ...attempt('s2', '0.67.0', 1)];
    expect(renderVersionChange(rows, { shipId: 's2', repo: '', branch: '' })).toBe('');
    expect(renderVersionChange(rows, { ...where, shipId: '' })).toBe('');
  });

  it('reads a wrong-typed version as absent', () => {
    const row = parseTrendRow('{"type":"ship_attempt","ship_id":"s1","devkit_version":64}');
    expect(row?.devkit_version).toBeUndefined();
  });
});

const CLI = join(import.meta.dirname, 'gate-digest.mts');
function sinkWith(rows: TrendRow[]): string {
  const sink = join(mkdtempSync(join(tmpdir(), 'gate-version-')), 'gate-events.jsonl');
  writeFileSync(sink, rows.map((r) => JSON.stringify(r)).join('\n'));
  return sink;
}
/** Runs the digest the way commit-with-gate-capture.sh does, with the ship's exported envelope. */
function digest(rows: TrendRow[], shipId: string, env: Record<string, string>): string {
  return execFileSync('node', [CLI, 'digest', sinkWith(rows), shipId], {
    encoding: 'utf8',
    env: { ...process.env, DEVKIT_SHIP_REPO: '', DEVKIT_SHIP_BRANCH: '', ...env },
  });
}

describe('gate-digest CLI — the wiring a ship actually runs', () => {
  const rows = [...attempt('s1', '0.64.0', 1), ...attempt('s2', '0.67.0', 1)];

  it('reads the sink once for both branch-history lines', () => {
    expect(renderBranchHistory(sinkWith(rows), key('s2'))).toBe(line('0.64.0', '0.67.0'));
  });

  it('prints the upgrade line for a keyed ship', () => {
    const env = { DEVKIT_SHIP_REPO: where.repo, DEVKIT_SHIP_BRANCH: where.branch };
    expect(digest(rows, 's2', env)).toContain(line('0.64.0', '0.67.0'));
  });

  it('prints nothing when the ship envelope is not exported', () => {
    expect(digest(rows, 's2', {})).not.toContain('↑ devkit');
  });
});
