/** Holdout isolation applies to a whole incident family, including links through existing rows. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BenchAbort } from '../../../../decisions/eval/bench.mts';
import { BENCH_REVIEWERS } from '../bench.mts';
import { assertHoldoutGroups, lintRows, loadRows, readCorpusRows } from '../corpus.mts';
import { auditSuite } from '../corpus/audit.mts';
import { assignHoldout, packByMax } from '../finalize.mts';

const fixtureDirs: string[] = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const row = (id: string, extra = {}) => ({
  id,
  reviewer: 'correctness-reviewer',
  expected: 'PASS',
  note: 'A synthetic row for the holdout contract.',
  repo: { base: {}, staged: {} },
  ...extra,
});

function writeCorpus(rows: ReturnType<typeof row>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-holdout-'));
  fixtureDirs.push(dir);
  const file = join(dir, 'cases-correctness.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  return file;
}

describe('holdout group validation', () => {
  it('rejects an empty caseId before it can be treated as an unlinked row', () => {
    const rows = [
      row('bug', { caseId: '', holdout: true }),
      row('repair', { caseId: '', holdout: false }),
    ];
    expect(() => lintRows(rows, 'correctness-reviewer')).toThrow(
      /caseId must be a non-empty string/,
    );
  });

  it('preserves a named family through structural validation, assignment and admission', () => {
    const rows = lintRows(
      [row('bug', { caseId: 'incident' }), row('repair', { caseId: 'incident' })],
      'correctness-reviewer',
    );
    assignHoldout(rows);
    expect(() => assertHoldoutGroups(rows, 'correctness-reviewer')).not.toThrow();
    expect(packByMax(rows, 1)).toEqual({ accepted: [], deferred: rows });
    expect(packByMax(rows, 2)).toEqual({ accepted: rows, deferred: [] });
  });

  it.each([true, false])('allows a caseId pair entirely on holdout=%s', (holdout) => {
    const rows = [
      row('bug', { caseId: 'incident', holdout }),
      row('repair', { caseId: 'incident', holdout }),
    ];
    expect(() => assertHoldoutGroups(rows, 'correctness-reviewer')).not.toThrow();
  });

  it('treats absent holdout and explicit false as the same dev split', () => {
    const rows = [row('bug'), row('repair', { variantOf: 'bug', holdout: false })];
    expect(() => assertHoldoutGroups(rows, 'correctness-reviewer')).not.toThrow();
  });

  it.each([
    [row('bug', { caseId: 'incident', holdout: true }), row('repair', { caseId: 'incident' })],
    [
      row('bug', { holdout: true }),
      row('partial', { variantOf: 'bug', holdout: true }),
      row('repair', { variantOf: 'partial', holdout: false }),
    ],
    [
      row('bug', { caseId: 'incident', holdout: true }),
      row('partial', { caseId: 'incident', holdout: true }),
      row('repair', { variantOf: 'partial', holdout: false }),
    ],
  ])('refuses mixed splits across direct and transitive family links (%#)', (...rows) => {
    const check = () => assertHoldoutGroups(rows, 'correctness-reviewer');
    expect(check).toThrow(BenchAbort);
    expect(check).toThrow(expect.objectContaining({ code: 2 }));
    expect(check).toThrow(/correctness-reviewer/);
    expect(check).toThrow(/holdout/i);
    expect(check).toThrow(/bug/);
    expect(check).toThrow(/repair/);
  });

  it('allows unrelated rows on opposite sides', () => {
    expect(() =>
      assertHoldoutGroups([row('dev'), row('test', { holdout: true })], 'correctness-reviewer'),
    ).not.toThrow();
  });

  it.each(['false', 'true', 0, 1, null, [], {}])(
    'rejects non-boolean holdout=%j structurally',
    (holdout) => {
      expect(() => lintRows([row('bad', { holdout })], 'correctness-reviewer')).toThrow(/holdout/);
    },
  );

  it.each([undefined, false, true])(
    'accepts optional boolean holdout=%s structurally',
    (holdout) => {
      expect(() => lintRows([row('valid', { holdout })], 'correctness-reviewer')).not.toThrow();
    },
  );
});

describe('assignment with established corpus splits', () => {
  it.each([true, false, undefined])(
    'a lexically earlier sibling inherits existing holdout=%s',
    (holdout) => {
      const existing = [row('z-existing', { holdout })];
      const original = structuredClone(existing);
      const fresh = [row('a-incoming', { variantOf: 'z-existing', holdout: !holdout })];
      assignHoldout(fresh, existing);
      expect(fresh[0].holdout).toBe(!!holdout);
      expect(existing).toEqual(original);
    },
  );

  it('refuses an incoming bridge between opposite existing anchors and leaves the corpus untouched', () => {
    const existing = [
      row('held', { caseId: 'held-incident', holdout: true }),
      row('dev', { caseId: 'dev-incident', holdout: false }),
    ];
    const original = structuredClone(existing);
    const fresh = [
      row('bridge-a', { caseId: 'held-incident' }),
      row('bridge-b', { variantOf: 'bridge-a', caseId: 'dev-incident' }),
    ];
    const assign = () => assignHoldout(fresh, existing);
    expect(assign).toThrow(BenchAbort);
    expect(assign).toThrow(expect.objectContaining({ code: 2 }));
    expect(assign).toThrow(/pair group bridge-a/);
    expect(assign).toThrow(/opposite sides of the holdout boundary/);
    expect(existing).toEqual(original);
  });

  it('accepts a bridge between agreeing existing anchors', () => {
    const existing = [
      row('left', { caseId: 'left-incident', holdout: true }),
      row('right', { caseId: 'right-incident', holdout: true }),
    ];
    const original = structuredClone(existing);
    const fresh = [
      row('bridge-a', { caseId: 'left-incident' }),
      row('bridge-b', { variantOf: 'bridge-a', caseId: 'right-incident' }),
    ];
    assignHoldout(fresh, existing);
    expect(fresh.map((r) => r.holdout)).toEqual([true, true]);
    expect(existing).toEqual(original);
    expect(() =>
      assertHoldoutGroups([...existing, ...fresh], 'correctness-reviewer'),
    ).not.toThrow();
  });
});

describe('whole-family append budgets', () => {
  it('defers a variantOf chain as a whole when the budget cannot fit it', () => {
    const family = [
      row('a-bug'),
      row('b-partial', { variantOf: 'a-bug' }),
      row('c-repair', { variantOf: 'b-partial' }),
    ];
    const lone = row('z-unrelated');
    expect(packByMax([...family, lone], 2)).toEqual({ accepted: [lone], deferred: family });
    expect(packByMax([...family, lone], 3)).toEqual({ accepted: family, deferred: [lone] });
  });

  it('keeps mixed caseId and variantOf relations in the same admission batch', () => {
    const family = [
      row('a-bug', { caseId: 'incident' }),
      row('b-partial', { caseId: 'incident' }),
      row('c-repair', { variantOf: 'b-partial' }),
    ];
    expect(packByMax(family, 2)).toEqual({ accepted: [], deferred: family });
  });

  it('joins fresh siblings through existing rows without charging existing rows to the budget', () => {
    const existing = [
      row('old-a', { caseId: 'incident', holdout: true }),
      row('old-b', { caseId: 'incident', holdout: true }),
    ];
    const original = structuredClone(existing);
    const fresh = [row('a-new', { variantOf: 'old-a' }), row('b-new', { variantOf: 'old-b' })];
    expect(packByMax(fresh, 1, existing)).toEqual({ accepted: [], deferred: fresh });
    expect(packByMax(fresh, 2, existing)).toEqual({ accepted: fresh, deferred: [] });
    expect(existing).toEqual(original);
  });

  it('preserves an unlimited batch and defers every row with a zero budget', () => {
    const fresh = [row('a'), row('b', { variantOf: 'a' })];
    expect(packByMax(fresh, null)).toEqual({ accepted: fresh, deferred: [] });
    expect(packByMax(fresh, 0)).toEqual({ accepted: [], deferred: fresh });
  });
});

describe('full-corpus preflight', () => {
  const correctness = BENCH_REVIEWERS.find((r) => r.name === 'correctness-reviewer');

  it('lets the diagnostic audit report a leaking corpus that benchmark loading refuses', () => {
    const rows = [
      row('bug', { caseId: 'incident', holdout: true }),
      row('repair', { caseId: 'incident', holdout: false }),
    ];
    const corpusFile = writeCorpus(rows);
    const report = auditSuite(correctness, readCorpusRows(correctness, corpusFile), new Map());
    expect(report.rows).toBe(2);
    expect(report.pairs.straddlingHoldout).toBe(1);
    expect(() => loadRows(correctness, { corpusFile })).toThrow(/straddles the holdout boundary/);
  });

  it.each([{ dev: true }, { only: 'safe' }, { dev: true, only: 'safe' }])(
    'refuses a leaking corpus before applying filter %j',
    (filter) => {
      const rows = [
        row('safe'),
        row('bug', { caseId: 'incident', holdout: true }),
        row('repair', { caseId: 'incident', holdout: false }),
        ...Array.from({ length: 3 }, (_, i) => row(`holdout-pass-${i}`, { holdout: true })),
        ...Array.from({ length: 3 }, (_, i) =>
          row(`holdout-fail-${i}`, { expected: 'FAIL', expectItems: ['state'], holdout: true }),
        ),
      ];
      const corpusFile = writeCorpus(rows);
      expect(() => loadRows(correctness, { ...filter, corpusFile })).toThrow(/holdout/i);
    },
  );

  it.each(BENCH_REVIEWERS.map((r) => [r.name, r]))(
    'keeps every committed family together in %s',
    (_name, reviewer) => {
      const rows = loadRows(reviewer);
      expect(rows.length).toBeGreaterThan(0);
      expect(() => assertHoldoutGroups(rows, reviewer.name)).not.toThrow();
    },
  );
});
