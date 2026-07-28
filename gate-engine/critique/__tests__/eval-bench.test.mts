// critique-eval unit tests — every pure metric/parser/scoring path, plus the row runners with
// injected execs (zero claude calls, zero tokens). The fixture-repo paths use REAL git in a
// tmpdir (the decisions-eval convention) — cheap, and the materialize contract is load-bearing.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
  salvageFingerprint,
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
  parseCritiqueFindings,
  parseReportFindings,
  parseSlotReply,
  runMatcher,
  scoreCase,
  voteSlot,
} from '../eval/matcher.mts';
import {
  BENCHMARK_DIRECTIVE,
  buildIntrinsicArgs,
  buildWorkflowArgs,
  CLAUDE_RESULT_ARGS,
  extractBenchmarkCritiqueResponse,
  parseSummary,
  runWorkflow,
  unwrapClaudeResult,
  WORKFLOW_TOOLS,
} from '../eval/run-critic.mts';
import { REVIEWED_RESPONSE } from './response-fixture.mts';

const critic = { body: 'AGENT BODY', model: 'opus', raw: '---\nmodel: opus\n---\nAGENT BODY' };

describe('salvage fingerprint', () => {
  it('binds saved trials to agent, model, corpus, and runner', () => {
    const base = salvageFingerprint(critic, '{"id":"row"}', 'runner-a');
    expect(salvageFingerprint(critic, '{"id":"row"}', 'runner-a')).toBe(base);
    expect(
      salvageFingerprint({ ...critic, raw: `${critic.raw}\nchanged` }, '{"id":"row"}', 'runner-a'),
    ).not.toBe(base);
    expect(salvageFingerprint({ ...critic, model: 'sonnet' }, '{"id":"row"}', 'runner-a')).not.toBe(
      base,
    );
    expect(salvageFingerprint(critic, '{"id":"other"}', 'runner-a')).not.toBe(base);
    expect(salvageFingerprint(critic, '{"id":"row"}', 'runner-b')).not.toBe(base);
  });
});

const SUMMARY_OK = [
  'CRITIQUE: .cursor/.feature-critique.md',
  'VERDICT: RETHINK',
  'FEASIBILITY: Partially Feasible',
  'CRITICAL_ISSUES: 2',
  'WARNINGS: 1',
  'UX_IMPACT: none',
  'FRAME_META: BANDAID',
  '',
  'SUMMARY: The fix hides the symptom.',
  'ACTIONS:',
  '- Implement the canonical home first',
].join('\n');
const RESPONSE_OK = JSON.stringify({
  ...REVIEWED_RESPONSE,
  verdict: 'RETHINK',
  frameMeta: 'BANDAID',
});

// ─── run-critic: argv order (the variadic-swallow trap) ───────────────────────────

describe('argv builders', () => {
  it('intrinsic: positional prompt sits BEFORE the variadic tool flags', () => {
    const args = buildIntrinsicArgs('PROPOSAL', critic);
    const prompt = args.findIndex((a) => a.includes('PROPOSAL'));
    expect(prompt).toBeGreaterThan(-1);
    expect(args[prompt].startsWith(BENCHMARK_DIRECTIVE)).toBe(true);
    expect(prompt).toBeGreaterThan(args.indexOf('--no-session-persistence'));
    expect(args.slice(prompt - 2, prompt)).toEqual(CLAUDE_RESULT_ARGS);
    expect(args.indexOf('--disallowedTools')).toBeGreaterThan(prompt);
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('AGENT BODY');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
  });

  it('workflow: prompt before --allowedTools, tools as ONE comma-joined string', () => {
    const args = buildWorkflowArgs('PROPOSAL', critic);
    const prompt = args.indexOf('PROPOSAL');
    const allowed = args.indexOf('--allowedTools');
    expect(prompt).toBeGreaterThan(-1);
    expect(args.slice(prompt - 2, prompt)).toEqual(CLAUDE_RESULT_ARGS);
    expect(allowed).toBeGreaterThan(prompt);
    expect(args[allowed + 1]).toBe(WORKFLOW_TOOLS);
    expect(args.filter((a) => a === '--allowedTools')).toHaveLength(1);
    expect(args).not.toContain('--disallowedTools');
  });
});

