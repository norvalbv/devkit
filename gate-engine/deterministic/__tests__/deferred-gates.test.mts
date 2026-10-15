/** An afterGreen extraGates entry runs last and only on an otherwise green run, except in review. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDeterministic } from '../run.mts';

const SLOW = { cmd: 'bun run slow', afterGreen: true };
const SUMMARY_RE = /^✗ deterministic gates failed:.*$/m;

let dir = '';
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-det-deferred-'));
  for (const name of [
    'DEVKIT_RUN_MODE',
    'DEVKIT_SHIP',
    'GUARD_DETERMINISTIC_STRICT',
    'FRINK_DETERMINISTIC_STRICT',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('DEVKIT_GATE_EVENTS', join(dir, 'events.jsonl'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

type Spec = string | { cmd?: string; afterGreen?: boolean; timeout?: number };

/** Declare `extraGates` in the temp repo's guard.config.json. */
function declare(extraGates: Record<string, Spec>): void {
  writeFileSync(join(dir, 'guard.config.json'), JSON.stringify({ extraGates }));
}

/** A gate runner that exits with `codes[k]` for the first key the spawned command contains. */
function runner(codes: Record<string, number> = {}) {
  return vi.fn((bin: string, argv: string[]) => {
    const command = [bin, ...argv].join(' ');
    const code = Object.entries(codes).find(([k]) => command.includes(k))?.[1] ?? 0;
    if (code !== 0) throw Object.assign(new Error(`exit ${code}`), { status: code });
  });
}

const ran = (exec: ReturnType<typeof runner>) =>
  exec.mock.calls
    .map(([bin, argv]) => [bin, ...argv].join(' '))
    .filter((c) => !c.startsWith('node'));
const errText = () => stderr.mock.calls.flat().join('\n');

describe('afterGreen extraGates', () => {
  it('a failing earlier gate skips the deferred gate and names it as NOT run', () => {
    declare({ slow: SLOW, cheap: 'bun run cheap' });
    const exec = runner({ cheap: 1 });
    expect(runDeterministic(dir, { exec, only: ['size'] })).toBe(1);
    expect(ran(exec)).toEqual(['bun run cheap']);
    expect(errText().match(SUMMARY_RE)?.[0]).toBe('✗ deterministic gates failed: cheap');
    expect(errText()).toContain('NOT run (an earlier gate failed): slow');
    expect(errText()).toContain('then commit again.');
    expect(errText()).not.toContain('commit once');
  });

  it('a red run that skipped nothing keeps the one-pass closing line and no NOT-run line', () => {
    declare({ cheap: 'bun run cheap' });
    expect(runDeterministic(dir, { exec: runner({ cheap: 1 }), only: ['size'] })).toBe(1);
    expect(errText()).toContain('Fix every failure above together, then commit once.');
    expect(errText()).not.toContain('NOT run');
  });

  it('runs after structure-lint, so a structure-only failure skips it too', () => {
    declare({ slow: SLOW, cheap: 'bun run cheap' });
    const green = runner();
    expect(runDeterministic(dir, { exec: green, only: ['size'], structure: 'bunx eslint' })).toBe(
      0,
    );
    expect(ran(green)).toEqual(['bun run cheap', 'bunx eslint', 'bun run slow']);
    const red = runner({ eslint: 1 });
    expect(runDeterministic(dir, { exec: red, only: ['size'], structure: 'bunx eslint' })).toBe(1);
    expect(ran(red)).toEqual(['bun run cheap', 'bunx eslint']);
  });

  it('blocks on its own failure, and a second deferred gate after it is NOT run', () => {
    declare({ slow: SLOW, slower: { cmd: 'bun run slower', afterGreen: true } });
    const exec = runner({ 'run slow': 1 });
    expect(runDeterministic(dir, { exec, only: ['size'] })).toBe(1);
    expect(ran(exec)).toEqual(['bun run slow']);
    expect(errText()).toContain('deterministic gates failed: slow\n');
    expect(errText()).toContain('NOT run (an earlier gate failed): slower');
  });

  it('records no gate_result for a skipped gate, only for the one that failed', () => {
    declare({ slow: SLOW });
    expect(runDeterministic(dir, { exec: runner({ 'size-disable': 1 }), only: ['size'] })).toBe(1);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === 'gate_result');
    expect(events.map((e) => e.gate)).toEqual(['size']);
  });

  it('keeps a comments-only summary line ending in guard-comments for blocked_gate attribution', () => {
    declare({ slow: SLOW });
    const exec = runner({ 'comment-firewall': 1 });
    expect(runDeterministic(dir, { exec, only: ['comments'] })).toBe(1);
    expect(errText()).toMatch(/✗ deterministic gates failed: guard-comments(\([^)]*\))?$/m);
  });

  it('an opt-out (exit 2) is not a failure, so the deferred gate still runs', () => {
    declare({ slow: SLOW });
    const exec = runner({ 'size-disable': 2 });
    expect(runDeterministic(dir, { exec, only: ['size'] })).toBe(0);
    expect(ran(exec)).toEqual(['bun run slow']);
  });

  it.each([
    ['review', ['bun run cheap', 'bun run slow']],
    ['dry-gates', ['bun run cheap']],
  ])('under DEVKIT_RUN_MODE=%s the skip is %j', (mode, expected) => {
    vi.stubEnv('DEVKIT_RUN_MODE', mode);
    vi.stubEnv('DEVKIT_REVIEW_GUARDS', 'size');
    declare({ slow: SLOW, cheap: 'bun run cheap' });
    const exec = runner({ cheap: 1 });
    expect(runDeterministic(dir, { exec, only: ['size'] })).toBe(1);
    expect(ran(exec)).toEqual(expected);
  });

  it.each([
    ['no cmd', { afterGreen: true }],
    ['an unknown key', { ...SLOW, timeout: 5 }],
    ['afterGreen false', { cmd: 'bun run slow', afterGreen: false }],
  ])('a malformed object form (%s) blocks as unrunnable extraGates', (_why, spec) => {
    declare({ slow: spec });
    const exec = runner();
    expect(runDeterministic(dir, { exec, only: ['size'] })).toBe(1);
    expect(errText()).toContain('guard.config.json extraGates.slow:');
    expect(ran(exec)).toEqual([]);
  });
});
