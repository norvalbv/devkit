import { types as utilTypes } from 'node:util';
import { PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES, } from "../capture-normalizer.mjs";
import { PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES, sha256Bytes } from "../evidence-record.mjs";
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
];
function plainRecord(value) {
    if (value === null || typeof value !== 'object')
        return null;
    try {
        if (utilTypes.isProxy(value) || Array.isArray(value))
            return null;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return null;
        return value;
    }
    catch {
        return null;
    }
}
function ownDataValue(record, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
            ? descriptor.value
            : undefined;
    }
    catch {
        return undefined;
    }
}
function opaqueIdentifier(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.length > CLAUDE_PLAN_CRITIQUE_IDENTITY_MAX_BYTES ||
        Buffer.byteLength(value, 'utf8') > CLAUDE_PLAN_CRITIQUE_IDENTITY_MAX_BYTES ||
        value.trim().length === 0)
        return false;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
            return false;
    }
    return true;
}
function tupleHash(domain, values) {
    return sha256Bytes(Buffer.from(JSON.stringify([domain, 1, ...values]), 'utf8'));
}
/** Stable turn identity shared by Claude SubagentStop capture and future Stop observation. */
export function deriveClaudePlanCritiqueWorkId(sessionId, promptId) {
    if (!opaqueIdentifier(sessionId) || !opaqueIdentifier(promptId))
        throw new Error('invalid Claude plan critique work identity');
    return `pcw1_${tupleHash('claude_plan_critique_work', [sessionId, promptId])}`;
}
function callbackIdentity(sessionId, promptId, agentId) {
    return JSON.stringify(['claude_plan_critique_subagent_stop', 1, sessionId, promptId, agentId]);
}
const skipped = (reason) => ({
    kind: 'skipped',
    reason,
});
/**
 * Adapt Claude's documented SubagentStop payload without reading transcripts or provider paths.
 * The final message is the exact hook field text encoded as UTF-8, not original wire bytes.
 */
export function adaptClaudeFeatureCritiqueSubagentStop(payload, context) {
    const record = plainRecord(payload);
    if (!record)
        return skipped('invalid_payload');
    if (ownDataValue(record, 'hook_event_name') !== 'SubagentStop')
        return skipped('unsupported_event');
    if (ownDataValue(record, 'agent_type') !== 'feature-critique')
        return skipped('unsupported_agent_type');
    const sessionId = ownDataValue(record, 'session_id');
    const promptId = ownDataValue(record, 'prompt_id');
    if (!opaqueIdentifier(sessionId) || !opaqueIdentifier(promptId))
        return skipped('work_identity_unavailable');
    const workId = deriveClaudePlanCritiqueWorkId(sessionId, promptId);
    const stopHookActive = ownDataValue(record, 'stop_hook_active');
    if (typeof stopHookActive !== 'boolean')
        return skipped('continuation_state_unavailable');
    if (stopHookActive)
        return { kind: 'work_unbindable', reason: 'hook_continuation', workId };
    const agentId = ownDataValue(record, 'agent_id');
    if (!opaqueIdentifier(agentId))
        return skipped('callback_identity_unavailable');
    const derivedCallbackIdentity = callbackIdentity(sessionId, promptId, agentId);
    if (Buffer.byteLength(derivedCallbackIdentity, 'utf8') > PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES)
        return skipped('callback_identity_unavailable');
    const finalMessage = ownDataValue(record, 'last_assistant_message');
    if (typeof finalMessage !== 'string')
        return skipped('final_message_unavailable');
    if (finalMessage.length > PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES ||
        Buffer.byteLength(finalMessage, 'utf8') > PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES)
        return skipped('final_message_too_large');
    if (finalMessage.trim().length === 0)
        return skipped('final_message_unavailable');
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