describe('Claude result transport', () => {
  it('unwraps the final result from JSON output mode', () => {
    expect(
      unwrapClaudeResult(
        JSON.stringify({ type: 'result', subtype: 'success', result: RESPONSE_OK }),
      ),
    ).toBe(RESPONSE_OK);
  });

  it('keeps direct responses for injected runners and older CLIs', () => {
    expect(unwrapClaudeResult(RESPONSE_OK)).toBe(RESPONSE_OK);
    expect(unwrapClaudeResult(null)).toBeNull();
  });
});

// ─── run-critic: summary parsing ──────────────────────────────────────────────────

describe('parseSummary', () => {
  it('parses the full compact block', () => {
    const s = parseSummary(SUMMARY_OK);
    expect(s.verdict).toBe('RETHINK');
    expect(s.frameMeta).toBe('BANDAID');
    expect(s.criticalCount).toBe(2);
    expect(s.warningCount).toBe(1);
    expect(s.feasibility).toBe('Partially Feasible');
  });

  it('matches PROCEED WITH CHANGES before its PROCEED prefix', () => {
    expect(parseSummary('VERDICT: PROCEED WITH CHANGES').verdict).toBe('PROCEED WITH CHANGES');
    expect(parseSummary('VERDICT: PROCEED').verdict).toBe('PROCEED');
  });

  it('ambiguity parses NULL, never a guess', () => {
    expect(parseSummary('no block at all').verdict).toBeNull();
    expect(parseSummary('FRAME_META: SOUND or maybe BANDAID').frameMeta).toBeNull();
    expect(parseSummary('CRITICAL_ISSUES: several').criticalCount).toBeNull();
  });

  it('tolerates markdown dressing on labels', () => {
    expect(parseSummary('**VERDICT**: REJECT').verdict).toBe('REJECT');
  });

  it('parses the closed JSON response and normalizes its verdict spelling', () => {
    const summary = parseSummary(
      JSON.stringify({ ...REVIEWED_RESPONSE, verdict: 'PROCEED_WITH_CHANGES' }),
    );
    expect(summary).toMatchObject({
      responseValid: true,
      verdict: 'PROCEED WITH CHANGES',
      frameMeta: 'SOUND',
      criticalCount: 1,
      warningCount: 1,
    });
  });
});

