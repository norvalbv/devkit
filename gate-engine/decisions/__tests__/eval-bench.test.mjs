import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BenchAbort,
  cleanBenchEnv,
  compare,
  materializeFixture,
  parseCasesText,
  runAlignmentBench,
  runDepthAudit,
  runDepthBench,
  runDetectBench,
  tally,
} from '../eval/bench.mjs';

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

// ─── Baseline comparison ──────────────────────────────────────────────────────────

describe('compare', () => {
  const detectSummary = (recall, acc) => ({
    model: 'haiku',
    decision: { recall },
    accuracyScored: acc,
  });

  it('regresses only when a compared metric drops beyond epsilon', () => {
    expect(compare('detect', detectSummary(0.9, 90), detectSummary(0.9, 90)).regressed).toBe(false);
    expect(
      compare('detect', detectSummary(0.9 - 1e-12, 90), detectSummary(0.9, 90)).regressed,
    ).toBe(false); // epsilon tolerance
    expect(compare('detect', detectSummary(0.8, 90), detectSummary(0.9, 90)).regressed).toBe(true);
    expect(compare('detect', detectSummary(0.9, 85), detectSummary(0.9, 90)).regressed).toBe(true);
    expect(compare('detect', detectSummary(0.95, 95), detectSummary(0.9, 90)).regressed).toBe(
      false,
    );
  });

  it('skips (never lies) when the baseline config differs or the section is missing', () => {
    const r = compare('detect', detectSummary(0.5, 50), {
      ...detectSummary(0.9, 90),
      model: 'sonnet',
    });
    expect(r.regressed).toBe(false);
    expect(r.lines[0]).toContain('baseline config differs');
    expect(compare('detect', detectSummary(0.5, 50), undefined).regressed).toBe(false);
  });

  it('alignment compares the scored config: cascade-on gates on final, cascade-off on firstPass', () => {
    const s = (cascade, finalP, firstP) => ({
      model: 'haiku',
      escalateModel: 'opus',
      cascade,
      final: { contradict: { precision: finalP }, macroF1: 0.8 },
      firstPass: { contradict: { precision: firstP }, macroF1: 0.8 },
    });
    // final regressed, firstPass fine → cascade-on run fails, cascade-off run passes.
    expect(compare('alignment', s(true, 0.5, 0.9), s(true, 0.9, 0.9)).regressed).toBe(true);
    expect(compare('alignment', s(false, 0.5, 0.9), s(false, 0.9, 0.9)).regressed).toBe(false);
  });
});
