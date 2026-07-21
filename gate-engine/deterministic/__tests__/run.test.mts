import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOpts, prefixCacheScope, runDeterministic, selectedIds } from '../run.mts';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  delete process.env.DEVKIT_RUN_MODE;
  delete process.env.DEVKIT_REVIEW_GUARDS;
  delete process.env.DEVKIT_SHIP;
  delete process.env.GUARD_COVERAGE_OK;
  delete process.env.GUARD_NO_COVERAGE;
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

  it('review --only cannot re-enable a gate outside the configured review allowlist', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'size';

    expect(runDeterministic(repo(['size', 'fanout']), { exec, only: ['fanout'] })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('not enabled for review: fanout');
    expect(exec).not.toHaveBeenCalled();
  });

  it('review --only may narrow the allowlist and runs the canonical subset once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'fanout,size';

    expect(runDeterministic(repo(['clone']), { exec, only: ['fanout', 'fanout'] })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1][0]).toContain('folder-fanout');
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

  it('runs an explicitly-selected opt-in guard (coverage)', () => {
    expect(selectedIds(repo(['size', 'coverage']))).toEqual(['size', 'coverage']);
  });

  it('EXCLUDES opt-in coverage from the missing-config fallback (unadopted repo never wedged)', () => {
    expect(selectedIds(repo(null))).toEqual(['size', 'fanout', 'dup', 'clone']);
  });

  it('uses the explicit review allowlist instead of components.guards in review mode', () => {
    const d = repo(['size', 'fanout', 'dup', 'clone']);
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = ' clone, size ,decisions ';
    expect(selectedIds(d)).toEqual(['size', 'clone']);
    process.env.DEVKIT_REVIEW_GUARDS = '';
    expect(selectedIds(d)).toEqual([]);
    delete process.env.DEVKIT_REVIEW_GUARDS;
    expect(selectedIds(d)).toEqual([]);
  });
});

describe('coverage — opt-in wiring through runDeterministic', () => {
  it('spawns the coverage module when selected', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(['size', 'coverage']), { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.some(([, argv]) => argv[0].includes('coverage/run'))).toBe(true);
  });

  it('does NOT spawn coverage on the missing-config fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec({});
    expect(runDeterministic(repo(null), { exec })).toBe(0);
    expect(exec.mock.calls.some(([, argv]) => argv[0].includes('coverage/run'))).toBe(false);
  });
});

describe('prefixCacheScope', () => {
  it('salts review entries with mode and allowlist while leaving commit/ship scopes unchanged', () => {
    expect(prefixCacheScope()).toBeUndefined();
    expect(prefixCacheScope('custom')).toBe('custom');
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'size,decisions';
    expect(prefixCacheScope()).toBe('devkit-guards:review:size');
    expect(prefixCacheScope('custom')).toBe('custom:review:size');
  });

  it('canonicalizes the effective guard set so order and duplicates share one cache key', () => {
    process.env.DEVKIT_RUN_MODE = 'review';
    expect(prefixCacheScope(undefined, ['fanout', 'size', 'fanout'])).toBe(
      'devkit-guards:review:size,fanout',
    );
    expect(prefixCacheScope(undefined, ['size', 'fanout'])).toBe(
      'devkit-guards:review:size,fanout',
    );
  });

  // THE anti-laundering property. Without the salt a GUARD_COVERAGE_OK ship records an all-green key
  // that a later un-bypassed ship of the identical tree would HIT — skipping every gate, so coverage
  // never runs again. The two runs must never share a key.
  it.each([
    'GUARD_COVERAGE_OK',
    'GUARD_NO_COVERAGE',
  ])('%s salts the scope away from a clean run', (key) => {
    const cleanDefault = prefixCacheScope();
    const cleanCustom = prefixCacheScope('custom');
    process.env[key] = '1';
    expect(prefixCacheScope()).toBe('devkit-guards:coverage-bypassed');
    expect(prefixCacheScope('custom')).toBe('custom:coverage-bypassed');
    expect(prefixCacheScope()).not.toBe(cleanDefault);
    expect(prefixCacheScope('custom')).not.toBe(cleanCustom);
  });

  it('composes with the review salt rather than replacing it', () => {
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_GUARDS = 'size';
    process.env.GUARD_COVERAGE_OK = '1';
    expect(prefixCacheScope()).toBe('devkit-guards:review:size:coverage-bypassed');
  });

  it('a falsey value leaves the scope unsalted (envFlag semantics)', () => {
    process.env.GUARD_COVERAGE_OK = '0';
    expect(prefixCacheScope()).toBeUndefined();
    expect(prefixCacheScope('custom')).toBe('custom');
  });
});
