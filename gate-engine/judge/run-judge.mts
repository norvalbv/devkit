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
import { trackJudge } from './process/heartbeat.mts';
import {
  cleanupJudgeRun,
  type ExecJudgeOpts,
  prepareJudgeRun,
  routeJudge,
  settleJudgeError,
  settleJudgeOutput,
} from './process/judge-exec.mts';
import type { JudgeError } from './outage/classify.mts';

// Re-exported so the gates that already import their remedy wording from here keep ONE import path,
// while the wording itself lives beside the classifier that decides it.
export {
  type RemedyCause,
  remedyCause,
  strictRemedy,
  unavailableMessage,
} from './outage/wording.mts';
export {
  type AgentRunRecord,
  type RecordAgentRunOpts,
  recordAgentRun,
} from './process/judge-exec.mts';

// Narrow an unknown thrown value to the JudgeError shape; a non-object (or null) reads as {} so every
// field access is undefined — matching the original `e?.field` optional-chaining behaviour exactly.
function judgeErr(e: unknown): JudgeError {
  return e && typeof e === 'object' ? (e as JudgeError) : {};
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
export function execJudge(opts: ExecJudgeOpts): string | null {
  const run = prepareJudgeRun(opts);
  try {
    const { cli, spawnOptions } = routeJudge(opts, run);
    // stderr is piped, not discarded: it is the channel a claude quota message arrives on.
    const out = execFileSync(cli.bin, cli.argv, {
      ...spawnOptions,
      input: opts.input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return settleJudgeOutput(opts, run, cli, out);
  } catch (e) {
    return settleJudgeError(opts, run, judgeErr(e));
  } finally {
    cleanupJudgeRun(run);
  }
}

/**
 * Async twin of execJudge — same contract (raw stdout, or `null` after ONE stderr warning), but
 * non-blocking so a caller can run SEVERAL judges concurrently (the review gate fans out one judge
 * per domain reviewer; serialising them would multiply the commit's wall-clock by the reviewer
 * count). Callback-form execFile because the promisified variant cannot take stdin: the prompt's
 * evidence (diffstat) goes to the child's stdin by hand. maxBuffer is explicit — an investigating
 * judge's transcript (tool output included) can exceed the 1 MB default.
 */
export function execJudgeAsync(opts: ExecJudgeOpts): Promise<string | null> {
  const run = prepareJudgeRun(opts);
  return new Promise((resolve) => {
    // Liveness narration; stopped first on every settle path so no line follows the verdict.
    const stopHeartbeat = trackJudge({ label: opts.label, timeoutMs: opts.timeout });
    // Shared outage path: a callback error AND a synchronous throw from execFile() itself both
    // resolve null, so this function never rejects.
    const fail = (err: JudgeError, stdout?: string) => {
      stopHeartbeat();
      cleanupJudgeRun(run);
      // The callback's own stdout wins; the throw-attached copy covers the synchronous-throw path.
      resolve(settleJudgeError(opts, run, { ...err, stdout: stdout ?? err.stdout }));
    };
    try {
      const { cli, spawnOptions } = routeJudge(opts, run);
      const child = execFile(cli.bin, cli.argv, spawnOptions, (err, stdout, stderr) => {
        stopHeartbeat();
        if (err) {
          fail(
            { ...judgeErr(err), stderr: stderr ? String(stderr) : undefined },
            stdout ? String(stdout) : undefined,
          );
          return;
        }
        cleanupJudgeRun(run);
        resolve(settleJudgeOutput(opts, run, cli, stdout));
      });
      // EPIPE guard: claude may exit (ENOENT wrapper, early crash) before stdin is consumed.
      child.stdin?.on('error', () => {});
      if (opts.input !== undefined) child.stdin?.write(opts.input);
      child.stdin?.end();
    } catch (e) {
      fail(judgeErr(e));
    }
  });
}
