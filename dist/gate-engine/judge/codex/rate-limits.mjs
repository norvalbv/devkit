/** Read the codex account's rate-limit state and model list without spending a token: both RPCs
 *  answer in ~1s while `codex exec` refuses. Advisory-only; every failure mode returns null. */
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
const MODEL_LIST_ID = 3;
/** Plans whose credits are not trusted to serve `codex exec` past a spent plan limit. */
const UNCREDITED_PLANS = new Set(['free', 'go']);
/** A field is reported only when it is a usable number — this also rejects a wrong-typed value,
 *  because `Number.isFinite` is false for strings, null and undefined alike. */
const usableNumber = (v) => Number.isFinite(v) ? v : undefined;
/** Same for text: an absent or blank value is not a signal. */
const usableText = (v) => v && `${v}`.trim() ? v : undefined;
/** One window's usable fields, or null with no window object. resetsAt is seconds on the wire; an
 *  implausible value (a unit change) is dropped, keeping the lock but not the time. */
function readWindow(w) {
    // A non-object window (a stray string) reads every field as absent, which is already the answer.
    if (!w)
        return null;
    const out = {};
    const used = usableNumber(w.usedPercent);
    if (used !== undefined)
        out.usedPercent = used;
    const window = usableNumber(w.windowDurationMins);
    if (window !== undefined)
        out.windowDurationMins = window;
    const seconds = usableNumber(w.resetsAt);
    if (seconds !== undefined && seconds > 0 && plausibleReset(seconds * 1000))
        out.resetsAt = seconds * 1000;
    return out;
}
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
    const reachedType = usableText(limits.rateLimitReachedType);
    const primary = readWindow(limits.primary);
    const secondary = readWindow(limits.secondary);
    // codex's TUI (rate_limits.rs): usable credits serve past a spent plan unless spend control is
    // reached. Only a strict `true` counts — a garbled credits field is not evidence of headroom.
    const credits = limits.credits;
    const creditsUsable = (credits?.unlimited === true || credits?.hasCredits === true) &&
        limits.spendControlReached !== true;
    // The lock lasts until the LAST exhausted window clears; an unknown reset ranks latest, so no
    // other window's time is offered as the clearing time.
    let exhaustedWindow;
    let latestReset = Number.NEGATIVE_INFINITY;
    for (const [name, w] of [
        ['primary', primary],
        ['secondary', secondary],
    ]) {
        if (w?.usedPercent === undefined || w.usedPercent < 100)
            continue;
        const reset = w.resetsAt ?? Number.POSITIVE_INFINITY;
        if (exhaustedWindow === undefined || reset > latestReset) {
            exhaustedWindow = name;
            latestReset = reset;
        }
    }
    // Absent `rateLimitReachedType` alone is NOT "not reached" — the backend maps an unknown kind to
    // None — so a spent window is the second positive signal.
    const planLimited = reachedType !== undefined || exhaustedWindow !== undefined;
    const planType = usableText(limits.planType);
    // An allowlist: workspace_* kinds void credits upstream, and an unknown kind stays a lock.
    // Free/Go credits did not serve codex exec on a live account; paid plans' did (a heuristic).
    const covered = creditsUsable &&
        (reachedType === undefined || reachedType === 'rate_limit_reached') &&
        !(planType !== undefined && UNCREDITED_PLANS.has(planType));
    const snapshot = {
        reached: planLimited && !covered,
        onCredits: planLimited && covered,
    };
    if (reachedType !== undefined)
        snapshot.reachedType = reachedType;
    if (planType !== undefined)
        snapshot.planType = planType;
    if (exhaustedWindow !== undefined)
        snapshot.exhaustedWindow = exhaustedWindow;
    // Raw facts for the telemetry row. With a credits field, false means it named none spendable.
    if (credits)
        snapshot.creditsUsable = creditsUsable;
    const ordinary = parsed.result?.ordinaryUsageAllowed;
    if (ordinary === true || ordinary === false)
        snapshot.ordinaryUsageAllowed = ordinary;
    // The reported window is the spent one; with none spent, primary as before.
    const shown = exhaustedWindow === 'secondary' ? secondary : primary;
    if (shown)
        Object.assign(snapshot, shown);
    return snapshot;
}
/** The codex CLI version from the `initialize` reply's `userAgent` ("<client>/<version> (…)"), or
 *  undefined when the line is not that reply or names no version. */
