import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJson, type JsonValue } from '../../comment-firewall/types.mts';
import { resolveGuardConfigJson } from '../../config.mts';
import { loadScopedTargets, matchScope } from '../../decisions/check-alignment.mts';
import { BenchAbort, parseCasesText } from '../../decisions/eval/bench.mts';
import {
  applyRetryEvidence,
  type AuditCheckpointValue,
  type BenchSummary,
  type CaseResult,
  CEILING_FALSE_FLAG,
  type CompletenessCase,
  completenessBaselineEligibility,
  completenessCaseCheckpointIdentity,
  completenessCaseInputHash,
  completenessFixtureCapabilityFingerprint,
  completenessMatcherInputHash,
  completenessReviewerCheckpointIdentity,
  completenessSlotKey,
  compareCompleteness,
  consistentReviewerModel,
  FLOOR_GAP_RECALL,
  lintCases,
  matcherAudit,
  type MatcherCheckpointValue,
  materializeCompletenessFixture,
  type ReviewerCheckpointValue,
  runCase,
  runIndependentMatcherAudit,
  reusableCaseCheckpoint,
  reusableCaseCheckpointForRow,
  reusableMatcherCheckpoint,
  reusableReviewerCheckpoint,
  summarize,
  variantConsistency,
  writeCompletenessBaseline,
} from '../eval/bench.mts';
import { openCheckpointStore, type CheckpointStore } from '../eval/checkpoint.mts';
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
      {
        id: 'g1',
        severity: 'IMPORTANT',
        desc: 'export-csv missing from help menu',
        paths: ['src/help-menu.ts'],
      },
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

function asJson<T>(value: T): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('test fixture must be JSON-serializable');
  return parseJson(serialized);
}

/** Matcher stub: gold slot matches F1, decoys stay clean. */
const matcherStub = async ({ args }: { args: string[] }) => {
  const prompt = args[1];
  if (prompt.includes('GOLD GAP:')) return 'SLOT: F1';
  return 'SLOT: NONE';
};

const reviewerCheckpointValue = (): ReviewerCheckpointValue => ({
  reviewerModel: 'gpt-5.6-sol',
  args: ['-p', 'review prompt containing Target shortcuts-global-only', '--model', 'gpt-5.6-sol'],
  raw: REVIEWER_TRANSCRIPT,
  exit: 1,
});

interface MemoryCheckpoint<T> {
  store: CheckpointStore<T>;
  values: Map<string, T>;
}

function memoryCheckpoint<T>(): MemoryCheckpoint<T> {
  const values = new Map<string, T>();
  const key = (id: string, inputHash: string) => JSON.stringify([id, inputHash]);
  return {
    values,
    store: {
      get size() {
        return values.size;
      },
      take(id, inputHash) {
        return values.get(key(id, inputHash));
      },
      record(id, inputHash, value) {
        values.set(key(id, inputHash), value);
      },
    },
  };
}

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
    expect(findings[0].context).toEqual([
      'The registry gained the action but the sibling list did not.',
    ]);
    expect(findings[1]).toMatchObject({
      severity: 'LOW',
      desc: 'consider a changelog entry',
      impact: '',
    });
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
    expect(
      parseFindings('CRITICAL: x | a.ts | y\nISSUES: 2 critical, 0 important, 0 low').warnings[0],
    ).toMatch(/disagrees/);
    expect(parseFindings('CRITICAL: x | a.ts | y').warnings[0]).toMatch(/no ISSUES tally/);
  });

  it('returns zero findings for a clean report and never treats VERDICT as a finding', () => {
    const { findings } = parseFindings(
      'ISSUES: 0 critical, 0 important, 0 low\nVERDICT: PASS — complete',
    );
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
  const finding = {
    severity: 'IMPORTANT' as const,
    desc: 'gap',
    paths: '',
    impact: '',
    context: [],
  };

  it('short-circuits with zero findings — no exec call, gold missed, decoys clean', async () => {
    let calls = 0;
    const outcomes = await runMatcher(gold, decoys, [], {
      exec: async () => {
        calls += 1;
        return 'SLOT: F1';
      },
    });
    expect(calls).toBe(0);
    expect(outcomes).toEqual([
      { slotId: 'g1', kind: 'gold', match: 0, stable: true, outage: false },
      { slotId: 'd1', kind: 'decoy', match: 0, stable: true, outage: false },
    ]);
  });

  it('votes K trials per slot and retries a dark reply once', async () => {
    const replies: (string | null)[] = [
      null,
      'SLOT: F1',
      'SLOT: F1',
      'SLOT: F1',
      'SLOT: NONE',
      'SLOT: NONE',
      'SLOT: NONE',
    ];
    let i = 0;
    const outcomes = await runMatcher(gold, decoys, [finding], {
      runs: 3,
      concurrency: 1,
      // No ?? here — a deliberate null (dark judge) must reach the matcher as null.
      exec: async () => (i < replies.length ? replies[i++] : 'SLOT: NONE'),
    });
    const g = outcomes.find((o) => o.slotId === 'g1');
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
      repo: { base: { 'same.ts': 'x' }, staged: { 'same.ts': 'x' } },
      gold: [{ id: 'x', severity: 'IMPORTANT', desc: 'a' }],
      decoys: [
        { id: 'x', kind: 'recorded-decision', targetSlug: 'nope', desc: 'b' },
        { id: 'y', kind: 'recorded-decision', desc: 'c' } as never,
      ],
    });
    const errors = lintCases([bad, makeRow()]);
    expect(errors.join('\n')).toMatch(/missing or non-string note/);
    expect(errors.join('\n')).toMatch(/nothing staged/);
    expect(errors.join('\n')).toMatch(/duplicate slot id x/);
    expect(errors.join('\n')).toMatch(/docs\/decisions\/nope\.md not in repo\.base/);
    expect(errors.join('\n')).toMatch(/needs targetSlug/);
  });
  it('rejects a recorded-decision decoy whose Target has no parseable Scope', () => {
    const row = makeRow();
    const file = 'docs/decisions/shortcuts-global-only.md';
    row.repo.base[file] = row.repo.base[file].replace(/^\*\*Scope:\*\*.*$/m, '');

    expect(lintCases([row]).join('\n')).toMatch(/has no parseable Target Scope/);
  });
  it('rejects a recorded-decision decoy whose Target scope misses the staged files', () => {
    const row = makeRow();
    const file = 'docs/decisions/shortcuts-global-only.md';
    row.repo.base[file] = row.repo.base[file].replace(
      /^\*\*Scope:\*\*.*$/m,
      '**Scope:** unrelated/**',
    );

    expect(lintCases([row]).join('\n')).toMatch(/applicable to staged files/);
  });
  it('rejects a recorded-decision targetSlug that cannot name a loadable axis file', () => {
    const row = makeRow();
    row.decoys[0].targetSlug = 'INDEX';
    row.repo.base['docs/decisions/INDEX.md'] = row.repo.base[
      'docs/decisions/shortcuts-global-only.md'
    ].replaceAll('shortcuts-global-only', 'INDEX');

    expect(lintCases([row]).join('\n')).toMatch(/invalid targetSlug INDEX/);
  });
  it('reports malformed slot collections instead of throwing while spreading them', () => {
    const malformed = makeRow();
    Reflect.set(malformed, 'gold', {});
    Reflect.set(malformed, 'decoys', {});

    expect(() => lintCases([malformed])).not.toThrow();
    expect(lintCases([malformed]).join('\n')).toMatch(/gold\/decoys must be arrays/);
  });
  it('rejects truthy non-string required fields before reporting coverage', () => {
    const malformed = makeRow();
    Reflect.set(malformed, 'category', 1);
    malformed.message = '   ';

    expect(lintCases([malformed]).join('\n')).toMatch(/missing or non-string category/);
    expect(lintCases([malformed]).join('\n')).toMatch(/missing or non-string message/);
  });
  it('rejects non-object rows and malformed metadata, maps, slots, and variant links', () => {
    const malformed = makeRow({
      id: 'malformed-contract',
      variantOf: 'missing-base',
      variantKind: null,
    });
    Reflect.set(malformed, 'holdout', 'false');
    Reflect.set(malformed, 'repo', { base: { '../outside': 'x' }, staged: { '/tmp/x': 'x' } });
    Reflect.set(malformed, 'gold', [
      { id: '   ', severity: 'URGENT', desc: 'gap', paths: ['   '] },
    ]);
    Reflect.set(malformed, 'decoys', [{ id: 'd1', kind: 'unknown', desc: '   ' }]);

    const errors = lintCases([null, malformed]).join('\n');
    expect(errors).toMatch(/must be a JSON object/);
    expect(errors).toMatch(/holdout must be boolean/);
    expect(errors).toMatch(/variantOf requires an explicit variantKind/);
    expect(errors).toMatch(/variantOf base missing-base does not exist/);
    expect(errors).toMatch(/repo\.base\/staged must be string maps/);
    expect(errors).toMatch(/slot must have an id/);
    expect(errors).toMatch(/must have a description/);
    expect(errors).toMatch(/bad severity/);
    expect(errors).toMatch(/paths must be non-empty strings/);
    expect(errors).toMatch(/bad kind/);
  });
});

