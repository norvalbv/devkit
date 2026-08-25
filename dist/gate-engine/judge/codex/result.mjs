/**
 * `codex exec --json` support: how devkit runs a judge on an OpenAI Codex subscription instead of
 * the `claude` CLI. Routing is BY MODEL ID — a `gpt-*` model (e.g. `gpt-5.6-sol`) spawns
 * `codex exec`; every other id keeps the claude path byte-for-byte, so execJudge's five callers
 * never change their argv and the production gates are untouched until someone configures a gpt
 * model explicitly.
 *
 * Why: ship-gate judge volume drains the owner's Claude subscription while the Codex subscription
 * has headroom (sc-2048). The two CLIs are near-isomorphic for a headless judge — prompt as argv,
 * evidence on stdin (codex appends piped stdin as a `<stdin>` block), JSON result envelope carrying
 * the final message and token usage — so the seam is argv translation + envelope parsing, not a
 * second judge pipeline.
 */
import { withResultArgs } from '../claude-result.mjs';
/** Parse the JSONL stream ONCE at the I/O boundary; the verdict/usage/failure readers below all
 * branch on these domain events rather than re-scanning raw lines. */
function codexEventsOf(raw) {
    const events = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            // SAFETY: `codex exec --json` prints one ThreadEvent object per line
            // (codex-rs/exec/src/exec_events.rs); all fields are declared optional above, so a line that
            // is JSON but not a ThreadEvent reads as an event no consumer matches.
            events.push(JSON.parse(trimmed));
        }
        catch {
            // Non-JSON noise on stdout — skipped, mirroring unwrapClaudeResult's fail-safe contract.
        }
    }
    return events;
}
/** The routing predicate: OpenAI model ids are `gpt-*`; anything else stays on the claude path. */
export function isCodexModel(model) {
    return model !== null && model.startsWith('gpt-');
}
/**
 * Claude judge argv comes in exactly two caller shapes (factory: `-p --model m <policy…> PROMPT`;
 * review gate: `-p PROMPT --model m <policy…>`), so extraction must not assume prompt position:
 * a non-flag token right after `-p` is the prompt, otherwise the trailing positional is.
 *
 * Every claude value-flag a judge caller uses MUST be listed here: an omitted one is skipped as a
 * bare flag and its VALUE is misread as the positional prompt. `--append-system-prompt` (the eval
 * harnesses' agent-brief seam) was the near-miss: omitting it would have run a gpt judge with no
 * brief while the bench still recorded agentHash as if the brief were used — a corrupted, not
 * failed, measurement.
 */
const VALUE_FLAGS = new Set([
    '--model',
    '--settings',
    '--allowedTools',
    '--disallowedTools',
    '--output-format',
    '--append-system-prompt',
]);
/** What an actual CLI option looks like (`-x`, `--kebab-or_snake`). A judge PROMPT may also start
 * with '-' (a markdown-bullet brief) but then carries spaces/punctuation no option name has. */
const CLI_OPTION_RE = /^--?[\w-]+$/;
export function parseClaudeArgv(args) {
    let model = null;
    let prompt = null;
    let systemPrompt = null;
    let readOnly = false;
    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        if (token === '-p') {
            // Same rule as the trailing positional below: prompt TEXT may open on a dash (a markdown
            // bullet), so only a token that actually looks like a CLI option is refused here —
            // `startsWith('-')` alone silently dropped a dash-led prompt in this caller shape too.
            const next = args[i + 1];
            if (next !== undefined && !CLI_OPTION_RE.test(next)) {
                prompt = next;
                i += 1;
            }
            continue;
        }
        if (VALUE_FLAGS.has(token)) {
            if (token === '--model')
                model = args[i + 1] ?? null;
            if (token === '--append-system-prompt')
                systemPrompt = args[i + 1] ?? null;
            if (token === '--disallowedTools')
                readOnly = true;
            i += 1;
            continue;
        }
        if (token.startsWith('-')) {
            // The trailing positional is ALLOWED to start with '-' (a prompt opening on a markdown
            // bullet): a dash-led LAST token that is not flag-shaped is that prompt, not an option —
            // skipping it would leave prompt=null and misreport a working judge as an outage.
            if (prompt === null && i === args.length - 1 && !CLI_OPTION_RE.test(token))
                prompt = token;
            continue;
        }
        prompt = token;
    }
    return { model, prompt, systemPrompt, readOnly };
}
/**
 * Translate a claude judge argv into the equivalent `codex exec` argv. Hermetic on purpose:
 * `--ignore-user-config` (auth still works, but the owner's MCP servers / notify hooks / desktop
 * integrations must not load into a judge), `--ignore-rules` (nor user execpolicy), `--ephemeral`
 * (the codex twin of `--no-session-persistence`), `--skip-git-repo-check` (bench scratch dirs are
 * not always repos). Evidence still arrives on stdin — codex appends it as a `<stdin>` block.
 */
