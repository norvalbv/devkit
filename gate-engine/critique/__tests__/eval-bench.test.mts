// critique-eval unit tests — every pure metric/parser/scoring path, plus the row runners with
// injected execs (zero claude calls, zero tokens). The fixture-repo paths use REAL git in a
// tmpdir (the decisions-eval convention) — cheap, and the materialize contract is load-bearing.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { critiqueEligibility, parsePlanCritiqueResponse } from '../contract.mts';
import {
  aggregateSummaries,
  compare,
  isDecoyOnly,
  lintRows,
  type Row,
  type RunDeps,
  runIntrinsicRow,
  runWorkflowRow,
  type Summary,
  summarize,
} from '../eval/bench.mts';
import {
  buildDecoyPrompt,
  buildGoldPrompt,
  type DecoySlot,
  type Finding,
  type GoldSlot,
  kappa,
  mapPool,
  parseReportFindings,
  parseSlotReply,
  runMatcher,
  scoreCase,
  voteSlot,
} from '../eval/matcher.mts';
import { summarizePlanUplift } from '../eval/plan-uplift.mts';
import {
  BENCHMARK_DIRECTIVE,
  buildIntrinsicArgs,
  buildWorkflowArgs,
  parseSummary,
  runWorkflow,
  WORKFLOW_TOOLS,
} from '../eval/run-critic.mts';

const critic = { body: 'AGENT BODY', model: 'opus', raw: '---\nmodel: opus\n---\nAGENT BODY' };

const jsonResponse = (verdict = 'RETHINK', frameMeta = 'BANDAID', findings: unknown[] = []) =>
  JSON.stringify({
    schemaVersion: 1,
    kind: 'plan_critique',
    phase: 'plan',
    status: 'reviewed',
    verdict,
    feasibility: 'Partially Feasible',
    frameMeta,
    summary: 'The fix hides the symptom.',
    findings,
    edgeCases: [
      {
        risk: 'unhandled input',
        scenario: 'the input is malformed',
        expectedBehavior: 'return an ineligible record',
        testType: 'unit',
      },
    ],
    actions: ['Implement the canonical home first'],
  });

const SUMMARY_OK = jsonResponse('RETHINK', 'BANDAID', [
  {
    severity: 'critical',
    lens: 'frame',
    claim: 'The plan fixes the wrong layer.',
    evidence: 'Target x assigns the responsibility elsewhere.',
    impact: 'The root cause remains.',
    recommendation: 'Implement the target state.',
  },
  {
    severity: 'critical',
    lens: 'alignment',
    claim: 'The plan contradicts the target.',
    evidence: 'Target x rejects this mechanism.',
    impact: 'The decision gate blocks.',
    recommendation: 'Revise the mechanism.',
  },
  {
    severity: 'warning',
    lens: 'ux',
    claim: 'Migration copy is incomplete.',
    evidence: 'The plan omits existing users.',
    impact: 'Users see extra friction.',
    recommendation: 'Add migration guidance.',
  },
]);

// ─── run-critic: argv order (the variadic-swallow trap) ───────────────────────────

describe('argv builders', () => {
  it('intrinsic: positional prompt sits BEFORE the variadic tool flags', () => {
    const args = buildIntrinsicArgs('PROPOSAL', critic);
    const prompt = args.findIndex((a) => a.includes('PROPOSAL'));
    expect(prompt).toBeGreaterThan(-1);
    expect(args[prompt].startsWith(BENCHMARK_DIRECTIVE)).toBe(true);
    expect(prompt).toBeGreaterThan(args.indexOf('--no-session-persistence'));
    expect(args.indexOf('--disallowedTools')).toBeGreaterThan(prompt);
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('AGENT BODY');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
  });

  it('workflow: prompt before --allowedTools, tools as ONE comma-joined string', () => {
    const args = buildWorkflowArgs('PROPOSAL', critic);
    const prompt = args.indexOf('PROPOSAL');
    const allowed = args.indexOf('--allowedTools');
    expect(prompt).toBeGreaterThan(-1);
    expect(allowed).toBeGreaterThan(prompt);
    expect(args[allowed + 1]).toBe(WORKFLOW_TOOLS);
    expect(args.filter((a) => a === '--allowedTools')).toHaveLength(1);
    expect(args).not.toContain('--disallowedTools');
  });
});

