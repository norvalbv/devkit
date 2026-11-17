/**
 * The `claude -p` result envelope: how devkit asks for a judge's result AND its spend
 * in one spawn.
 *
 * Why the gate chain needs this at all: a judge's cost was unmeasurable. `judge_exec` carried
 * duration and model but no tokens, while the usage tracker's own token rows are keyed by session
 * and carry no ship_id — two halves with no join, and the headless judge sessions were captured only
 * partially anyway (1,191 haiku rows against 2,338 haiku judge calls over one six-day sample). The
 * chars we did record are the prompt plus the final verdict line, which misses every file a judge
 * READ — the bulk of an investigating reviewer's spend. Meanwhile the CLI had been reporting exact
 * usage, cost and a session id all along, and text mode threw it away (sc-1527).
 *
 * The envelope is unwrapped HERE, at the spawn layer, so callers keep receiving the verdict text
 * they already parse — switching output modes is not their problem.
 *
 * Fail-safe by construction: anything unrecognised (an older CLI, a test double returning bare text,
 * codex output) falls back to the raw string and reports no usage. A judge that works must
 * never start failing because its accounting could not be read.
 */
import { z } from 'zod';
import { isRecord } from '../eval/schema.mjs';
import { saveSidecar } from './transcript-store.mjs';
/** Ask for the event stream (`--verbose` is required with it under `-p`). Shared with bench runners. */
export const CLAUDE_RESULT_ARGS = ['--output-format', 'stream-json', '--verbose'];
/**
 * PREPEND, never append: several judges end their argv with a VARIADIC terminal flag (JUDGE_READ_ONLY
 * sits after the positional prompt), which would swallow anything added at the end. Options parse
 * before `-p` regardless of position. Idempotent — a caller that already asked for JSON is left alone
 * rather than passed a duplicate flag.
 */
export function withResultArgs(args) {
    return args.includes('--output-format') ? args : [...CLAUDE_RESULT_ARGS, ...args];
}
const toolInputSchema = z.looseObject({ command: z.string().optional() }).catch({});
const denialSchema = z.object({
    tool_name: z.string().catch('unknown'),
    tool_use_id: z.string().optional(),
    tool_input: toolInputSchema,
});
const blockSchema = z.object({
    type: z.string(),
    id: z.string().optional().catch(undefined),
    name: z.string().catch('unknown'),
    input: toolInputSchema,
    tool_use_id: z.string().optional().catch(undefined),
    is_error: z.boolean().optional().catch(undefined),
});
const claudeEventSchema = z.looseObject({
    type: z.enum(['system', 'assistant', 'user', 'result']),
    subtype: z.string().optional().catch(undefined),
    result: z.string().optional().catch(undefined),
    tool_use_id: z.string().optional().catch(undefined),
    parent_tool_use_id: z.string().nullish().catch(null),
    permission_denials: z.array(denialSchema).optional().catch(undefined),
    message: z
        .object({ content: z.array(blockSchema).catch([]) })
        .optional()
        .catch(undefined),
});
/** The claude events in `raw`, one per JSON line. Empty for bytes that are not claude output. */
function claudeEvents(raw) {
    const events = [];
    for (const line of raw?.split('\n') ?? []) {
        if (!line.trimStart().startsWith('{'))
            continue;
        let json;
        try {
            json = JSON.parse(line);
        }
        catch {
            continue; // A torn final line from a killed spawn; the events before it still count.
        }
        const event = claudeEventSchema.safeParse(json);
        if (event.success)
            events.push(event.data);
    }
    return events;
}
function resultEvent(events) {
    return events.filter((event) => event.type === 'result').at(-1);
}
function resultText(event) {
    return event?.result?.trim() ? event.result : null;
}
/**
 * The judge's final reply. Bytes that are not claude output (a test double's bare text) pass through,
 * but a claude stream without a result is null: the raw stream holds every file the judge read.
 */
export function unwrapClaudeResult(raw) {
    if (raw === null)
        return null;
    const events = claudeEvents(raw);
    return events.length === 0 ? raw : resultText(resultEvent(events));
}
/** Why a claude stream carries no verdict, or null when it does (or is not claude output). */
export function claudeFailure(raw) {
    const events = claudeEvents(raw);
    const result = resultEvent(events);
    if (events.length === 0 || resultText(result) !== null)
        return null;
    return `claude returned no result text (${result?.subtype ?? 'stream ended without a result'})`;
}
const count = (value) => (typeof value === 'number' && value >= 0 ? value : 0);
/**
 * The spend fields, or null when the envelope is absent/unreadable — never a zero-filled object. A
 * synthetic `{tokens: 0, cost: 0}` row would read downstream as a free judge and quietly deflate
 * every cost aggregate; an absent row reads as "not measured", which is the truth.
 *
 * Cache reads are kept as their own field rather than folded into input: at these prompt sizes they
 * dominate the raw token count while costing a fraction, so summing them would misrank reviewers.
 */