export function codexExecArgs(parts) {
    if (!parts.model || !parts.prompt)
        throw new Error('codex judge: argv carries no --model or no prompt — cannot translate');
    // Codex exec has no system-prompt flag: an agent brief (`--append-system-prompt`) is prepended
    // to the prompt instead. A labeled block, so the model sees the brief/task boundary the two
    // claude message slots used to provide.
    const prompt = parts.systemPrompt
        ? `<agent-brief>\n${parts.systemPrompt}\n</agent-brief>\n\n${parts.prompt}`
        : parts.prompt;
    // `--json` is the same flag OpenAI's own SDK spawns as `--experimental-json` (an alias,
    // codex-rs/exec/src/cli.rs) — machine-readable but not promised frozen, which is why the parsers
    // here are pinned by a captured fixture and a failure-event test. Web search is disabled the way
    // the vendor SDK does it (`-c` override): no claude judge ever had a web tool, and a judge must
    // not browse.
    return [
        'exec',
        '--model',
        parts.model,
        '--sandbox',
        parts.readOnly ? 'read-only' : 'workspace-write',
        '-c',
        'web_search="disabled"',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--ephemeral',
        '--color',
        'never',
        '--json',
        prompt,
    ];
}
/** The codex binary to spawn: overridable so an operator can pin ONE build when several sit on
 * PATH (measured on this machine: 0.149.0-alpha and 0.146.0 resolve depending on hook PATH
 * order, and the JSONL schema is per-version). */
const codexBin = () => process.env.GUARD_CODEX_BIN || 'codex';
/**
 * The ONE routing decision, taken from the caller's untouched claude-shaped argv — every consumer
 * (spawn, outage wording, output parsing) derives from this, so first-vs-last `--model` ambiguity
 * cannot make two call sites disagree about which binary ran. The claude branch reproduces the
 * pre-adapter spawn exactly (withResultArgs included), which the routing test pins.
 */
export function judgeCliFor(args) {
    const parts = parseClaudeArgv(args);
    if (!isCodexModel(parts.model))
        return { bin: 'claude', argv: withResultArgs(args), codex: false };
    return { bin: codexBin(), argv: codexExecArgs(parts), codex: true };
}
/** The binary NAME for outage wording — must never throw (it runs inside catch blocks, including
 * when argv translation itself threw), so it derives from the same parse but skips translation. */
export function judgeBinFor(args) {
    return isCodexModel(parseClaudeArgv(args).model) ? codexBin() : 'claude';
}
/** The verdict text: the LAST completed `agent_message` in the JSONL stream, or null when none
 * parses — the spawn layer then falls back to the raw bytes, same fail-safe as the claude path. */
export function unwrapCodexResult(raw) {
    if (raw === null)
        return null;
    let last = null;
    for (const event of codexEventsOf(raw)) {
        if (event.type !== 'item.completed' || event.item?.type !== 'agent_message')
            continue;
        const text = event.item.text;
        if (text !== undefined && text.trim())
            last = text;
    }
    return last;
}
/**
 * A terminal failure event, or null on a healthy stream. `turn.failed` (error.message) and the
 * top-level `error` event (message) are first-class in codex's taxonomy
 * (codex-rs/exec/src/exec_events.rs: TurnFailedEvent, ThreadErrorEvent) — a stream carrying one
 * must land on the OUTAGE path, never fall through to "no agent_message → raw JSONL as verdict,
 * outcome ok", which is how the naive parsers in the wild get it wrong.
 */
export function codexFailure(raw) {
    if (raw === null)
        return null;
    let failure = null;
    for (const event of codexEventsOf(raw)) {
        if (event.type === 'turn.failed')
            failure = event.error?.message ?? 'turn.failed';
        else if (event.type === 'error')
            failure = event.message ?? 'error event';
    }
    return failure;
}
const count = (value) => value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
/**
 * Spend from the LAST `turn.completed` event, mapped onto the collector's claude-shaped columns:
 * codex's `input_tokens` INCLUDES the cached portion — codex's own accessor is
 * `non_cached_input() = (input_tokens - cached_input()).max(0)` (codex-rs/protocol/src/protocol.rs)
 * — while claude's excludes it, so the cached slice is subtracted to keep `input_tokens` meaning
 * "uncached input" in every row; reasoning tokens are billed output and fold into `output_tokens`.
 * Null when no usage event parses — never a zero-filled row (see parseJudgeUsage on why).
 */
export function parseCodexUsage(raw) {
    if (raw === null)
        return null;
    let usage = null;
    for (const event of codexEventsOf(raw))
        if (event.type === 'turn.completed' && event.usage)
            usage = event.usage;
    if (!usage)
        return null;
    const input = count(usage.input_tokens);
    const cached = count(usage.cached_input_tokens);
    return {
        input_tokens: Math.max(0, input - cached),
        output_tokens: count(usage.output_tokens) + count(usage.reasoning_output_tokens),
        cache_creation: count(usage.cache_write_input_tokens),
        cache_read: cached,
        cost_usd: 0,
        billing: 'subscription',
    };
}