// ─── run-critic: summary parsing ──────────────────────────────────────────────────

describe('parseSummary', () => {
  it('parses the exact JSON contract', () => {
    const s = parseSummary(SUMMARY_OK);
    expect(s.verdict).toBe('RETHINK');
    expect(s.frameMeta).toBe('BANDAID');
    expect(s.criticalCount).toBe(2);
    expect(s.warningCount).toBe(1);
    expect(s.feasibility).toBe('Partially Feasible');
  });

  it('maps the JSON underscore verdict onto the historical benchmark label', () => {
    expect(parseSummary(jsonResponse('PROCEED_WITH_CHANGES', 'SOUND')).verdict).toBe(
      'PROCEED WITH CHANGES',
    );
    expect(parseSummary(jsonResponse('PROCEED', 'SOUND')).verdict).toBe('PROCEED');
  });

  it('ambiguity parses NULL, never a guess', () => {
    expect(parseSummary('no block at all').verdict).toBeNull();
    expect(parseSummary('```json\n{}\n```').frameMeta).toBeNull();
    expect(parseSummary('{"kind":').criticalCount).toBeNull();
  });

  it('rejects legacy compact-summary output', () => {
    expect(parseSummary('**VERDICT**: REJECT').verdict).toBeNull();
  });
});

describe('contract regression corpus', () => {
  it('locks mined legacy formats, wrong-phase handling, malformed JSON, and no flow id', () => {
    const rows = readFileSync(new URL('../eval/cases-contract.jsonl', import.meta.url), 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            raw: string;
            contractState: 'valid' | 'invalid';
            eligibilityReason: string;
            livePrompt?: string;
            expectedStatus?: string;
          },
      );
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      expectedStatus: 'wrong_phase',
      livePrompt: expect.stringContaining('implementation is complete'),
    });
    for (const row of rows) {
      const contract = parsePlanCritiqueResponse(row.raw);
      expect(contract.state, row.id).toBe(row.contractState);
      expect(critiqueEligibility(contract).reason, row.id).toBe(row.eligibilityReason);
    }
  });
});

describe('paired plan uplift', () => {
  it('reports paired gains, harms, sound-plan revisions, cost, and pass arms separately', () => {
    const assessment = (
      residualGoldFlawIds: string[],
      introducedDefectIds: string[],
      completeness: number,
      tokens: number,
      latencyMs: number,
    ) => ({
      residualGoldFlawIds,
      introducedDefectIds,
      completeness,
      contractValid: true,
      tokens,
      latencyMs,
    });
    const result = summarizePlanUplift([
      {
        schemaVersion: 1,
        caseId: 'flawed',
        generatorModelFamily: 'family-a',
        criticModelFamily: 'family-b',
        critiquePasses: 1,
        revised: true,
        goldFlawIds: ['f1'],
        initial: assessment(['f1'], [], 0.6, 100, 1000),
        refined: assessment([], [], 0.9, 140, 1400),
      },
      {
        schemaVersion: 1,
        caseId: 'sound',
        generatorModelFamily: 'family-a',
        criticModelFamily: 'family-a',
        critiquePasses: 2,
        revised: true,
        goldFlawIds: [],
        initial: assessment([], [], 1, 100, 1000),
        refined: assessment([], ['new-defect'], 0.8, 180, 1800),
      },
    ]);
    expect(result.all.residualGoldFlaws).toEqual({ initial: 1, refined: 0, delta: -1 });
    expect(result.all.pairedResidual).toEqual({ improved: 1, worsened: 0, tied: 1 });
    expect(result.all.introducedDefects.delta).toBe(1);
    expect(result.all.falseRevisions).toMatchObject({ count: 1, total: 1, rate: 1 });
    expect(result.all.critiqueCycles).toEqual({ total: 3, mean: 1.5 });
    expect(result.all.sameFamilyPairs).toBe(1);
    expect(result.onePass.cases).toBe(1);
    expect(result.twoPass.cases).toBe(1);
  });
});

