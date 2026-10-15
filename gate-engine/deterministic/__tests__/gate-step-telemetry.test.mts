/** Every gate guard-deterministic spawns writes one `gate_step` row: status, exit code, duration. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runDeterministic } from '../run.mts';

let dir = '';
let sink = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-det-step-'));
  sink = join(dir, 'events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of [
    'DEVKIT_GATE_EVENTS',
    'DEVKIT_SHIP',
    'GUARD_COVERAGE_OK',
    'GUARD_HOOK_PARITY_OK',
    'GUARD_DECISION_CHECKS_OK',
    'GUARD_DETERMINISTIC_STRICT',
  ]) {
    delete process.env[key];
  }
  vi.restoreAllMocks();
});

function selectGuards(guards: string[]) {
  mkdirSync(join(dir, '.devkit'), { recursive: true });
  writeFileSync(join(dir, '.devkit', 'config.json'), JSON.stringify({ components: { guards } }));
}

// Fake spawner: the first `codes` key found in the spawned command line sets its exit code.
function fakeExec(codes: Record<string, number> = {}) {
  return vi.fn((bin: string, args: string[]) => {
    const line = [bin, ...args].join(' ');
    const code = Object.entries(codes).find(([k]) => line.includes(k))?.[1] ?? 0;
    if (code !== 0) throw Object.assign(new Error(`exit ${code}`), { status: code });
  });
}

const eventSchema = z.object({
  type: z.string(),
  gate: z.string().optional(),
  family: z.string().optional(),
  status: z.string().optional(),
  exit_code: z.number().optional(),
  duration_ms: z.number().optional(),
  cache_state: z.string().optional(),
});

function rows(type: string) {
  let text = '';
  try {
    text = readFileSync(sink, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => eventSchema.parse(JSON.parse(line)))
    .filter((e) => e.type === type);
}

const steps = () =>
  rows('gate_step').map(({ gate, status, exit_code }) => [gate, status, exit_code]);

describe('gate_step telemetry', () => {
  it('records each spawned gate, pass or fail, with a duration', () => {
    selectGuards(['size', 'fanout']);
    const exec = fakeExec({ 'size-disable': 1 });
    expect(runDeterministic(dir, { exec, extra: [{ label: 'lint', cmd: 'eslint src' }] })).toBe(1);
    expect(steps()).toEqual([
      ['size', 'fail', 1],
      ['fanout', 'pass', 0],
      ['lint', 'pass', 0],
    ]);
    for (const row of rows('gate_step')) {
      expect(row).toMatchObject({ family: 'deterministic' });
      expect(row.duration_ms).toEqual(expect.any(Number));
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('times the gate itself', () => {
    selectGuards(['size']);
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const exec = vi.fn(() => {
      now += 1234;
    });
    expect(runDeterministic(dir, { exec })).toBe(0);
    expect(rows('gate_step')[0].duration_ms).toBe(1234);
  });

  // Date.now() is wall-clock: an NTP step backwards mid-gate must not publish a negative duration.
  it('a clock that steps backwards records 0, never a negative duration', () => {
    selectGuards(['size']);
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now -= 500));
    expect(runDeterministic(dir, { exec: fakeExec() })).toBe(0);
    expect(rows('gate_step').map((e) => e.duration_ms)).toEqual([0]);
  });

  it('an opt-out, an unexpected exit and a strict could-not-run are could_not_run, never fail', () => {
    selectGuards(['dup', 'size']);
    const exec = fakeExec({ matcher: 2, 'size-disable': 9 });
    expect(runDeterministic(dir, { exec })).toBe(1);
    expect(steps()).toEqual([
      ['size', 'could_not_run', 9],
      ['dup', 'could_not_run', 2],
    ]);
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    rmSync(sink);
    expect(runDeterministic(dir, { exec: fakeExec({ matcher: 2 }) })).toBe(1);
    expect(steps()).toEqual([
      ['size', 'pass', 0],
      ['dup', 'could_not_run', 2],
    ]);
  });

  it('a gate that exits 0 under its own bypass flag is could_not_run, never pass', () => {
    selectGuards(['coverage']);
    process.env.GUARD_COVERAGE_OK = '1';
    process.env.GUARD_HOOK_PARITY_OK = '1';
    const extra = [
      { label: 'hook-parity', cmd: 'node parity.mjs' },
      { label: 'lint', cmd: 'eslint src' },
    ];
    expect(runDeterministic(dir, { exec: fakeExec(), extra })).toBe(0);
    expect(steps()).toEqual([
      ['coverage', 'could_not_run', 0],
      ['hook-parity', 'could_not_run', 0],
      ['lint', 'pass', 0],
    ]);
  });

  it('a gate that could not even spawn is a fail with exit code 1', () => {
    selectGuards(['size']);
    const exec = vi.fn(() => {
      throw new Error('spawn ENOENT');
    });
    expect(runDeterministic(dir, { exec })).toBe(1);
    expect(steps()).toEqual([['size', 'fail', 1]]);
  });

  // A registry gate arrives as `guard-<id>`; its bypass lookup must use the stripped id.
  it('a bypassed registry gate is could_not_run too', () => {
    process.env.GUARD_DECISION_CHECKS_OK = '1';
    expect(runDeterministic(dir, { exec: fakeExec(), only: ['decision-checks'] })).toBe(0);
    expect(steps()).toEqual([['decision-checks', 'could_not_run', 0]]);
  });

  it('an unrunnable command spawns nothing and writes no step', () => {
    selectGuards(['size']);
    expect(runDeterministic(dir, { exec: fakeExec(), extra: [{ label: 'empty', cmd: ' ' }] })).toBe(
      1,
    );
    expect(steps()).toEqual([['size', 'pass', 0]]);
    expect(rows('gate_result')).toHaveLength(1);
  });

  it('a cached-prefix skip writes steps only for gates that re-run (coverage)', () => {
    selectGuards(['size', 'coverage']);
    mkdirSync(join(dir, 'coverage'));
    writeFileSync(join(dir, 'coverage', 'coverage-final.json'), '{"a":1}');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    process.env.DEVKIT_SHIP = '1';
    expect(runDeterministic(dir, { exec: fakeExec() })).toBe(0);
    expect(runDeterministic(dir, { exec: fakeExec() })).toBe(0);
    expect(steps()).toEqual([
      ['size', 'pass', 0],
      ['coverage', 'pass', 0],
      ['coverage', 'pass', 0],
    ]);
    expect(rows('gate_timing').map((e) => e.cache_state)).toEqual(['none', 'partial']);
  });

  it('adds no gate_result or gate_timing rows', () => {
    selectGuards(['size', 'fanout']);
    expect(runDeterministic(dir, { exec: fakeExec() })).toBe(0);
    expect(rows('gate_result')).toEqual([]);
    expect(rows('gate_timing')).toHaveLength(1);
  });
});