export function parseJudgeUsage(raw) {
    const envelope = resultEvent(claudeEvents(raw));
    if (!envelope)
        return null;
    const usage = isRecord(envelope.usage) ? envelope.usage : {};
    const cost = envelope.total_cost_usd;
    return {
        input_tokens: count(usage.input_tokens),
        output_tokens: count(usage.output_tokens),
        cache_creation: count(usage.cache_creation_input_tokens),
        cache_read: count(usage.cache_read_input_tokens),
        cost_usd: typeof cost === 'number' && cost >= 0 ? cost : 0,
        ...(typeof envelope.session_id === 'string' && envelope.session_id
            ? { session_id: envelope.session_id }
            : {}),
    };
}
const WHITESPACE_RUN_RE = /\s+/g;
const TOOL_LINE_CHARS = 500;
/** `<tool>: <command, else the input as JSON>`, whitespace-collapsed and capped. */
function toolCallLine(name, input) {
    const what = input.command ?? JSON.stringify(input);
    return `${name}: ${what}`.replace(WHITESPACE_RUN_RE, ' ').slice(0, TOOL_LINE_CHARS);
}
/**
 * The tool calls the headless permission gate refused, one `<tool>: <command>` line each. Null when
 * the bytes carry no `permission_denials` list (codex, a test double): not measured, never zero.
 */
export function parsePermissionDenials(raw) {
    const denials = resultEvent(claudeEvents(raw))?.permission_denials;
    return denials?.map((d) => toolCallLine(d.tool_name, d.tool_input)) ?? null;
}
const modelRefusalSchema = z.object({
    type: z.literal('result'),
    is_error: z.literal(true),
    terminal_reason: z.literal('api_error'),
    api_error_status: z.literal(404),
    result: z.string(),
});
/** The CLI's own sentence when the API 404s the requested model, else null. Only an API-error
 *  envelope is read, so model-authored text never reaches outage telemetry. */
export function claudeModelRefusal(raw) {
    if (!raw)
        return null;
    let json;
    try {
        json = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const envelope = modelRefusalSchema.safeParse(json);
    return envelope.success ? envelope.data.result : null;
}
/** Hand a spawn's denials to its caller and store their text in a `<label>.denied` sidecar.
 * `fallback` carries denials measured outside the claude envelope (the codex tool gate). */
export function recordPermissionDenials(sink, raw, fallback) {
    const denied = parsePermissionDenials(raw) ?? fallback ?? null;
    if (denied === null)
        return {};
    sink.onPermissionDenials?.(denied);
    const fields = { permission_denials: denied.length };
    if (denied.length === 0)
        return fields;
    const ref = saveSidecar(`${sink.label}.denied`, denied, sink.lens);
    if (ref)
        fields.denials_ref = ref;
    return fields;
}
function deniedIds(events) {
    const refused = events.filter((e) => e.type === 'system' && e.subtype === 'permission_denied');
    const denials = resultEvent(events)?.permission_denials ?? [];
    return new Set([...denials, ...refused].map((d) => d.tool_use_id));
}
/**
 * One line per tool call, in call order: `[ok|error|denied|no result]`, the last when the stream
 * ended before the call returned. Only the call is kept, never its result body.
 */
export function claudeCommandLines(raw) {
    const events = claudeEvents(raw);
    const calls = new Map();
    for (const event of events)
        for (const block of event.message?.content ?? []) {
            if (event.type === 'assistant' && block.type === 'tool_use' && block.id) {
                const via = event.parent_tool_use_id ? '(subagent) ' : '';
                calls.set(block.id, {
                    line: via + toolCallLine(block.name, block.input),
                    status: 'no result',
                });
            }
            const call = block.type === 'tool_result' && block.tool_use_id && calls.get(block.tool_use_id);
            if (call)
                call.status = block.is_error ? 'error' : 'ok';
        }
    const denied = deniedIds(events);
    return [...calls].map(([id, c]) => `[${denied.has(id) ? 'denied' : c.status}] ${c.line}`);
}
/** Store the tool calls as `<label>.commands`; the ref, or null when the judge called no tool. */
export function saveClaudeCommands(label, raw, lens) {
    return saveSidecar(`${label}.commands`, raw ? claudeCommandLines(raw) : [], lens);
}