describe('extractBenchmarkCritiqueResponse', () => {
  it('distinguishes exact contract output from one embedded strict response', () => {
    expect(extractBenchmarkCritiqueResponse(RESPONSE_OK)).toMatchObject({
      raw: RESPONSE_OK,
      exact: true,
    });
    expect(extractBenchmarkCritiqueResponse(`readiness note\n${RESPONSE_OK}`)).toMatchObject({
      raw: RESPONSE_OK,
      exact: false,
    });
    expect(extractBenchmarkCritiqueResponse(`\`\`\`json\n${RESPONSE_OK}\n\`\`\``)).toMatchObject({
      raw: RESPONSE_OK,
      exact: false,
    });
  });

  it('projects semantic fields without repairing or accepting ambiguous output', () => {
    expect(extractBenchmarkCritiqueResponse(`${RESPONSE_OK}\n${RESPONSE_OK}`)).toBeNull();
    expect(extractBenchmarkCritiqueResponse(`note {not JSON}\n${RESPONSE_OK}`)).toMatchObject({
      raw: RESPONSE_OK,
      exact: false,
    });
    expect(
      extractBenchmarkCritiqueResponse(
        JSON.stringify({ ...REVIEWED_RESPONSE, unlistedField: true }),
      ),
    ).toMatchObject({ exact: false });
    expect(
      extractBenchmarkCritiqueResponse(
        JSON.stringify({
          ...REVIEWED_RESPONSE,
          findings: [{ ...REVIEWED_RESPONSE.findings[0], claim: 42 }],
        }),
      ),
    ).toBeNull();
    expect(
      extractBenchmarkCritiqueResponse(
        JSON.stringify({
          ...REVIEWED_RESPONSE,
          findings: [{ ...REVIEWED_RESPONSE.findings[0], lens: 'CONTRACT_BOUNDARY' }],
        }),
      ),
    ).toMatchObject({ exact: false });
    expect(extractBenchmarkCritiqueResponse('VERDICT: RETHINK')).toBeNull();
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

  it('projects closed JSON findings into the unchanged matcher shape', () => {
    expect(parseCritiqueFindings(JSON.stringify(REVIEWED_RESPONSE))).toEqual([
      expect.objectContaining({
        severity: 'CRITICAL',
        desc: 'The file writer and reader disagree.',
        body: expect.stringContaining('Evidence: The runner reads a path'),
      }),
      expect.objectContaining({
        severity: 'WARNING',
        desc: 'Malformed model output needs a completed-failure state.',
      }),
    ]);
    expect(parseCritiqueFindings(`prefix\n${JSON.stringify(REVIEWED_RESPONSE)}`)).toEqual([]);
    expect(parseCritiqueFindings('VERDICT: RETHINK')).toEqual([]);
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
  const response = (
    verdict: 'RETHINK' | 'REJECT',
    frameMeta: 'BANDAID' | 'SOUND',
    summary: string,
  ) => JSON.stringify({ ...REVIEWED_RESPONSE, verdict, frameMeta, summary });

  it('votes K JSON trials and applies the ported text checks', async () => {
    const outs = [
      response('RETHINK', 'BANDAID', 'Use the canonical home.'),
      response('RETHINK', 'BANDAID', 'This is a band-aid.'),
      response('REJECT', 'SOUND', 'The framing is otherwise sound.'),
    ];
    let k = 0;
    const r = await runIntrinsicRow(
      { ...baseRow, expectFrameMeta: ['BANDAID'], requireAny: ['canonical', 'band-aid'] },
      { ...noDeps, critic, runs: 3, execIntrinsic: (async () => outs[k++]) as never },
    );
    expect(r.verdict).toMatchObject({ got: 'RETHINK', ok: true, stable: false });
    expect(r.frameMeta).toMatchObject({ got: 'BANDAID', ok: true });
    expect(r.textOk).toBe(true); // 2 of 3 runs hit a requireAny term
    expect(r.contract).toEqual({
      responseValid: true,
      validRuns: 3,
      semanticRuns: 3,
      totalRuns: 3,
    });
    expect(r.ok).toBe(true);
  });

  it('keeps intrinsic semantic scoring separate from exact transport validity', async () => {
    const exact = response('RETHINK', 'BANDAID', 'Use the canonical home.');
    const outs = [exact, `readiness\n${exact}`, 'VERDICT: RETHINK'];
    let k = 0;
    const r = await runIntrinsicRow(baseRow, {
      ...noDeps,
      critic,
      runs: 3,
      execIntrinsic: (async () => outs[k++]) as never,
    });
    expect(r.verdict).toMatchObject({ got: 'RETHINK', ok: true });
    expect(r.contract).toEqual({
      responseValid: false,
      validRuns: 1,
      semanticRuns: 2,
      totalRuns: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.outage).toBe(false);
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

  it('treats too few semantic trials as an outage', async () => {
    const outs = [
      'not a critique',
      'still not a critique',
      response('RETHINK', 'BANDAID', 'valid'),
    ];
    let k = 0;
    const r = await runIntrinsicRow(baseRow, {
      ...noDeps,
      critic,
      runs: 3,
      execIntrinsic: (async () => outs[k++]) as never,
    });
    expect(r.contract?.semanticRuns).toBe(1);
    expect(r.verdict.got).toBe('NULL');
    expect(r.outage).toBe(true);
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
  const wfOut = (raw: string | null) => async () => ({ raw });
  const matchStub = async () => [
    { slotId: 'F1', kind: 'gold' as const, match: 1, stable: true, outage: false },
    { slotId: 'D1', kind: 'decoy' as const, match: 0, stable: true, outage: false },
  ];

  it('aggregates slots/contract across trials', async () => {
    const r = await runWorkflowRow(row, {
      ...noDeps,
      critic,
      runs: 1,
      execWorkflow: wfOut(RESPONSE_OK) as never,
      match: matchStub as never,
    });
    expect(r.outage).toBe(false);
    expect(r.slots.F1).toMatchObject({ got: 'hit', ok: true });
    expect(r.slots.D1).toMatchObject({ got: 'clean', ok: true });
    expect(r.contract).toEqual({
      responseValid: true,
      validRuns: 1,
      semanticRuns: 1,
      totalRuns: 1,
    });
    expect(r.falseAlarm).toBeNull(); // row has gold — not a decoy-only instrument
    expect(r.ok).toBe(true);
  });

  it('salvaged JSON trials replace spawning entirely', async () => {
    let spawns = 0;
    const salvage = () => [{ raw: RESPONSE_OK }, { raw: RESPONSE_OK }, { raw: RESPONSE_OK }];
    const r = await runWorkflowRow(row, {
      ...noDeps,
      critic,
      runs: 3,
      salvage,
      execWorkflow: (async () => {
        spawns += 1;
        return { raw: null };
      }) as never,
      match: matchStub as never,
    });
    expect(spawns).toBe(0); // already-paid trials — nothing re-bought
    expect(r.outage).toBe(false);
    expect(r.verdict).toMatchObject({ got: 'RETHINK', ok: true, stable: true });
    expect(r.contract).toEqual({
      responseValid: true,
      validRuns: 3,
      semanticRuns: 3,
      totalRuns: 3,
    });
  });

  it('too few salvaged trials for a K-majority falls back to live spawning', async () => {
    let spawns = 0;
    const r = await runWorkflowRow(row, {
      ...noDeps,
      critic,
      runs: 3,
      salvage: () => [{ raw: RESPONSE_OK }], // 1 < 2
      execWorkflow: (async () => {
        spawns += 1;
        return { raw: RESPONSE_OK };
      }) as never,
      match: matchStub as never,
    });
    expect(spawns).toBe(3);
    expect(r.contract).toEqual({
      responseValid: true,
      validRuns: 3,
      semanticRuns: 3,
      totalRuns: 3,
    });
  });

  it('reports exact validity while scoring intact semantic fields independently', async () => {
    const raws = [
      RESPONSE_OK,
      `\`\`\`json\n${RESPONSE_OK}\n\`\`\``,
      JSON.stringify({
        ...REVIEWED_RESPONSE,
        analysis: {
          ...REVIEWED_RESPONSE.analysis,
          configurationRows: [
            { ...REVIEWED_RESPONSE.analysis.configurationRows[0], correct: 'yes' },
          ],
        },
      }),
    ];
    let spawned = 0;
    let matched = 0;
    const r = await runWorkflowRow(row, {
      ...noDeps,
      critic,
      runs: 3,
      execWorkflow: (async () => ({ raw: raws[spawned++] })) as never,
      match: (async (...args: Parameters<typeof matchStub>) => {
        matched += 1;
        return matchStub(...args);
      }) as never,
    });
    expect(matched).toBe(3);
    expect(r.contract).toEqual({
      responseValid: false,
      validRuns: 1,
      semanticRuns: 3,
      totalRuns: 3,
    });
    expect(r.verdict.got).toBe('RETHINK');
    expect(r.slots.F1).toMatchObject({ got: 'hit', ok: true });
    expect(r.ok).toBe(true);
    expect(r.outage).toBe(false);
  });

  it('does not turn invalid responses into clean decoy outcomes', async () => {
    let matched = 0;
    const r = await runWorkflowRow(
      { ...row, gold: [], decoys: [DECOYS[0]], expectVerdict: ['PROCEED'] },
      {
        ...noDeps,
        critic,
        runs: 3,
        execWorkflow: wfOut(`${RESPONSE_OK}\n${RESPONSE_OK}`) as never,
        match: (async () => {
          matched += 1;
          return [];
        }) as never,
      },
    );
    expect(matched).toBe(0);
    expect(r.contract).toEqual({
      responseValid: false,
      validRuns: 0,
      semanticRuns: 0,
      totalRuns: 3,
    });
    expect(r.falseAlarm).toBeNull();
    expect(r.slots).toEqual({});
    expect(r.ok).toBe(false);
    expect(r.outage).toBe(true);
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

// ─── run-critic: workflow response transport ─────────────────────────────────────

describe('runWorkflow', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'critique-eval-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the closed response without prefixing a flow identifier', async () => {
    let seenPrompt = '';
    const exec = async ({ args }: { args: string[] }) => {
      seenPrompt = args.find((a) => a.includes('critique this')) ?? '';
      return RESPONSE_OK;
    };
    const out = await runWorkflow({
      critic,
      prompt: 'critique this',
      fixtureDir: dir,
      exec: exec as never,
    });
    expect(seenPrompt).toBe('critique this');
    expect(out).toEqual({ raw: RESPONSE_OK });
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
          responseValid: true,
          validRuns: 3,
          semanticRuns: 3,
          totalRuns: 3,
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
    expect(s.contract.responseValid).toEqual({ ok: 3, total: 3 });
    expect(s.contract.semanticUsable).toEqual({ ok: 3, total: 3 });
    expect(s.precisionInfo).toEqual({ matched: 1, emitted: 4 });
  });
});