// ─── matcher: report parsing ──────────────────────────────────────────────────────

const REPORT = `# Feature Critique: X

## Executive Summary
Bad.

## Critical Issues (Blockers)
1. **Symlinks not followed**
   - Problem: neither tool follows them
   - Impact: silent no-op
2. **Dangling links on uninstall**

## Warnings (Non-blocking but significant)
1. **Git symlink handling varies**
   - Concern: windows checkouts

## What's Good
- The goal itself
`;

describe('parseReportFindings', () => {
  it('extracts numbered items per section with severities', () => {
    const f = parseReportFindings(REPORT);
    expect(f.map((x) => [x.severity, x.desc])).toEqual([
      ['CRITICAL', 'Symlinks not followed'],
      ['CRITICAL', 'Dangling links on uninstall'],
      ['WARNING', 'Git symlink handling varies'],
    ]);
    expect(f[0].body).toContain('Problem: neither tool follows them');
  });

  it('absent sections parse to zero findings, and "What\'s Good" items never leak in', () => {
    expect(parseReportFindings('# nothing here')).toEqual([]);
    expect(parseReportFindings(REPORT).some((f) => f.desc.includes('goal'))).toBe(false);
  });
});

// ─── matcher: reply parsing + voting ──────────────────────────────────────────────

describe('parseSlotReply', () => {
  it('last SLOT line wins; NONE → 0; out-of-range → null', () => {
    expect(parseSlotReply('thinking...\nSLOT: F2', 3)).toBe(2);
    expect(parseSlotReply('SLOT: F1\nactually\nSLOT: NONE', 3)).toBe(0);
    expect(parseSlotReply('SLOT: F9', 3)).toBeNull();
    expect(parseSlotReply('no line', 3)).toBeNull();
    expect(parseSlotReply('**SLOT**: F 2', 3)).toBe(2);
  });
});

describe('voteSlot', () => {
  it('majority wins and unanimity marks stable', () => {
    expect(voteSlot([1, 1, 1])).toEqual({ match: 1, stable: true, outage: false });
    expect(voteSlot([1, 1, 0])).toEqual({ match: 1, stable: false, outage: false });
  });
  it('tie → NONE-as-instability; all-null → outage; NULL-majority fails safe', () => {
    expect(voteSlot([1, 0])).toEqual({ match: 0, stable: false, outage: false });
    expect(voteSlot([null, null, null])).toEqual({ match: 0, stable: false, outage: true });
    // Two dark trials + one vote is a NULL majority — fail-safe no-match, not a 1-vote win.
    expect(voteSlot([null, null, 2])).toEqual({ match: 0, stable: false, outage: false });
    expect(voteSlot([null, 2, 2])).toEqual({ match: 2, stable: false, outage: false });
  });
});

// ─── matcher: scoring ─────────────────────────────────────────────────────────────

const GOLD: GoldSlot[] = [
  { id: 'F1', class: 'feasibility', severity: 'CRITICAL', desc: 'symlinks not followed' },
  { id: 'F2', class: 'data-flow', severity: 'WARNING', desc: 'dangling links' },
];
const DECOYS: DecoySlot[] = [{ id: 'D1', kind: 'sound-choice', desc: 'single source of truth' }];
const FINDINGS: Finding[] = [
  { severity: 'CRITICAL', desc: 'no symlink support', body: '' },
  { severity: 'CRITICAL', desc: 'single source of truth is wrong', body: '' },
  { severity: 'WARNING', desc: 'uninstall leaves links', body: '' },
];

