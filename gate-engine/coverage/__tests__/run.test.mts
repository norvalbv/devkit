/**
 * The coverage gate (gate-engine/coverage/run.mts). Two load-bearing properties: it is FAIL-CLOSED
 * (a selected gate with no coverage artifact exits 1 — never a silent pass), and it enforces only the
 * threshold KEYS a consumer configured. Two bypasses, both explicit: `coverage: false` (repo-wide)
 * and GUARD_COVERAGE_OK / GUARD_NO_COVERAGE (per-run operator assertion). Also covers the
 * istanbul/V8 aggregation math (statements/functions/branches/lines) in computePercentages.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { computePercentages, runCoverage } from '../run.mts';

let roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-gate-'));
  roots.push(root);
  return root;
};

// Every spelling the bypass answers to, incl. the FRINK_* back-compat aliases envVar() falls back to.
// Snapshot + restore around each test: a leaked GUARD_COVERAGE_OK would turn every fail-closed
// assertion in this file into a false green — the exact defect the gate exists to prevent.
const ENV_KEYS = [
  'GUARD_COVERAGE_OK',
  'GUARD_NO_COVERAGE',
  'FRINK_COVERAGE_OK',
  'FRINK_NO_COVERAGE',
];
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
  vi.restoreAllMocks();
});

const writeConfig = (root: string, cfg: object) =>
  writeFileSync(join(root, 'guard.config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
const writeCoverage = (root: string, cov: object) => {
  mkdirSync(join(root, 'coverage'), { recursive: true });
  writeFileSync(join(root, 'coverage', 'coverage-final.json'), JSON.stringify(cov));
};
const spy = () => ({
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  err: vi.spyOn(console, 'error').mockImplementation(() => {}),
});
const text = (m: ReturnType<typeof vi.spyOn>) => m.mock.calls.flat().join('\n');

// One istanbul file entry: 2 statements (1 covered → 50%), 1 function (covered → 100%),
// 1 branch with 2 arms (1 covered → 50%), 2 lines (line 1 covered, line 2 not → 50%).
const FILE = {
  statementMap: { '0': { start: { line: 1 } }, '1': { start: { line: 2 } } },
  s: { '0': 3, '1': 0 },
  f: { '0': 1 },
  b: { '0': [1, 0] },
};
const COV = { '/x/a.ts': FILE };

describe('computePercentages — istanbul/V8 aggregation', () => {
  it('computes statements/functions/branches/lines from a file entry', () => {
    expect(computePercentages(COV)).toEqual({
      statements: 50,
      functions: 100,
      branches: 50,
      lines: 50,
    });
  });

  it('an entry with no counts is 100% (nothing to cover, no divide-by-zero)', () => {
    expect(computePercentages({ '/x/empty.ts': {} })).toEqual({
      statements: 100,
      functions: 100,
      branches: 100,
      lines: 100,
    });
  });

  it('aggregates across files (a fully-covered second file lifts the total)', () => {
    const full = { statementMap: { '0': { start: { line: 1 } } }, s: { '0': 1 }, f: {}, b: {} };
    // file A: 1/2 statements; file B: 1/1 → 2/3 ≈ 66.7%
    expect(computePercentages({ '/x/a.ts': FILE, '/x/b.ts': full }).statements).toBeCloseTo(
      66.7,
      1,
    );
  });

  it('THROWS on a non-object root or a null/array/non-object entry (parseable but malformed)', () => {
    expect(() => computePercentages(null)).toThrow();
    expect(() => computePercentages([FILE])).toThrow();
    expect(() => computePercentages({ '/x/a.ts': null })).toThrow();
    expect(() => computePercentages({ '/x/a.ts': [1, 2] })).toThrow();
    expect(() => computePercentages({ '/x/a.ts': 42 })).toThrow();
  });

  it('THROWS on a non-array branch counter', () => {
    expect(() => computePercentages({ '/x/a.ts': { b: { '0': 5 } } })).toThrow();
  });
});

describe('runCoverage — fail-closed gate', () => {
  it('coverage: false → bypass (exit 0) with a note', () => {
    const root = makeRoot();
    writeConfig(root, { coverage: false });
    const s = spy();
    expect(runCoverage(root)).toBe(0);
    expect(text(s.log)).toMatch(/bypassed/i);
  });

  it('no config + no coverage artifact → FAIL HARD (exit 1), never a silent pass', () => {
    const root = makeRoot(); // no guard.config.json → default {} (active-strict)
    const s = spy();
    expect(runCoverage(root)).toBe(1);
    expect(text(s.err)).toMatch(/no coverage data|coverage-final\.json absent/i);
    expect(text(s.err)).toMatch(/test:run:coverage/);
  });

  it('default {} + artifact present, no thresholds → PASS (presence is enough)', () => {
    const root = makeRoot();
    writeCoverage(root, COV);
    const s = spy();
    expect(runCoverage(root)).toBe(0);
    expect(text(s.log)).toMatch(/passed/i);
  });

  it('thresholds met → PASS', () => {
    const root = makeRoot();
    writeConfig(root, { coverage: { statements: 40, functions: 90 } });
    writeCoverage(root, COV);
    expect(runCoverage(root)).toBe(0);
  });

  it('a statement shortfall → FAIL (exit 1), naming the metric and the floor', () => {
    const root = makeRoot();
    writeConfig(root, { coverage: { statements: 60 } });
    writeCoverage(root, COV);
    const s = spy();
    expect(runCoverage(root)).toBe(1);
    expect(text(s.err)).toMatch(/statements: 50% \(min 60%\)/);
  });

  it('enforces ONLY the configured keys — a branch floor fails while functions pass', () => {
    const root = makeRoot();
    writeConfig(root, { coverage: { functions: 100, branches: 60 } });
    writeCoverage(root, COV);
    const s = spy();
    expect(runCoverage(root)).toBe(1);
    expect(text(s.err)).toMatch(/branches: 50% \(min 60%\)/);
    expect(text(s.err)).not.toMatch(/functions:/); // functions met → not listed
  });

  it('artifact present but unparseable JSON → FAIL (corrupt data is not verification)', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'coverage'), { recursive: true });
    writeFileSync(join(root, 'coverage', 'coverage-final.json'), '{ not json');
    const s = spy();
    expect(runCoverage(root)).toBe(1);
    expect(text(s.err)).toMatch(/not valid coverage data/i);
  });

  it('parseable but malformed shape (garbage entry) → FAIL, never a silent 100% pass', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'coverage'), { recursive: true });
    writeFileSync(join(root, 'coverage', 'coverage-final.json'), JSON.stringify({ '/x/a.ts': 42 }));
    const s = spy();
    expect(runCoverage(root)).toBe(1);
    expect(text(s.err)).toMatch(/not valid coverage data/i);
    expect(text(s.log)).not.toMatch(/passed/i);
  });

  it('parseable but a null entry → FAIL cleanly, no uncaught crash', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'coverage'), { recursive: true });
    writeFileSync(
      join(root, 'coverage', 'coverage-final.json'),
      JSON.stringify({ '/x/a.ts': null }),
    );
    expect(runCoverage(root)).toBe(1);
  });

  // Every blocking arm must NAME the per-run escape. A gate that blocks without printing its own
  // knob is what cornered six field ship attempts into fixing out-of-scope debt or leaving devkit.
  it.each([
    ['absent artifact', (root: string) => writeConfig(root, {})],
    [
      'malformed artifact',
      (root: string) => {
        mkdirSync(join(root, 'coverage'), { recursive: true });
        writeFileSync(join(root, 'coverage', 'coverage-final.json'), '{ not json');
      },
    ],
    [
      'threshold shortfall',
      (root: string) => {
        writeConfig(root, { coverage: { statements: 60 } });
        writeCoverage(root, COV);
      },
    ],
  ])('the %s failure prints the GUARD_COVERAGE_OK remedy', (_label, setup) => {
    const root = makeRoot();
    setup(root);
    const s = spy();
    expect(runCoverage(root)).toBe(1);
    expect(text(s.err)).toMatch(/export GUARD_COVERAGE_OK=1/);
  });

  it('the absent-artifact arm warns that a local "coverage": false is ignored by ship', () => {
    // The pre-fix text advised `coverage: false` unconditionally; under ship that silently no-ops
    // (the worktree reads the COMMITTED config), which burned a user-approved bypass in the field.
    const root = makeRoot();
    const s = spy();
    expect(runCoverage(root)).toBe(1);
    expect(text(s.err)).toMatch(/reads that file from the COMMITTED tree/);
  });
});

describe('runCoverage — GUARD_COVERAGE_OK per-run bypass', () => {
  it.each([
    'GUARD_COVERAGE_OK',
    'GUARD_NO_COVERAGE',
  ])('%s=1 + NO artifact → exit 0 (the field case: base debt, absent coverage data)', (key) => {
    const root = makeRoot();
    process.env[key] = '1';
    const s = spy();
    expect(runCoverage(root)).toBe(0);
    expect(text(s.log)).toMatch(/BYPASSED/);
    // Must NOT read as the repo-wide opt-out — a log reader has to tell the two apart.
    expect(text(s.log)).not.toMatch(/guard\.config\.json/);
  });

  it('bypasses a real threshold shortfall too', () => {
    const root = makeRoot();
    writeConfig(root, { coverage: { statements: 99 } });
    writeCoverage(root, COV);
    process.env.GUARD_COVERAGE_OK = '1';
    expect(runCoverage(root)).toBe(0);
  });

  it('is read BEFORE resolveGuardConfig — a malformed guard.config.json cannot defeat it', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'guard.config.json'), '{ not json');
    expect(() => runCoverage(root)).toThrow(); // control: without the flag the bad config throws
    process.env.GUARD_COVERAGE_OK = '1';
    expect(runCoverage(root)).toBe(0);
  });

  // envFlag's falsey set. `=0` must NOT bypass, or a habitual `GUARD_COVERAGE_OK=0` reads as "off"
  // to a human while silently disabling the gate.
  it.each(['0', 'false', 'no', ''])('=%s does NOT bypass — the gate still blocks', (v) => {
    const root = makeRoot();
    process.env.GUARD_COVERAGE_OK = v;
    expect(runCoverage(root)).toBe(1);
  });

  it('unset → the fail-closed contract is untouched', () => {
    const root = makeRoot();
    expect(runCoverage(root)).toBe(1);
  });
});

describe('resolveGuardConfig — coverage field', () => {
  it('absent key resolves to the active-strict {} default', () => {
    const root = makeRoot();
    expect(resolveGuardConfig(root).coverage).toEqual({});
  });

  it('literal false is preserved (the only opt-out)', () => {
    const root = makeRoot();
    writeConfig(root, { coverage: false });
    expect(resolveGuardConfig(root).coverage).toBe(false);
  });

  it('a threshold object is passed through', () => {
    const root = makeRoot();
    writeConfig(root, { coverage: { statements: 62, functions: 59 } });
    expect(resolveGuardConfig(root).coverage).toEqual({ statements: 62, functions: 59 });
  });

  it('a garbage value (array) falls back to the {} default, never disabling the gate', () => {
    const root = makeRoot();
    writeConfig(root, { coverage: [1, 2] });
    expect(resolveGuardConfig(root).coverage).toEqual({});
  });
});
