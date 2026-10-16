import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GATE_BYPASSES } from '../../../../gate-engine/deterministic/command-gates.mts';
import { BYPASS_ENV } from '../../../../vitest.setup.mjs';
import { BYPASS_FLAGS, shipBypasses } from './bypasses.mts';

const SHIP = 'ship-1';
interface RowFields {
  type: string;
  exit_code?: number;
  gate?: string;
  bypass?: string;
  reviewer?: string | null;
  reason?: string;
  judge?: string;
  waivers?: { lens: string }[];
  items?: { disposition?: string; status?: string }[];
}
const row = (fields: RowFields) => JSON.stringify({ ship_id: SHIP, ...fields });
const ATTEMPT = row({ type: 'ship_attempt' });
const PASSED = row({ type: 'ship_result', exit_code: 0 });

function sink(...lines: string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'ship-bypasses-')), 'gate-events.jsonl');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const read = (lines: string[], commits = 1) =>
  shipBypasses({ shipId: SHIP, sink: sink(...lines) }, commits);

// The repo's documented one-run controls, so a new control cannot ship without the verdict seeing it.
function documentedControls(): string[] {
  const skill = readFileSync(
    new URL('../../../../skills/commit-gates/SKILL.md', import.meta.url),
    'utf8',
  );
  const section = skill.split('## Canonical one-run controls')[1].split('\n## ')[0];
  return [...new Set(section.match(/GUARD_[A-Z_]+/g) ?? [])];
}

const ALL_FLAGS = [
  ...BYPASS_FLAGS,
  'REVIEW_SKIP',
  'DECISIONS_DIR',
  'ALLOWLIST_PATH',
  'COMPLETENESS_HARD',
  'SENTRY_HARD',
  ...Object.values(GATE_BYPASSES),
].flatMap((name) => [`GUARD_${name}`, `FRINK_${name}`]);

beforeEach(() => {
  for (const name of [...ALL_FLAGS, 'HUSKY']) vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('shipBypasses', () => {
  it('reads none from a clean, passing gate run', () => {
    expect(read([ATTEMPT, PASSED])).toEqual([]);
  });

  const NO_RUN = { unknown: 'no devkit ship gate run' };
  const NO_PASS = { unknown: 'no passing gate run on record for this ship' };
  it.each([
    ['no ship id', { shipId: undefined, sink: sink(ATTEMPT, PASSED) }, 1, NO_RUN],
    ['no sink', { shipId: SHIP, sink: undefined }, 1, NO_RUN],
    ['an unreadable sink', { shipId: SHIP, sink: '/nonexistent/gate-events.jsonl' }, 1, NO_PASS],
    ['a gate run that did not pass', { shipId: SHIP, sink: sink(ATTEMPT) }, 1, NO_PASS],
    ['a pass with no attempt row', { shipId: SHIP, sink: sink(PASSED) }, 1, NO_PASS],
    [
      'earlier commits gated by earlier ships',
      { shipId: SHIP, sink: sink(ATTEMPT, PASSED) },
      2,
      { unknown: '2 commits since the PR base, only a one-commit run is on record' },
    ],
  ])('is unknown with %s', (_name, record, commits, why) => {
    expect(shipBypasses(record, commits)).toEqual(why);
  });

  it('is unknown when only another ship passed', () => {
    const other = JSON.stringify({ ship_id: 'ship-2', type: 'ship_result', exit_code: 0 });
    expect(read([ATTEMPT, row({ type: 'ship_result', exit_code: 1 }), other])).toEqual(NO_PASS);
  });

  it('names every bypass flag set in the environment, in either spelling', () => {
    vi.stubEnv('GUARD_COVERAGE_OK', '1');
    vi.stubEnv('FRINK_NO_REVIEW', 'true');
    vi.stubEnv('GUARD_STRUCTURE_OK', '0');
    vi.stubEnv('GUARD_REVIEW_SKIP', 'correctness-reviewer');
    vi.stubEnv('GUARD_COMPLETENESS_HARD', '0');
    vi.stubEnv('GUARD_SENTRY_HARD', '1');
    vi.stubEnv('GUARD_NO_COVERAGE', '0');
    vi.stubEnv('FRINK_NO_COVERAGE', '1');
    vi.stubEnv('GUARD_DECISIONS_DIR', 'records');
    vi.stubEnv('HUSKY', '0');
    expect(read([ATTEMPT, PASSED])).toEqual([
      'GUARD_NO_REVIEW',
      'GUARD_COVERAGE_OK',
      'GUARD_REVIEW_SKIP',
      'GUARD_DECISIONS_DIR',
      'GUARD_COMPLETENESS_HARD=0',
      'HUSKY=0',
    ]);
  });

  it('adds what the gate rows recorded: bypass fields, skipped reviewers and waived findings', () => {
    const rows = [
      row({ type: 'ship_attempt' }),
      row({ type: 'gate_result', gate: 'hook-parity', bypass: 'GUARD_HOOK_PARITY_OK' }),
      row({ type: 'review_skipped', reviewer: 'commit-guard', reason: 'GUARD_REVIEW_SKIP' }),
      row({ type: 'review_skipped', reviewer: null, reason: 'gate_disabled' }),
      row({ type: 'review_skipped', reviewer: 'sentry', reason: 'not_selected' }),
      row({ type: 'review_skipped', reviewer: null, reason: 'no_llm' }),
      row({ type: 'review_result', reviewer: 'correctness-reviewer', waivers: [{ lens: 'x' }] }),
      row({
        type: 'review_result',
        reviewer: 'conventions-reviewer',
        items: [{ disposition: 'waived' }],
      }),
      row({
        type: 'review_result',
        reviewer: 'api-security-reviewer',
        items: [{ status: 'pass' }],
      }),
      row({ type: 'cache_hit', judge: 'review:commit-guard', waivers: [{ lens: 'y' }] }),
      PASSED,
    ];
    expect(read(rows)).toEqual([
      'GUARD_HOOK_PARITY_OK',
      'GUARD_REVIEW_SKIP',
      'GUARD_NO_REVIEW',
      'waived:correctness-reviewer',
      'waived:conventions-reviewer',
      'waived:review:commit-guard',
    ]);
  });

  it('reads only this attempt: rows before its ship_attempt are an earlier attempt', () => {
    const earlier = row({ type: 'gate_result', bypass: 'GUARD_COVERAGE_OK' });
    expect(read([ATTEMPT, earlier, ATTEMPT, PASSED])).toEqual([]);
  });

  it("never credits this attempt with an earlier attempt's pass", () => {
    expect(read([ATTEMPT, PASSED, ATTEMPT])).toEqual(NO_PASS);
  });

  it.each([
    ...documentedControls(),
    ...BYPASS_ENV.filter((name) => name.startsWith('GUARD_')),
    ...Object.values(GATE_BYPASSES).map((suffix) => `GUARD_${suffix}`),
  ])('reports the documented control %s', (name) => {
    vi.stubEnv(name, name === 'GUARD_COMPLETENESS_HARD' ? '0' : '1');
    expect(read([ATTEMPT, PASSED])).toEqual([expect.stringContaining(name)]);
  });
});
