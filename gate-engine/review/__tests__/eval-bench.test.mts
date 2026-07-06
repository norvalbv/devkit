// completeness-eval unit tests — every metric, parser, and harness path that can be exercised
// without a claude call. The bench imports the gate (runCompleteness) and drives it through the
// same injectable-exec seam the gate's own tests use, so the fixture/free-skip/outage machinery
// is testable end-to-end with stub judges.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScopedTargets, matchScope } from '../../decisions/check-alignment.mts';
import { BenchAbort, parseCasesText } from '../../decisions/eval/bench.mts';
import {
  type BenchSummary,
  CEILING_FALSE_FLAG,
  type CompletenessCase,
  compareCompleteness,
  FLOOR_GAP_RECALL,
  lintCases,
  matcherAudit,
  materializeCompletenessFixture,
  runCase,
  summarize,
  variantConsistency,
} from '../eval/bench.mts';
import {
  buildDecoyPrompt,
  buildGoldPrompt,
  kappa,
  mapPool,
  parseFindings,
  parseSlotReply,
  runMatcher,
  scoreCase,
  voteSlot,
} from '../eval/matcher.mts';

// ─── Shared fixtures ──────────────────────────────────────────────────────────────

const DECOY_TARGET_MD = `---
slug: shortcuts-global-only
created: 2026-01-01
---

# shortcuts-global-only

## Target · 2026-01-01 — shortcuts are global, per-user customization out of scope

**Context:** Per-user shortcut maps were prototyped and cut; sync cost dwarfed the win.
**Ruling:** Keyboard shortcuts are global. Per-user customization is explicitly out of scope.
**Consequences:**
- Positive: one registry, no sync surface.
- Negative: power users cannot rebind.
**Scope:** src/**
**Source:** manual
`;

function makeRow(overrides: Partial<CompletenessCase> = {}): CompletenessCase {
  return {
    id: 'test-registration-gap',
    category: 'registration-gap',
    difficulty: 'clear',
    provenance: 'authored',
    note: 'new action must appear in the help menu; customization decoy is recorded',
    message: 'feat: add export-csv shortcut action',
    repo: {
      base: {
        'src/registry.ts': 'export const ACTIONS = ["copy"];\n',
        'src/help-menu.ts': 'export const HELP = ["copy"];\n',
        'docs/decisions/shortcuts-global-only.md': DECOY_TARGET_MD,
      },
      staged: { 'src/registry.ts': 'export const ACTIONS = ["copy", "export-csv"];\n' },
    },
    gold: [
      { id: 'g1', severity: 'IMPORTANT', desc: 'export-csv missing from help menu', paths: ['src/help-menu.ts'] },
    ],
    decoys: [
      {
        id: 'd1',
        kind: 'recorded-decision',
        targetSlug: 'shortcuts-global-only',
        desc: 'flagging that shortcuts lack per-user customization',
      },
    ],
    expectedVerdict: 'FAIL',
    ...overrides,
  };
}

const REVIEWER_TRANSCRIPT = [
  'Investigated the staged diff.',
  'IMPORTANT: export-csv is not registered in the help menu | src/help-menu.ts | users cannot discover it',
  'The registry gained the action but the sibling list did not.',
  'LOW: consider a changelog entry | CHANGELOG.md',
  'ISSUES: 0 critical, 1 important, 1 low',
  'VERDICT: FAIL — help menu registration missing',
].join('\n');

/** Matcher stub: gold slot matches F1, decoys stay clean. */
const matcherStub = async ({ args }: { args: string[] }) => {
  const prompt = args[1];
  if (prompt.includes('GOLD GAP:')) return 'SLOT: F1';
  return 'SLOT: NONE';
};

// ─── parseFindings ────────────────────────────────────────────────────────────────