export function parseInitializeReply(line) {
    try {
        // SAFETY: every field is optional and re-checked below, as in parseRateLimitsReply.
        const parsed = JSON.parse(line);
        if (parsed?.id !== INITIALIZE_ID)
            return undefined;
        return /^[^/\s]+\/(\d[^\s]*)/.exec(usableText(parsed.result?.userAgent) ?? '')?.[1];
    }
    catch {
        return undefined;
    }
}
/** The `model/list` reply as `{ models }`, or null when the line is not that reply. `models` is
 *  absent for an error (an older codex) or a partial page: neither proves a model is missing. */
export function parseModelListReply(line) {
    let parsed;
    try {
        // SAFETY: every field is optional and re-checked below, as in parseRateLimitsReply.
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (parsed.id !== MODEL_LIST_ID)
        return null;
    const data = parsed.result?.data;
    if (!Array.isArray(data) || parsed.result?.nextCursor)
        return {};
    const ids = (list) => [
        ...new Set(list
            .flatMap((m) => [usableText(m?.id), usableText(m?.model)])
            .filter((id) => id !== undefined)),
    ];
    return { models: ids(data), visibleModels: ids(data.filter((m) => m?.hidden !== true)) };
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
        let snapshot = null;
        let modelList = null;
        let cliVersion;
        // A slow or unknown model/list must not erase a rate-limit answer that already arrived.
        const finish = () => {
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
            if (snapshot && cliVersion !== undefined)
                snapshot = { ...snapshot, cliVersion };
            resolve(snapshot && modelList?.models ? { ...snapshot, ...modelList } : snapshot);
        };
        const timer = setTimeout(finish, timeoutMs);
        // A daemon that never answers must not keep the ship's event loop alive past its own timeout.
        timer.unref?.();
        child.on('error', finish);
        // A child that exits before reading gets EPIPE as an async stream 'error', which the write's try
        // cannot catch; unhandled, it is an uncaught exception that fails the whole run.
        child.stdin?.on('error', finish);
        // Exiting early is itself an answer: whatever arrived before it is all we learned.
        child.on('close', finish);
        child.stderr?.on('data', () => {
            /* diagnostics only; the reply is on stdout */
        });
        child.stdout?.on('data', (chunk) => {
            buffered += chunk.toString();
            if (buffered.length > MAX_OUTPUT) {
                finish();
                return;
            }
            const lines = buffered.split('\n');
            buffered = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
                cliVersion = parseInitializeReply(line) ?? cliVersion;
                snapshot = parseRateLimitsReply(line) ?? snapshot;
                modelList = parseModelListReply(line) ?? modelList;
                if (snapshot && modelList)
                    finish();
            }
        });
        // The three JSON-RPC requests this module ever sends; a named shape keeps the writer typed.
        const send = (payload) => {
            try {
                child.stdin?.write(`${JSON.stringify(payload)}\n`);
            }
            catch {
                finish();
            }
        };
        // `initialize` is mandatory before any other method; its reply names the CLI version.
        send({
            jsonrpc: '2.0',
            id: INITIALIZE_ID,
            method: 'initialize',
            params: { clientInfo: { name: 'devkit', title: 'devkit ship preflight', version: '1' } },
        });
        send({ jsonrpc: '2.0', id: READ_ID, method: 'account/rateLimits/read', params: {} });
        send({
            jsonrpc: '2.0',
            id: MODEL_LIST_ID,
            method: 'model/list',
            params: { includeHidden: true, limit: 200 },
        });
    });
}
