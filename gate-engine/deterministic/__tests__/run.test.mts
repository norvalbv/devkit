import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOpts, runDeterministic, selectedIds } from '../run.mts';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  vi.restoreAllMocks();
});

// A repo whose .devkit/config.json selects `guards`. Pass null for no config (missing-config path).
function repo(guards) {
  const d = mkdtempSync(join(tmpdir(), 'guard-det-'));
  dirs.push(d);
  if (guards) {
    mkdirSync(join(d, '.devkit'), { recursive: true });
    writeFileSync(join(d, '.devkit', 'config.json'), JSON.stringify({ components: { guards } }));
  }
  return d;
}

// Fake `node <guard-module> <args>` runner: maps a guard module basename → exit code. Throws
// { status } for non-zero (like execFileSync), returns for 0. argv[0] is the resolved module path.
function mkExec(codeByModule) {
  return vi.fn((_node, argv) => {
    const mod = argv[0];
    const hit = Object.entries(codeByModule).find(([k]) => mod.includes(k));
    const code = hit ? hit[1] : 0;
    if (code !== 0) {
      const e = new Error(`exit ${code}`);
      e.status = code;
      throw e;
    }
  });
}

describe('runDeterministic — aggregation + trichotomy', () => {
  it('TWO real failures are BOTH reported in one aggregated report → single exit 1', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout', 'dup', 'clone']);
    const exec = mkExec({ 'size-disable': 1, matcher: 1 }); // size + dup fail
    expect(runDeterministic(d, { exec })).toBe(1);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('deterministic gates failed: guard-size guard-dup');
    expect(exec).toHaveBeenCalledTimes(4); // fanout + clone still ran (not fail-fast)
  });

  it('exit 2 = could-not-run → fail-open (not accumulated), whole set exits 0', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout', 'dup', 'clone']);
    const exec = mkExec({ 'size-disable': 2, 'folder-fanout': 2, matcher: 2, 'clone-detector': 2 });
    expect(runDeterministic(d, { exec })).toBe(0);
  });

  it('an unexpected non-{0,1,2} code is aggregated WITH the code named', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['fanout']);
    const exec = mkExec({ 'folder-fanout': 127 });
    expect(runDeterministic(d, { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('guard-fanout(unexpected:127)');
  });

  it('runs ONLY the selected guards (components.guards)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(['size']), { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1); // only size
  });

  it('a missing/unreadable config runs the WHOLE set (never silently skip a gate)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(null), { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(4);
  });
});

describe('runDeterministic — --structure / --extra / --only', () => {
  it('--structure "guard-structure gate" runs the sibling module and keeps the trichotomy', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    const exec = mkExec({ 'structure/run.mts': 1 });
    expect(runDeterministic(d, { exec, structure: 'guard-structure gate' })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('structure-lint');
    // resolved as `node <sibling structure/run.mts> gate`, never via bunx/PATH
    const call = exec.mock.calls.find(([, argv]) => argv[0].includes('structure/run.mts'));
    expect(call[0]).toBe('node');
    expect(call[1][1]).toBe('gate');
    // exit 2 = could-not-run → fail-open for the guard form
    const exec2 = mkExec({ 'structure/run.mts': 2 });
    expect(runDeterministic(d, { exec: exec2, structure: 'guard-structure gate' })).toBe(0);
  });

  it('a non-guard structure command spawns via PATH and BLOCKS on exit 2 (eslint fatal ≠ opt-out)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    const exec = vi.fn((bin) => {
      if (bin === 'bunx') {
        const e = new Error('exit 2');
        e.status = 2;
        throw e;
      }
    });
    expect(runDeterministic(d, { exec, structure: 'bunx eslint src' })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('structure-lint(unexpected:2)');
    expect(exec).toHaveBeenCalledWith('bunx', ['eslint', 'src'], expect.anything());
  });

  it('--extra gates run under their own label and aggregate with the built-ins', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    const exec = vi.fn((bin, argv) => {
      const key = [bin, ...argv].join(' ');
      if (key.includes('size-disable') || bin === 'bun') {
        const e = new Error('exit 1');
        e.status = 1;
        throw e;
      }
    });
    expect(runDeterministic(d, { exec, extra: [{ label: 'lint', cmd: 'bun run lint' }] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain(
      'deterministic gates failed: guard-size lint',
    );
  });

  it('a malformed --extra (no command) BLOCKS as unrunnable — never silently skipped', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size']);
    expect(runDeterministic(d, { exec: mkExec({}), extra: [{ label: 'lint' }] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('lint(unrunnable: empty command)');
  });

  it('--only restricts the built-in set, overriding the config selection', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = repo(['size', 'fanout', 'dup', 'clone']);
    const exec = mkExec({});
    expect(runDeterministic(d, { exec, only: ['size', 'fanout'] })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(2);
    const mods = exec.mock.calls.map(([, argv]) => argv[0]).join(' ');
    expect(mods).toContain('size-disable');
    expect(mods).toContain('folder-fanout');
  });

  it('a typoed --only id fails CLOSED before running any gate (no silent drop)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    // `siz` is a typo for `size` — must NOT silently run zero built-ins.
    expect(runDeterministic(repo(['size']), { exec, only: ['siz', 'fanout'] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('unknown gate id(s): siz');
    expect(exec).not.toHaveBeenCalled(); // refused before the gate loop
  });

  it('an empty --only selection (e.g. `--only ,,` → []) fails CLOSED, never runs zero built-ins silently', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(['size']), { exec, only: [] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('empty selection');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('parseOpts — the argv tokenizer the real hook depends on', () => {
  it('captures --hook/--scope/--structure values and repeated --extra specs', () => {
    const o = parseOpts([
      '--hook',
      '/a b/pre-commit',
      '--scope',
      'frink-extra',
      '--structure',
      'guard-structure gate',
      '--extra',
      'lint=bun run lint',
      '--extra',
      'types=tsc -p .',
    ]);
    expect(o.hookPath).toBe('/a b/pre-commit');
    expect(o.scope).toBe('frink-extra');
    expect(o.structure).toBe('guard-structure gate');
    expect(o.extra).toEqual([
      { label: 'lint', cmd: 'bun run lint' },
      { label: 'types', cmd: 'tsc -p .' },
    ]);
  });

  it('a malformed --extra (no `=`) parses to a label-only spec (runDeterministic then blocks it)', () => {
    expect(parseOpts(['--extra', 'lint']).extra).toEqual([{ label: 'lint' }]);
  });

  it('--only splits/trims/drops blanks — `,,` yields [] (fail-closed at runDeterministic)', () => {
    expect(parseOpts(['--only', 'size, fanout ,']).only).toEqual(['size', 'fanout']);
    expect(parseOpts(['--only', ',,']).only).toEqual([]);
  });
});

describe('selectedIds', () => {
  it('intersects components.guards with the deterministic set in fixed order, dropping AI ids', () => {
    const d = repo(['clone', 'size', 'review', 'decisions']); // review/decisions are AI (fail-fast)
    expect(selectedIds(d)).toEqual(['size', 'clone']);
  });
});