describe('parseFindings', () => {
  it('parses canonical severity lines with paths and impact', () => {
    const { findings, issues, warnings } = parseFindings(REVIEWER_TRANSCRIPT);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      severity: 'IMPORTANT',
      desc: 'export-csv is not registered in the help menu',
      paths: 'src/help-menu.ts',
      impact: 'users cannot discover it',
    });
    expect(findings[0].context).toEqual(['The registry gained the action but the sibling list did not.']);
    expect(findings[1]).toMatchObject({ severity: 'LOW', desc: 'consider a changelog entry', impact: '' });
    expect(issues).toEqual({ critical: 0, important: 1, low: 1 });
    expect(warnings).toEqual([]);
  });

  it('tolerates markdown dressing and requires the colon', () => {
    const { findings } = parseFindings(
      '- **CRITICAL**: build breaks | a.ts | no dist\n' +
        '> IMPORTANT: docs stale | docs/x.md | misleads\n' +
        'This CRITICAL gap is discussed in prose without a colon-start.\n',
    );
    expect(findings.map((f) => f.severity)).toEqual(['CRITICAL', 'IMPORTANT']);
  });

  it('warns on ISSUES tally mismatch and on a missing tally', () => {
    expect(parseFindings('CRITICAL: x | a.ts | y\nISSUES: 2 critical, 0 important, 0 low').warnings[0]).toMatch(
      /disagrees/,
    );
    expect(parseFindings('CRITICAL: x | a.ts | y').warnings[0]).toMatch(/no ISSUES tally/);
  });

  it('returns zero findings for a clean report and never treats VERDICT as a finding', () => {
    const { findings } = parseFindings('ISSUES: 0 critical, 0 important, 0 low\nVERDICT: PASS — complete');
    expect(findings).toEqual([]);
  });
});

// ─── Slot replies + voting ────────────────────────────────────────────────────────

describe('parseSlotReply', () => {
  it('parses F<n>, NONE, and lets the LAST SLOT line win', () => {
    expect(parseSlotReply('SLOT: F2', 3)).toBe(2);
    expect(parseSlotReply('SLOT: NONE', 3)).toBe(0);
    expect(parseSlotReply('thinking… SLOT: F1\nno wait\nSLOT: NONE', 3)).toBe(0);
    expect(parseSlotReply('**SLOT: F 3**', 3)).toBe(3);
  });

  it('returns null (outage, not NONE) on garbage or out-of-range', () => {
    expect(parseSlotReply('the answer is F2', 3)).toBeNull();
    expect(parseSlotReply('SLOT: F9', 3)).toBeNull();
    expect(parseSlotReply('', 3)).toBeNull();
  });
});

describe('voteSlot', () => {
  it('unanimous vote is stable', () => {
    expect(voteSlot([2, 2, 2])).toEqual({ match: 2, stable: true, outage: false });
  });
  it('majority wins but is marked unstable', () => {
    expect(voteSlot([2, 2, 0])).toEqual({ match: 2, stable: false, outage: false });
  });
  it('a full tie fails safe to NONE (instability), all-null is an outage', () => {
    expect(voteSlot([1, 0])).toMatchObject({ match: 0, stable: false, outage: false });
    expect(voteSlot([null, null, null])).toMatchObject({ match: 0, outage: true });
  });
});

