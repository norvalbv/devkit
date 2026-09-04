/** Read the codex account's rate-limit state without spending a token: `account/rateLimits/read`
 *  answers in ~1s while `codex exec` refuses. Advisory-only; every failure mode returns null. */
import { spawn } from 'node:child_process';
import { plausibleReset } from '../outage/classify.mjs';
/** Matches judgeBinForModel's resolution so the preflight probes the binary the judges will use. */
const codexBin = () => process.env.GUARD_CODEX_BIN || 'codex';
/** Generous next to the ~1.1s measured round trip: this never blocks, so a slow probe costs only
 *  its own wait, while too short a cap reports "unknown" on a healthy machine. */
const PROBE_TIMEOUT_MS = 15_000;
/** The RPC answers in one small object; anything beyond this is not the reply we asked for. */
const MAX_OUTPUT = 512 * 1024;
const INITIALIZE_ID = 1;
const READ_ID = 2;
/** A field is reported only when it is a usable number — this also rejects a wrong-typed value,
 *  because `Number.isFinite` is false for strings, null and undefined alike. */
const usableNumber = (v) => Number.isFinite(v) ? v : undefined;
/** Same for text: an absent or blank value is not a signal. */
const usableText = (v) => v && `${v}`.trim() ? v : undefined;
/** Parse one reply line, or null when it is not the reply we asked for. Exported for tests: this
 *  protocol is the likeliest thing to drift, and a captured payload beats spawning a daemon. */
export function parseRateLimitsReply(line) {
    let parsed;
    try {
        // SAFETY: every RateLimitsReply field is optional and re-checked below, so a line that is JSON
        // but not this reply reads as absent fields rather than a false report.
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (parsed.id !== READ_ID)
        return null;
    const limits = parsed.result?.rateLimits;
    if (!limits)
        return null;
    const snapshot = {
        // Absent `rateLimitReachedType` means "not reached" — the field the ROLLOUT LOGS never populate,
        // and the reason this RPC exists rather than a file read.
        reached: usableText(limits.rateLimitReachedType) !== undefined,
    };
    const reachedType = usableText(limits.rateLimitReachedType);
    if (reachedType !== undefined)
        snapshot.reachedType = reachedType;
    const planType = usableText(limits.planType);
    if (planType !== undefined)
        snapshot.planType = planType;
    const primary = limits.primary;
    if (primary) {
        const used = usableNumber(primary.usedPercent);
        if (used !== undefined)
            snapshot.usedPercent = used;
        const window = usableNumber(primary.windowDurationMins);
        if (window !== undefined)
            snapshot.windowDurationMins = window;
        const seconds = usableNumber(primary.resetsAt);
        // Seconds on the wire; the shared window catches a unit change that would otherwise render as
        // "resets in 104249970674d". Out of range keeps the lock and drops only the time.
        if (seconds !== undefined && seconds > 0 && plausibleReset(seconds * 1000))
            snapshot.resetsAt = seconds * 1000;
    }
    return snapshot;
}
/** Ask the local codex install for its rate-limit state. Resolves null for every unhappy path;
 *  never throws, never blocks, never spends. */
export function readCodexRateLimits(timeoutMs = PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(codexBin(), [
                'app-server',
                '--stdio',
                // This server starts no conversation, so it should launch no MCP server — but
                // judge-mcp-profiles wants that true by construction, not by reading upstream correctly.
                '-c',
                'mcp_servers={}',
            ], { stdio: ['pipe', 'pipe', 'pipe'] });
        }
        catch {
            resolve(null);
            return;
        }
        let settled = false;
        let buffered = '';
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            // SIGKILL, not SIGTERM: a trapping child would otherwise outlive the ship (sc-1317).
            try {
                child.kill('SIGKILL');
            }
            catch {
                /* already gone */
            }
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        // A daemon that never answers must not keep the ship's event loop alive past its own timeout.
        timer.unref?.();
        child.on('error', () => finish(null));
        // Exiting before the reply arrived is itself an answer: we learned nothing.
        child.on('close', () => finish(null));
        child.stderr?.on('data', () => {
            /* diagnostics only; the reply is on stdout */
        });
        child.stdout?.on('data', (chunk) => {
            buffered += chunk.toString();
            if (buffered.length > MAX_OUTPUT) {
                finish(null);
                return;
            }
            const lines = buffered.split('\n');
            buffered = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
                const snapshot = parseRateLimitsReply(line);
                if (snapshot)
                    finish(snapshot);
            }
        });
        // The two JSON-RPC requests this module ever sends; a named shape keeps the writer typed.
        const send = (payload) => {
            try {
                child.stdin?.write(`${JSON.stringify(payload)}\n`);
            }
            catch {
                finish(null);
            }
        };
        // `initialize` is mandatory before any other method; the server replies with its own identity,
        // which we ignore — the handshake is the point, not the answer.
        send({
            jsonrpc: '2.0',
            id: INITIALIZE_ID,
            method: 'initialize',
            params: { clientInfo: { name: 'devkit', title: 'devkit ship preflight', version: '1' } },
        });
        send({ jsonrpc: '2.0', id: READ_ID, method: 'account/rateLimits/read', params: {} });
    });
}
