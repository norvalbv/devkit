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
// execFile's `timeout` fires by KILLING the child (SIGTERM), which marks the error `killed`. That
// kill — not ENOENT / quota / a non-zero exit — is the one outage a retry can't fix: the re-run would
// burn the same budget again. Callers that retry use this to skip a timeout. (ETIMEDOUT covers the
// rare platform that reports a code instead of the signal.)
function isJudgeTimeout(e) {
    const err = judgeErr(e);
    return err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT';
}
export function execJudge({ label, args, input, timeout, cwd, onOutage, }) {
    try {
        const out = execFileSync('claude', args, {
            cwd,
            input,
            encoding: 'utf8',
            timeout,
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        if (!out || !String(out).trim()) {
            warnNoOutput(label);
            onOutage?.('empty');
            return null;
        }
        return out;
    }
    catch (e) {
        warnUnavailable(label, e, timeout);
        onOutage?.(isJudgeTimeout(e) ? 'timeout' : 'transient');
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
 * @param {{ label: string, args: string[], input?: string, timeout?: number, cwd?: string, onOutage?: (kind: 'timeout'|'transient'|'empty') => void }} opts
 * @returns {Promise<string|null>}
 */
export function execJudgeAsync({ label, args, input, timeout, cwd, onOutage, }) {
    return new Promise((resolve) => {
        const child = execFile('claude', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                warnUnavailable(label, err, timeout);
                onOutage?.(isJudgeTimeout(err) ? 'timeout' : 'transient');
                resolve(null);
                return;
            }
            if (!stdout || !String(stdout).trim()) {
                warnNoOutput(label);
                onOutage?.('empty');
                resolve(null);
                return;
            }
            resolve(stdout);
        });
        // EPIPE guard: claude may exit (ENOENT wrapper, early crash) before stdin is consumed.
        child.stdin?.on('error', () => { });
        if (input !== undefined)
            child.stdin?.write(input);
        child.stdin?.end();
    });
}
