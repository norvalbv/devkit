import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GATE_BYPASSES } from '../../../../gate-engine/deterministic/command-gates.mts';
import { BYPASS_ENV } from '../../../../vitest.setup.mjs';
import {
  attemptBypasses,
  BYPASS_FLAGS,
  REAIM_FLAGS,
  SOFTEN_FLAGS,
  shipBypasses,
} from './bypasses.mts';

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

const read = (lines: string[]) => attemptBypasses(sink(...lines), SHIP);

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
  ...REAIM_FLAGS,
  ...SOFTEN_FLAGS,
  ...Object.values(GATE_BYPASSES),
].flatMap((name) => [`GUARD_${name}`, `FRINK_${name}`]);

beforeEach(() => {
  for (const name of [...ALL_FLAGS, 'HUSKY']) vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('attemptBypasses', () => {
  it('reads none from a clean, passing gate run', () => {
    expect(read([ATTEMPT, PASSED])).toEqual([]);
  });

  it.each([
    ['an unreadable sink', '/nonexistent/gate-events.jsonl'],
    ['a gate run that did not pass', sink(ATTEMPT)],
    ['a pass with no attempt row', sink(PASSED)],
  ])('has no record with %s', (_name, file) => {
    expect(attemptBypasses(file, SHIP)).toBeUndefined();
  });

  it('has no record when only another ship passed', () => {
    const other = JSON.stringify({ ship_id: 'ship-2', type: 'ship_result', exit_code: 0 });
    expect(read([ATTEMPT, row({ type: 'ship_result', exit_code: 1 }), other])).toBeUndefined();
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

  it.each([
    ...documentedControls(),
    ...BYPASS_ENV.filter((name) => name.startsWith('GUARD_')),
    ...Object.values(GATE_BYPASSES).map((suffix) => `GUARD_${suffix}`),
  ])('reports the documented control %s', (name) => {
    vi.stubEnv(name, name === 'GUARD_COMPLETENESS_HARD' ? '0' : '1');
    expect(read([ATTEMPT, PASSED])).toEqual([expect.stringContaining(name)]);
  });
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const NOW = Date.parse('2026-10-14T12:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();
const gated = (head: string, bypasses: string[] | string = [], ts = at(NOW)) =>
  JSON.stringify({ type: 'ship_gated', ship_id: 'any', head, bypasses, ts });
const commit = (sha: string, committedMs = NOW - 60_000) => ({ sha, committedMs });

describe('shipBypasses', () => {
  const both = [commit(SHA_B), commit(SHA_A)];

  it('reads a PR shipped as two clean gated commits as clean', () => {
    expect(shipBypasses(sink(gated(SHA_A), gated(SHA_B)), both)).toEqual([]);
  });

  it('skips a torn line in the shared sink instead of losing every record', () => {
    const torn = '{"type":"ship_gated","head":"bbb';
    expect(shipBypasses(sink(gated(SHA_A), torn, gated(SHA_B)), both)).toEqual([]);
  });

  it("carries an earlier commit's waived finding", () => {
    expect(shipBypasses(sink(gated(SHA_A, ['waived:x']), gated(SHA_B)), both)).toEqual([
      'waived:x',
    ]);
  });

  it('adds a control exported for this process', () => {
    vi.stubEnv('GUARD_SHIP_BASE_OK', '1');
    expect(shipBypasses(sink(gated(SHA_A), gated(SHA_B)), both)).toEqual(['GUARD_SHIP_BASE_OK']);
  });

  it.each([
    ['no record for one commit', [gated(SHA_B)], 'aaaaaaaaaaaa'],
    ['a record for a commit outside the range', [gated('c'.repeat(40))], 'bbbbbbbbbbbb and 1 more'],
    ['a record whose bypasses are malformed', [gated(SHA_A, 'none'), gated(SHA_B)], 'aaaaaaaaaaaa'],
  ])('is unknown with %s, naming the commit', (_name, lines, named) => {
    expect(shipBypasses(sink(...lines), both)).toEqual({
      unknown: `no passing devkit ship gate record for ${named}`,
    });
  });

  it('stops reading at rows older than the commits, so an older record is not found', () => {
    const old = at(NOW - 3 * 86_400_000);
    // The newest chunk ends on an old ship_attempt row, so the scan stops before the chunk that
    // holds the record: more than one 256 KiB read chunk of filler separates them.
    const filler = Array<string>(15_000).fill('{"type":"gate_result"}');
    const file = sink(
      gated(SHA_A, [], old),
      ...filler,
      JSON.stringify({ type: 'ship_attempt', ts: old }),
    );
    expect(shipBypasses(file, [commit(SHA_A, NOW)])).toEqual({
      unknown: 'no passing devkit ship gate record for aaaaaaaaaaaa',
    });
    expect(shipBypasses(file, [commit(SHA_A, NOW - 4 * 86_400_000)])).toEqual([]);
  });

  it('is unknown with no sink or no commits', () => {
    expect(shipBypasses(undefined, both)).toEqual({ unknown: 'no devkit ship gate run' });
    expect(shipBypasses(sink(gated(SHA_A)), [])).toEqual({
      unknown: 'no commits since the PR base',
    });
  });
});

describe('bypasses record CLI', () => {
  const script = new URL('./bypasses.mts', import.meta.url).pathname;
  const record = (lines: string[], head: string) => {
    const file = sink(...lines);
    const env = { ...process.env, DEVKIT_SHIP_ID: SHIP, DEVKIT_GATE_EVENTS: file };
    spawnSync(process.execPath, [script, 'record', head], { env, encoding: 'utf8' });
    return readFileSync(file, 'utf8').trim().split('\n').slice(lines.length);
  };

  it("appends the passing run's record under the sha it produced", () => {
    vi.stubEnv('GUARD_COVERAGE_OK', '1');
    const [line] = record([ATTEMPT, PASSED], SHA_A);
    expect(JSON.parse(line)).toMatchObject({
      type: 'ship_gated',
      ship_id: SHIP,
      head: SHA_A,
      bypasses: ['GUARD_COVERAGE_OK'],
    });
  });

  it.each([
    ['a run that did not pass', [ATTEMPT], SHA_A],
    ['a head that is not a sha', [ATTEMPT, PASSED], 'HEAD'],
  ])('appends nothing for %s', (_name, lines, head) => {
    expect(record(lines, head)).toEqual([]);
  });
});