describe('scoreCase', () => {
  it('hits, misses, decoy blocker rule, fabricated criticals', () => {
    const score = scoreCase(GOLD, DECOYS, FINDINGS, [
      { slotId: 'F1', kind: 'gold', match: 1, stable: true, outage: false },
      { slotId: 'F2', kind: 'gold', match: 0, stable: true, outage: false },
      { slotId: 'D1', kind: 'decoy', match: 2, stable: true, outage: false },
    ]);
    expect(score.slots.find((s) => s.slotId === 'F1')).toMatchObject({
      got: 'hit',
      ok: true,
      class: 'feasibility',
    });
    expect(score.slots.find((s) => s.slotId === 'F2')).toMatchObject({ got: 'miss', ok: false });
    // Decoy matched by a CRITICAL finding = flagged (the failure).
    expect(score.slots.find((s) => s.slotId === 'D1')).toMatchObject({ got: 'flagged', ok: false });
    // Finding 2 (critical, unclaimed by gold) and finding 1 claimed → fabricated = [2].
    expect(score.fabricatedCriticals).toEqual([2]);
    expect(score.severity).toEqual([{ slotId: 'F1', expected: 'CRITICAL', got: 'CRITICAL' }]);
  });

  it('decoy matched by a WARNING is "mentioned" — allowed hedging', () => {
    const score = scoreCase([], DECOYS, FINDINGS, [
      { slotId: 'D1', kind: 'decoy', match: 3, stable: true, outage: false },
    ]);
    expect(score.slots[0]).toMatchObject({ got: 'mentioned', ok: true });
    // Empty gold: every CRITICAL is fabricated by construction.
    expect(score.fabricatedCriticals).toEqual([1, 2]);
  });
});

describe('kappa', () => {
  it('1 on perfect agreement, ~0 at chance, NaN on empty', () => {
    expect(kappa(['1', '0', '2'], ['1', '0', '2'])).toBe(1);
    expect(kappa([], [])).toBeNaN();
    // All-NONE matcher vs mixed labels: raw agreement 50% but kappa 0 (the inflation case).
    expect(kappa(['0', '0', '0', '0'], ['0', '1', '0', '2'])).toBeLessThanOrEqual(0);
  });
});

describe('runMatcher', () => {
  it('zero findings short-circuits with no claude calls', async () => {
    let calls = 0;
    const exec = async () => {
      calls += 1;
      return 'SLOT: NONE';
    };
    const out = await runMatcher(GOLD, DECOYS, [], { exec: exec as never });
    expect(calls).toBe(0);
    expect(out).toHaveLength(3);
    expect(out.every((o) => o.match === 0 && o.stable && !o.outage)).toBe(true);
  });

  it('retries once on an unparseable reply, and argv carries the isolation flags', async () => {
    const argvs: string[][] = [];
    let first = true;
    const exec = async ({ args }: { args: string[] }) => {
      argvs.push(args);
      if (first) {
        first = false;
        return 'gibberish';
      }
      return 'SLOT: F1';
    };
    const out = await runMatcher([GOLD[0]], [], FINDINGS, { runs: 1, exec: exec as never });
    expect(out[0].match).toBe(1);
    expect(argvs).toHaveLength(2); // one flake + one retry
    expect(argvs[0]).toContain('--disallowedTools');
    expect(argvs[0]).toContain('--no-session-persistence');
  });
});

describe('prompts', () => {
  it('withhold tiers from the matcher and number the findings', () => {
    const g = buildGoldPrompt(GOLD[0], FINDINGS);
    expect(g).toContain('F1 (CRITICAL): no symlink support');
    expect(g).not.toContain('feasibility'); // class withheld
    const d = buildDecoyPrompt(DECOYS[0], FINDINGS);
    expect(d).toContain('DECOY: single source of truth');
  });
});

