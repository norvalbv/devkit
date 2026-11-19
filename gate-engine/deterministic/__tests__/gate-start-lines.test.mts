import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATE_REASON_ENV } from '../reason.mts';
import { runDeterministic } from '../run.mts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.DEVKIT_SHIP;
  for (const f of ['GUARD_HOOK_PARITY_OK', 'GUARD_DECISION_CHECKS_OK', 'GUARD_COVERAGE_OK'])
    delete process.env[f];
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
      '  ✓ guard-size passed',
      '▶ deterministic: hook-parity',
      'exec true',
      '  ✓ hook-parity passed',
      '▶ deterministic: knip',
      'exec knip',
      '  ✓ knip passed',
      '▶ deterministic: structure-lint',
      'exec eslint',
      '  ✓ structure-lint passed',
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

describe('runDeterministic — a verdict line closes each gate header', () => {
  // Throws what execFileSync throws for a gate exiting non-zero or timing out, keyed on its argv.
  const failing = (byArg: Record<string, { status?: number; code?: string }>) => {
    const t = timeline();
    t.exec.mockImplementation((cmd: string, args: string[] = []) => {
      t.events.push(`exec ${cmd}`);
      const hit = Object.entries(byArg).find(([k]) => [cmd, ...args].some((a) => a.includes(k)));
      if (hit) throw Object.assign(new Error(cmd), hit[1]);
    });
    return t;
  };

  it('names a failure, an opt-out and a timeout, never as passed', () => {
    const { events, exec } = failing({
      false: { status: 1 },
      matcher: { status: 2 },
      slow: { code: 'ETIMEDOUT' },
      eslint: { status: 2 },
    });
    const d = repo(['dup'], { hang: 'slow' });
    const extra = [{ label: 'hook-parity', cmd: 'false' }];

    expect(runDeterministic(d, { exec, extra, structure: 'eslint src' })).toBe(1);

    expect(events.filter((l) => l.startsWith('  '))).toEqual([
      '  ⚠ guard-dup SKIPPED — opted out, did NOT run',
      '  ✗ hook-parity failed',
      '  ✗ hang could not run',
      '  ✗ structure-lint could not run',
    ]);
  });

  it('names a declared extraGates entry on a passing run, and drops it once undeclared', () => {
    const declared = timeline();
    expect(runDeterministic(repo([], { 'git-pathspec': 'node check.mjs' }), declared)).toBe(0);
    expect(declared.events).toContain('  ✓ git-pathspec passed');

    vi.restoreAllMocks();
    const undeclared = timeline();
    expect(runDeterministic(repo([]), undeclared)).toBe(0);
    expect(undeclared.events.some((l) => l.includes('git-pathspec'))).toBe(false);
  });

  it('marks only the gate that left a withheld note as DEGRADED, not the gates after it', () => {
    const { events, exec } = timeline();
    exec.mockImplementation((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      events.push(`exec ${args.join(' ')}`);
      if (args.some((a) => a.includes('size')))
        writeFileSync(String(opts.env[GATE_REASON_ENV]), 'semantic index unavailable\n');
    });

    expect(runDeterministic(repo(['size', 'fanout']), { exec })).toBe(0);

    expect(events.filter((l) => l.startsWith('  '))).toEqual([
      '  ⚠ guard-size passed (DEGRADED)',
      '  ✓ guard-fanout passed',
    ]);
  });

  it('reports an opt-out that strict mode refuses as could not run, never as SKIPPED', () => {
    process.env.GUARD_DETERMINISTIC_STRICT = '1';
    const { events, exec } = failing({ matcher: { status: 2 } });

    expect(runDeterministic(repo(['dup']), { exec })).toBe(1);

    expect(events).toContain('  ✗ guard-dup could not run');
  });

  // An --extra label is bare; a registry gate's label carries the guard- prefix its flag omits.
  it.each([
    [
      'an --extra gate',
      'GUARD_HOOK_PARITY_OK',
      [],
      [{ label: 'hook-parity', cmd: 'true' }],
      'hook-parity',
    ],
    [
      'a registry gate',
      'GUARD_DECISION_CHECKS_OK',
      ['decision-checks'],
      [],
      'guard-decision-checks',
    ],
    ['the coverage gate', 'GUARD_COVERAGE_OK', ['coverage'], [], 'guard-coverage'],
  ])(
    'marks %s that passed through its own bypass flag as BYPASSED',
    (_, flag, guards, extra, label) => {
      process.env[flag] = '1';
      const { events, exec } = timeline();

      expect(runDeterministic(repo(guards), { exec, extra })).toBe(0);

      expect(events).toContain(`  ⚠ ${label} BYPASSED — verified nothing`);
    },
  );
});
