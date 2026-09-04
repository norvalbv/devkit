// Shared exec + catch-and-warn for every `claude -p` gate judge (the judge-gate factory and any
// thin caller built on it: vision / sentry / critique / decisions in the consumer repo).
//
// WHY this exists: each gate used to wrap its `claude` call in `try { … } catch { return null }` with
// NO log. So when the judge could not run (binary absent / offline / quota-exhausted / timeout) the
// gate failed open SILENTLY — the maintainer never learned the LLM check had gone dark. On a drainable
// per-user credit pool a mid-month outage is a real, recurring failure class. This helper makes that
// outage VISIBLE (one stderr line) without changing any exit code — the gate's own fail-open/block
// decision is untouched.
//
// It owns ONLY the exec + catch-and-warn. Argv composition stays in each caller because the flag sets
// genuinely diverge (read-only `--disallowedTools *` vs investigating `--allowedTools`, prompt
// position, model, timeout, stdin slicing). The caller builds `args`; the helper runs it.
//
// The warning states the OUTAGE only ("judgement skipped") — NOT the gate outcome, because that
// diverges: a warn-by-default gate fails open (commit proceeds) while a deterministic-floor gate's
// regex floor still blocks. Each caller describes its own consequence where it differs.

import { execFile, execFileSync } from 'node:child_process';
import {
  type JudgeUsage,
  parseJudgeUsage,
  unwrapClaudeResult,
  withResultArgs,
} from './claude-result.mts';
import {
  codexFailure,
  judgeBinFor,
  type JudgeCli,
  judgeCliFor,
  parseClaudeArgv,
  parseCodexUsage,
  unwrapCodexResult,
} from './codex/result.mts';
import { emitGateEvent } from './gate-events.mts';
import { withoutGitEnv } from './judge-isolation.mts';
import {
  type JudgeMcpProfile,
  type PreparedJudgeMcpProfile,
  prepareJudgeMcpProfile,
} from './mcp/profile.mts';
import {
  classifyJudgeOutage,
  type JudgeError,
  type JudgeOutage,
  type JudgeOutageKind,
} from './outage/classify.mts';
import { unavailableMessage, warnNoOutput } from './outage/wording.mts';

import { composeTranscript, saveTranscriptUnique } from './transcript-store.mts';

// Re-exported so the gates that already import their remedy wording from here keep ONE import path,
// while the wording itself lives beside the classifier that decides it.
export { strictRemedy, unavailableMessage } from './outage/wording.mts';

// Narrow an unknown thrown value to the JudgeError shape; a non-object (or null) reads as {} so every
// field access is undefined — matching the original `e?.field` optional-chaining behaviour exactly.
function judgeErr(e: unknown): JudgeError {
  return e && typeof e === 'object' ? (e as JudgeError) : {};
}

/** ONE classification per failed spawn, so the sync and async paths cannot disagree. The double
 *  classify keeps the wording a pure function of the error, hence unit-testable. */
function reportOutage(
  opts: ExecJudgeOpts,
  e: JudgeError,
  bin: string,
  startedAt: number,
  usage?: JudgeUsage | null,
): JudgeOutage {
  const outage = classifyJudgeOutage(e);
  console.error(unavailableMessage(opts.label, e, opts.timeout, bin));
  emitJudgeExec(opts, outage.kind, startedAt, undefined, usage, outage.detail);
  opts.onOutage?.(outage);
  return outage;
}

/**
 * THE cap for a deep, tool-using judge that investigates a whole staged diff — the review-gate
 * cascade (first pass + escalation) AND the commit-msg completeness judge. ONE constant on purpose
 * (sc-1227): these were two independent literals, the review gate's was raised to 30 min for the
 * reason below, completeness's was left at 420000 under a comment still claiming the two were
 * "aligned", and every commit whose completeness judgement ran past 420s became unshippable —
 * strict ship fails closed on a SKIP and completeness is the last gate.
 *
 * WHY 30 min (sc-1048): the correctness reviewer's deep four-lens investigation legitimately runs
 * past the old 420s cap and got SIGKILLed mid-verdict — measured on the usage-tracker as repeated
 * 421s inconclusive timeouts while the median run is ~60-250s. The cap is sized for the
 * slow-but-working judge, not the median. A judge that TIMES OUT is never re-run (see
 * cascadeVerdict), so a stuck judge still costs at most one cap, not two.
 *
 * NOTE: a single pass exceeds the 600s foreground tool cap — an AGENT-driven commit (the gate run
 * inside a Bash tool) is still killed at 600s, so this cap takes FULL effect only for a commit run
 * in a real terminal (or a detached ship), where SHIP_COMMIT_TIMEOUT is the outer bound.
 *
 * NOT for the shallow, scope-limited judges: the decisions gate's haiku/opus alignment cascade
 * reads one target's staged hunks and keeps its own much tighter caps.
 */