describe('mapPool', () => {
  it('preserves order under bounded concurrency', async () => {
    const out = await mapPool([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });
});

// ─── bench: corpus lint ───────────────────────────────────────────────────────────

const baseRow: Row = {
  id: 'r1',
  mode: 'intrinsic',
  prompt: 'p',
  expectVerdict: ['RETHINK'],
  category: 'c',
  note: 'why',
};

describe('lintRows', () => {
  it('accepts a minimal valid corpus', () => {
    expect(lintRows([baseRow])).toEqual([]);
  });
  it('rejects the schema drifts that corrupt metrics silently', () => {
    const bad: Row[] = [
      { ...baseRow, id: 'dup' },
      { ...baseRow, id: 'dup' },
      { ...baseRow, id: 'r2', note: '' },
      { ...baseRow, id: 'r3', expectVerdict: ['MAYBE' as never] },
      {
        ...baseRow,
        id: 'r4',
        gold: [{ id: 'g', class: 'feasibility', severity: 'CRITICAL', desc: 'x' }],
      },
      { ...baseRow, id: 'r5', mode: 'workflow' },
      { ...baseRow, id: 'r6', variantOf: 'nope' },
      {
        ...baseRow,
        id: 'r7',
        mode: 'workflow',
        repo: { base: { 'a.txt': 'x' }, staged: {} },
        gold: [{ id: 'g', class: 'not-a-class' as never, severity: 'CRITICAL', desc: 'x' }],
      },
    ];
    const problems = lintRows(bad);
    expect(problems.join('\n')).toContain('duplicate id');
    expect(problems.join('\n')).toContain('note is mandatory');
    expect(problems.join('\n')).toContain('unknown verdict MAYBE');
    expect(problems.join('\n')).toContain('intrinsic rows are closed-set only');
    expect(problems.join('\n')).toContain('workflow row needs repo.base');
    expect(problems.join('\n')).toContain('variantOf nope not in corpus');
    expect(problems.join('\n')).toContain('unknown class not-a-class');
  });
});

// ─── bench: aggregation ───────────────────────────────────────────────────────────

describe('aggregateSummaries', () => {
  it('majority verdict + set-membership; tie → NULL', () => {
    const s = (verdict: string | null, meta: string | null) =>
      ({ verdict, frameMeta: meta }) as never;
    const agg = aggregateSummaries(
      [s('RETHINK', 'BANDAID'), s('RETHINK', 'SOUND'), s('REJECT', 'BANDAID')],
      { expectVerdict: ['RETHINK', 'REJECT'], expectFrameMeta: ['BANDAID'] },
    );
    expect(agg.verdict).toEqual({ got: 'RETHINK', ok: true, stable: false });
    expect(agg.frameMeta).toEqual({ got: 'BANDAID', ok: true, stable: false });
    const tie = aggregateSummaries([s('RETHINK', null), s('REJECT', null)], {
      expectVerdict: ['PROCEED'],
    });
    expect(tie.verdict.got).toBe('NULL');
    expect(tie.verdict.ok).toBe(false);
    expect(tie.frameMeta).toBeNull();
  });
});

// ─── bench: row runners with injected execs (no claude, real fixtures) ────────────

const noDeps: Omit<RunDeps, 'critic' | 'runs'> = { registerCleanup: () => {} };

describe('runIntrinsicRow', () => {
  it('votes K trials and applies the ported text checks', async () => {
    const outs = [
      jsonResponse('RETHINK', 'BANDAID'),
      jsonResponse('RETHINK', 'BANDAID').replace('canonical home', 'band-aid'),
      jsonResponse('PROCEED', 'SOUND').replace('canonical home', 'fine'),
    ];
    let k = 0;
    const r = await runIntrinsicRow(
      { ...baseRow, expectFrameMeta: ['BANDAID'], requireAny: ['canonical', 'band-aid'] },
      { ...noDeps, critic, runs: 3, execIntrinsic: (async () => outs[k++]) as never },
    );
    expect(r.verdict).toMatchObject({ got: 'RETHINK', ok: true, stable: false });
    expect(r.frameMeta).toMatchObject({ got: 'BANDAID', ok: true });
    expect(r.textOk).toBe(true); // 2 of 3 runs hit a requireAny term
    expect(r.ok).toBe(true);
  });

  it('aborts the run on a dark trial (cheap class)', async () => {
    await expect(
      runIntrinsicRow(baseRow, {
        ...noDeps,
        critic,
        runs: 1,
        execIntrinsic: (async () => null) as never,
      }),
    ).rejects.toMatchObject({ code: 2 });
  });
});

describe('runWorkflowRow', () => {
  const row: Row = {
    id: 'w1',
    mode: 'workflow',
    prompt: 'critique this',
    repo: { base: { 'src/a.ts': 'x' }, staged: {} },
    gold: [GOLD[0]],
    decoys: [DECOYS[0]],
    expectVerdict: ['RETHINK'],
    category: 'c',
    note: 'why',
  };
  const wfOut = (raw: string | null) => async () => ({
    raw,
    report: raw === null ? null : REPORT,
    artifact: raw,
    artifactPath: 'x',
    contractValid: raw !== null,
    repositoryUnchanged: true,
    providerArtifactsAbsent: true,
  });
  const matchStub = async () => [
    { slotId: 'F1', kind: 'gold' as const, match: 1, stable: true, outage: false },
    { slotId: 'D1', kind: 'decoy' as const, match: 0, stable: true, outage: false },
  ];

  it('aggregates slots/contract across trials', async () => {
    const r = await runWorkflowRow(row, {
      ...noDeps,
      critic,
      runs: 1,
      execWorkflow: wfOut(jsonResponse()) as never,
      match: matchStub as never,
    });
    expect(r.outage).toBe(false);
    expect(r.slots.F1).toMatchObject({ got: 'hit', ok: true });
    expect(r.slots.D1).toMatchObject({ got: 'clean', ok: true });
    expect(r.contract).toMatchObject({
      jsonContractValid: true,
      edgeCasesValid: true,
      repositoryUnchanged: true,
      providerArtifactsAbsent: true,
    });
    expect(r.falseAlarm).toBeNull(); // row has gold — not a decoy-only instrument
    expect(r.ok).toBe(true);
  });

  it('salvaged trials replace spawning entirely; missing artifact scores null, not fail', async () => {
    let spawns = 0;
    const salvage = () => [
      { raw: jsonResponse(), report: REPORT, artifact: null },
      { raw: jsonResponse(), report: REPORT, artifact: null },
      { raw: jsonResponse(), report: REPORT, artifact: null },
    ];
    const r = await runWorkflowRow(row, {
      ...noDeps,
      critic,
      runs: 3,
      salvage,
      execWorkflow: (async () => {
        spawns += 1;
        return {
          raw: null,
          report: null,
          artifact: null,
          artifactPath: '',
          contractValid: false,
          repositoryUnchanged: true,
          providerArtifactsAbsent: true,
        };
      }) as never,
      match: matchStub as never,
    });
    expect(spawns).toBe(0); // already-paid trials — nothing re-bought
    expect(r.outage).toBe(false);
    expect(r.verdict).toMatchObject({ got: 'RETHINK', ok: true, stable: true });
    expect(r.contract).toMatchObject({
      jsonContractValid: true,
      edgeCasesValid: true,
      repositoryUnchanged: null,
      providerArtifactsAbsent: null,
    });
  });

  it('too few salvaged trials for a K-majority falls back to live spawning', async () => {
    let spawns = 0;
    const r = await runWorkflowRow(row, {
      ...noDeps,
      critic,
      runs: 3,
      salvage: () => [{ raw: jsonResponse(), report: null, artifact: null }], // 1 < 2
      execWorkflow: (async () => {
        spawns += 1;
        return {
          raw: jsonResponse(),
          report: REPORT,
          artifact: jsonResponse(),
          artifactPath: 'x',
          contractValid: true,
          repositoryUnchanged: true,
          providerArtifactsAbsent: true,
        };
      }) as never,
      match: matchStub as never,
    });
    expect(spawns).toBe(3);
    expect(r.contract).toMatchObject({ edgeCasesValid: true, repositoryUnchanged: true });
  });

  it('scores NULL when completed trials fall below the K-majority minimum', async () => {
    const r = await runWorkflowRow(row, {
      ...noDeps,
      critic,
      runs: 3,
      execWorkflow: wfOut(null) as never,
      match: matchStub as never,
    });
    expect(r.outage).toBe(true);
    expect(r.verdict.got).toBe('NULL');
  });
});

// ─── run-critic: workflow JSON + no-write contract ────────────────────────────────

describe('runWorkflow', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'critique-eval-test-'));
  execFileSync('git', ['init', '-q', dir]);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('derives matcher findings from JSON and leaves the fixture untouched', async () => {
    let seenPrompt = '';
    const raw = jsonResponse('PROCEED', 'SOUND');
    const exec = async ({ args }: { args: string[] }) => {
      seenPrompt = args.find((a) => a.includes('critique this')) ?? '';
      return raw;
    };
    const out = await runWorkflow({
      critic,
      prompt: 'critique this',
      fixtureDir: dir,
      exec: exec as never,
    });
    expect(seenPrompt).toBe('critique this');
    expect(out.report).toContain('## Critical Issues');
    expect(out.artifact).toBe(raw);
    expect(out.artifactPath).toBe('response.edgeCases');
    expect(out).toMatchObject({
      contractValid: true,
      repositoryUnchanged: true,
      providerArtifactsAbsent: true,
    });
  });
});

