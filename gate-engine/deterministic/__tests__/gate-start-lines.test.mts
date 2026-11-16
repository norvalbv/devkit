import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDeterministic } from '../run.mts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.DEVKIT_SHIP;
  delete process.env.GUARD_DETERMINISTIC_STRICT;
  delete process.env.FRINK_DETERMINISTIC_STRICT;
  vi.restoreAllMocks();
});

const START_RE = /^▶ deterministic: /;

// A repo whose .devkit/config.json selects `guards`, with optional guard.config.json extraGates.
function repo(guards: string[], extraGates?: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'guard-det-start-'));
  dirs.push(d);
  mkdirSync(join(d, '.devkit'));
  writeFileSync(join(d, '.devkit', 'config.json'), JSON.stringify({ components: { guards } }));
  if (extraGates) writeFileSync(join(d, 'guard.config.json'), JSON.stringify({ extraGates }));
  return d;
}

// Records stdout lines and gate spawns in one timeline, so a test can assert what printed before what.
function timeline() {
  const events: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line) => events.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const exec = vi.fn((cmd: string) => {
    events.push(`exec ${cmd}`);
  });
  return { events, exec, starts: () => events.filter((l) => START_RE.test(l)) };
}

// A staged ship repo, so the second identical run is a deterministic-prefix cache hit.
function shipRepo(guards: string[]) {
  const d = repo(guards);
  if (guards.includes('coverage')) {
    mkdirSync(join(d, 'coverage'));
    writeFileSync(join(d, 'coverage', 'coverage-final.json'), '{"a":1}');
  }
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '.'], { cwd: d });
  process.env.DEVKIT_SHIP = '1';
  return d;
}

describe('runDeterministic — a line names each gate as it starts', () => {
  it('prints one line per gate kind, each immediately before that gate spawns', () => {
    const { events, exec } = timeline();
    const d = repo(['size'], { knip: 'knip --strict' });
    const opts = { exec, extra: [{ label: 'hook-parity', cmd: 'true' }], structure: 'eslint src' };

    expect(runDeterministic(d, opts)).toBe(0);

    expect(events).toEqual([
      '▶ deterministic: guard-size',
      'exec node',
      '▶ deterministic: hook-parity',
      'exec true',
      '▶ deterministic: knip',
      'exec knip',
      '▶ deterministic: structure-lint',
      'exec eslint',
    ]);
  });

  it('prints no gate line on a prefix-cache hit that runs no gate', () => {
    const d = shipRepo(['size']);
    expect(runDeterministic(d, { exec: timeline().exec })).toBe(0);

    const { starts, exec } = timeline();
    expect(runDeterministic(d, { exec })).toBe(0);

    expect(exec).not.toHaveBeenCalled();
    expect(starts()).toEqual([]);
  });

  it('names only coverage on a cache hit, since coverage is the one gate it re-runs', () => {
    const d = shipRepo(['size', 'coverage']);
    expect(runDeterministic(d, { exec: timeline().exec })).toBe(0);

    const { starts, exec } = timeline();
    expect(runDeterministic(d, { exec })).toBe(0);

    expect(starts()).toEqual(['▶ deterministic: guard-coverage']);
  });

  it('prints no line for an empty --extra command, which still fails as unrunnable', () => {
    const { starts, exec } = timeline();
    const err = vi.mocked(console.error);
    const d = repo([]);

    expect(runDeterministic(d, { exec, extra: [{ label: 'empty', cmd: '' }] })).toBe(1);

    expect(starts()).toEqual([]);
    expect(err.mock.calls.flat().join('\n')).toContain('empty(unrunnable: empty command)');
  });
});
