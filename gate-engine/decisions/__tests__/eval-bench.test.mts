import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BenchAbort,
  cleanBenchEnv,
  compare,
  majorityVerdict,
  materializeFixture,
  mcnemarMidP,
  parseCasesText,
  runAlignmentBench,
  runDepthAudit,
  runDepthBench,
  runDetectBench,
  tally,
  wilson,
} from '../eval/bench.mts';

// ─── Pure metrics ─────────────────────────────────────────────────────────────────

describe('tally (multiclass metrics)', () => {
  const rows = [
    { expected: 'ALIGN', got: 'ALIGN' },
    { expected: 'ALIGN', got: 'CONTRADICT' },
    { expected: 'CONTRADICT', got: 'CONTRADICT' },
    { expected: 'UNCLEAR', got: 'NULL' }, // got-NULL: its own column, costs UNCLEAR recall
    { expected: 'NO-MATCH', got: 'NO-MATCH' }, // deterministic row: accuracy only
  ];
  const classes = ['ALIGN', 'CONTRADICT', 'UNCLEAR'];

  it('builds the confusion matrix with NULL and NO-MATCH as plain cells', () => {
    const t = tally(rows, classes);
    expect(t.confusion.ALIGN).toEqual({ ALIGN: 1, CONTRADICT: 1 });
    expect(t.confusion.UNCLEAR).toEqual({ NULL: 1 });
    expect(t.confusion['NO-MATCH']).toEqual({ 'NO-MATCH': 1 });
  });

  it('per-class precision/recall/F1 count cross-class leakage', () => {
    const t = tally(rows, classes);
    // CONTRADICT: tp=1, fp=1 (the misjudged ALIGN row), fn=0.
    expect(t.perClass.CONTRADICT).toMatchObject({ tp: 1, fp: 1, fn: 0 });
    expect(t.perClass.CONTRADICT.precision).toBeCloseTo(0.5);
    expect(t.perClass.CONTRADICT.recall).toBe(1);
    // UNCLEAR: the got-NULL row is a recall miss, not an error.
    expect(t.perClass.UNCLEAR).toMatchObject({ tp: 0, fn: 1 });
  });

  it('macro-F1 averages over the REAL classes only (NULL/NO-MATCH never join the mean)', () => {
    const t = tally(rows, classes);
    const expected = (t.perClass.ALIGN.f1 + t.perClass.CONTRADICT.f1 + t.perClass.UNCLEAR.f1) / 3;
    expect(t.macroF1).toBeCloseTo(expected);
  });

  it('a class absent from the rows scores 0 across the board (zero denominators)', () => {
    const t = tally([{ expected: 'PASS', got: 'PASS' }], ['PASS', 'THIN']);
    expect(t.perClass.THIN).toMatchObject({ precision: 0, recall: 0, f1: 0 });
    expect(t.accuracy).toBe(100);
  });
});

// ─── Env hygiene ──────────────────────────────────────────────────────────────────

describe('cleanBenchEnv', () => {
  it('strips every GUARD_*/FRINK_* and the GIT_* control vars; keeps BENCH_*', () => {
    const env = {
      GUARD_DECISION_NO_LLM: '1',
      GUARD_DECISIONS_DIR: '/elsewhere',
      FRINK_NO_LOG: '1',
      GIT_DIR: '/host/.git',
      GIT_WORK_TREE: '/host',
      BENCH_MODEL: 'sonnet',
      PATH: '/usr/bin',
    };
    const stripped = cleanBenchEnv(env);
    expect(stripped.sort()).toEqual([
      'FRINK_NO_LOG',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GUARD_DECISIONS_DIR',
      'GUARD_DECISION_NO_LLM',
    ]);
    expect(env.BENCH_MODEL).toBe('sonnet');
    expect(env.PATH).toBe('/usr/bin');
  });
});

// ─── Corpus parsing ───────────────────────────────────────────────────────────────

