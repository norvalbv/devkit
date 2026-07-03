import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDeterministic, selectedIds } from '../run.mjs';

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

describe('selectedIds', () => {
  it('intersects components.guards with the deterministic set in fixed order, dropping AI ids', () => {
    const d = repo(['clone', 'size', 'review', 'decisions']); // review/decisions are AI (fail-fast)
    expect(selectedIds(d)).toEqual(['size', 'clone']);
  });
});