describe('mapPool', () => {
  it('preserves order and bounds concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

// ─── runMatcher (stub exec) ───────────────────────────────────────────────────────

describe('runMatcher', () => {
  const gold = [{ id: 'g1', severity: 'IMPORTANT' as const, desc: 'gap' }];
  const decoys = [{ id: 'd1', kind: 'out-of-scope' as const, desc: 'decoy' }];
  const finding = { severity: 'IMPORTANT' as const, desc: 'gap', paths: '', impact: '', context: [] };

  it('short-circuits with zero findings — no exec call, gold missed, decoys clean', async () => {
    let calls = 0;
    const outcomes = await runMatcher(gold, decoys, [], {
      exec: async () => ((calls += 1), 'SLOT: F1'),
    });
    expect(calls).toBe(0);
    expect(outcomes).toEqual([
      { slotId: 'g1', kind: 'gold', match: 0, stable: true, outage: false },
      { slotId: 'd1', kind: 'decoy', match: 0, stable: true, outage: false },
    ]);
  });

  it('votes K trials per slot and retries a dark reply once', async () => {
    const replies: (string | null)[] = [null, 'SLOT: F1', 'SLOT: F1', 'SLOT: F1', 'SLOT: NONE', 'SLOT: NONE', 'SLOT: NONE'];
    let i = 0;
    const outcomes = await runMatcher(gold, decoys, [finding], {
      runs: 3,
      concurrency: 1,
      // No ?? here — a deliberate null (dark judge) must reach the matcher as null.
      exec: async () => (i < replies.length ? replies[i++] : 'SLOT: NONE'),
    });
    const g = outcomes.find((o) => o.slotId === 'g1')!;
    expect(g).toMatchObject({ match: 1, stable: true, outage: false }); // retry rescued the flake
    expect(outcomes.find((o) => o.slotId === 'd1')).toMatchObject({ match: 0, stable: true });
  });

  it('an all-dark slot is an outage', async () => {
    const outcomes = await runMatcher(gold, [], [finding], { runs: 1, exec: async () => null });
    expect(outcomes[0]).toMatchObject({ outage: true, match: 0 });
  });

  it('prompts carry the findings and withhold gold severities', () => {
    const gp = buildGoldPrompt(gold[0], [finding]);
    expect(gp).toContain('F1 (IMPORTANT)');
    expect(gp).toContain('GOLD GAP: gap');
    expect(gp).not.toMatch(/target severity/i);
    expect(buildDecoyPrompt(decoys[0], [finding])).toContain('DECOY: decoy');
  });
});

// ─── scoreCase + kappa ────────────────────────────────────────────────────────────

describe('scoreCase', () => {
  const gold = [
    { id: 'g1', severity: 'CRITICAL' as const, desc: 'a' },
    { id: 'g2', severity: 'LOW' as const, desc: 'b' },
  ];
  const decoys = [{ id: 'd1', kind: 'out-of-scope' as const, desc: 'c' }];
  const findings = [
    { severity: 'IMPORTANT' as const, desc: 'a-ish', paths: '', impact: '', context: [] },
    { severity: 'LOW' as const, desc: 'noise', paths: '', impact: '', context: [] },
  ];

  it('maps hits, misses, flags, spurious, and severity pairs', () => {
    const score = scoreCase(gold, decoys, findings, [
      { slotId: 'g1', kind: 'gold', match: 1, stable: true, outage: false },
      { slotId: 'g2', kind: 'gold', match: 0, stable: true, outage: false },
      { slotId: 'd1', kind: 'decoy', match: 0, stable: true, outage: false },
    ]);
    expect(score.slots).toEqual([
      { slotId: 'g1', kind: 'gold', ok: true, got: 'hit', stable: true, outage: false },
      { slotId: 'g2', kind: 'gold', ok: false, got: 'miss', stable: true, outage: false },
      { slotId: 'd1', kind: 'decoy', ok: true, got: 'clean', stable: true, outage: false },
    ]);
    expect(score.severity).toEqual([{ expected: 'CRITICAL', got: 'IMPORTANT' }]);
    expect(score.spurious).toEqual([2]); // F2 claimed by no slot
  });

  it('a flagged decoy is not ok', () => {
    const score = scoreCase([], decoys, findings, [
      { slotId: 'd1', kind: 'decoy', match: 2, stable: true, outage: false },
    ]);
    expect(score.slots[0]).toMatchObject({ ok: false, got: 'flagged' });
    expect(score.spurious).toEqual([1]);
  });
});

describe('kappa', () => {
  it('is 1 on perfect agreement and NaN on empty/mismatched input', () => {
    expect(kappa(['A', 'B'], ['A', 'B'])).toBe(1);
    expect(kappa([], [])).toBeNaN();
    expect(kappa(['A'], ['A', 'B'])).toBeNaN();
  });
  it('matches a hand-computed example', () => {
    // 10 items: 8 agree. a: 6×NONE 4×F1 · b: 6×NONE 4×F1, disagreements symmetric.
    const a = ['N', 'N', 'N', 'N', 'N', 'N', 'F', 'F', 'F', 'F'];
    const b = ['N', 'N', 'N', 'N', 'N', 'F', 'N', 'F', 'F', 'F'];
    // po = 0.8; pe = 0.6*0.6 + 0.4*0.4 = 0.52; κ = (0.8-0.52)/0.48 = 0.5833…
    expect(kappa(a, b)).toBeCloseTo(0.5833, 3);
  });
  it('is ~0 when agreement is chance-level despite high raw agreement on a skewed set', () => {
    const a = Array(20).fill('NONE');
    const b = Array(20).fill('NONE');
    b[0] = 'F1'; // rater b deviates once; kappa collapses because pe ≈ 1
    expect(kappa(a, b)).toBeLessThan(0.1);
  });
});

// ─── Corpus lint ──────────────────────────────────────────────────────────────────

describe('lintCases', () => {
  it('passes a well-formed row', () => {
    expect(lintCases([makeRow()])).toEqual([]);
  });
  it('catches missing fields, duplicate slots, empty staging, unbacked decoys', () => {
    const bad = makeRow({
      note: '',
      repo: { base: {}, staged: {} },
      gold: [{ id: 'x', severity: 'IMPORTANT', desc: 'a' }],
      decoys: [
        { id: 'x', kind: 'recorded-decision', targetSlug: 'nope', desc: 'b' },
        { id: 'y', kind: 'recorded-decision', desc: 'c' } as never,
      ],
    });
    const errors = lintCases([bad, makeRow()]);
    expect(errors.join('\n')).toMatch(/missing note/);
    expect(errors.join('\n')).toMatch(/nothing staged/);
    expect(errors.join('\n')).toMatch(/duplicate slot id x/);
    expect(errors.join('\n')).toMatch(/docs\/decisions\/nope\.md not in repo\.base/);
    expect(errors.join('\n')).toMatch(/needs targetSlug/);
  });
});

// ─── Fixture wrapper ──────────────────────────────────────────────────────────────

describe('materializeCompletenessFixture', () => {
  it('commits guard.config.json in base, writes the msg under .git, and the decoy Target round-trips through the gate loader', () => {
    const fx = materializeCompletenessFixture(makeRow(), '/abs/agents');
    try {
      // guard.config.json is committed base — absent from the staged set the judge diffs.
      expect(fx.staged).toEqual(['src/registry.ts']);
      const cfg = JSON.parse(readFileSync(join(fx.repo, 'guard.config.json'), 'utf8'));
      expect(cfg.review.agentsDir).toBe('/abs/agents');
      expect(readFileSync(fx.msgFile, 'utf8')).toBe('feat: add export-csv shortcut action\n');
      expect(fx.msgFile).toContain('.git');
      // The exact loader the gate's scopedTargets() uses must find and scope-match the decoy.
      const targets = loadScopedTargets(join(fx.repo, 'docs/decisions'));
      expect(targets).toHaveLength(1);
      expect(targets[0].slug).toBe('shortcuts-global-only');
      expect(matchScope(fx.staged, targets[0].scopeGlobs)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

// ─── runCase through the real gate (stub judges) ──────────────────────────────────

describe('runCase', () => {
  afterEach(() => {
    delete process.env.GUARD_NO_COMPLETENESS;
  });

  it('runs the gate end-to-end: findings scored, decoy clean, verdict captured', async () => {
    const res = await runCase(makeRow(), {
      reviewerExec: async () => REVIEWER_TRANSCRIPT,
      matcherExec: matcherStub,
      matchRuns: 1,
      saveTranscript: false,
    });
    expect(res.outage).toBe(false);
    expect(res.verdict).toBe('FAIL');
    expect(res.score!.slots).toEqual([
      { slotId: 'g1', kind: 'gold', ok: true, got: 'hit', stable: true, outage: false },
      { slotId: 'd1', kind: 'decoy', ok: true, got: 'clean', stable: true, outage: false },
    ]);
    expect(res.score!.severity).toEqual([{ expected: 'IMPORTANT', got: 'IMPORTANT' }]);
    expect(res.score!.spurious).toEqual([2]); // the LOW changelog finding matched nothing
  });

  it('a dark reviewer is an outage, not a crash and not a pass', async () => {
    const res = await runCase(makeRow(), {
      reviewerExec: async () => null,
      matcherExec: matcherStub,
      matchRuns: 1,
      saveTranscript: false,
    });
    expect(res).toMatchObject({ outage: true, score: null });
  });

  it('a gate free-skip (env kill-switch) aborts as a fixture bug — never a pass', async () => {
    process.env.GUARD_NO_COMPLETENESS = '1';
    await expect(
      runCase(makeRow(), { reviewerExec: async () => REVIEWER_TRANSCRIPT, matcherExec: matcherStub, saveTranscript: false }),
    ).rejects.toThrow(/free-skipped/);
  });

  it('a missing agent brief free-skips and aborts', async () => {
    const emptyAgents = mkdtempSync(join(tmpdir(), 'completeness-eval-test-'));
    try {
      await expect(
        runCase(makeRow(), {
          reviewerExec: async () => REVIEWER_TRANSCRIPT,
          matcherExec: matcherStub,
          agentsDir: emptyAgents,
          saveTranscript: false,
        }),
      ).rejects.toThrow(/free-skipped/);
    } finally {
      rmSync(emptyAgents, { recursive: true, force: true });
    }
  });

  it('a scope-mismatched recorded-decision decoy aborts — the reviewer was never tempted', async () => {
    const row = makeRow({
      repo: {
        base: {
          'lib/other.ts': 'export {};\n',
          // Scope src/** but the staged file lives in lib/ — the Target never loads.
          'docs/decisions/shortcuts-global-only.md': DECOY_TARGET_MD,
        },
        staged: { 'lib/other.ts': 'export const x = 1;\n' },
      },
      gold: [],
    });
    await expect(
      runCase(row, { reviewerExec: async () => REVIEWER_TRANSCRIPT, matcherExec: matcherStub, saveTranscript: false }),
    ).rejects.toThrow(/not in the gate prompt/);
  });
});

// ─── summarize + variantConsistency ───────────────────────────────────────────────

function summaryFrom(slotSpecs: Record<string, { kind: 'gold' | 'decoy'; ok: boolean; stable?: boolean }>): BenchSummary {
  // Build a summary via the real aggregation path with one synthetic case per slot map.
  const rows: CompletenessCase[] = [];
  const results = [];
  const byCase: Record<string, typeof slotSpecs> = {};
  for (const [key, spec] of Object.entries(slotSpecs)) {
    const [caseId, slotId] = key.split('::');
    byCase[caseId] ??= {};
    byCase[caseId][slotId] = spec;
  }
  for (const [caseId, slots] of Object.entries(byCase)) {
    const gold = Object.entries(slots)
      .filter(([, s]) => s.kind === 'gold')
      .map(([id]) => ({ id, severity: 'IMPORTANT' as const, desc: id }));
    const decoys = Object.entries(slots)
      .filter(([, s]) => s.kind === 'decoy')
      .map(([id]) => ({ id, kind: 'out-of-scope' as const, desc: id }));
    rows.push(makeRow({ id: caseId, gold, decoys, expectedVerdict: undefined }));
    results.push({
      id: caseId,
      outage: false,
      exit: 0,
      verdict: null,
      warnings: [],
      score: {
        slots: Object.entries(slots).map(([slotId, s]) => ({
          slotId,
          kind: s.kind,
          ok: s.ok,
          got: s.kind === 'gold' ? (s.ok ? 'hit' : 'miss') : s.ok ? 'clean' : 'flagged',
          stable: s.stable ?? true,
          outage: false,
        })),
        severity: [],
        spurious: [],
        findingCount: 0,
      },
    });
  }
  return summarize(rows, results as never);
}

describe('summarize', () => {
  it('computes gap recall, false-flag rate, and the recorded-decision sub-line', () => {
    const row = makeRow();
    const results = [
      {
        id: row.id,
        outage: false,
        exit: 0,
        verdict: 'FAIL',
        warnings: [],
        score: {
          slots: [
            { slotId: 'g1', kind: 'gold' as const, ok: true, got: 'hit' as const, stable: true, outage: false },
            { slotId: 'd1', kind: 'decoy' as const, ok: false, got: 'flagged' as const, stable: true, outage: false },
          ],
          severity: [{ expected: 'IMPORTANT' as const, got: 'CRITICAL' as const }],
          spurious: [3],
          findingCount: 3,
        },
      },
    ];
    const s = summarize([row], results as never);
    expect(s.gold).toEqual({ total: 1, hit: 1 });
    expect(s.decoys).toEqual({ total: 1, flagged: 1, recorded: { total: 1, flagged: 1 } });
    expect(s.gapRecall).toBe(1);
    expect(s.falseFlagRate).toBe(1);
    expect(s.findings).toEqual({ total: 3, matched: 2, spurious: 1 });
    expect(s.severity.exact).toBe(0);
    expect(s.verdicts).toEqual({ total: 1, correct: 1 });
    expect(s.rows[row.id]).toEqual({ ok: false, stable: true }); // the flagged decoy sinks the case
    expect(s.slots[`${row.id}::g1`]).toMatchObject({ kind: 'gold', ok: true });
  });

  it('counts case outages and slot outages separately; outage slots join no metric', () => {
    const row = makeRow();
    const s = summarize(
      [row, makeRow({ id: 'other' })],
      [
        { id: row.id, outage: true, exit: 0, verdict: null, warnings: [], score: null },
        {
          id: 'other',
          outage: false,
          exit: 0,
          verdict: null,
          warnings: [],
          score: {
            slots: [
              { slotId: 'g1', kind: 'gold', ok: false, got: 'miss', stable: true, outage: true },
              { slotId: 'd1', kind: 'decoy', ok: true, got: 'clean', stable: true, outage: false },
            ],
            severity: [],
            spurious: [],
            findingCount: 0,
          },
        },
      ] as never,
    );
    expect(s.caseOutages).toBe(1);
    expect(s.slotOutages).toBe(1);
    expect(s.outages).toBe(2);
    expect(s.gold.total).toBe(0); // the outage slot never joined
    expect(s.decoys.total).toBe(1);
  });

  it('a null verdict scores as PASS (the gate fail-open reading)', () => {
    const row = makeRow({ expectedVerdict: 'PASS', decoys: [], gold: [] });
    // Bypass lint concerns — direct summarize with an empty-slot score.
    const s = summarize(
      [row],
      [{ id: row.id, outage: false, exit: 0, verdict: null, warnings: [], score: { slots: [], severity: [], spurious: [], findingCount: 0 } }] as never,
    );
    expect(s.verdicts).toEqual({ total: 1, correct: 1 });
  });
});

describe('variantConsistency', () => {
  it('groups invariance variants by slot-outcome pattern', () => {
    const rows = [
      makeRow({ id: 'a' }),
      makeRow({ id: 'a-var', variantOf: 'a', variantKind: 'invariance' }),
      makeRow({ id: 'b' }),
      makeRow({ id: 'b-var', variantOf: 'b', variantKind: 'invariance' }),
    ];
    const s = summaryFrom({
      'a::g1': { kind: 'gold', ok: true },
      'a-var::g1': { kind: 'gold', ok: true },
      'b::g1': { kind: 'gold', ok: true },
      'b-var::g1': { kind: 'gold', ok: false },
    });
    expect(variantConsistency(rows, s)).toEqual({ consistent: 1, total: 2, broken: ['b'] });
  });
  it('returns null with no variant groups', () => {
    expect(variantConsistency([makeRow()], summaryFrom({ 'x::g1': { kind: 'gold', ok: true } }))).toBeNull();
  });
});

// ─── compareCompleteness ──────────────────────────────────────────────────────────

function baseSummary(overrides: Partial<BenchSummary> = {}): BenchSummary {
  return {
    matchModel: 'haiku',
    matchRuns: 3,
    cases: 4,
    caseOutages: 0,
    slotOutages: 0,
    outages: 0,
    gold: { total: 4, hit: 4 },
    decoys: { total: 4, flagged: 0, recorded: { total: 2, flagged: 0 } },
    findings: { total: 6, matched: 5, spurious: 1 },
    severity: { total: 4, exact: 3, confusion: {} },
    verdicts: { total: 0, correct: 0 },
    gapRecall: 1,
    falseFlagRate: 0,
    rows: { a: { ok: true, stable: true }, b: { ok: true, stable: true }, c: { ok: true, stable: true }, d: { ok: true, stable: true } },
    slots: {},
    gateHash: 'gh',
    matcherHash: 'mh',
    corpusHash: 'ch',
    ...overrides,
  };
}

describe('compareCompleteness', () => {
  it('skips without lying on config / hash / outage mismatches', () => {
    const base = baseSummary();
    expect(compareCompleteness(baseSummary({ matchModel: 'sonnet' }), base).lines[0]).toMatch(/config differs/);
    expect(compareCompleteness(baseSummary({ gateHash: 'x' }), base).lines[0]).toMatch(/gate code \/ agent brief changed/);
    expect(compareCompleteness(baseSummary({ matcherHash: 'x' }), base).lines[0]).toMatch(/matcher changed/);
    expect(compareCompleteness(baseSummary({ corpusHash: 'x' }), base).lines[0]).toMatch(/corpus changed/);
    expect(compareCompleteness(baseSummary({ outages: 1 }), base).lines[0]).toMatch(/outage/);
    expect(compareCompleteness(baseSummary(), undefined).lines[0]).toMatch(/no baseline/);
  });

  it('hard floor and ceiling breaches fail regardless of flips', () => {
    const base = baseSummary();
    const lowRecall = compareCompleteness(
      baseSummary({ gapRecall: FLOOR_GAP_RECALL - 0.01, rows: base.rows }),
      base,
    );
    expect(lowRecall.regressed).toBe(true);
    expect(lowRecall.lines.join('\n')).toMatch(/FLOOR BREACH/);
    const noisy = compareCompleteness(baseSummary({ falseFlagRate: CEILING_FALSE_FLAG + 0.01 }), base);
    expect(noisy.regressed).toBe(true);
    expect(noisy.lines.join('\n')).toMatch(/CEILING BREACH/);
  });

  it('a single stable case flip warns but does not regress; ~6 one-directional flips regress', () => {
    const mkRows = (bad: string[]) =>
      Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`c${i}`, { ok: !bad.includes(`c${i}`), stable: true }]),
      );
    const base = baseSummary({ rows: mkRows([]) });
    const oneFlip = compareCompleteness(baseSummary({ rows: mkRows(['c0']) }), base);
    expect(oneFlip.regressed).toBe(false);
    expect(oneFlip.lines.join('\n')).toMatch(/case flips vs baseline/);
    const sixFlips = compareCompleteness(
      baseSummary({ rows: mkRows(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']) }),
      base,
    );
    expect(sixFlips.regressed).toBe(true);
    expect(sixFlips.lines.join('\n')).toMatch(/REGRESSION/);
  });

  it('symmetric churn does not regress; unstable flips never count', () => {
    const base = baseSummary({
      rows: { a: { ok: true, stable: true }, b: { ok: false, stable: true }, c: { ok: true, stable: true } },
    });
    const churn = compareCompleteness(
      baseSummary({ rows: { a: { ok: false, stable: true }, b: { ok: true, stable: true }, c: { ok: true, stable: true } } }),
      base,
    );
    expect(churn.regressed).toBe(false);
    const unstable = compareCompleteness(
      baseSummary({
        rows: {
          a: { ok: false, stable: false },
          b: { ok: false, stable: false },
          c: { ok: false, stable: false },
        },
        gapRecall: 1,
      }),
      base,
    );
    expect(unstable.regressed).toBe(false);
    expect(unstable.lines.join('\n')).toMatch(/unstable cases/);
  });
});

// ─── The committed corpus itself ──────────────────────────────────────────────────

describe('cases-completeness.jsonl (the committed corpus)', () => {
  const corpus = parseCasesText(
    readFileSync(join(import.meta.dirname, '../eval/cases-completeness.jsonl'), 'utf8'),
  ) as CompletenessCase[];

  it('lints clean', () => {
    expect(lintCases(corpus)).toEqual([]);
  });

  it('every recorded-decision decoy Target round-trips through the gate loader and scope-matches the staged files', () => {
    for (const row of corpus) {
      const rdDecoys = row.decoys.filter((d) => d.kind === 'recorded-decision');
      if (!rdDecoys.length) continue;
      const fx = materializeCompletenessFixture(row, '/abs/agents');
      try {
        const targets = loadScopedTargets(join(fx.repo, 'docs/decisions'));
        for (const d of rdDecoys) {
          const t = targets.find((x) => x.slug === d.targetSlug);
          expect(t, `${row.id}: decoy Target ${d.targetSlug} must parse (needs a **Scope:** field)`).toBeDefined();
          expect(
            matchScope(fx.staged, t!.scopeGlobs),
            `${row.id}: decoy Target ${d.targetSlug} scope must match ≥1 staged file or the gate never loads it`,
          ).toBe(true);
        }
      } finally {
        fx.cleanup();
      }
    }
  });

  it('variant rows point at existing canonical rows', () => {
    const ids = new Set(corpus.map((r) => r.id));
    for (const r of corpus) if (r.variantOf) expect(ids.has(r.variantOf), `${r.id} → ${r.variantOf}`).toBe(true);
  });
});

// ─── matcherAudit ─────────────────────────────────────────────────────────────────

describe('matcherAudit', () => {
  const transcripts: Record<string, { outcomes: { slotId: string; match: number }[] }> = {
    'case-a': { outcomes: [{ slotId: 'g1', match: 1 }, { slotId: 'd1', match: 0 }] },
    'case-b': { outcomes: [{ slotId: 'g1', match: 0 }] },
  };
  const read = (id: string) => transcripts[id] ?? null;

  it('joins labels to transcripts and reports agreement + kappa', () => {
    const labels = [
      '{"caseId":"case-a","slotId":"g1","match":"F1"}',
      '{"caseId":"case-a","slotId":"d1","match":"NONE"}',
      '{"caseId":"case-b","slotId":"g1","match":"F2"}',
      '{"caseId":"case-b","slotId":"gone","match":"NONE"}',
    ].join('\n');
    const res = matcherAudit(labels, read);
    expect(res.n).toBe(3);
    expect(res.agree).toBe(2); // F2 label vs NONE matcher disagrees
    expect(res.missing).toEqual(['case-b::gone']);
    expect(Number.isFinite(res.kappa)).toBe(true);
  });

  it('aborts with no labels', () => {
    expect(() => matcherAudit('', read)).toThrow(BenchAbort);
  });
});