describe('parseCasesText', () => {
  it('parses jsonl, skipping blank lines', () => {
    expect(parseCasesText('{"id":"a"}\n\n{"id":"b"}\n')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

// ─── Fixture materializer ─────────────────────────────────────────────────────────

describe('materializeFixture', () => {
  const row = (base, staged) => ({ repo: { base, staged } });

  it('stages adds, modifications and deletions against a committed base (nested dirs included)', () => {
    const fx = materializeFixture(
      row(
        { 'src/repo/users.ts': 'export const a = 1;\n', 'src/api/h.ts': 'export const h = 1;\n' },
        {
          'src/api/h.ts': 'export const h = 2;\n', // modify
          'src/repo/orders.ts': 'export const o = 1;\n', // add (nested)
          'src/repo/users.ts': null, // staged deletion
        },
      ),
    );
    try {
      expect(fx.staged.sort()).toEqual(['src/api/h.ts', 'src/repo/orders.ts', 'src/repo/users.ts']);
      const status = execSync('git diff --cached --name-status', {
        cwd: fx.repo,
        encoding: 'utf8',
      });
      expect(status).toContain('D\tsrc/repo/users.ts');
      expect(status).toContain('A\tsrc/repo/orders.ts');
      expect(status).toContain('M\tsrc/api/h.ts');
    } finally {
      fx.cleanup();
    }
  });

  it('cleanup removes the whole tree', () => {
    const fx = materializeFixture(row({ 'a.ts': 'x\n' }, { 'a.ts': 'y\n' }));
    expect(existsSync(fx.repo)).toBe(true);
    fx.cleanup();
    expect(existsSync(fx.repo)).toBe(false);
  });

  it('never touches the host repo (the GIT_*-leak corruption class)', () => {
    const before = execSync('git status --porcelain', { encoding: 'utf8' });
    const fx = materializeFixture(row({ 'a.ts': 'x\n' }, { 'b.ts': 'y\n' }));
    fx.cleanup();
    expect(execSync('git status --porcelain', { encoding: 'utf8' })).toBe(before);
  });
});

// ─── Sub-bench behavior with a stubbed claude on PATH ─────────────────────────────
// Same PATH-stub pattern as check-alignment.test.mjs: the stub logs argv to CLAUDE_STUB_LOG so
// tests can assert exactly which judge calls were (not) made.

describe('sub-benches (stubbed claude)', () => {
  let dir;
  let savedPath;
  let log;
  const useStub = (script) => {
    const bin = join(dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'claude');
    writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\ncat >/dev/null\n${script}`);
    chmodSync(fake, 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
  };
  const calls = () => (existsSync(log) ? execSync(`cat "${log}"`, { encoding: 'utf8' }) : '');

  let savedNoLlm;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-bench-'));
    log = join(dir, 'calls.log');
    savedPath = process.env.PATH;
    // Cleared so an inherited NO_LLM knob can't null the judges; restored after (a leaked delete
    // would bleed into other suites sharing this vitest worker).
    savedNoLlm = [process.env.GUARD_DECISION_NO_LLM, process.env.FRINK_DECISION_NO_LLM];
    delete process.env.GUARD_DECISION_NO_LLM;
    delete process.env.FRINK_DECISION_NO_LLM;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    const [g, f] = savedNoLlm;
    if (g === undefined) delete process.env.GUARD_DECISION_NO_LLM;
    else process.env.GUARD_DECISION_NO_LLM = g;
    if (f === undefined) delete process.env.FRINK_DECISION_NO_LLM;
    else process.env.FRINK_DECISION_NO_LLM = f;
    rmSync(dir, { recursive: true, force: true });
  });

  const freeSkipRow = {
    id: 'fs',
    entries: [{ status: 'M', path: 'README.md', added: 1, deleted: 1 }],
    diff: '',
    expected: 'ROUTINE',
    category: 'free-skip',
  };
  const smellRow = {
    id: 'dep',
    entries: [{ status: 'M', path: 'package.json', added: 1, deleted: 1, depKeys: ['zod'] }],
    diff: 'diff --git a/package.json …',
    expected: 'ROUTINE',
    category: 'dep-bump',
  };
  const alignRow = (id, ruling, expected) => ({
    id,
    expected,
    target: { ruling, vision: 'v', scope: ['src/**'] },
    repo: {
      base: { 'src/a.ts': 'export const a = 1;\n' },
      staged: { 'src/a.ts': 'export const a = 2;\n' },
    },
  });

  it('detect: a no-smell row free-skips — zero claude spawns', () => {
    useStub('echo ROUTINE\n');
    const s = runDetectBench([freeSkipRow]);
    expect(s.results[0]).toMatchObject({ got: 'ROUTINE', ok: true, freeSkip: true });
    expect(calls()).toBe('');
  });

  it('detect: a smelled row runs the judge; ambiguous output scores NULL', () => {
    useStub('echo "ROUTINE but maybe a DECISION? no: ROUTINE DECISION"\n');
    const s = runDetectBench([smellRow], { model: 'haiku' });
    // Both words → parseVerdict says DECISION (safety bias), never NULL — pin the real parser.
    expect(s.results[0].got).toBe('DECISION');
    useStub('echo "who knows"\n');
    const s2 = runDetectBench([smellRow], { model: 'haiku' });
    expect(s2.results[0].got).toBe('NULL');
  });

  it('detect: expected-NULL rows count in display accuracy but not the scored (gated) accuracy', () => {
    useStub('echo ROUTINE\n');
    const nullRow = { ...smellRow, id: 'amb', expected: 'NULL' };
    const s = runDetectBench([smellRow, nullRow]);
    expect(s.total).toBe(2);
    expect(s.accuracy).toBe(50); // the NULL row "failed" on display…
    expect(s.accuracyScored).toBe(100); // …but is excluded from what --fail gates on
  });

  it('detect: a dark judge aborts with exit code 2 (cheap rows, sentry-style)', () => {
    useStub('exit 3\n');
    expect(() => runDetectBench([smellRow])).toThrow(BenchAbort);
    try {
      runDetectBench([smellRow]);
    } catch (e) {
      expect(e.code).toBe(2);
    }
  });

  it('alignment: cascade-off never calls the escalation model', () => {
    useStub('printf "VERDICT: CONTRADICT\\n"\n');
    const s = runAlignmentBench([alignRow('r1', 'stay generic', 'CONTRADICT')], {
      model: 'haiku',
      escalateModel: 'opus',
      cascade: false,
    });
    expect(s.results[0]).toMatchObject({ first: 'CONTRADICT', final: 'CONTRADICT' });
    expect(s.accuracy).toBe(100); // top-level accuracy present (the config-line print reads it)
    expect(calls()).not.toContain('--model opus');
  });

  it('alignment: one cascade-on run tallies BOTH configs — first-pass CONTRADICT, final ALIGN, escalation rate', () => {
    useStub(
      'case "$*" in\n  *"--model haiku"*) printf "VERDICT: CONTRADICT\\n";;\n' +
        '  *) printf "VERDICT: ALIGN\\n";;\nesac\n',
    );
    const s = runAlignmentBench([alignRow('r1', 'stay generic', 'ALIGN')], {
      model: 'haiku',
      escalateModel: 'opus',
      cascade: true,
    });
    expect(s.final.confusion.ALIGN).toEqual({ ALIGN: 1 }); // cascade rescued the false block
    expect(s.firstPass.confusion.ALIGN).toEqual({ CONTRADICT: 1 }); // haiku-alone would have blocked
    expect(s.escalationRate).toBe(1);
    expect(s.results[0].ok).toBe(true);
  });

  const depthRow = (id, expected) => ({
    id,
    block: `## Target · 2026-01-01 — t\n\n**Context:** c\n**Ruling:** r\n**Consequences:**\n- Positive: p\n- Negative: n\n**Vision-fit:** n/a`,
    expected,
  });

  it('depth: PASS/THIN scored via the real parser; ambiguous output is NULL', () => {
    useStub('echo PASS\n');
    const s = runDepthBench([depthRow('deep', 'PASS')]);
    expect(s.results[0]).toMatchObject({ got: 'PASS', ok: true });
    useStub('echo "PASS but THIN"\n');
    const s2 = runDepthBench([depthRow('amb', 'THIN')]);
    expect(s2.results[0].got).toBe('NULL');
  });

  it('depth: a dark judge aborts with exit code 2 (cheap rows, sentry-style)', () => {
    useStub('exit 3\n');
    try {
      runDepthBench([depthRow('down', 'PASS')]);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BenchAbort);
      expect(e.code).toBe(2);
    }
  });

  it("depth-audit: judges the cwd repo's real records and flags missing Revisit-when", () => {
    // The audit reads <cwd>/docs/decisions — point cwd at a fixture repo for the test.
    const auditCwd = mkdtempSync(join(tmpdir(), 'eval-audit-'));
    mkdirSync(join(auditCwd, 'docs', 'decisions'), { recursive: true });
    const record = (slug, extra = '') =>
      `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n# ${slug}\n\n## Target · 2026-01-01 — r\n\n**Context:** c\n**Ruling:** r\n${extra}`;
    writeFileSync(join(auditCwd, 'docs', 'decisions', 'bare.md'), record('bare'));
    writeFileSync(
      join(auditCwd, 'docs', 'decisions', 'expiring.md'),
      record('expiring', '**Revisit-when:** cost drops below $1\n'),
    );
    writeFileSync(join(auditCwd, 'docs', 'decisions', 'INDEX.md'), '# Decision Index\n');
    useStub('echo PASS\n');
    const lines = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
    const prevCwd = process.cwd();
    try {
      process.chdir(auditCwd);
      const counts = runDepthAudit({ model: 'haiku' });
      expect(counts).toEqual({ PASS: 2, THIN: 0, NULL: 0 });
    } finally {
      process.chdir(prevCwd);
      logSpy.mockRestore();
      rmSync(auditCwd, { recursive: true, force: true });
    }
    const out = lines.join('\n');
    expect(out).toMatch(/bare\s+PASS\s+\(no Revisit-when\)/); // the deterministic 100-year marker
    expect(out).not.toMatch(/expiring\s+PASS\s+\(no Revisit-when\)/); // present → no flag
    expect(out).not.toContain('INDEX'); // the index is never judged
  });

  it('alignment: a NO-MATCH row is free — no fixture judging, scored deterministically', () => {
    useStub('printf "VERDICT: ALIGN\\n"\n');
    const row = alignRow('nm', 'stay generic', 'NO-MATCH');
    row.target.scope = ['lib/**']; // staged src/a.ts never matches
    const s = runAlignmentBench([row], { cascade: true });
    expect(s.results[0]).toMatchObject({ final: 'NO-MATCH', ok: true });
    expect(calls()).toBe('');
  });

  // 3 fixture repos + 3 stub judges — legitimately slow under full-suite load, hence the budget.
  it('alignment: a partial outage scores that row NULL and continues; all-outage aborts (2)', {
    timeout: 30000,
  }, () => {
    // The stub crashes only for the target whose ruling mentions "flaky".
    useStub(
      'case "$*" in\n  *"flaky ruling"*) exit 3;;\n  *) printf "VERDICT: ALIGN\\n";;\nesac\n',
    );
    const s = runAlignmentBench(
      [alignRow('ok', 'stay generic', 'ALIGN'), alignRow('down', 'flaky ruling', 'ALIGN')],
      { cascade: false },
    );
    expect(s.outages).toBe(1);
    expect(s.results.find((r) => r.id === 'down').final).toBe('NULL');
    useStub('exit 3\n');
    expect(() =>
      runAlignmentBench([alignRow('all-down', 'stay generic', 'ALIGN')], { cascade: false }),
    ).toThrow(BenchAbort);
  });
});

// ─── Small-n statistics ───────────────────────────────────────────────────────────

describe('wilson', () => {
  it('brackets the point estimate and stays inside [0,1]', () => {
    const ci = wilson(14, 16);
    expect(ci.lo).toBeGreaterThan(0.6);
    expect(ci.lo).toBeLessThan(14 / 16);
    expect(ci.hi).toBeGreaterThan(14 / 16);
    expect(ci.hi).toBeLessThanOrEqual(1);
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(10, 10).hi).toBe(1);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it('is honestly wide at bench-sized n — the interval IS the point', () => {
    const { lo, hi } = wilson(12, 15); // 80% accuracy on 15 rows
    expect(hi - lo).toBeGreaterThan(0.3); // a >30pp band: nothing at this n resolves small deltas
  });
});

describe('mcnemarMidP', () => {
  it('no discordant pairs → p=1; symmetric flips are never significant', () => {
    expect(mcnemarMidP(0, 0)).toBe(1);
    expect(mcnemarMidP(3, 3)).toBeGreaterThan(0.5);
  });

  it('a single one-directional flip is judge noise, ~5+ is significant', () => {
    expect(mcnemarMidP(1, 0)).toBeGreaterThan(0.05); // the observed haiku flip must NOT trip the gate
    expect(mcnemarMidP(5, 1)).toBeGreaterThan(0.05); // report's worked example: p≈.219
    expect(mcnemarMidP(6, 0)).toBeLessThan(0.05);
    expect(mcnemarMidP(0, 6)).toBeLessThan(0.05); // significance is directionless; direction gates in compare()
  });
});

describe('majorityVerdict', () => {
  it('votes majority, flags non-unanimous, breaks full ties to NULL (fail-safe)', () => {
    expect(majorityVerdict(['ROUTINE', 'ROUTINE', 'ROUTINE'])).toEqual({
      verdict: 'ROUTINE',
      unanimous: true,
    });
    expect(majorityVerdict(['ROUTINE', 'DECISION', 'ROUTINE'])).toEqual({
      verdict: 'ROUTINE',
      unanimous: false,
    });
    expect(majorityVerdict(['ROUTINE', 'DECISION', 'NULL']).verdict).toBe('NULL');
  });
});

// ─── Baseline comparison (flip-table gate) ────────────────────────────────────────

describe('compare', () => {
  // A summary/baseline pair builder: metrics healthy by default; rows drive the flip table.
  const detectSummary = ({ recall = 0.9, rows = {} } = {}) => ({
    model: 'haiku',
    decision: { recall },
    accuracyScored: 90,
    rows,
  });
  const row = (ok, stable = true, expected = 'ROUTINE') => ({ got: 'x', ok, stable, expected });

  it('aggregate metric drops alone NEVER fail — they print as informational', () => {
    const r = compare('detect', detectSummary({ recall: 0.8 }), detectSummary({ recall: 1.0 }));
    expect(r.regressed).toBe(false);
    expect(r.lines.some((l) => l.includes('informational'))).toBe(true);
  });

  it('a hard floor breach fails regardless of flip statistics', () => {
    const r = compare('detect', detectSummary({ recall: 0.5 }), detectSummary({ recall: 0.9 }));
    expect(r.regressed).toBe(true);
    expect(r.lines.some((l) => l.includes('FLOOR BREACH'))).toBe(true);
  });

  it('one stable flip warns with the row id but does not fail (noise at this n)', () => {
    const base = detectSummary({ rows: { a: row(true), b: row(true) } });
    const cur = detectSummary({ rows: { a: row(false), b: row(true) } });
    const r = compare('detect', cur, base);
    expect(r.regressed).toBe(false);
    expect(r.lines.some((l) => l.includes('regressed [a]'))).toBe(true);
    expect(r.lines.some((l) => l.includes('cannot distinguish'))).toBe(true); // the MDE line
  });

  it('6+ one-directional stable flips are significant → fail; symmetric flips are not', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const base = detectSummary({ rows: Object.fromEntries(ids.map((i) => [i, row(true)])) });
    const cur = detectSummary({ rows: Object.fromEntries(ids.map((i) => [i, row(false)])) });
    expect(compare('detect', cur, base).regressed).toBe(true);
    // Same 6 flips but 3 in each direction → churn, not regression.
    const mixedBase = detectSummary({
      rows: Object.fromEntries(ids.map((i, k) => [i, row(k < 3)])),
    });
    const mixedCur = detectSummary({
      rows: Object.fromEntries(ids.map((i, k) => [i, row(k >= 3)])),
    });
    expect(compare('detect', mixedCur, mixedBase).regressed).toBe(false);
  });

  it('unstable flips are instability, not regression — reported separately, never counted', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const base = detectSummary({ rows: Object.fromEntries(ids.map((i) => [i, row(true)])) });
    const cur = detectSummary({
      rows: Object.fromEntries(ids.map((i) => [i, row(false, false)])), // all flips non-unanimous
    });
    const r = compare('detect', cur, base);
    expect(r.regressed).toBe(false);
    expect(r.lines.some((l) => l.includes('unstable rows'))).toBe(true);
  });

  it('expected-NULL rows stay out of the flip table', () => {
    const base = detectSummary({ rows: { amb: row(true, true, 'NULL') } });
    const cur = detectSummary({ rows: { amb: row(false, true, 'NULL') } });
    expect(compare('detect', cur, base).lines.some((l) => l.includes('flips'))).toBe(false);
  });

  it('skips (never lies) on config, gate-hash or corpus-hash mismatch, or missing section', () => {
    const r = compare('detect', detectSummary({ recall: 0.5 }), {
      ...detectSummary({ recall: 0.9 }),
      model: 'sonnet',
    });
    expect(r.regressed).toBe(false);
    expect(r.lines[0]).toContain('baseline config differs');
    const h = compare(
      'detect',
      { ...detectSummary({ recall: 0.5 }), gateHash: 'aaa' },
      { ...detectSummary({ recall: 0.9 }), gateHash: 'bbb' },
    );
    expect(h.regressed).toBe(false);
    expect(h.lines[0]).toContain('gate code changed');
    const c = compare(
      'detect',
      { ...detectSummary({ recall: 0.5 }), corpusHash: 'aaa' },
      { ...detectSummary({ recall: 0.9 }), corpusHash: 'bbb' },
    );
    expect(c.lines[0]).toContain('corpus changed');
    expect(compare('detect', detectSummary({}), undefined).regressed).toBe(false);
  });

  it('alignment: outages skip the comparison; floor checks the scored config', () => {
    const s = (cascade, finalP, firstP, outages = 0) => ({
      model: 'haiku',
      escalateModel: 'opus',
      cascade,
      outages,
      final: { contradict: { precision: finalP }, macroF1: 0.8 },
      firstPass: { contradict: { precision: firstP }, macroF1: 0.8 },
    });
    expect(compare('alignment', s(true, 0.5, 0.9), s(true, 0.9, 0.9)).regressed).toBe(true); // floor
    expect(compare('alignment', s(false, 0.9, 0.5), s(false, 0.9, 0.9)).regressed).toBe(true); // cascade-off gates firstPass
    const o = compare('alignment', s(true, 0.5, 0.9, 2), s(true, 0.9, 0.9));
    expect(o.regressed).toBe(false);
    expect(o.lines[0]).toContain('outage');
  });
});