// ─── bench: summarize + compare ───────────────────────────────────────────────────

function mkSummary(over: Partial<Summary> = {}): Summary {
  return {
    model: 'opus',
    matchModel: 'haiku',
    runs: 3,
    matchRuns: 3,
    agentHash: 'a',
    runnerHash: 'r',
    corpusHash: 'c',
    outages: 0,
    recall: { hits: 8, total: 10 },
    cleanRate: { clean: 4, total: 5 },
    decoyFlags: { flagged: 0, mentioned: 1, total: 8 },
    perClass: Object.fromEntries(
      [
        'feasibility',
        'ux',
        'security',
        'codebase-conflict',
        'data-flow',
        'runtime-config',
        'missing-consideration',
      ].map((c) => [c, { hits: 1, total: 1 }]),
    ) as Summary['perClass'],
    verdictAccuracy: { correct: 9, total: 10 },
    confusion: {},
    frameMetaAccuracy: { correct: 5, total: 6 },
    severityCalibration: { exact: 6, total: 8 },
    precisionInfo: { matched: 8, emitted: 12 },
    contract: {},
    rows: {},
    ...over,
  };
}

describe('compare', () => {
  it('skips on config/hash mismatch and on outages — never lies', () => {
    expect(compare(mkSummary({ model: 'sonnet' }), mkSummary()).lines[0]).toContain(
      'config differs',
    );
    expect(compare(mkSummary({ agentHash: 'zzz' }), mkSummary()).lines[0]).toContain(
      'agentHash changed',
    );
    expect(compare(mkSummary({ outages: 2 }), mkSummary()).lines[0]).toContain('outage');
    for (const c of [
      compare(mkSummary({ model: 'sonnet' }), mkSummary()),
      compare(mkSummary({ outages: 2 }), mkSummary()),
    ])
      expect(c.regressed).toBe(false);
  });

  it('NEW floor breaches fail immediately', () => {
    const c = compare(mkSummary({ recall: { hits: 5, total: 10 } }), mkSummary());
    expect(c.regressed).toBe(true);
    expect(c.lines.join('\n')).toContain('valid-flaw recall');
    const ceil = compare(
      mkSummary({ decoyFlags: { flagged: 3, mentioned: 0, total: 8 } }),
      mkSummary(),
    );
    expect(ceil.regressed).toBe(true);
  });

  it('a breach the baseline already carries prints loudly but does not gate', () => {
    const breached = { cleanRate: { clean: 1, total: 5 } };
    const c = compare(mkSummary(breached), mkSummary(breached));
    expect(c.regressed).toBe(false);
    expect(c.lines.join('\n')).toContain('KNOWN FLOOR BREACH');
    expect(c.lines.join('\n')).toContain('B2 target');
  });

  it('row-level verdict flips gate via mid-p; one stable flip is noise, not regression', () => {
    const rowsBase = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `r${i}`,
        {
          expected: 'RETHINK',
          got: 'RETHINK',
          ok: true,
          verdictOk: true,
          verdictStable: true,
          slots: {},
          falseAlarm: null,
          outage: false,
        },
      ]),
    );
    const oneFlip = structuredClone(rowsBase);
    oneFlip.r0 = { ...oneFlip.r0, verdictOk: false, got: 'PROCEED', ok: false };
    expect(compare(mkSummary({ rows: oneFlip }), mkSummary({ rows: rowsBase })).regressed).toBe(
      false,
    );
    const manyFlips = structuredClone(rowsBase);
    for (const id of ['r0', 'r1', 'r2', 'r3', 'r4'])
      manyFlips[id] = { ...manyFlips[id], verdictOk: false, got: 'PROCEED', ok: false };
    const c = compare(mkSummary({ rows: manyFlips }), mkSummary({ rows: rowsBase }));
    expect(c.regressed).toBe(true);
    expect(c.lines.join('\n')).toContain('verdict: REGRESSION');
  });

  it('slot improvements count even when the composite row ok is unchanged (symmetric b/c)', () => {
    const slotRow = (got: string) => ({
      expected: 'RETHINK',
      got: 'PROCEED', // verdict wrong in BOTH runs → composite ok identical and false
      ok: false,
      verdictOk: false,
      verdictStable: true,
      slots: { g1: { got, ok: got === 'hit', stable: true } },
      falseAlarm: null,
      outage: false,
    });
    const base = mkSummary({
      rows: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`r${i}`, slotRow('miss')])),
    });
    const improved = mkSummary({
      rows: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`r${i}`, slotRow(i < 5 ? 'hit' : 'miss')]),
      ),
    });
    const c = compare(improved, base);
    expect(c.regressed).toBe(false);
    const recallLine = c.lines.find((l) => l.startsWith('  recall: flips'));
    expect(recallLine).toContain('improved [r0, r1, r2, r3, r4]');
  });

  it('recall degradation = stable slots lost AND none gained; unstable losses are instability', () => {
    const slotRow = (got: string, stable = true) => ({
      expected: 'RETHINK',
      got: 'RETHINK',
      ok: true,
      verdictOk: true,
      verdictStable: true,
      slots: { g1: { got, ok: got === 'hit', stable } },
      falseAlarm: null,
      outage: false,
    });
    const base = mkSummary({
      rows: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`r${i}`, slotRow('hit')])),
    });
    const degradedRows = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`r${i}`, slotRow(i < 5 ? 'miss' : 'hit')]),
    );
    const c = compare(mkSummary({ rows: degradedRows }), base);
    expect(c.lines.join('\n')).toContain('recall: REGRESSION');
    const unstableRows = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`r${i}`, slotRow(i < 5 ? 'miss' : 'hit', i >= 5)]),
    );
    const cu = compare(mkSummary({ rows: unstableRows }), base);
    expect(cu.regressed).toBe(false);
    expect(cu.lines.join('\n')).toContain('instability');
  });
});

