import { describe, expect, it } from 'vitest';
import { temporaryRoot } from '../__tests__/evidence-store-fixture.mts';
import { REVIEWED_RESPONSE } from '../__tests__/response-fixture.mts';
import { capturePlanCritiqueCompletedCallback } from '../capture-normalizer.mts';
import { PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES, sha256Bytes } from '../evidence-record.mts';
import {
  readPlanCritiqueExactResponse,
  readPlanCritiqueProjection,
  readPlanCritiqueTranscript,
} from '../evidence-store.mts';
import {
  adaptClaudeFeatureCritiqueSubagentStop,
  CLAUDE_PLAN_CRITIQUE_IDENTITY_MAX_BYTES,
  deriveClaudePlanCritiqueWorkId,
} from './claude-subagent-stop.mts';

const response = JSON.stringify(REVIEWED_RESPONSE);
const repository = {
  fingerprint: sha256Bytes(Buffer.from('repository', 'utf8')),
  fingerprintSource: 'canonical_remote' as const,
  branch: 'codex/example',
  head: 'a'.repeat(40),
};

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'SubagentStop',
    session_id: 'session-1',
    prompt_id: 'prompt-1',
    stop_hook_active: false,
    agent_id: 'agent-1',
    agent_type: 'feature-critique',
    last_assistant_message: response,
    transcript_path: '/untrusted/main.jsonl',
    agent_transcript_path: '/untrusted/subagent.jsonl',
    permission_mode: 'plan',
    model: 'forged-model',
    ...overrides,
  };
}

const adapt = (value: unknown) => adaptClaudeFeatureCritiqueSubagentStop(value, { repository });