export const DEEP_JUDGE_TIMEOUT_MS = 1800000;

/** Run one judge invocation: raw stdout, or null after ONE stderr warning when it could not run.
 *  `onOutage` fires with the classified outage, whose `permanent` flag is the retry predicate. */
// Options for both execJudge and its async twin. onOutage is optional — most callers don't retry.
// Transcripts are collected BY DEFAULT (the ledger's whole point is that judgements stay
// inspectable without any caller remembering to ask); `transcript: false` opts out — for gates
// that already persist their own gate-level transcript (the review gate) so every diff isn't
// stored twice. `timeout` is REQUIRED (sc-1317): Node's `execFile`/`execFileSync` treat an
// omitted/0 timeout as "no cap at all", which would silently defeat the SIGKILL guarantee below —
// every real caller already supplies one, so this is a type-level guard, not a behavior change.
interface ExecJudgeOpts {
  label: string;
  args: string[];
  input?: string;
  timeout: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Fires once per failed spawn with the CLASSIFIED outage — `permanent` is the retry predicate. */
  onOutage?: (outage: JudgeOutage) => void;
  transcript?: boolean;
  /** Strict MCP profile. Omitted means a pure/internal judge with no MCP servers. */
  mcpProfile?: JudgeMcpProfile;
  /** Observes the exact, secret-safe MCP capability identity prepared for this spawn. */
  onMcpPrepared?: (capabilityFingerprint: string) => void;
  /** Trusted-registry project roots; isolated fixtures supply the consumer root they represent. */
  mcpProjectRoots?: readonly string[];
  /** Tool-equipped, write-free Codex judge; required without staged-tree tamper detection. */
  codexReadOnly?: boolean;
  /** Split-reviewer lens group for judge_exec spend attribution; all parts share one judge label. */
  lens?: string;
}

