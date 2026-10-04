import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execJudge, execJudgeAsync, recordAgentRun } from '../../judge/run-judge.mts';
import {
  PRIOR_ART_QUESTION_IDS,
  type PriorArtResponseV1,
  type PriorArtVerdict,
} from '../response-contract.mts';

const CLI = path.resolve(import.meta.dirname, '../../review/cli.mts');
let dir: string;
let sink: string;

function response(verdict: PriorArtVerdict = 'DISSOLVE_FRAME'): PriorArtResponseV1 {
  const nextStep = {
    SOLVED_ELSEWHERE: 'adopt_existing',
    DISSOLVE_FRAME: 'reframe',
    GENUINE_NEW_WORK: 'proceed_to_plan',
    INSUFFICIENT_EVIDENCE: 'gather_evidence',
  } as const;
  return {
    schemaVersion: 1,
    kind: 'prior_art',
    phase: 'problem',
    status: 'reviewed',
    problem: {
      statement: 'Session restart loses output.',
      restatedFrame: 'Restart is assumed.',
      assumedConstraints: ['restart per turn'],
    },
    verdict,
    confidence: verdict === 'INSUFFICIENT_EVIDENCE' ? 'low' : 'high',
    legs: [
      {
        leg: 'local',
        status: 'reached',
        detail: 'Read declared peer.',
        declaredCheckouts: 1,
        resolvedCheckouts: 1,
      },
      { leg: 'github', status: 'reached', detail: 'Read upstream issue.' },
      { leg: 'web', status: 'unavailable', detail: 'No web tool.' },
      { leg: 'papers', status: 'unavailable', detail: 'No paper tool.' },
      { leg: 'deep-research', status: 'unavailable', detail: 'No MCP.' },
    ],
    frameChallenge: {
      framing: 'DISSOLVES',
      upstreamChoice: 'Per-turn restart',
      boundaryMustExist: 'no',
    },
    questions: PRIOR_ART_QUESTION_IDS.map((id) => ({
      id,
      status: 'ANSWERED',
      finding: 'Read evidence.',
    })),
    evidence: [
      {
        kind: 'upstream',
        source: 'https://example.org/sdk/issue',
        repoRoot: null,
        claim: 'Upstream lacks per-turn restart support.',
        quote: 'Keep the session open.',
      },
    ],
    suggestedNextStep: { kind: nextStep[verdict], detail: 'Use the researched path.' },
    routing: null,
    summary: 'Session-lifetime operation avoids restart losses.',
    researchReferences: [],
  };
}

function events() {
  return readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'prior-art-telemetry-'));
  sink = path.join(dir, 'events.jsonl');
  vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
  vi.stubEnv('DEVKIT_AGENT_RUN_ID', 'prior-art-telemetry');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('validated prior-art judge_exec telemetry', () => {
  it.each([
    'SOLVED_ELSEWHERE',
    'DISSOLVE_FRAME',
    'GENUINE_NEW_WORK',
    'INSUFFICIENT_EVIDENCE',
  ] as const)(
    'records the validated %s verdict and frame on exactly one existing event',
    (verdict) => {
      recordAgentRun({ label: 'prior-art', output: JSON.stringify(response(verdict)) });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        type: 'judge_exec',
        outcome: 'ok',
        prior_art_status: 'reviewed',
        prior_art_verdict: verdict,
        prior_art_framing: 'DISSOLVES',
        prior_art_boundary: 'no',
        prior_art_next_step: response(verdict).suggestedNextStep?.kind,
        prior_art_confidence: response(verdict).confidence,
      });
      expect(events()[0]).not.toHaveProperty('prior_art_upstream_choice');
    },
  );

  it.each(['wrong_phase', 'aborted'] as const)('keeps %s distinct from reviewed', (status) => {
    const output = {
      ...response(),
      status,
      verdict: null,
      confidence: null,
      legs: [],
      questions: [],
      evidence: [],
      frameChallenge: null,
      suggestedNextStep: null,
      routing: status === 'wrong_phase' ? 'route_feature_critique' : null,
    };
    recordAgentRun({ label: 'prior-art', output: JSON.stringify(output) });
    expect(events()[0]).toHaveProperty('prior_art_status', status);
    expect(events()[0]).not.toHaveProperty('prior_art_verdict');
  });

  it.each([
    'not JSON',
    '{"verdict":"GENUINE_NEW_WORK"}',
    JSON.stringify({ ...response('GENUINE_NEW_WORK'), legs: [] }),
  ])('records invalid output without laundering a verdict: %s', (output) => {
    recordAgentRun({ label: 'prior-art', output });
    expect(events()[0]).toMatchObject({ outcome: 'ok', prior_art_status: 'invalid' });
    expect(events()[0]).toHaveProperty('prior_art_error');
    expect(events()[0]).not.toHaveProperty('prior_art_verdict');
    expect(events()[0]).not.toHaveProperty('prior_art_framing');
  });

  it('does not parse another agent or a failed prior-art spawn as a validated verdict', () => {
    const extra = { prior_art_status: 'reviewed', prior_art_verdict: 'GENUINE_NEW_WORK' };
    recordAgentRun({
      label: 'review:correctness-reviewer',
      output: JSON.stringify(response()),
      extra,
    });
    recordAgentRun({
      label: 'prior-art',
      output: JSON.stringify(response()),
      outcome: 'timeout',
      extra,
    });
    recordAgentRun({ label: 'prior-art', output: '', extra });
    for (const event of events()) {
      expect(event).not.toHaveProperty('prior_art_status');
      expect(event).not.toHaveProperty('prior_art_verdict');
    }
  });

  it('derives fields after caller extras so a malformed result cannot be labeled valid', () => {
    recordAgentRun({
      label: 'prior-art',
      output: '{"verdict":"GENUINE_NEW_WORK"}',
      extra: { prior_art_status: 'reviewed', prior_art_verdict: 'GENUINE_NEW_WORK' },
    });
    expect(events()[0]).toHaveProperty('prior_art_status', 'invalid');
    expect(events()[0]).not.toHaveProperty('prior_art_verdict');
  });

  it('works through the real record-agent CLI without a ship or a transcript dependency', () => {
    const run = spawnSync('node', [CLI, 'record-agent', 'prior-art'], {
      input: JSON.stringify(response()),
      encoding: 'utf8',
      env: { ...process.env, DEVKIT_SHIP_ID: '', DEVKIT_REVIEW_RUN_ID: '' },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(events()[0]).toMatchObject({ run_mode: 'agent', prior_art_verdict: 'DISSOLVE_FRAME' });
  });

  it('records the unwrapped verdict for both spawned judge paths', async () => {
    writeFileSync(
      path.join(dir, 'result.json'),
      JSON.stringify({ type: 'result', result: JSON.stringify(response()) }),
    );
    writeFileSync(
      path.join(dir, 'claude'),
      '#!/bin/sh\ncat >/dev/null\ncat "$PRIOR_ART_RESULT"\n',
      { mode: 0o755 },
    );
    const opts = {
      label: 'prior-art',
      args: ['-p', 'investigate'],
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        PRIOR_ART_RESULT: path.join(dir, 'result.json'),
      },
    };
    expect(execJudge(opts)).toBeTruthy();
    expect(await execJudgeAsync(opts)).toBeTruthy();
    expect(events()).toHaveLength(2);
    for (const event of events())
      expect(event).toHaveProperty('prior_art_verdict', 'DISSOLVE_FRAME');
  });
});
