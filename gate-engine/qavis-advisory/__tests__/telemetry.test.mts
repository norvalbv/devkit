import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type RouteResult, runQavisAdvisory } from '../check.mts';
import { summarise } from '../../../cli/lib/ship/digest/gate-digest.mts';

let dir: string;
let sink: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'qavis-telemetry-'));
  sink = path.join(dir, 'events.jsonl');
  vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
  vi.stubEnv('DEVKIT_SHIP_ID', 'frink-ship');
  vi.stubEnv('DEVKIT_SHIP_REPO', 'frink');
  for (const name of [
    'GUARD_QAVIS_OK',
    'GUARD_NO_QAVIS_ADVISORY',
    'DEVKIT_SHIP_QA',
    'DEVKIT_SHIP_ROOT',
  ])
    vi.stubEnv(name, '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const events = () =>
  readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

it.each([
  ['SILENT', '1', 0, 'gate_result', 'pass', 'silent'],
  ['ADVISE', '1', 3, 'gate_result', 'fail', 'required'],
  ['ADVISE', '', 0, 'advisory_result', 'finding', 'required'],
  [null, '1', 0, 'gate_infra_failure', undefined, 'unavailable'],
] as const)(
  'records %s under strict=%s without inventing a QA verdict',
  (verdict, strict, code, type, status, outcome) => {
    vi.stubEnv('GUARD_AI_STRICT', strict);
    const result: RouteResult =
      verdict === null ? { verdict, skip: 'classifier invalid' } : { verdict };
    expect(runQavisAdvisory(dir, { hasRecipe: () => true, route: () => result })).toBe(code);
    const rows = events();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      type,
      gate: 'qavis-advisory',
      qavis_outcome: outcome,
      exit_code: code,
      ship_id: 'frink-ship',
      repo: 'frink',
    });
    expect(rows[0].status).toBe(status);
    expect(rows[1]).toMatchObject({ type: 'gate_timing', gate: 'qavis-advisory' });
    expect(rows[1].actual_duration_ms).toBeGreaterThanOrEqual(0);
    if (code === 3)
      expect(console.error).toHaveBeenCalledWith('qavis-advisory: strict gate blocked');
    else expect(console.error).not.toHaveBeenCalledWith('qavis-advisory: strict gate blocked');
  },
);

it.each([
  [{ verdict: 'SILENT' }, 0, 'self_run_cleared'],
  [{ verdict: 'ADVISE' }, 3, 'required'],
  [{ verdict: null, skip: 'provider unavailable' }, 0, 'unavailable'],
] as const)('records the self-run and its recheck: %s', (after, expectedCode, expectedOutcome) => {
  vi.stubEnv('GUARD_AI_STRICT', '1');
  vi.stubEnv('DEVKIT_SHIP_QA', '1');
  const route = vi
    .fn<() => RouteResult>()
    .mockReturnValueOnce({ verdict: 'ADVISE' })
    .mockReturnValueOnce(after);
  const qa = vi.fn(() => 2);
  expect(runQavisAdvisory(dir, { hasRecipe: () => true, route, qa })).toBe(expectedCode);
  expect(qa).toHaveBeenCalledWith(dir);
  expect(events()[0]).toMatchObject({
    qa_exit_code: 2,
    qavis_outcome: expectedOutcome,
  });
});

it('a broken telemetry sink cannot block a silent gate', () => {
  vi.stubEnv('DEVKIT_GATE_EVENTS', dir);
  expect(
    runQavisAdvisory(dir, { hasRecipe: () => true, route: () => ({ verdict: 'SILENT' }) }),
  ).toBe(0);
});

it('preserves unavailable classifier detail through the ship digest', () => {
  runQavisAdvisory(dir, {
    hasRecipe: () => true,
    route: () => ({ verdict: null, skip: 'classifier invalid' }),
  });
  const rows = summarise(events(), 'frink-ship');
  expect(rows).toContainEqual(
    expect.objectContaining({
      gate: 'qavis-advisory',
      state: 'could-not-run',
      detail: 'classifier invalid',
    }),
  );
});