describe('adaptClaudeFeatureCritiqueSubagentStop', () => {
  it('maps only documented capture fields and preserves the final message text as UTF-8', () => {
    const result = adapt(payload());
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('expected a ready callback');

    expect(result.callback).toMatchObject({
      provider: 'claude',
      workId: deriveClaudePlanCritiqueWorkId('session-1', 'prompt-1'),
      repository,
      model: null,
      promptHash: null,
      providerCompletedAt: null,
    });
    expect(result.callback.callbackIdentity).toBe(
      JSON.stringify(['claude_plan_critique_subagent_stop', 1, 'session-1', 'prompt-1', 'agent-1']),
    );
    expect(Buffer.from(result.callback.exactResponse).toString('utf8')).toBe(response);
    expect(result.callback).not.toHaveProperty('opaqueTranscript');
    expect(result.callback).not.toHaveProperty('permission_mode');
  });

  it('shares work identity across a fresh recheck while keeping callback identity distinct', () => {
    const first = adapt(payload({ agent_id: 'agent-1' }));
    const second = adapt(payload({ agent_id: 'agent-2' }));
    expect(first.kind).toBe('ready');
    expect(second.kind).toBe('ready');
    if (first.kind !== 'ready' || second.kind !== 'ready')
      throw new Error('expected ready callbacks');
    expect(second.callback.workId).toBe(first.callback.workId);
    expect(second.callback.callbackIdentity).not.toBe(first.callback.callbackIdentity);
  });

  it('derives domain-separated, delimiter-safe, deterministic work identities', () => {
    const workId = deriveClaudePlanCritiqueWorkId('a:b', 'c');
    expect(workId).toMatch(/^pcw1_[0-9a-f]{64}$/);
    expect(deriveClaudePlanCritiqueWorkId('a:b', 'c')).toBe(workId);
    expect(deriveClaudePlanCritiqueWorkId('a', 'b:c')).not.toBe(workId);
    expect(() => deriveClaudePlanCritiqueWorkId('session\u0000', 'prompt')).toThrow(
      /invalid Claude plan critique work identity/,
    );
  });

  it.each([
    { value: null, reason: 'invalid_payload' },
    { value: [], reason: 'invalid_payload' },
    { value: payload({ hook_event_name: 'Stop' }), reason: 'unsupported_event' },
    { value: payload({ agent_type: 'feature-critique-copy' }), reason: 'unsupported_agent_type' },
    {
      value: payload({ stop_hook_active: undefined }),
      reason: 'continuation_state_unavailable',
    },
    { value: payload({ prompt_id: undefined }), reason: 'work_identity_unavailable' },
    { value: payload({ session_id: 'session\n2' }), reason: 'work_identity_unavailable' },
    { value: payload({ agent_id: '' }), reason: 'callback_identity_unavailable' },
    { value: payload({ last_assistant_message: null }), reason: 'final_message_unavailable' },
    { value: payload({ last_assistant_message: '   ' }), reason: 'final_message_unavailable' },
  ])('skips unsupported or incomplete payloads with $reason', ({ value, reason }) => {
    expect(adapt(value)).toEqual({ kind: 'skipped', reason });
  });

  it('marks the whole work unbindable when another hook continued the subagent', () => {
    const continued = payload({ stop_hook_active: true });
    for (const key of ['agent_id', 'last_assistant_message'])
      Object.defineProperty(continued, key, {
        enumerable: true,
        get: () => {
          throw new Error('continued output must not be inspected');
        },
      });
    expect(adapt(continued)).toEqual({
      kind: 'work_unbindable',
      reason: 'hook_continuation',
      workId: deriveClaudePlanCritiqueWorkId('session-1', 'prompt-1'),
    });
  });

  it('bounds opaque identities and final output before allocating capture bytes', () => {
    expect(
      adapt(payload({ session_id: 's'.repeat(CLAUDE_PLAN_CRITIQUE_IDENTITY_MAX_BYTES + 1) })),
    ).toEqual({ kind: 'skipped', reason: 'work_identity_unavailable' });
    expect(
      adapt(
        payload({
          last_assistant_message: 'x'.repeat(PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES + 1),
        }),
      ),
    ).toEqual({ kind: 'skipped', reason: 'final_message_too_large' });
  });

  it('bounds the serialized callback tuple after JSON escaping', () => {
    expect(
      adapt(
        payload({
          session_id: '\\'.repeat(CLAUDE_PLAN_CRITIQUE_IDENTITY_MAX_BYTES),
          prompt_id: '\\'.repeat(CLAUDE_PLAN_CRITIQUE_IDENTITY_MAX_BYTES),
          agent_id: '\\'.repeat(CLAUDE_PLAN_CRITIQUE_IDENTITY_MAX_BYTES),
        }),
      ),
    ).toEqual({ kind: 'skipped', reason: 'callback_identity_unavailable' });
  });

  it('ignores accessors instead of executing untrusted payload code', () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, 'hook_event_name', {
      enumerable: true,
      get: () => {
        throw new Error('must not run');
      },
    });
    expect(adapt(value)).toEqual({ kind: 'skipped', reason: 'unsupported_event' });
  });

  it('rejects live and revoked Proxies without executing their traps', () => {
    let traps = 0;
    const live = new Proxy(payload(), {
      getPrototypeOf: () => {
        traps += 1;
        throw new Error('must not run');
      },
    });
    expect(adapt(live)).toEqual({ kind: 'skipped', reason: 'invalid_payload' });
    expect(traps).toBe(0);

    const revoked = Proxy.revocable(payload(), {});
    revoked.revoke();
    expect(adapt(revoked.proxy)).toEqual({ kind: 'skipped', reason: 'invalid_payload' });
  });

  it('feeds exact valid and malformed responses into the existing capture transaction', () => {
    for (const finalMessage of [response, '{']) {
      const result = adapt(payload({ last_assistant_message: finalMessage }));
      if (result.kind !== 'ready') throw new Error('expected a ready callback');
      const root = temporaryRoot();
      const captured = capturePlanCritiqueCompletedCallback(result.callback, { root });

      expect(
        readPlanCritiqueExactResponse(captured.record.critiqueId, { root })?.toString('utf8'),
      ).toBe(finalMessage);
      expect(captured.record.execution).toMatchObject({
        provider: 'claude',
        model: null,
        promptHash: null,
      });
      expect(readPlanCritiqueTranscript(captured.record.critiqueId, { root })).toBeNull();
      if (finalMessage === response) {
        expect(captured.record.contract.state).toBe('valid');
        expect(readPlanCritiqueProjection(captured.record.critiqueId, { root })).not.toBeNull();
      } else {
        expect(captured.record.contract).toMatchObject({
          state: 'invalid',
          error: { code: 'INVALID_JSON', path: '$' },
        });
        expect(readPlanCritiqueProjection(captured.record.critiqueId, { root })).toBeNull();
      }
    }
  });

  it('replays the same provider callback deterministically', () => {
    const first = adapt(payload());
    const replay = adapt(payload());
    if (first.kind !== 'ready' || replay.kind !== 'ready')
      throw new Error('expected ready callbacks');
    const root = temporaryRoot();
    const stored = capturePlanCritiqueCompletedCallback(first.callback, { root });
    const repeated = capturePlanCritiqueCompletedCallback(replay.callback, { root });
    expect(repeated.record.critiqueId).toBe(stored.record.critiqueId);
    expect(repeated.record.execution.callbackHash).toBe(stored.record.execution.callbackHash);
  });
});
