import {
  PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES,
  type PlanCritiqueCompletedCallbackV1,
} from '../capture-normalizer.mts';
import { PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES } from '../evidence-record.mts';
import {
  boundedOpaqueIdentifier,
  ownHookValue,
  plainHookPayload,
  versionedTupleHash,
} from './input-boundary.mts';

export const CLAUDE_PLAN_CRITIQUE_IDENTITY_MAX_BYTES = 1024;

export const CLAUDE_PLAN_CRITIQUE_SKIP_REASONS = [
  'invalid_payload',
  'unsupported_event',
  'unsupported_agent_type',
  'continuation_state_unavailable',
  'work_identity_unavailable',
  'callback_identity_unavailable',
  'final_message_unavailable',
  'final_message_too_large',
] as const;

export type ClaudePlanCritiqueSkipReason = (typeof CLAUDE_PLAN_CRITIQUE_SKIP_REASONS)[number];

/** `work_unbindable` must be durably quarantined before any runtime hook activation. */
export type ClaudePlanCritiqueSubagentStopResultV1 =
  | { kind: 'ready'; callback: PlanCritiqueCompletedCallbackV1 }
  | { kind: 'work_unbindable'; reason: 'hook_continuation'; workId: string }
  | { kind: 'skipped'; reason: ClaudePlanCritiqueSkipReason };

export interface ClaudePlanCritiqueAdapterContextV1 {
  repository: PlanCritiqueCompletedCallbackV1['repository'];
}

function opaqueIdentifier(value: unknown): value is string {
  return boundedOpaqueIdentifier(value, CLAUDE_PLAN_CRITIQUE_IDENTITY_MAX_BYTES);
}

/** Stable turn identity shared by Claude SubagentStop capture and future Stop observation. */
export function deriveClaudePlanCritiqueWorkId(sessionId: string, promptId: string): string {
  if (!opaqueIdentifier(sessionId) || !opaqueIdentifier(promptId))
    throw new Error('invalid Claude plan critique work identity');
  return `pcw1_${versionedTupleHash('claude_plan_critique_work', [sessionId, promptId])}`;
}

function callbackIdentity(sessionId: string, promptId: string, agentId: string): string {
  return JSON.stringify(['claude_plan_critique_subagent_stop', 1, sessionId, promptId, agentId]);
}

const skipped = (reason: ClaudePlanCritiqueSkipReason): ClaudePlanCritiqueSubagentStopResultV1 => ({
  kind: 'skipped',
  reason,
});

/**
 * Adapt Claude's documented SubagentStop payload without reading transcripts or provider paths.
 * The final message is the exact hook field text encoded as UTF-8, not original wire bytes.
 */
export function adaptClaudeFeatureCritiqueSubagentStop(
  payload: unknown,
  context: ClaudePlanCritiqueAdapterContextV1,
): ClaudePlanCritiqueSubagentStopResultV1 {
  const record = plainHookPayload(payload);
  if (!record) return skipped('invalid_payload');
  if (ownHookValue(record, 'hook_event_name') !== 'SubagentStop')
    return skipped('unsupported_event');
  if (ownHookValue(record, 'agent_type') !== 'feature-critique')
    return skipped('unsupported_agent_type');

  const sessionId = ownHookValue(record, 'session_id');
  const promptId = ownHookValue(record, 'prompt_id');
  if (!opaqueIdentifier(sessionId) || !opaqueIdentifier(promptId))
    return skipped('work_identity_unavailable');
  const workId = deriveClaudePlanCritiqueWorkId(sessionId, promptId);

  const stopHookActive = ownHookValue(record, 'stop_hook_active');
  if (typeof stopHookActive !== 'boolean') return skipped('continuation_state_unavailable');
  if (stopHookActive) return { kind: 'work_unbindable', reason: 'hook_continuation', workId };

  const agentId = ownHookValue(record, 'agent_id');
  if (!opaqueIdentifier(agentId)) return skipped('callback_identity_unavailable');
  const derivedCallbackIdentity = callbackIdentity(sessionId, promptId, agentId);
  if (
    Buffer.byteLength(derivedCallbackIdentity, 'utf8') > PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES
  )
    return skipped('callback_identity_unavailable');

  const finalMessage = ownHookValue(record, 'last_assistant_message');
  if (typeof finalMessage !== 'string') return skipped('final_message_unavailable');
  if (
    finalMessage.length > PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES ||
    Buffer.byteLength(finalMessage, 'utf8') > PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES
  )
    return skipped('final_message_too_large');
  if (finalMessage.trim().length === 0) return skipped('final_message_unavailable');

  return {
    kind: 'ready',
    callback: {
      provider: 'claude',
      callbackIdentity: derivedCallbackIdentity,
      workId,
      repository: { ...context.repository },
      model: null,
      promptHash: null,
      providerCompletedAt: null,
      exactResponse: Buffer.from(finalMessage, 'utf8'),
    },
  };
}