describe('summarize helpers', () => {
  it('isDecoyOnly needs workflow mode and an empty gold set', () => {
    expect(isDecoyOnly({ ...baseRow, mode: 'workflow', gold: [] })).toBe(true);
    expect(isDecoyOnly({ ...baseRow, mode: 'workflow', gold: [GOLD[0]] })).toBe(false);
    expect(isDecoyOnly(baseRow)).toBe(false);
  });

  it('splits decoy flags from warning-tier mentions and keeps per-class totals', () => {
    const results = [
      {
        id: 'w1',
        mode: 'workflow' as const,
        expected: 'RETHINK',
        verdict: { got: 'RETHINK', ok: true, stable: true },
        frameMeta: null,
        textOk: null,
        slots: {
          g1: {
            kind: 'gold' as const,
            class: 'security' as const,
            got: 'hit',
            ok: true,
            stable: true,
          },
          g2: {
            kind: 'gold' as const,
            class: 'security' as const,
            got: 'miss',
            ok: false,
            stable: true,
          },
          d1: { kind: 'decoy' as const, got: 'mentioned', ok: true, stable: true },
          d2: { kind: 'decoy' as const, got: 'flagged', ok: false, stable: true },
        },
        severity: [],
        falseAlarm: null,
        contract: {
          jsonContractValid: true,
          edgeCasesValid: false,
          repositoryUnchanged: true,
          providerArtifactsAbsent: false,
        },
        fabricatedPerRun: [1],
        findingCount: 4,
        outage: false,
        ok: false,
      },
    ];
    const s = summarize(results, { model: 'opus' });
    expect(s.perClass.security).toEqual({ hits: 1, total: 2 });
    expect(s.decoyFlags).toEqual({ flagged: 1, mentioned: 1, total: 2 });
    expect(s.recall).toEqual({ hits: 1, total: 2 });
    expect(s.contract.edgeCasesValid).toEqual({ ok: 0, total: 1 });
    expect(s.precisionInfo).toEqual({ matched: 1, emitted: 4 });
  });
});
