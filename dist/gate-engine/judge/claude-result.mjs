/**
 * The `claude -p --output-format json` envelope: how devkit asks for a judge's result AND its spend
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
 * a truncated buffer) falls back to the raw string and reports no usage. A judge that works must
 * never start failing because its accounting could not be read.
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Ask for the JSON envelope. Exported so bench runners and the spawn layer request it identically. */
export const CLAUDE_RESULT_ARGS = ['--output-format', 'json'];
/**
 * PREPEND, never append: several judges end their argv with a VARIADIC terminal flag (JUDGE_READ_ONLY
 * sits after the positional prompt), which would swallow anything added at the end. Options parse
 * before `-p` regardless of position. Idempotent — a caller that already asked for JSON is left alone
 * rather than passed a duplicate flag.
 */
export function withResultArgs(args) {
    return args.includes('--output-format') ? args : [...CLAUDE_RESULT_ARGS, ...args];
}
/** Claude's JSON output mode isolates the final result from intermediate narration. */
export function unwrapClaudeResult(raw) {
    if (raw === null)
        return null;
    try {
        const envelope = JSON.parse(raw);
        if (isRecord(envelope) &&
            envelope.type === 'result' &&
            typeof envelope.result === 'string' &&
            envelope.result.trim())
            return envelope.result;
    }
    catch {
        // Injected test doubles and older CLIs may still return the final response directly.
    }
    return raw;
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
    if (raw === null)
        return null;
    let envelope;
    try {
        envelope = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!isRecord(envelope) || envelope.type !== 'result')
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