/** The `--model <m>` value from a judge argv, for the telemetry event; null when absent. */
function modelFromArgs(args: string[]): string | null {
  const i = args.indexOf('--model');
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

function allowedToolsFromArgs(args: string[]): string {
  return parseClaudeArgv(args).allowedTools?.join(',') ?? '';
}

export interface RecordAgentRunOpts {
  /** Telemetry label — the `judge` field, e.g. `review:correctness-reviewer` or `prior-art`. */
  label: string;
  /** The agent's response. Absent/empty means no transcript is stored (nothing to store). */
  output?: string;
  /** What the agent judged, stored above the output under the DIFF header. */
  input?: string;
  model?: string | null;
  /**
   * Omit to have it DERIVED from `output` — an absent/blank response is `empty`, matching how
   * execJudge classifies the same condition. Never defaults to a blanket `ok`: that would land a
   * no-output run as `{outcome:'ok', output_chars:0}`, distinguishable from a real success only by
   * inferring from the missing `transcript_ref` (which gate-telemetry-self-describing rules out)
   * and silently inflating the label's success rate.
   */
  outcome?: 'ok' | JudgeOutageKind;
  /** Omitted entirely from the event when unknown, rather than emitted as a misleading 0. */
  durationMs?: number;
  transcript?: boolean;
  /** Extra event keys (e.g. a disposition). Spread FIRST so it can never shadow the core shape. */
  extra?: Record<string, unknown>;
}

/**
 * Record ONE agent invocation into the shared telemetry stream: the durable transcript plus the
 * `judge_exec` line that references it. Exported because not every agent devkit wants visible is
 * spawned through `execJudge` — one dispatched by the assistant via the Task tool (the `prior-art`
 * subagent the brainstorming skill invokes) never enters this module, so its production runs were
 * absent from the dashboard while its BENCH runs, which do go through execJudgeAsync, were recorded
 * in full.
 * `guard-review record-agent` is the entry point for those; this is the one implementation both use,
 * so a Task-dispatched agent and a spawned judge produce the same event shape.
 *
 * Best-effort by construction — emitGateEvent/saveTranscriptUnique never throw and no-op without a
 * sink, so no caller's contract is touched. Returns the transcript ref, or null when none was stored.
 */
export function recordAgentRun(opts: RecordAgentRunOpts): string | null {
  // Same predicate execJudge applies to a judge's stdout, so both entry points name a no-output run
  // identically rather than one of them calling it a success.
  const outcome = opts.outcome ?? (opts.output?.trim() ? 'ok' : 'empty');
  // Exclusive-create store: the durable event line's transcript_ref must keep resolving to THIS
  // invocation's output — never silently rewritten by a later sample OR a later process (a
  // retried/amended commit shares the same run id). Uniqueness is the filesystem's, not ours.
  const ref =
    outcome === 'ok' && opts.transcript !== false && opts.output
      ? saveTranscriptUnique(opts.label, composeTranscript(opts.input ?? '', opts.output))
      : null;
  emitGateEvent({
    ...(opts.extra ?? {}),
    type: 'judge_exec',
    judge: opts.label,
    model: opts.model ?? null,
    outcome,
    ...(opts.durationMs === undefined ? {} : { duration_ms: opts.durationMs }),
    input_chars: opts.input?.length ?? 0,
    output_chars: opts.output?.length ?? 0,
    ...(ref ? { transcript_ref: ref } : {}),
  });
  return ref;
}

/**
 * One `judge_exec` telemetry line per `claude -p` invocation — the SPEND/OUTAGE ledger every judge
 * shares, complementing (never replacing) the richer gate-level verdict events the review/decisions
 * gates emit themselves. This is what makes every judge visible to the usage tracker: the gate-level
 * emitters only cover the gates that thought to call them (the factory/sentry judges recorded
 * nothing at all before this).
 */
function emitJudgeExec(
  opts: ExecJudgeOpts,
  outcome: 'ok' | JudgeOutageKind,
  startedAt: number,
  output?: string,
  usage?: JudgeUsage | null,
  /** The provider's own failure sentence, so the ledger records WHY, not just that it failed. */
  outageDetail?: string,
): void {
  // Omitted entirely when unreadable — see parseJudgeUsage on why a zero-filled row is worse
  // than an absent one.
  const extra: Partial<JudgeUsage> & { lens?: string; outage_detail?: string } = usage
    ? { ...usage }
    : {};
  if (opts.lens !== undefined) extra.lens = opts.lens;
  // The sc-2538 evidence sat in a stderr line nobody kept. On the ledger it is queryable: the
  // dashboard can answer "which outage, and until when" without re-running the ship.
  if (outageDetail !== undefined) extra.outage_detail = outageDetail;
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

/**
 * Unwrap one judge's stdout into the verdict text its caller expects, plus the spend to bill it.
 * Both come from the SAME parse of the same bytes, so a run can never be recorded with a cost that
 * belongs to different output. The parser follows the binary that produced the bytes — a codex
 * JSONL stream fed to the claude unwrapper would hand the verdict parser raw event noise. A codex
 * stream carrying a terminal failure event (`turn.failed` / `error`) reads as a FAILURE, never as
 * verdict text: falling through would record outcome 'ok' with raw JSONL as the transcript.
 */
function readJudgeOutput(
  stdout: string,
  cli: JudgeCli,
): { text: string; usage: JudgeUsage | null } | { failure: string; usage: JudgeUsage | null } {
  if (cli.codex) {
    const failure = codexFailure(stdout);
    // A failed turn's stream can still carry its usage event — those tokens were burned whether or
    // not a verdict arrived, and dropping them under-counts exactly the most expensive failures.
    if (failure !== null) return { failure, usage: parseCodexUsage(stdout) };
    return { text: unwrapCodexResult(stdout) ?? stdout, usage: parseCodexUsage(stdout) };
  }
  return { text: unwrapClaudeResult(stdout) ?? stdout, usage: parseJudgeUsage(stdout) };
}

/**
 * Salvage the spend from a FAILED spawn's partial stdout: the SIGKILL at the cap and a non-zero
 * exit both leave whatever the judge streamed first, and a parseable usage record there prices
 * tokens that were burned regardless of the missing verdict. Unparseable/absent → null, never a
 * zero row (see parseJudgeUsage: a zero-filled row reads downstream as a free judge).
 */
function salvageUsage(text: string | undefined, args: string[]): JudgeUsage | null {
  if (!text || !text.trim()) return null;
  return judgeBinFor(args) === 'claude' ? parseJudgeUsage(text) : parseCodexUsage(text);
}

/**
 * Compose the spawn for the routed binary. The claude path prepends the profile's --mcp-config
 * flags; the codex path translates the SAME selected servers into codex-native `-c mcp_servers.*`
 * config with secrets forwarded through the spawn env by NAME (sc-2054 — see codexMcpArgs). Both
 * runtimes now honor the judge-mcp-profiles Target.
 */
function spawnFor(args: string[], mcp: PreparedJudgeMcpProfile, codexReadOnly = false): JudgeCli {
  const cli = judgeCliFor(args, mcp.servers, codexReadOnly);
  return cli.codex ? cli : { ...cli, argv: withResultArgs([...mcp.args, ...args]) };
}

export function execJudge(opts: ExecJudgeOpts): string | null {
  const { label, args, input, timeout, cwd, env, onOutage } = opts;
  const startedAt = Date.now();
  const mcp = prepareJudgeMcpProfile(opts.mcpProfile ?? { kind: 'none' }, {
    cwd: cwd ?? process.cwd(),
    env,
    allowedTools: allowedToolsFromArgs(args),
    projectRoots: opts.mcpProjectRoots,
  });
  try {
    opts.onMcpPrepared?.(mcp.capabilityFingerprint);
    // Inside the try on purpose: an argv a codex model cannot express (no prompt) surfaces as ONE
    // outage warning carrying the translation error, keeping this function's never-throws contract.
    const cli = spawnFor(args, mcp, opts.codexReadOnly === true);
    const out = execFileSync(cli.bin, cli.argv, {
      cwd,
      // Never the caller's env verbatim: git leaks an ABSOLUTE GIT_INDEX_FILE/GIT_DIR into every
      // hook run in a linked worktree (how ship commits), and a tool-using judge that touches
      // another repo would write ITS index over the ship's staged diff. See withoutGitEnv.
      env: { ...withoutGitEnv(env), ...cli.extraEnv },
      input,
      encoding: 'utf8',
      timeout,
      // SIGTERM alone can be trapped/ignored by the child, leaving the cap best-effort instead of a
      // guarantee (sc-1317) — SIGKILL cannot be caught, so the timeout always actually terminates.
      killSignal: 'SIGKILL',
      // stderr was DISCARDED, throwing away the one channel a claude quota message arrives on.
      // Nothing was ever displayed from it, so piping it changes no output.
      stdio: ['pipe', 'pipe', 'pipe'],
      // REQUIRED by the line above: stderr now counts against maxBuffer, so the 1 MB default would
      // turn a chatty-but-healthy judge into an ENOBUFS failure. 10 MB matches the async twin.
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!out || !String(out).trim()) {
      warnNoOutput(label, judgeBinFor(args));
      emitJudgeExec(opts, 'empty', startedAt);
      onOutage?.({ kind: 'empty', permanent: false });
      return null;
    }
    const parsed = readJudgeOutput(String(out), cli);
    if ('failure' in parsed) {
      // The stream reported the turn failed (exit 0 notwithstanding). This was hardcoded
      // `transient` while HOLDING the message that proves a usage lock is not transient.
      reportOutage(opts, { providerFailure: parsed.failure }, cli.bin, startedAt, parsed.usage);
      return null;
    }
    emitJudgeExec(opts, 'ok', startedAt, parsed.text, parsed.usage);
    return parsed.text;
  } catch (e) {
    reportOutage(
      opts,
      judgeErr(e),
      judgeBinFor(args),
      startedAt,
      salvageUsage(judgeErr(e).stdout, args),
    );
    return null;
  } finally {
    mcp.cleanup();
  }
}

/**
 * Async twin of execJudge — same contract (raw stdout, or `null` after ONE stderr warning), but
 * non-blocking so a caller can run SEVERAL judges concurrently (the review gate fans out one judge
 * per domain reviewer; serialising them would multiply the commit's wall-clock by the reviewer
 * count). Callback-form execFile because the promisified variant cannot take stdin: the prompt's
 * evidence (diffstat) goes to the child's stdin by hand. maxBuffer is explicit — an investigating
 * judge's transcript (tool output included) can exceed the 1 MB default.
 *
 * @param {{ label: string, args: string[], input?: string, timeout: number, cwd?: string, onOutage?: (outage: JudgeOutage) => void }} opts
 * @returns {Promise<string|null>}
 */
export function execJudgeAsync(opts: ExecJudgeOpts): Promise<string | null> {
  const { label, args, input, timeout, cwd, env, onOutage } = opts;
  const startedAt = Date.now();
  const mcp = prepareJudgeMcpProfile(opts.mcpProfile ?? { kind: 'none' }, {
    cwd: cwd ?? process.cwd(),
    env,
    allowedTools: allowedToolsFromArgs(args),
    projectRoots: opts.mcpProjectRoots,
  });
  return new Promise((resolve) => {
    // Shared outage path — a callback error AND a synchronous throw from execFile() itself (e.g. an
    // out-of-range `timeout` validates and throws before spawn even starts, sc-1317) both resolve
    // null the same way. Without the try/catch below, that synchronous throw escaped as a REJECTED
    // promise, breaking this function's own documented contract (never throws/rejects, always
    // resolves) for any caller awaiting it outside its own try/catch — the sync execJudge twin
    // already had this same guard via its enclosing try/catch.
    const fail = (err: JudgeError, stdout?: string) => {
      mcp.cleanup();
      // The callback's own stdout wins (execFile hands it beside the error); the throw-attached
      // copy covers the synchronous-throw path.
      const streams = stdout ?? err.stdout;
      reportOutage(
        opts,
        { ...err, stdout: streams },
        judgeBinFor(args),
        startedAt,
        salvageUsage(streams, args),
      );
      resolve(null);
    };
    try {
      opts.onMcpPrepared?.(mcp.capabilityFingerprint);
      // See the sync twin: routing inside the try keeps the never-rejects contract when argv
      // translation itself throws.
      const cli = spawnFor(args, mcp, opts.codexReadOnly === true);
      const child = execFile(
        cli.bin,
        cli.argv,
        {
          cwd,
          // env: see the execJudge twin — the git-env scrub applies to every judge spawn.
          env: { ...withoutGitEnv(env), ...cli.extraEnv },
          encoding: 'utf8',
          timeout,
          // See the execJudge twin: SIGKILL so the cap is a guaranteed kill, not a trappable request.
          killSignal: 'SIGKILL',
          maxBuffer: 10 * 1024 * 1024,
        },
        // The third parameter was omitted, silently dropping stderr — the channel a claude-family
        // quota message arrives on (sc-2538). The sync twin's `stdio` change is this one's mirror.
        (err, stdout, stderr) => {
          if (err) {
            fail(
              { ...judgeErr(err), stderr: stderr ? String(stderr) : undefined },
              stdout ? String(stdout) : undefined,
            );
            return;
          }
          mcp.cleanup();
          if (!stdout || !String(stdout).trim()) {
            warnNoOutput(label, judgeBinFor(args));
            emitJudgeExec(opts, 'empty', startedAt);
            onOutage?.({ kind: 'empty', permanent: false });
            resolve(null);
            return;
          }
          const parsed = readJudgeOutput(String(stdout), cli);
          if ('failure' in parsed) {
            // See the sync twin: a stream-reported failed turn is classified, not assumed.
            reportOutage(
              opts,
              { providerFailure: parsed.failure },
              cli.bin,
              startedAt,
              parsed.usage,
            );
            resolve(null);
            return;
          }
          emitJudgeExec(opts, 'ok', startedAt, parsed.text, parsed.usage);
          resolve(parsed.text);
        },
      );
      // EPIPE guard: claude may exit (ENOENT wrapper, early crash) before stdin is consumed.
      child.stdin?.on('error', () => {});
      if (input !== undefined) child.stdin?.write(input);
      child.stdin?.end();
    } catch (e) {
      fail(judgeErr(e));
    }
  });
}
