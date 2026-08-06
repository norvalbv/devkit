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
import { emitGateEvent } from "./gate-events.mjs";
import { withoutGitEnv } from "./judge-isolation.mjs";
import { composeTranscript, saveTranscriptUnique } from "./transcript-store.mjs";
// Narrow an unknown thrown value to the JudgeError shape; a non-object (or null) reads as {} so every
// field access is undefined — matching the original `e?.field` optional-chaining behaviour exactly.
function judgeErr(e) {
    return e && typeof e === 'object' ? e : {};
}
// The two dark-judge warning shapes, shared by the sync and async runners so the outage stays
// visible with ONE wording (and the twin catch blocks don't diverge or trip the dup gate).
function warnNoOutput(label) {
    // Ran (exit 0) but emitted nothing — a soft outage the parser would silently read as "no
    // verdict". Surface it so this variant of a dark judge is not silent either.
    console.error(`⚠️  ${label}: claude judge returned no output — judgement skipped`);
}
// A timeout KILL (SIGTERM at the N-second cap) is the gate's OWN contention kill, not auth/quota — so
// it must NOT read as "offline/quota/absent". That label sent an operator chasing a phantom quota
// problem on a healthy subscription (sc-1049); "offline/quota/absent" is reserved for a genuine outage
// (ENOENT / 401 / non-zero exit). Pure fn (not the console.error wrapper) so the wording is unit-
// testable without spawning `claude`. Retrying a timeout is a separate concern (sc-1048), so this
// stays outage-only — no "will retry" claim the code doesn't honor.
export function unavailableMessage(label, e, timeout) {
    if (isJudgeTimeout(e)) {
        // `> 0` too, not just finite — a 0ms cap would render a nonsense "after 0s".
        const secs = timeout != null && Number.isFinite(timeout) && timeout > 0
            ? `after ${Math.round(timeout / 1000)}s `
            : '';
        return `⚠️  ${label}: claude judge timed out ${secs}(machine contention?) — judgement skipped`;
    }
    const err = judgeErr(e);
    const reason = err.code ?? (err.status != null ? `exit ${err.status}` : (err.message ?? 'unknown'));
    return `⚠️  ${label}: claude judge unavailable (${reason}; offline/quota/absent) — judgement skipped`;
}
function warnUnavailable(label, e, timeout) {
    console.error(unavailableMessage(label, e, timeout));
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
/**
 * The remedy line a fail-closed (strict/ship) gate prints when a judge produced no verdict. ONE
 * wording seam for every gate (sc-1227) — completeness, the review cascade and decision-alignment
 * each hand-rolled their own copy, and the copies drifted.
 *
 * The CAUSE decides the remedy, and getting that wrong costs real operator time:
 * - `timeout` — the gate's OWN contention kill at the cap. Sending the operator to auth/quota here
 *   is a dead end on a demonstrably healthy CLI (sc-1227, the same misdiagnosis sc-1049 fixed for
 *   the warning line). The levers that actually work are re-running, getting out from under the
 *   600s agent-tool cap, and shrinking the commit.
 * - `sync` — a missing brief/checklist artifact: an un-synced consumer, not an outage.
 * - `outage` — a genuine dark judge (ENOENT / 401 / non-zero exit): auth/quota is the right place.
 *
 * Each caller appends its own cached-verdict clause — what a retry re-uses differs per gate.
 */
export function strictRemedy(cause) {
    if (cause === 'timeout')
        return ('the judge hit its time cap — this is NOT an auth/quota problem. Re-run `devkit ship`; run ' +
            'it in a real terminal or a detached ship so the 600s agent tool cap cannot kill it early; ' +
            'or stage a smaller commit, which judges faster');
    if (cause === 'sync')
        return ('run `devkit sync-agents && devkit sync-skills` so the briefs + checklist scripts are ' +
            'present, then re-run devkit ship');
    return 'check `claude` CLI auth/quota, then re-run devkit ship';
}
// execFile's `timeout` fires by KILLING the child (SIGKILL, sc-1317 — SIGTERM alone let a child that
// traps/ignores it survive past the cap), which marks the error `killed`. That kill — not ENOENT /
// quota / a non-zero exit — is the one outage a retry can't fix: the re-run would burn the same
// budget again. Callers that retry use this to skip a timeout. `killed` is set regardless of which
// signal did it, so it's checked first; `err.signal === 'SIGTERM'` is a defensive fallback from
// before the SIGKILL switch, kept in case a platform ever reports the pre-kill signal instead of
// `killed`. (ETIMEDOUT covers the rare platform that reports a code instead of either.)
function isJudgeTimeout(e) {
    const err = judgeErr(e);
    return err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT';
}
/** The `--model <m>` value from a judge argv, for the telemetry event; null when absent. */
function modelFromArgs(args) {
    const i = args.indexOf('--model');
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
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
export function recordAgentRun(opts) {
    // Same predicate execJudge applies to a judge's stdout, so both entry points name a no-output run
    // identically rather than one of them calling it a success.
    const outcome = opts.outcome ?? (opts.output?.trim() ? 'ok' : 'empty');
    // Exclusive-create store: the durable event line's transcript_ref must keep resolving to THIS
    // invocation's output — never silently rewritten by a later sample OR a later process (a
    // retried/amended commit shares the same run id). Uniqueness is the filesystem's, not ours.
    const ref = outcome === 'ok' && opts.transcript !== false && opts.output
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
function emitJudgeExec(opts, outcome, startedAt, output) {
    recordAgentRun({
        label: opts.label,
        output,
        input: opts.input,
        model: modelFromArgs(opts.args),
        outcome,
        durationMs: Date.now() - startedAt,
        transcript: opts.transcript,
    });
}
export function execJudge(opts) {
    const { label, args, input, timeout, cwd, env, onOutage } = opts;
    const startedAt = Date.now();
    try {
        const out = execFileSync('claude', args, {
            cwd,
            // Never the caller's env verbatim: git leaks an ABSOLUTE GIT_INDEX_FILE/GIT_DIR into every
            // hook run in a linked worktree (how ship commits), and a tool-using judge that touches
            // another repo would write ITS index over the ship's staged diff. See withoutGitEnv.
            env: withoutGitEnv(env),
            input,
            encoding: 'utf8',
            timeout,
            // SIGTERM alone can be trapped/ignored by the child, leaving the cap best-effort instead of a
            // guarantee (sc-1317) — SIGKILL cannot be caught, so the timeout always actually terminates.
            killSignal: 'SIGKILL',
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        if (!out || !String(out).trim()) {
            warnNoOutput(label);
            emitJudgeExec(opts, 'empty', startedAt);
            onOutage?.('empty');
            return null;
        }
        emitJudgeExec(opts, 'ok', startedAt, out);
        return out;
    }
    catch (e) {
        warnUnavailable(label, e, timeout);
        const kind = isJudgeTimeout(e) ? 'timeout' : 'transient';
        emitJudgeExec(opts, kind, startedAt);
        onOutage?.(kind);
        return null;
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
 * @param {{ label: string, args: string[], input?: string, timeout: number, cwd?: string, onOutage?: (kind: 'timeout'|'transient'|'empty') => void }} opts
 * @returns {Promise<string|null>}
 */
export function execJudgeAsync(opts) {
    const { label, args, input, timeout, cwd, env, onOutage } = opts;
    const startedAt = Date.now();
    return new Promise((resolve) => {
        // Shared outage path — a callback error AND a synchronous throw from execFile() itself (e.g. an
        // out-of-range `timeout` validates and throws before spawn even starts, sc-1317) both resolve
        // null the same way. Without the try/catch below, that synchronous throw escaped as a REJECTED
        // promise, breaking this function's own documented contract (never throws/rejects, always
        // resolves) for any caller awaiting it outside its own try/catch — the sync execJudge twin
        // already had this same guard via its enclosing try/catch.
        const fail = (err) => {
            warnUnavailable(label, err, timeout);
            const kind = isJudgeTimeout(err) ? 'timeout' : 'transient';
            emitJudgeExec(opts, kind, startedAt);
            onOutage?.(kind);
            resolve(null);
        };
        try {
            const child = execFile('claude', args, {
                cwd,
                // env: see the execJudge twin — the git-env scrub applies to every judge spawn.
                env: withoutGitEnv(env),
                encoding: 'utf8',
                timeout,
                // See the execJudge twin: SIGKILL so the cap is a guaranteed kill, not a trappable request.
                killSignal: 'SIGKILL',
                maxBuffer: 10 * 1024 * 1024,
            }, (err, stdout) => {
                if (err) {
                    fail(err);
                    return;
                }
                if (!stdout || !String(stdout).trim()) {
                    warnNoOutput(label);
                    emitJudgeExec(opts, 'empty', startedAt);
                    onOutage?.('empty');
                    resolve(null);
                    return;
                }
                emitJudgeExec(opts, 'ok', startedAt, stdout);
                resolve(stdout);
            });
            // EPIPE guard: claude may exit (ENOENT wrapper, early crash) before stdin is consumed.
            child.stdin?.on('error', () => { });
            if (input !== undefined)
                child.stdin?.write(input);
            child.stdin?.end();
        }
        catch (e) {
            fail(e);
        }
    });
}