// ─── Fixture wrapper ──────────────────────────────────────────────────────────────

describe('materializeCompletenessFixture', () => {
  it('commits guard.config.json in base, writes the msg under .git, and the decoy Target round-trips through the gate loader', () => {
    const consumerConfig = resolveGuardConfigJson(
      JSON.stringify({
        indexPath: '.custom-index',
        searchTool: 'custom_search',
        review: { escalationModel: 'opus' },
      }),
      process.cwd(),
    );
    const fx = materializeCompletenessFixture(
      makeRow(),
      '/abs/agents',
      writeFileSync,
      consumerConfig,
    );
    try {
      // guard.config.json is committed base — absent from the staged set the judge diffs.
      expect(fx.staged).toEqual(['src/registry.ts']);
      const cfg = JSON.parse(readFileSync(join(fx.repo, 'guard.config.json'), 'utf8'));
      expect(cfg.review.agentsDir).toBe('/abs/agents');
      expect(cfg.review.escalationModel).toBe('opus');
      expect(cfg.searchTool).toBe('custom_search');
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
  it('cleans up the disposable repo when the commit-message write fails', () => {
    let repo = '';
    const writeMessage = (file: string): never => {
      repo = dirname(dirname(file));
      throw new Error('write denied');
    };

    expect(() => materializeCompletenessFixture(makeRow(), '/abs/agents', writeMessage)).toThrow(
      'write denied',
    );
    expect(repo).not.toBe('');
    expect(existsSync(repo)).toBe(false);
  });
});

// ─── runCase through the real gate (stub judges) ──────────────────────────────────

describe('runCase', () => {
  // Pin the decisions retriever to its lexical floor. These cases assert which decision records
  // reach the gate prompt, and the dense tier is a LOCAL DAEMON: with Ollama running the retriever
  // fuses both tiers and pulls in topically-near axes, without it the same assertion sees only
  // lexical matches. Left unpinned, the decoy-reachability tests pass in CI and fail on a developer
  // machine — a test whose verdict depends on what is installed is measuring the machine.
  beforeEach(() => {
    process.env.DECISIONS_NO_EMBED = '1';
  });
  afterEach(() => {
    delete process.env.GUARD_NO_COMPLETENESS;
    delete process.env.DECISIONS_NO_EMBED;
  });

  it('runs the gate end-to-end: findings scored, decoy clean, verdict captured', async () => {
    const consumerConfig = resolveGuardConfigJson(
      JSON.stringify({ review: { escalationModel: 'opus' } }),
      process.cwd(),
    );
    const res = await runCase(makeRow(), {
      reviewerExec: async (options) => {
        expect(options.args).toContain('opus');
        return REVIEWER_TRANSCRIPT;
      },
      matcherExec: matcherStub,
      matchRuns: 1,
      saveTranscript: false,
      consumerConfig,
    });
    expect(res.outage).toBe(false);
    expect(res.reviewerModel).toBe('opus');
    expect(res.verdict).toBe('FAIL');
    expect(res.score?.slots).toEqual([
      { slotId: 'g1', kind: 'gold', ok: true, got: 'hit', stable: true, outage: false },
      { slotId: 'd1', kind: 'decoy', ok: true, got: 'clean', stable: true, outage: false },
    ]);
    expect(res.score?.severity).toEqual([{ expected: 'IMPORTANT', got: 'IMPORTANT' }]);
    expect(res.score?.spurious).toEqual([2]); // the LOW changelog finding matched nothing
    expect(res.auditOutcomes).toEqual([
      { slotId: 'g1', match: 1, outage: false },
      { slotId: 'd1', match: 0, outage: false },
    ]);
  });

  it('resumes a saved reviewer response and durably fills only missing matcher slots', async () => {
    const row = makeRow();
    const reviewerResume = reviewerCheckpointValue();
    const { store } = memoryCheckpoint<MatcherCheckpointValue>();
    let reviewerCalls = 0;
    let matcherCalls = 0;
    const result = await runCase(row, {
      reviewerResume,
      reviewerExec: async () => {
        reviewerCalls += 1;
        return REVIEWER_TRANSCRIPT;
      },
      matcherExec: async (options) => {
        matcherCalls += 1;
        return matcherStub(options);
      },
      matcherCheckpoint: store,
      matchRuns: 1,
      saveTranscript: false,
    });

    expect(reviewerCalls).toBe(0);
    expect(matcherCalls).toBe(2);
    expect(store.size).toBe(2);
    const inputHash = completenessMatcherInputHash(row, result.findings!);
    expect(store.take(completenessSlotKey(row.id, 'g1'), inputHash)?.outcome).toMatchObject({
      slotId: 'g1',
      match: 1,
      outage: false,
    });
    expect(store.take(completenessSlotKey(row.id, 'd1'), inputHash)?.outcome).toMatchObject({
      slotId: 'd1',
      match: 0,
      outage: false,
    });

    const replayed = await runCase(row, {
      reviewerResume,
      reviewerExec: async () => {
        throw new Error('a saved reviewer response must skip reviewerExec');
      },
      matcherExec: async () => {
        throw new Error('complete matcher slots must skip matcherExec');
      },
      matcherCheckpoint: store,
      matchRuns: 1,
      saveTranscript: false,
    });
    expect(replayed.score).toEqual(result.score);
    expect(matcherCalls).toBe(2);
  });

  it('banks a fresh reviewer response before starting matcher work', async () => {
    const events: string[] = [];
    let saved: ReviewerCheckpointValue | undefined;
    await runCase(makeRow(), {
      reviewerExec: async () => REVIEWER_TRANSCRIPT,
      onReviewerComplete: (value) => {
        events.push('reviewer-complete');
        saved = value;
      },
      matcherExec: async (options) => {
        events.push('matcher');
        expect(events[0]).toBe('reviewer-complete');
        return matcherStub(options);
      },
      matchRuns: 1,
      saveTranscript: false,
    });

    expect(events).toEqual(['reviewer-complete', 'matcher', 'matcher']);
    expect(reusableReviewerCheckpoint(asJson(saved ?? null), 'gpt-5.6-sol')).toBeDefined();
  });

  it('audits current findings independently and keeps a Codex auditor read-only', async () => {
    const row = makeRow();
    const result = await runCase(row, {
      reviewerExec: async () => REVIEWER_TRANSCRIPT,
      matcherExec: matcherStub,
      matchRuns: 1,
      saveTranscript: false,
    });
    const options: { codexReadOnly?: boolean }[] = [];
    const audit = await runIndependentMatcherAudit([row], [result], {
      model: 'gpt-5.6-sol',
      exec: async (opts) => {
        options.push(opts);
        return opts.args[1].includes('AUDIT SLOT: export-csv missing from help menu')
          ? 'SLOT: F1'
          : 'SLOT: NONE';
      },
    });
    expect(audit).toMatchObject({
      model: 'gpt-5.6-sol',
      n: 2,
      agree: 2,
      kappa: 1,
      missing: [],
    });
    expect(options).toHaveLength(2);
    expect(options.every((opts) => opts.codexReadOnly === true)).toBe(true);
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

  it('aborts before spending when a trusted MCP server changes after checkpoint planning', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'completeness-eval-mcp-'));
    const registry = join(configRoot, 'registry.json');
    const previousRegistry = process.env.DEVKIT_JUDGE_MCP_CONFIG;
    const writeRegistry = (version: string) => {
      writeFileSync(
        registry,
        JSON.stringify({
          projects: {
            [process.cwd()]: {
              mcpServers: { context7: { command: 'node', args: [`context7-${version}`] } },
            },
          },
        }),
      );
      chmodSync(registry, 0o600);
    };
    try {
      process.env.DEVKIT_JUDGE_MCP_CONFIG = registry;
      writeRegistry('v1');
      const row = makeRow();
      const plannedFingerprint = completenessFixtureCapabilityFingerprint(row);
      writeRegistry('version-two');
      expect(completenessFixtureCapabilityFingerprint(row)).not.toBe(plannedFingerprint);

      let reviewerCalls = 0;
      await expect(
        runCase(row, {
          expectedCapabilityFingerprint: plannedFingerprint,
          reviewerExec: async () => {
            reviewerCalls += 1;
            return REVIEWER_TRANSCRIPT;
          },
          matcherExec: matcherStub,
          saveTranscript: false,
        }),
      ).rejects.toThrow(/MCP capabilities changed during the run/);
      expect(reviewerCalls).toBe(0);

      writeRegistry('v1');
      let checkpointWrites = 0;
      await expect(
        runCase(row, {
          expectedCapabilityFingerprint: plannedFingerprint,
          reviewerExec: async (options) => {
            reviewerCalls += 1;
            writeRegistry('changed-during-spawn');
            options.onMcpPrepared?.(completenessFixtureCapabilityFingerprint(row));
            return REVIEWER_TRANSCRIPT;
          },
          onReviewerComplete: () => {
            checkpointWrites += 1;
          },
          matcherExec: matcherStub,
          saveTranscript: false,
        }),
      ).rejects.toThrow(/MCP capabilities changed during the run/);
      expect(reviewerCalls).toBe(1);
      expect(checkpointWrites).toBe(0);

      writeRegistry('v1');
      let savedReviewer: ReviewerCheckpointValue | undefined;
      await runCase(row, {
        expectedCapabilityFingerprint: plannedFingerprint,
        reviewerExec: async (options) => {
          options.onMcpPrepared?.(plannedFingerprint);
          return REVIEWER_TRANSCRIPT;
        },
        onReviewerComplete: (value) => {
          savedReviewer = value;
        },
        matcherExec: matcherStub,
        matchRuns: 1,
        saveTranscript: false,
      });
      expect(savedReviewer?.mcpCapabilityFingerprint).toBe(plannedFingerprint);
      expect(
        reusableReviewerCheckpoint(
          asJson(savedReviewer ?? null),
          'gpt-5.6-sol',
          plannedFingerprint,
        ),
      ).toBeDefined();
    } finally {
      if (previousRegistry === undefined) delete process.env.DEVKIT_JUDGE_MCP_CONFIG;
      else process.env.DEVKIT_JUDGE_MCP_CONFIG = previousRegistry;
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it('a gate free-skip (env kill-switch) aborts as a fixture bug — never a pass', async () => {
    process.env.GUARD_NO_COMPLETENESS = '1';
    await expect(
      runCase(makeRow(), {
        reviewerExec: async () => REVIEWER_TRANSCRIPT,
        matcherExec: matcherStub,
        saveTranscript: false,
      }),
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

  it('a scope-mismatched decoy still reaches the prompt via the SEMANTIC channel', async () => {
    // scopedTargets has two channels: scope-match (glob) and semantic (the commit message). Here
    // the glob misses (Scope src/**, staged file in lib/) but the message "add export-csv shortcut
    // action" matches the shortcuts-global-only Target, so the semantic supplement supplies it —
    // which is exactly that channel's job.
    //
    // This used to abort with "not in the gate prompt": retrieval ranked INDEX.md rows only, and
    // the fixture has no INDEX.md, so the semantic channel was silently dead. It is dead in real
    // repos too whenever INDEX is incomplete — measured at 27% of axes on a real 86-axis corpus.
    // Candidate generation now reads the decisions directory, so the channel works as designed.
    const row = makeRow({
      repo: {
        base: {
          'lib/other.ts': 'export {};\n',
          'docs/decisions/shortcuts-global-only.md': DECOY_TARGET_MD,
        },
        staged: { 'lib/other.ts': 'export const x = 1;\n' },
      },
      gold: [],
    });
    const result = await runCase(row, {
      reviewerExec: async () => REVIEWER_TRANSCRIPT,
      matcherExec: matcherStub,
      saveTranscript: false,
    });
    expect(result.id).toBe('test-registration-gap');
  });

  it('a decoy Target that reaches the reviewer by NO channel aborts as a fixture bug', async () => {
    // The fixture-sanity assertion still bites: a decoy neither scope-matched nor topically
    // reachable tests nothing, so the bench must refuse to score the case rather than pass it.
    const row = makeRow({
      message: 'chore: bump lockfile',
      repo: {
        base: {
          'lib/other.ts': 'export {};\n',
          'docs/decisions/shortcuts-global-only.md': DECOY_TARGET_MD,
        },
        staged: { 'lib/other.ts': 'export const x = 1;\n' },
      },
      gold: [],
    });
    await expect(
      runCase(row, {
        reviewerExec: async () => REVIEWER_TRANSCRIPT,
        matcherExec: matcherStub,
        saveTranscript: false,
      }),
    ).rejects.toThrow(/not in the gate prompt/);
  });
});

// Durable completeness checkpoints

describe('completeness checkpoints', () => {
  const checkpointResult = (): CaseResult => ({
    id: 'test-registration-gap',
    reviewerModel: 'gpt-5.6-sol',
    findings: parseFindings(REVIEWER_TRANSCRIPT).findings,
    auditOutcomes: [
      { slotId: 'g1', match: 1, outage: false },
      { slotId: 'd1', match: 0, outage: false },
    ],
    outage: false,
    exit: 1,
    verdict: 'FAIL',
    warnings: [],
    score: {
      slots: [
        {
          slotId: 'g1',
          kind: 'gold',
          ok: true,
          got: 'hit',
          stable: true,
          outage: false,
        },
        {
          slotId: 'd1',
          kind: 'decoy',
          ok: true,
          got: 'clean',
          stable: true,
          outage: false,
        },
      ],
      severity: [{ expected: 'IMPORTANT', got: 'IMPORTANT' }],
      spurious: [2],
      findingCount: 2,
    },
  });

  it('accepts valid pending and complete rows, but rejects every outage and model mismatch', () => {
    const result = checkpointResult();
    expect(
      reusableCaseCheckpoint(asJson({ result, retryComplete: false }), 'gpt-5.6-sol'),
    ).toBeDefined();
    expect(
      reusableCaseCheckpoint(asJson({ result, retryComplete: true }), 'gpt-5.6-sol'),
    ).toBeDefined();

    expect(
      reusableCaseCheckpoint(
        asJson({ result: { ...result, outage: true }, retryComplete: true }),
        'gpt-5.6-sol',
      ),
    ).toBeUndefined();
    expect(
      reusableCaseCheckpoint(
        asJson({
          result: {
            ...result,
            score: {
              ...result.score!,
              slots: result.score!.slots.map((slot, i) =>
                i === 0 ? { ...slot, outage: true } : slot,
              ),
            },
          },
          retryComplete: true,
        }),
        'gpt-5.6-sol',
      ),
    ).toBeUndefined();
    expect(
      reusableCaseCheckpoint(
        asJson({
          result: {
            ...result,
            auditOutcomes: result.auditOutcomes!.map((slot, i) =>
              i === 0 ? { ...slot, outage: true } : slot,
            ),
          },
          retryComplete: true,
        }),
        'gpt-5.6-sol',
      ),
    ).toBeUndefined();
    expect(
      reusableCaseCheckpoint(
        asJson({ result: { ...result, reviewerModel: 'opus' }, retryComplete: true }),
        'gpt-5.6-sol',
      ),
    ).toBeUndefined();
    expect(
      reusableCaseCheckpoint(
        asJson({
          result: { ...result, score: { ...result.score!, slots: [null] } },
          retryComplete: true,
        }),
        'gpt-5.6-sol',
      ),
    ).toBeUndefined();
    expect(
      reusableCaseCheckpoint(
        asJson({ result: { ...result, findings: [null] }, retryComplete: true }),
        'gpt-5.6-sol',
      ),
    ).toBeUndefined();
    expect(
      reusableCaseCheckpointForRow({ result, retryComplete: true }, makeRow(), 'gpt-5.6-sol'),
    ).toBe(true);
    expect(
      reusableCaseCheckpointForRow(
        {
          result: {
            ...result,
            findings: [],
            auditOutcomes: [],
            score: { slots: [], severity: [], spurious: [], findingCount: 0 },
          },
          retryComplete: true,
        },
        makeRow(),
        'gpt-5.6-sol',
      ),
    ).toBe(false);
  });

  it('partitions paid reviewer and case evidence by exact MCP capabilities', () => {
    const row = makeRow();
    const caseA = completenessCaseCheckpointIdentity({
      reviewerModel: 'gpt-5.6-sol',
      mcpCapabilityFingerprint: 'mcp-a',
      retryBaselineHash: 'none',
      noLlm: false,
    });
    const caseB = completenessCaseCheckpointIdentity({
      reviewerModel: 'gpt-5.6-sol',
      mcpCapabilityFingerprint: 'mcp-b',
      retryBaselineHash: 'none',
      noLlm: false,
    });

    expect(caseA).not.toEqual(caseB);
    expect(completenessReviewerCheckpointIdentity('gpt-5.6-sol', 'mcp-a', false)).not.toEqual(
      completenessReviewerCheckpointIdentity('gpt-5.6-sol', 'mcp-b', false),
    );
    expect(completenessCaseInputHash(row, 'mcp-a')).not.toBe(
      completenessCaseInputHash(row, 'mcp-b'),
    );
  });

  it('persists the reviewer before matcher work and resumes every exact paid phase', async () => {
    const matcherValues = new Map<string, MatcherCheckpointValue>();
    const matcherCheckpoint: CheckpointStore<MatcherCheckpointValue> = {
      get size() {
        return matcherValues.size;
      },
      take(id, inputHash) {
        return matcherValues.get(JSON.stringify([id, inputHash]));
      },
      record(id, inputHash, value) {
        matcherValues.set(JSON.stringify([id, inputHash]), value);
      },
    };
    const events: string[] = [];
    let reviewerSaved: ReviewerCheckpointValue | undefined;
    let matcherCalls = 0;
    const first = await runCase(makeRow(), {
      reviewerExec: async () => REVIEWER_TRANSCRIPT,
      matcherExec: async ({ args }) => {
        expect(reviewerSaved).toBeDefined();
        events.push('matcher');
        matcherCalls += 1;
        return args[1].includes('export-csv missing from help menu') ? 'SLOT: F1' : 'SLOT: NONE';
      },
      matchRuns: 1,
      saveTranscript: false,
      matcherCheckpoint,
      onReviewerComplete: (value) => {
        reviewerSaved = value;
        events.push('reviewer-saved');
      },
    });
    expect(events[0]).toBe('reviewer-saved');
    expect(matcherCalls).toBe(2);
    expect(matcherCheckpoint.size).toBe(2);
    expect(reusableReviewerCheckpoint(asJson(reviewerSaved ?? null), 'gpt-5.6-sol')).toBeDefined();
    expect(reusableMatcherCheckpoint(asJson([...matcherValues.values()][0] ?? null))).toBeDefined();

    const second = await runCase(makeRow(), {
      reviewerResume: reviewerSaved,
      reviewerExec: async () => {
        throw new Error('an exact reviewer checkpoint must skip the reviewer');
      },
      matcherExec: async () => {
        throw new Error('exact matcher slot checkpoints must skip the matcher');
      },
      matchRuns: 1,
      saveTranscript: false,
      matcherCheckpoint,
      onReviewerComplete: () => {
        throw new Error('a resumed reviewer must not be recorded as newly completed');
      },
    });
    expect(second).toEqual(first);
  });

  it('reopens disk checkpoints after interruption without repaying the reviewer or finished slot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'completeness-restart-'));
    const row = makeRow();
    const reviewerKey = `${row.id}::primary`;
    const rowHash = completenessCaseInputHash(row, 'mcp-test');
    const reviewerIdentity = { test: 'reviewer-restart' };
    const matcherIdentity = { test: 'matcher-restart' };
    const openReviewer = () =>
      openCheckpointStore<ReviewerCheckpointValue>({
        kind: 'reviewer',
        identity: reviewerIdentity,
        dir,
        decode: (value) => reusableReviewerCheckpoint(value, 'gpt-5.6-sol'),
      });
    const openMatcher = () =>
      openCheckpointStore<MatcherCheckpointValue>({
        kind: 'matcher',
        identity: matcherIdentity,
        dir,
        decode: reusableMatcherCheckpoint,
        accept: (value) => !value.outcome.outage,
      });
    let reviewerCalls = 0;
    let goldCalls = 0;
    let decoyCalls = 0;
    try {
      const reviewer = openReviewer();
      const matcher = openMatcher();
      let announceGoldPersisted!: () => void;
      const goldPersisted = new Promise<void>((resolve) => {
        announceGoldPersisted = resolve;
      });
      const signalingMatcher: CheckpointStore<MatcherCheckpointValue> = {
        get size() {
          return matcher.size;
        },
        take: (id, inputHash) => matcher.take(id, inputHash),
        record(id, inputHash, value) {
          matcher.record(id, inputHash, value);
          if (id === completenessSlotKey(row.id, 'g1')) announceGoldPersisted();
        },
      };

      await expect(
        runCase(row, {
          reviewerExec: async () => {
            reviewerCalls += 1;
            return REVIEWER_TRANSCRIPT;
          },
          onReviewerComplete: (value) => reviewer.record(reviewerKey, rowHash, value),
          matcherExec: async ({ args }) => {
            if (args[1].includes('export-csv missing from help menu')) {
              goldCalls += 1;
              return 'SLOT: F1';
            }
            decoyCalls += 1;
            await goldPersisted;
            throw new Error('simulated interruption after one durable matcher slot');
          },
          matcherCheckpoint: signalingMatcher,
          matchRuns: 1,
          saveTranscript: false,
        }),
      ).rejects.toThrow(/simulated interruption/);

      const reopenedReviewer = openReviewer();
      const reopenedMatcher = openMatcher();
      expect(reopenedReviewer.take(reviewerKey, rowHash)).toBeDefined();
      expect(reopenedMatcher.size).toBe(1);
      const resumed = await runCase(row, {
        reviewerResume: reopenedReviewer.take(reviewerKey, rowHash),
        reviewerExec: async () => {
          throw new Error('durable reviewer response must not be repaid');
        },
        onReviewerComplete: () => {
          throw new Error('resumed reviewer response must not be rewritten');
        },
        matcherExec: async ({ args }) => {
          if (args[1].includes('export-csv missing from help menu')) {
            goldCalls += 1;
            return 'SLOT: F1';
          }
          decoyCalls += 1;
          return 'SLOT: NONE';
        },
        matcherCheckpoint: reopenedMatcher,
        matchRuns: 1,
        saveTranscript: false,
      });

      expect(resumed.score?.slots.every((slot) => slot.ok)).toBe(true);
      expect(reviewerCalls).toBe(1);
      expect(goldCalls).toBe(1);
      expect(decoyCalls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed reviewer and matcher phase values', () => {
    const reviewer: ReviewerCheckpointValue = {
      reviewerModel: 'gpt-5.6-sol',
      args: ['-p', 'prompt', '--model', 'gpt-5.6-sol'],
      raw: REVIEWER_TRANSCRIPT,
      exit: 1,
    };
    expect(reusableReviewerCheckpoint(asJson(reviewer), 'gpt-5.6-sol')).toBeDefined();
    expect(
      reusableReviewerCheckpoint(asJson({ ...reviewer, raw: '' }), 'gpt-5.6-sol'),
    ).toBeUndefined();
    expect(
      reusableReviewerCheckpoint(
        asJson({ ...reviewer, args: ['-p', 'prompt', '--model', 'opus'] }),
        'gpt-5.6-sol',
      ),
    ).toBeUndefined();
    expect(
      reusableMatcherCheckpoint(
        asJson({
          outcome: { slotId: 'g1', kind: 'gold', match: 1, stable: true, outage: false },
        }),
      ),
    ).toBeDefined();
    expect(
      reusableMatcherCheckpoint(
        asJson({
          outcome: { slotId: 'g1', kind: 'gold', match: 1, stable: false, outage: true },
        }),
      ),
    ).toBeUndefined();
  });

  it('reuses an exact independent audit and misses when findings or primary assignments change', async () => {
    const values = new Map<string, AuditCheckpointValue>();
    const checkpoint = {
      get size() {
        return values.size;
      },
      take(id: string, inputHash: string) {
        return values.get(JSON.stringify([id, inputHash]));
      },
      record(id: string, inputHash: string, value: AuditCheckpointValue) {
        values.set(JSON.stringify([id, inputHash]), value);
      },
    };
    const row = makeRow();
    const result = checkpointResult();
    let calls = 0;
    const exec = async ({ args }: { args: string[] }) => {
      calls += 1;
      return args[1].includes('export-csv missing from help menu') ? 'SLOT: F1' : 'SLOT: NONE';
    };

    await runIndependentMatcherAudit([row], [result], {
      model: 'gpt-5.6-sol',
      exec,
      checkpoint,
    });
    expect(calls).toBe(2);
    expect(checkpoint.size).toBe(2);

    const missingKey = [...values.entries()].find(
      ([, value]) => value.outcome.slotId === completenessSlotKey(row.id, 'd1'),
    )![0];
    values.delete(missingKey);
    await runIndependentMatcherAudit([row], [result], {
      model: 'gpt-5.6-sol',
      exec,
      checkpoint,
    });
    expect(calls).toBe(3);
    expect(checkpoint.size).toBe(2);

    await runIndependentMatcherAudit([row], [result], {
      model: 'gpt-5.6-sol',
      exec: async () => {
        throw new Error('an exact checkpoint hit must not invoke the judge');
      },
      checkpoint,
    });
    expect(calls).toBe(3);

    const [exactKey, exactValue] = [...values.entries()][0];
    values.set(exactKey, {
      outcome: { ...exactValue.outcome, match: result.findings!.length + 1 },
    });
    await runIndependentMatcherAudit([row], [result], {
      model: 'gpt-5.6-sol',
      exec,
      checkpoint,
    });
    expect(calls).toBe(4);

    const changedFindings = {
      ...result,
      findings: result.findings!.map((finding, i) =>
        i === 0 ? { ...finding, desc: `${finding.desc} (changed)` } : finding,
      ),
    };
    await runIndependentMatcherAudit([row], [changedFindings], {
      model: 'gpt-5.6-sol',
      exec,
      checkpoint,
    });
    expect(calls).toBe(6);

    const changedPrimary = {
      ...result,
      auditOutcomes: result.auditOutcomes!.map((outcome, i) =>
        i === 0 ? { ...outcome, match: 0 } : outcome,
      ),
    };
    await runIndependentMatcherAudit([row], [changedPrimary], {
      model: 'gpt-5.6-sol',
      exec,
      checkpoint,
    });
    expect(calls).toBe(8);

    const noFindings = {
      ...result,
      findings: [],
      auditOutcomes: result.auditOutcomes!.map((outcome) => ({ ...outcome, match: 0 })),
    };
    const noFindingAudit = await runIndependentMatcherAudit([row], [noFindings], {
      model: 'gpt-5.6-sol',
      exec: async () => {
        calls += 1;
        return 'SLOT: NONE';
      },
      checkpoint,
    });
    expect(noFindingAudit).toMatchObject({ n: 2, agree: 2, missing: [] });
    expect(calls).toBe(8);
  });
});

function summaryFrom(
  slotSpecs: Record<string, { kind: 'gold' | 'decoy'; ok: boolean; stable?: boolean }>,
): BenchSummary {
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
      reviewerModel: 'gpt-5.6-sol',
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
    const row = makeRow({ id: '__proto__' });
    const results = [
      {
        id: row.id,
        reviewerModel: 'gpt-5.6-sol',
        outage: false,
        exit: 0,
        verdict: 'FAIL',
        warnings: [],
        score: {
          slots: [
            {
              slotId: 'g1',
              kind: 'gold' as const,
              ok: true,
              got: 'hit' as const,
              stable: true,
              outage: false,
            },
            {
              slotId: 'd1',
              kind: 'decoy' as const,
              ok: false,
              got: 'flagged' as const,
              stable: true,
              outage: false,
            },
          ],
          severity: [{ expected: 'IMPORTANT' as const, got: 'CRITICAL' as const }],
          spurious: [3],
          findingCount: 3,
        },
      },
    ];
    const s = summarize([row], results as never);
    expect(s.gold).toEqual({ total: 1, hit: 1 });
    expect(s.reviewerModel).toBe('gpt-5.6-sol');
    expect(s.decoys).toEqual({ total: 1, flagged: 1, recorded: { total: 1, flagged: 1 } });
    expect(s.gapRecall).toBe(1);
    expect(s.falseFlagRate).toBe(1);
    expect(s.findings).toEqual({ total: 3, matched: 2, spurious: 1 });
    expect(s.severity.exact).toBe(0);
    expect(s.verdicts).toEqual({ total: 1, correct: 1 });
    expect(s.rows[row.id]).toEqual({ ok: false, stable: true }); // the flagged decoy sinks the case
    expect(s.slots[completenessSlotKey(row.id, 'g1')]).toMatchObject({ kind: 'gold', ok: true });
  });

  it('counts case outages and slot outages separately; outage slots join no metric', () => {
    const row = makeRow();
    const s = summarize([row, makeRow({ id: 'other' })], [
      {
        id: row.id,
        reviewerModel: 'gpt-5.6-sol',
        outage: true,
        exit: 0,
        verdict: null,
        warnings: [],
        score: null,
      },
      {
        id: 'other',
        reviewerModel: 'gpt-5.6-sol',
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
    ] as never);
    expect(s.caseOutages).toBe(1);
    expect(s.slotOutages).toBe(1);
    expect(s.outages).toBe(2);
    expect(s.gold.total).toBe(0); // the outage slot never joined
    expect(s.decoys.total).toBe(1);
  });

  it('a null verdict scores as PASS (the gate fail-open reading)', () => {
    const row = makeRow({ expectedVerdict: 'PASS', decoys: [], gold: [] });
    const s = summarize([row], [
      {
        id: row.id,
        reviewerModel: 'gpt-5.6-sol',
        outage: false,
        exit: 0,
        verdict: null,
        warnings: [],
        score: { slots: [], severity: [], spurious: [], findingCount: 0 },
      },
    ] as never);
    expect(s.verdicts).toEqual({ total: 1, correct: 1 });
  });
});

describe('reviewer model provenance', () => {
  it('requires one exact model across every observed judge argv', () => {
    expect(
      consistentReviewerModel([
        { id: 'a', reviewerModel: 'gpt-5.6-sol' },
        { id: 'b', reviewerModel: 'gpt-5.6-sol' },
      ]),
    ).toBe('gpt-5.6-sol');
    expect(() =>
      consistentReviewerModel([
        { id: 'a', reviewerModel: 'gpt-5.6-sol' },
        { id: 'b', reviewerModel: 'opus' },
      ]),
    ).toThrow(/inconsistent reviewer models/);
  });
});

describe('baseline-discordance retries', () => {
  const firstResult = (): CaseResult => ({
    id: 'case',
    reviewerModel: 'gpt-5.6-sol',
    outage: false,
    exit: 0,
    verdict: 'FAIL',
    warnings: [],
    score: {
      slots: [
        {
          slotId: 'g1',
          kind: 'gold',
          ok: false,
          got: 'miss',
          stable: true,
          outage: false,
        },
      ],
      severity: [],
      spurious: [],
      findingCount: 0,
    },
  });

  it('taints evidence and unconfirms the flip when the retry reviewer is dark', () => {
    const first = firstResult();
    const evidence = applyRetryEvidence(first, {
      ...firstResult(),
      outage: true,
      score: null,
    });
    expect(evidence).toEqual({ caseOutages: 1, slotOutages: 0 });
    expect(first.score?.slots[0].stable).toBe(false);
  });

  it('taints evidence and unconfirms the slot when the retry matcher is dark', () => {
    const first = firstResult();
    const retry = firstResult();
    retry.score!.slots[0].outage = true;
    const evidence = applyRetryEvidence(first, retry);
    expect(evidence).toEqual({ caseOutages: 0, slotOutages: 1 });
    expect(first.score?.slots[0].stable).toBe(false);
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
      'a::d1': { kind: 'decoy', ok: true },
      'a-var::g1': { kind: 'gold', ok: true },
      'a-var::d1': { kind: 'decoy', ok: true },
      'b::g1': { kind: 'gold', ok: true },
      'b::d1': { kind: 'decoy', ok: true },
      'b-var::g1': { kind: 'gold', ok: false },
      'b-var::d1': { kind: 'decoy', ok: true },
    });
    expect(variantConsistency(rows, s)).toEqual({ consistent: 1, total: 2, broken: ['b'] });
  });
  it('returns null with no variant groups', () => {
    expect(
      variantConsistency([makeRow()], summaryFrom({ 'x::g1': { kind: 'gold', ok: true } })),
    ).toBeNull();
  });
  it('compares equivalent slots by kind and ordinal rather than row-local ids', () => {
    const rows = [
      makeRow({ id: 'base', gold: [{ id: 'base-gap', severity: 'IMPORTANT', desc: 'gap' }] }),
      makeRow({
        id: 'variant',
        variantOf: 'base',
        variantKind: 'invariance',
        gold: [{ id: 'variant-gap', severity: 'IMPORTANT', desc: 'gap' }],
      }),
    ];
    const summary = summaryFrom({
      'base::base-gap': { kind: 'gold', ok: true },
      'base::d1': { kind: 'decoy', ok: true },
      'variant::variant-gap': { kind: 'gold', ok: true },
      'variant::d1': { kind: 'decoy', ok: true },
    });

    expect(variantConsistency(rows, summary)).toEqual({ consistent: 1, total: 1, broken: [] });
    expect(completenessSlotKey('a', 'b::c')).not.toBe(completenessSlotKey('a::b', 'c'));
  });
  it('ignores row-local finding order when equivalent slots have the same semantic outcome', () => {
    const rows = [
      makeRow({ id: 'base' }),
      makeRow({ id: 'variant', variantOf: 'base', variantKind: 'invariance' }),
    ];
    const summary = summaryFrom({
      'base::g1': { kind: 'gold', ok: true },
      'base::d1': { kind: 'decoy', ok: true },
      'variant::g1': { kind: 'gold', ok: true },
      'variant::d1': { kind: 'decoy', ok: true },
    });
    summary.slots[completenessSlotKey('base', 'g1')].got = 'F1';
    summary.slots[completenessSlotKey('variant', 'g1')].got = 'F2';

    expect(variantConsistency(rows, summary)).toEqual({ consistent: 1, total: 1, broken: [] });
  });
  it('ignores variants without an explicit invariance kind', () => {
    const rows = [
      makeRow({ id: 'base' }),
      makeRow({ id: 'missing-kind', variantOf: 'base' }),
      makeRow({ id: 'null-kind', variantOf: 'base', variantKind: null }),
    ];

    expect(variantConsistency(rows, { slots: {} })).toBeNull();
  });
  it('marks an invariance group with a missing base as broken', () => {
    const rows = [makeRow({ id: 'orphan', variantOf: '__proto__', variantKind: 'invariance' })];
    const summary = summaryFrom({ 'orphan::g1': { kind: 'gold', ok: true } });

    expect(variantConsistency(rows, summary)).toEqual({
      consistent: 0,
      total: 1,
      broken: ['__proto__'],
    });
  });
  it('marks a group with identical missing slot outcomes as broken', () => {
    const rows = [
      makeRow({ id: 'base' }),
      makeRow({ id: 'variant', variantOf: 'base', variantKind: 'invariance' }),
    ];

    expect(variantConsistency(rows, { slots: {} })).toEqual({
      consistent: 0,
      total: 1,
      broken: ['base'],
    });
  });
});

// ─── compareCompleteness ──────────────────────────────────────────────────────────

function baseSummary(overrides: Partial<BenchSummary> = {}): BenchSummary {
  return {
    reviewerModel: 'gpt-5.6-sol',
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
    rows: {
      a: { ok: true, stable: true },
      b: { ok: true, stable: true },
      c: { ok: true, stable: true },
      d: { ok: true, stable: true },
    },
    slots: {},
    gateHash: 'gh',
    mcpCapabilityFingerprint: 'mcp-a',
    matcherHash: 'mh',
    corpusHash: 'ch',
    ...overrides,
  };
}

describe('compareCompleteness', () => {
  it('skips without lying on config / hash / outage mismatches', () => {
    const base = baseSummary();
    expect(compareCompleteness(baseSummary({ matchModel: 'sonnet' }), base).lines[0]).toMatch(
      /config differs/,
    );
    expect(compareCompleteness(baseSummary({ gateHash: 'x' }), base).lines[0]).toMatch(
      /gate code \/ agent brief changed/,
    );
    expect(
      compareCompleteness(baseSummary({ mcpCapabilityFingerprint: 'mcp-b' }), base).lines[0],
    ).toMatch(/MCP capabilities differ/);
    expect(compareCompleteness(baseSummary({ matcherHash: 'x' }), base).lines[0]).toMatch(
      /matcher changed/,
    );
    expect(compareCompleteness(baseSummary({ corpusHash: 'x' }), base).lines[0]).toMatch(
      /corpus changed/,
    );
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
    const noisy = compareCompleteness(
      baseSummary({ falseFlagRate: CEILING_FALSE_FLAG + 0.01 }),
      base,
    );
    expect(noisy.regressed).toBe(true);
    expect(noisy.lines.join('\n')).toMatch(/CEILING BREACH/);
    const invalid = compareCompleteness(
      baseSummary({ gapRecall: Number.NaN, falseFlagRate: Number.POSITIVE_INFINITY }),
      base,
    );
    expect(invalid.regressed).toBe(true);
    expect(invalid.lines.join('\n')).toMatch(/not finite/);
  });

  it('a reviewer-model mismatch cannot bypass hard floors', () => {
    const result = compareCompleteness(
      baseSummary({ reviewerModel: 'gpt-5.6-sol', gapRecall: FLOOR_GAP_RECALL - 0.01 }),
      baseSummary({ reviewerModel: 'opus' }),
    );
    expect(result.regressed).toBe(true);
    expect(result.lines.join('\n')).toMatch(/FLOOR BREACH/);
    expect(result.lines.join('\n')).toMatch(/reviewerModel/);
  });

  it('a single stable case flip warns but does not regress; ~6 one-directional flips regress', () => {
    const mkRows = (bad: string[]) =>
      Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `c${i}`,
          { ok: !bad.includes(`c${i}`), stable: true },
        ]),
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
      rows: {
        a: { ok: true, stable: true },
        b: { ok: false, stable: true },
        c: { ok: true, stable: true },
      },
    });
    const churn = compareCompleteness(
      baseSummary({
        rows: {
          a: { ok: false, stable: true },
          b: { ok: true, stable: true },
          c: { ok: true, stable: true },
        },
      }),
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

describe('baseline eligibility', () => {
  const audited = { model: 'gpt-5.6-sol', n: 20, agree: 19, kappa: 0.9, missing: 0 };

  it('requires floors, zero outages, and a valid complete matcher audit', () => {
    expect(completenessBaselineEligibility(baseSummary({ matcherAudit: audited })).eligible).toBe(
      true,
    );
    expect(
      completenessBaselineEligibility(
        baseSummary({ outages: 1, matcherAudit: audited }),
      ).reasons.join('\n'),
    ).toMatch(/outage/);
    expect(
      completenessBaselineEligibility(
        baseSummary({ matcherAudit: { ...audited, kappa: 0.69 } }),
      ).reasons.join('\n'),
    ).toMatch(/κ/);
    expect(
      completenessBaselineEligibility(
        baseSummary({ matcherAudit: { ...audited, missing: 1 } }),
      ).reasons.join('\n'),
    ).toMatch(/lack fresh outcomes/);
    expect(
      completenessBaselineEligibility(
        baseSummary({ matcherAudit: { ...audited, missing: Number.NaN } }),
      ).eligible,
    ).toBe(false);
    expect(
      completenessBaselineEligibility(baseSummary({ matcherAudit: { ...audited, missing: -1 } }))
        .eligible,
    ).toBe(false);
    expect(
      completenessBaselineEligibility(
        baseSummary({ matcherAudit: { ...audited, model: '   ' } }),
      ).reasons.join('\n'),
    ).toMatch(/matcher audit model was not recorded/);
    expect(
      completenessBaselineEligibility(
        baseSummary({ matcherAudit: { ...audited, n: 0, kappa: Number.NaN } }),
      ).eligible,
    ).toBe(false);
    expect(
      completenessBaselineEligibility(
        baseSummary({ mcpCapabilityFingerprint: '   ', matcherAudit: audited }),
      ).reasons.join('\n'),
    ).toMatch(/MCP capability fingerprint/);
    expect(
      completenessBaselineEligibility(
        baseSummary({ gapRecall: Number.NaN, matcherAudit: audited }),
      ).reasons.join('\n'),
    ).toMatch(/gap recall is not a finite rate/);
    expect(
      completenessBaselineEligibility(baseSummary({ gapRecall: 1.01, matcherAudit: audited }))
        .eligible,
    ).toBe(false);
    expect(
      completenessBaselineEligibility(
        baseSummary({ falseFlagRate: Number.POSITIVE_INFINITY, matcherAudit: audited }),
      ).reasons.join('\n'),
    ).toMatch(/false-flag rate is not a finite rate/);
    expect(
      completenessBaselineEligibility(baseSummary({ falseFlagRate: -0.01, matcherAudit: audited }))
        .eligible,
    ).toBe(false);
  });

  it('rejects impossible metric counts and count/rate inconsistencies', () => {
    expect(
      completenessBaselineEligibility(
        baseSummary({ gold: { total: 4, hit: 5 }, matcherAudit: audited }),
      ).reasons.join('\n'),
    ).toMatch(/gold hits/);
    expect(
      completenessBaselineEligibility(
        baseSummary({ findings: { total: 6, matched: 6, spurious: 1 }, matcherAudit: audited }),
      ).reasons.join('\n'),
    ).toMatch(/do not equal total findings/);
    expect(
      completenessBaselineEligibility(
        baseSummary({ gapRecall: 0.75, matcherAudit: audited }),
      ).reasons.join('\n'),
    ).toMatch(/does not match gold hit\/total counts/);
    expect(
      completenessBaselineEligibility(
        baseSummary({ cases: 5, matcherAudit: audited }),
      ).reasons.join('\n'),
    ).toMatch(/measured rows plus case outages/);
  });

  it('does not overwrite a baseline after an outage or model-mismatched floor failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'completeness-baseline-test-'));
    const file = join(dir, 'results.baseline.json');
    try {
      writeFileSync(file, 'preserve-me\n');
      const historical = { completeness: baseSummary({ reviewerModel: 'opus' }) };
      expect(() =>
        writeCompletenessBaseline(
          file,
          historical,
          baseSummary({
            reviewerModel: 'gpt-5.6-sol',
            gapRecall: FLOOR_GAP_RECALL - 0.01,
            matcherAudit: audited,
          }),
        ),
      ).toThrow(/refusing baseline write/);
      expect(readFileSync(file, 'utf8')).toBe('preserve-me\n');
      expect(() =>
        writeCompletenessBaseline(
          file,
          historical,
          baseSummary({ matcherAudit: { ...audited, missing: Number.NaN } }),
        ),
      ).toThrow(/refusing baseline write/);
      expect(readFileSync(file, 'utf8')).toBe('preserve-me\n');
      expect(() =>
        writeCompletenessBaseline(
          file,
          historical,
          baseSummary({ gapRecall: Number.NaN, matcherAudit: audited }),
        ),
      ).toThrow(/refusing baseline write/);
      expect(readFileSync(file, 'utf8')).toBe('preserve-me\n');
      expect(() =>
        writeCompletenessBaseline(
          file,
          historical,
          baseSummary({ outages: 1, matcherAudit: audited }),
        ),
      ).toThrow(/refusing baseline write/);
      expect(readFileSync(file, 'utf8')).toBe('preserve-me\n');
      expect(() =>
        writeCompletenessBaseline(
          file,
          historical,
          baseSummary({ mcpCapabilityFingerprint: '', matcherAudit: audited }),
        ),
      ).toThrow(/refusing baseline write/);
      expect(readFileSync(file, 'utf8')).toBe('preserve-me\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomically replaces an eligible baseline without leaving a temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'completeness-baseline-test-'));
    const file = join(dir, 'results.baseline.json');
    try {
      writeFileSync(file, 'old evidence\n');
      const summary = baseSummary({ matcherAudit: audited });

      writeCompletenessBaseline(file, { completeness: baseSummary() }, summary);

      expect(parseJson(readFileSync(file, 'utf8'))).toMatchObject({ completeness: summary });
      expect(readdirSync(dir)).toEqual(['results.baseline.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
          expect(
            t,
            `${row.id}: decoy Target ${d.targetSlug} must parse (needs a **Scope:** field)`,
          ).toBeDefined();
          expect(
            matchScope(fx.staged, t?.scopeGlobs),
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
    for (const r of corpus)
      if (r.variantOf) expect(ids.has(r.variantOf), `${r.id} → ${r.variantOf}`).toBe(true);
  });
});

// ─── matcherAudit ─────────────────────────────────────────────────────────────────

describe('matcherAudit', () => {
  const transcripts: Record<string, { outcomes: { slotId: string; match: number }[] }> = {
    'case-a': {
      outcomes: [
        { slotId: 'g1', match: 1 },
        { slotId: 'd1', match: 0 },
      ],
    },
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

  it('rejects malformed audit match labels', () => {
    const labels = '{"caseId":"case-a","slotId":"g1","match":"F0"}';

    expect(() => matcherAudit(labels, read)).toThrow(/malformed audit label/);
  });

  it('refuses transcript-local labels when the reviewer model changed', () => {
    const labels = '{"caseId":"case-a","slotId":"g1","match":"F1"}';
    expect(() =>
      matcherAudit(
        labels,
        () => ({ reviewerModel: 'gpt-5.6-sol', outcomes: [{ slotId: 'g1', match: 1 }] }),
        'opus',
      ),
    ).toThrow(/labels are bound to reviewer=opus/);
  });
});
