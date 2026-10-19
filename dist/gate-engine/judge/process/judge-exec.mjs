// What execJudge and execJudgeAsync share: preparing a judge spawn, classifying how it settled, and
// the judge_exec telemetry line. The twins in run-judge.mts differ only in how the child runs.
import { parsePriorArtResponse } from '../../prior-art/response-contract.mjs';
import { parseJudgeUsage, recordPermissionDenials, unwrapClaudeResult, withResultArgs, } from '../claude-result.mjs';
import { saveCodexCommands } from '../codex/commands.mjs';
import { codexFailure, judgeBinFor, judgeCliFor, parseClaudeArgv, parseCodexUsage, unwrapCodexResult, } from '../codex/result.mjs';
import { prepareCodexSandbox } from '../codex/workspace.mjs';
import { emitGateEvent } from '../gate-events.mjs';
import { withoutGitEnv } from '../judge-isolation.mjs';
import { prepareJudgeMcpProfile, spawnDegradedCause, } from '../mcp/profile.mjs';
import { classifyJudgeOutage, } from '../outage/classify.mjs';
import { unavailableMessage, warnNoOutput } from '../outage/wording.mjs';
import { composeTranscript, saveTranscriptUnique } from '../transcript-store.mjs';
/** The `--model <m>` value from a judge argv, for the telemetry event; null when absent. */
function modelFromArgs(args) {
    const i = args.indexOf('--model');
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
function allowedToolsFromArgs(args) {
    return parseClaudeArgv(args).allowedTools?.join(',') ?? '';
}
/** ONE classification per failed spawn, so the sync and async paths cannot disagree. */
function reportOutage(opts, e, bin, startedAt, usage) {
    const outage = classifyJudgeOutage(e);
    const model = modelFromArgs(opts.args);
    if (outage.kind === 'model-unavailable' && model !== null)
        outage.model = model;
    console.error(unavailableMessage(opts.label, e, opts.timeout, bin));
    emitJudgeExec(opts, outage.kind, startedAt, undefined, usage, outage.detail, e.stdout);
    opts.onOutage?.(outage);
    return outage;
}
/** Keep the validated outcome queryable after its transcript expires, without copying prose. */
function priorArtTelemetry(output) {
    const parsed = parsePriorArtResponse(output);
    if (!parsed.ok)
        return { prior_art_status: 'invalid', prior_art_error: parsed.error.code };
    const result = parsed.value;
    if (result.status !== 'reviewed')
        return { prior_art_status: result.status };
    return {
        prior_art_status: result.status,
        prior_art_verdict: result.verdict,
        prior_art_framing: result.frameChallenge?.framing,
        prior_art_boundary: result.frameChallenge?.boundaryMustExist,
        prior_art_next_step: result.suggestedNextStep?.kind,
        prior_art_confidence: result.confidence,
    };
}
/** Record ONE agent run: its transcript plus the `judge_exec` line referencing it. Exported for
 *  agents never spawned here (`guard-review record-agent`), so both produce the same event shape. */
export function recordAgentRun(opts) {
    // Same predicate execJudge applies to a judge's stdout, so both entry points name a no-output run
    // identically rather than one of them calling it a success.
    const outcome = opts.outcome ?? (opts.output?.trim() ? 'ok' : 'empty');
    // Exclusive-create store: transcript_ref must keep resolving to THIS invocation's output, even
    // when a retried commit shares the run id.
    const ref = outcome === 'ok' && opts.transcript !== false && opts.output
        ? saveTranscriptUnique(opts.label, composeTranscript(opts.input ?? '', opts.output))
        : null;
    const extra = Object.fromEntries(Object.entries(opts.extra ?? {}).filter(([key]) => !key.startsWith('prior_art_')));
    if (opts.label === 'prior-art' && outcome === 'ok')
        Object.assign(extra, priorArtTelemetry(opts.output ?? ''));
    const telemetry = emitGateEvent({
        ...extra,
        type: 'judge_exec',
        judge: opts.label,
        model: opts.model ?? null,
        outcome,
        ...(opts.durationMs === undefined ? {} : { duration_ms: opts.durationMs }),
        input_chars: opts.input?.length ?? 0,
        output_chars: opts.output?.length ?? 0,
        ...(ref ? { transcript_ref: ref } : {}),
    });
    return { ref, telemetry };
}
/** One `judge_exec` line per judge spawn: the spend/outage ledger every judge shares, beside
 *  (never replacing) the gate-level verdict events some gates emit themselves. */
function emitJudgeExec(opts, outcome, startedAt, output, usage, 
/** The provider's own failure sentence, so the ledger records WHY, not just that it failed. */
outageDetail, stdout) {
    // Omitted entirely when unreadable — see parseJudgeUsage on why a zero-filled row is worse
    // than an absent one.
    const extra = usage ? { ...usage } : {};
    if (opts.lens !== undefined)
        extra.lens = opts.lens;
    // On the ledger the outage detail is queryable: which outage, and until when.
    if (outageDetail !== undefined)
        extra.outage_detail = outageDetail;
    const commandsRef = saveCodexCommands(opts.label, stdout, opts.lens);
    if (commandsRef)
        extra.commands_ref = commandsRef;
    Object.assign(extra, recordPermissionDenials(opts, stdout));
    recordAgentRun({
        label: opts.label,
        output,
        input: opts.input,
        model: modelFromArgs(opts.args),
        outcome,
        durationMs: Date.now() - startedAt,
        transcript: opts.transcript,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
    });
}
// Verdict text and spend come from ONE parse of the same bytes, by the binary that produced them.
// A codex stream with a terminal failure event reads as a FAILURE, never as verdict text.
function readJudgeOutput(stdout, cli) {
    if (cli.codex) {
        const failure = codexFailure(stdout);
        // A failed turn's stream can still carry its usage event — those tokens were burned whether or
        // not a verdict arrived, and dropping them under-counts exactly the most expensive failures.
        if (failure !== null)
            return { failure: { providerFailure: failure, stdout }, usage: parseCodexUsage(stdout) };
        return { text: unwrapCodexResult(stdout) ?? stdout, usage: parseCodexUsage(stdout) };
    }
    return { text: unwrapClaudeResult(stdout) ?? stdout, usage: parseJudgeUsage(stdout) };
}
// Salvage the spend from a FAILED spawn's partial stdout (a timeout kill or non-zero exit).
// Unparseable or absent is null, never a zero row, which would read as a free judge.
function salvageUsage(text, args) {
    if (!text || !text.trim())
        return null;
    return judgeBinFor(args) === 'claude' ? parseJudgeUsage(text) : parseCodexUsage(text);
}
// Claude gets the profile's --mcp-config flags prepended; codex gets the SAME servers translated
// into native `-c mcp_servers.*` config, secrets forwarded through the spawn env by name.
function spawnFor(args, mcp, ws) {
    const cli = judgeCliFor(args, mcp.servers, ws.codexReadOnly, ws.workspace);
    return cli.codex ? cli : { ...cli, argv: withResultArgs([...mcp.args, ...args]) };
}
export function prepareJudgeRun(opts) {
    // Started before MCP preparation, so judge_exec duration_ms covers it.
    const startedAt = Date.now();
    const mcp = prepareJudgeMcpProfile(opts.mcpProfile ?? { kind: 'none' }, {
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env,
        allowedTools: allowedToolsFromArgs(opts.args),
        projectRoots: opts.mcpProjectRoots,
    });
    return { startedAt, mcp };
}
export function cleanupJudgeRun(run) {
    run.mcp.cleanup();
    run.ws?.cleanup();
}
/** Route the argv to its binary and build the spawn options. Callers run it inside their try, so
 *  an argv a codex model cannot express settles as ONE outage instead of throwing. */
export function routeJudge(opts, run) {
    run.ws = prepareCodexSandbox(opts.args, opts.codexReadOnly === true, opts.cwd ?? process.cwd());
    const cli = spawnFor(opts.args, run.mcp, run.ws);
    opts.onMcpPrepared?.(run.mcp.capabilityFingerprint, spawnDegradedCause(run.mcp, cli.mcpInjected));
    const spawnOptions = {
        cwd: opts.cwd,
        // Never the caller's env verbatim: git leaks an absolute GIT_INDEX_FILE/GIT_DIR into hooks in a
        // linked worktree, and a judge touching another repo would write over the staged diff.
        env: { ...withoutGitEnv(opts.env), ...cli.extraEnv },
        encoding: 'utf8',
        timeout: opts.timeout,
        // SIGTERM can be trapped by the child; SIGKILL cannot, so the timeout always terminates.
        killSignal: 'SIGKILL',
        // stderr is piped and counts against maxBuffer; a judge's tool transcript can exceed 1 MB.
        maxBuffer: 10 * 1024 * 1024,
    };
    return { cli, spawnOptions };
}
/** Classify a spawn that exited cleanly: empty output, a stream-reported failure, or a verdict. */
export function settleJudgeOutput(opts, run, cli, stdout) {
    if (!stdout || !stdout.trim()) {
        warnNoOutput(opts.label, judgeBinFor(opts.args));
        emitJudgeExec(opts, 'empty', run.startedAt);
        opts.onOutage?.({ kind: 'empty', permanent: false });
        return null;
    }
    const parsed = readJudgeOutput(stdout, cli);
    if ('failure' in parsed) {
        // The stream reported the turn failed (exit 0 notwithstanding): classified, not assumed.
        reportOutage(opts, parsed.failure, cli.bin, run.startedAt, parsed.usage);
        return null;
    }
    emitJudgeExec(opts, 'ok', run.startedAt, parsed.text, parsed.usage, undefined, stdout);
    return parsed.text;
}
/** Report a spawn that failed or threw, billing whatever usage its partial stdout carries. */
export function settleJudgeError(opts, run, err) {
    const bin = judgeBinFor(opts.args);
    reportOutage(opts, err, bin, run.startedAt, salvageUsage(err.stdout, opts.args));
    return null;
}
