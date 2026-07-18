import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSubagentStop, observePlanStop } from '../capture.mts';
import { resolveEligibleBinding } from '../evidence-bindings.mts';
import {
  blockedResponse,
  cleanResponse,
  cleanupCaptureFixtures,
  cursorSubagent,
  captureFixture as fixture,
  storedCaptureObservation as observation,
  storedCaptureRecord as record,
  requiredCaptureId as required,
} from './capture-fixtures.mts';

function cursorInput(
  repo: string,
  status: 'completed' | 'error' | 'aborted',
  summary?: string,
): Record<string, unknown> {
  return cursorSubagent(repo, 'conversation-callback', 'generation-callback', status, summary);
}

afterEach(() => {
  cleanupCaptureFixtures();
});

describe('provider callback boundaries', () => {
  it.each([
    'aborted',
    'error',
  ] as const)('keeps Cursor %s as pass two and makes a later completion ineligible pass three', (providerStatus) => {
    const { repo, evidence } = fixture();
    const first = captureSubagentStop(
      'cursor',
      cursorInput(repo, 'completed', blockedResponse),
      repo,
    );
    const interrupted = captureSubagentStop(
      'cursor',
      cursorInput(repo, providerStatus, cleanResponse),
      repo,
    );
    const third = captureSubagentStop(
      'cursor',
      cursorInput(repo, 'completed', cleanResponse),
      repo,
    );

    const firstRecord = record(evidence, first);
    const interruptedRecord = record(evidence, interrupted);
    expect(interruptedRecord).toMatchObject({
      workId: firstRecord.workId,
      lineage: { pass: 2, parentCritiqueId: first.critiqueId },
      contract: { state: 'invalid', eligible: false },
    });
    expect(interruptedRecord.contract.errors).toContain(
      `cursor subagent status was ${providerStatus}`,
    );
    const thirdRecord = record(evidence, third);
    expect(third).toMatchObject({ eligible: false, reason: 'retry_limit_exceeded' });
    expect(thirdRecord).toMatchObject({
      workId: firstRecord.workId,
      lineage: { pass: 3, parentCritiqueId: interrupted.critiqueId },
      contract: { eligible: false, eligibilityReason: 'retry_limit_exceeded' },
    });
    expect(resolveEligibleBinding(repo, firstRecord.workId)).toMatchObject({
      status: 'skipped',
      reason: 'no_matching_binding',
    });
  });

  it('retains an official Cursor terminal callback with no summary as pass two', () => {
    const { repo, evidence } = fixture();
    const first = captureSubagentStop(
      'cursor',
      cursorInput(repo, 'completed', blockedResponse),
      repo,
    );
    const interrupted = captureSubagentStop('cursor', cursorInput(repo, 'aborted'), repo);

    expect(interrupted).toMatchObject({ status: 'captured', eligible: false });
    const firstRecord = record(evidence, first);
    const interruptedRecord = record(evidence, interrupted);
    expect(interruptedRecord).toMatchObject({
      workId: firstRecord.workId,
      lineage: { pass: 2, parentCritiqueId: first.critiqueId },
      contract: { state: 'invalid', eligible: false },
    });
    expect(interruptedRecord.contract.errors).toContain('cursor subagent status was aborted');
  });

  it('retains malformed Cursor output identified only by subagent_type', () => {
    const { repo, evidence } = fixture();
    const captured = captureSubagentStop(
      'cursor',
      {
        ...cursorInput(repo, 'completed'),
        conversation_id: 'conversation-malformed',
        generation_id: 'generation-malformed',
        summary: 'not structured JSON',
      },
      repo,
    );

    expect(captured).toMatchObject({ status: 'captured', eligible: false });
    expect(record(evidence, captured)).toMatchObject({
      lineage: { pass: 1, parentCritiqueId: null },
      contract: { state: 'invalid', eligible: false },
    });
  });

  it('keeps a Cursor callback with missing lifecycle status ineligible', () => {
    const { repo, evidence } = fixture();
    const input = cursorInput(repo, 'completed', cleanResponse);
    delete input.status;
    const captured = captureSubagentStop('cursor', input, repo);

    expect(captured).toMatchObject({ status: 'captured', eligible: false });
    expect(record(evidence, captured)).toMatchObject({
      providerStatus: 'unknown',
      contract: {
        state: 'invalid',
        eligible: false,
        errors: ['cursor subagent status was missing or unsupported'],
      },
    });
  });

  it('accepts legacy non-Cursor records whose v1 provider status is absent', () => {
    const { repo, evidence } = fixture();
    const captured = captureSubagentStop(
      'codex',
      {
        cwd: repo,
        turn_id: 'legacy-turn',
        agent_id: 'legacy-agent',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      repo,
    );
    const stored = record(evidence, captured);
    const path = join(evidence, 'records', `${required(captured, 'critiqueId')}.json`);
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete legacy.providerStatus;
    writeFileSync(path, `${JSON.stringify(legacy)}\n`);

    expect(resolveEligibleBinding(repo, stored.workId)).toMatchObject({
      status: 'matched',
      record: { critiqueId: captured.critiqueId },
    });
  });

  it('requires an unconsumed explicit-work capture before linking a Stop', () => {
    const { repo } = fixture();
    process.env.DEVKIT_WORK_ID = 'explicit-stop-scope';
    const captured = captureSubagentStop(
      'claude',
      {
        cwd: repo,
        agent_id: 'explicit-agent',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      repo,
    );
    const stop = {
      cwd: repo,
      permission_mode: 'plan',
      last_assistant_message: 'Explicitly scoped plan',
    };

    expect(observePlanStop('claude', stop, repo)).toMatchObject({
      reason: 'linked',
      critiqueId: captured.critiqueId,
    });
    expect(observePlanStop('claude', stop, repo)).toMatchObject({
      status: 'observed',
      reason: 'no_turn_critique',
    });
  });

  it('does not link a Codex Stop to a critique from another turn', () => {
    const { repo, evidence } = fixture();
    const captured = captureSubagentStop(
      'codex',
      {
        cwd: repo,
        session_id: 'session-turns',
        turn_id: 'turn-captured',
        agent_id: 'agent-turn',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      repo,
    );
    const wrongTurn = observePlanStop(
      'codex',
      {
        cwd: repo,
        session_id: 'session-turns',
        turn_id: 'turn-other',
        permission_mode: 'plan',
        last_assistant_message: 'Unrelated plan',
      },
      repo,
    );
    expect(wrongTurn).toMatchObject({ status: 'observed', reason: 'no_turn_critique' });
    expect(observation(evidence, wrongTurn)).toMatchObject({
      critiqueId: null,
      consumedCaptureIds: [],
    });

    const matchingTurn = observePlanStop(
      'codex',
      {
        cwd: repo,
        session_id: 'session-turns',
        turn_id: 'turn-captured',
        permission_mode: 'plan',
        last_assistant_message: 'Matching plan',
      },
      repo,
    );
    expect(matchingTurn).toMatchObject({ reason: 'linked', critiqueId: captured.critiqueId });
  });

  it.each([
    ['with an explicit provider invocation id', { agent_id: 'agent-duplicate' }],
    ['without an explicit provider invocation id', {}],
  ])('deduplicates a repeated provider invocation %s', (_scenario, identity) => {
    const { repo, evidence } = fixture();
    const input = {
      cwd: repo,
      session_id: 'session-duplicate',
      turn_id: 'turn-duplicate',
      ...identity,
      agent_type: 'feature-critique',
      last_assistant_message: cleanResponse,
    };
    const first = captureSubagentStop('codex', input, repo);
    const duplicate = captureSubagentStop('codex', input, repo);

    expect(duplicate).toMatchObject({
      status: 'captured',
      reason: 'duplicate_provider_invocation',
      critiqueId: first.critiqueId,
      observationId: first.observationId,
      eligible: true,
    });
    expect(readdirSync(join(evidence, 'records'))).toHaveLength(1);
    expect(
      readdirSync(join(evidence, 'observations')).filter((name) => name.endsWith('.json')),
    ).toHaveLength(1);
  });

  it('skips Stop when the selected capture and resolved binding disagree', () => {
    const { repo, evidence } = fixture();
    const selected = captureSubagentStop(
      'codex',
      {
        cwd: repo,
        turn_id: 'turn-selected',
        agent_id: 'agent-selected',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      repo,
    );
    const other = captureSubagentStop(
      'codex',
      {
        cwd: repo,
        turn_id: 'turn-other',
        agent_id: 'agent-other',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      repo,
    );
    writeFileSync(
      join(evidence, 'observations', `${required(selected, 'observationId')}.json`),
      `${JSON.stringify(
        { ...observation(evidence, selected), critiqueId: other.critiqueId },
        null,
        2,
      )}\n`,
    );

    const stopped = observePlanStop(
      'codex',
      {
        cwd: repo,
        turn_id: 'turn-selected',
        permission_mode: 'plan',
        last_assistant_message: 'Final decision-complete plan',
      },
      repo,
    );
    expect(stopped).toMatchObject({ status: 'observed', reason: 'capture_binding_mismatch' });
    expect(stopped.critiqueId).toBeUndefined();
    expect(observation(evidence, stopped)).toMatchObject({
      status: 'skipped',
      reason: 'capture_binding_mismatch',
      critiqueId: null,
    });
  });
});
