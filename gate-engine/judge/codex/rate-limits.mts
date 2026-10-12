/** Read the codex account's rate-limit state and model list without spending a token: both RPCs
 *  answer in ~1s while `codex exec` refuses. Advisory-only; every failure mode returns null. */
import { spawn } from 'node:child_process';
import { plausibleReset } from '../outage/classify.mts';

/** Matches judgeBinForModel's resolution so the preflight probes the binary the judges will use. */
const codexBin = (): string => process.env.GUARD_CODEX_BIN || 'codex';

/** Generous next to the ~1.1s measured round trip: this never blocks, so a slow probe costs only
 *  its own wait, while too short a cap reports "unknown" on a healthy machine. */
const PROBE_TIMEOUT_MS = 15_000;
/** The RPC answers in one small object; anything beyond this is not the reply we asked for. */
const MAX_OUTPUT = 512 * 1024;

const INITIALIZE_ID = 1;
const READ_ID = 2;
const MODEL_LIST_ID = 3;

export interface CodexRateLimits {
  /** Percentage of the primary window consumed, when the payload carried one. */
  usedPercent?: number;
  /** Epoch MILLISECONDS. The wire format is epoch seconds; converted here so every devkit
   *  consumer works in one unit (JudgeOutage.resetsAt is ms). */
  resetsAt?: number;
  /** The window this percentage is measured over — 10080 minutes is the observed weekly plan. */
  windowDurationMins?: number;
  planType?: string;
  /** Provider reported a limit reached, or a window is fully spent with no usable credits (sc-3207:
   *  `rateLimitReachedType` is nullable upstream and was absent on a locked account). */
  reached: boolean;
  /** The plan limit is hit, but usable credits serve calls — codex's TUI treats this as served. */
  onCredits: boolean;
  /** The provider's own enum value, e.g. `rate_limit_reached`. Reported, never interpreted. */
  reachedType?: string;
  /** Which window is fully spent, when one is. Reported, never interpreted. */
  exhaustedWindow?: 'primary' | 'secondary';
  /** Every model id `model/list` returned, hidden ones included. Absent when it proved nothing. */
  models?: string[];
  /** The non-hidden subset: the ones worth suggesting as a move target. */
  visibleModels?: string[];
}

/** The wire shape — every field optional (codexEventsOf's contract in result.mts). Values are
 *  re-checked below, so a field carrying the wrong type is dropped rather than reported. */
interface RateLimitsWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}
interface RateLimitsPayload {
  primary?: RateLimitsWindow | null;
  secondary?: RateLimitsWindow | null;
  planType?: string;
  rateLimitReachedType?: string;
  credits?: { hasCredits?: boolean; unlimited?: boolean } | null;
  spendControlReached?: boolean;
}
interface RateLimitsReply {
  result?: { rateLimits?: RateLimitsPayload | null };
  id?: number;
}

/** A field is reported only when it is a usable number — this also rejects a wrong-typed value,
 *  because `Number.isFinite` is false for strings, null and undefined alike. */
const usableNumber = (v: number | undefined): number | undefined =>
  Number.isFinite(v) ? v : undefined;
/** Same for text: an absent or blank value is not a signal. */
const usableText = (v: string | undefined): string | undefined =>
  v && `${v}`.trim() ? v : undefined;

/** One window's usable fields, or null with no window object. resetsAt is seconds on the wire; an
 *  implausible value (a unit change) is dropped, keeping the lock but not the time. */
function readWindow(
  w: RateLimitsWindow | null | undefined,
): Pick<CodexRateLimits, 'usedPercent' | 'windowDurationMins' | 'resetsAt'> | null {
  // A non-object window (a stray string) reads every field as absent, which is already the answer.
  if (!w) return null;
  const out: Pick<CodexRateLimits, 'usedPercent' | 'windowDurationMins' | 'resetsAt'> = {};
  const used = usableNumber(w.usedPercent);
  if (used !== undefined) out.usedPercent = used;
  const window = usableNumber(w.windowDurationMins);
  if (window !== undefined) out.windowDurationMins = window;
  const seconds = usableNumber(w.resetsAt);
  if (seconds !== undefined && seconds > 0 && plausibleReset(seconds * 1000))
    out.resetsAt = seconds * 1000;
  return out;
}

/** Parse one reply line, or null when it is not the reply we asked for. Exported for tests: this
 *  protocol is the likeliest thing to drift, and a captured payload beats spawning a daemon. */
export function parseRateLimitsReply(line: string): CodexRateLimits | null {
  let parsed: RateLimitsReply;
  try {
    // SAFETY: every RateLimitsReply field is optional and re-checked below, so a line that is JSON
    // but not this reply reads as absent fields rather than a false report.
    parsed = JSON.parse(line) as RateLimitsReply;
  } catch {
    return null;
  }
  if (parsed.id !== READ_ID) return null;
  const limits = parsed.result?.rateLimits;
  if (!limits) return null;

  const reachedType = usableText(limits.rateLimitReachedType);
  const primary = readWindow(limits.primary);
  const secondary = readWindow(limits.secondary);
  // codex's TUI (rate_limits.rs): usable credits serve past a spent plan unless spend control is
  // reached. Only a strict `true` counts — a garbled credits field is not evidence of headroom.
  const credits = limits.credits;
  const creditsUsable =
    (credits?.unlimited === true || credits?.hasCredits === true) &&
    limits.spendControlReached !== true;
  // The lock lasts until the LAST exhausted window clears; an unknown reset ranks latest, so no
  // other window's time is offered as the clearing time.
  let exhaustedWindow: 'primary' | 'secondary' | undefined;
  let latestReset = Number.NEGATIVE_INFINITY;
  for (const [name, w] of [
    ['primary', primary],
    ['secondary', secondary],
  ] as const) {
    if (w?.usedPercent === undefined || w.usedPercent < 100) continue;
    const reset = w.resetsAt ?? Number.POSITIVE_INFINITY;
    if (exhaustedWindow === undefined || reset > latestReset) {
      exhaustedWindow = name;
      latestReset = reset;
    }
  }

  // Absent `rateLimitReachedType` alone is NOT "not reached" — the backend maps an unknown kind to
  // None — so a spent window is the second positive signal.
  const planLimited = reachedType !== undefined || exhaustedWindow !== undefined;
  // An allowlist: workspace_* kinds void credits upstream, and an unknown kind stays a lock.
  const covered =
    creditsUsable && (reachedType === undefined || reachedType === 'rate_limit_reached');
  const snapshot: CodexRateLimits = {
    reached: planLimited && !covered,
    onCredits: planLimited && covered,
  };
  if (reachedType !== undefined) snapshot.reachedType = reachedType;
  const planType = usableText(limits.planType);
  if (planType !== undefined) snapshot.planType = planType;
  if (exhaustedWindow !== undefined) snapshot.exhaustedWindow = exhaustedWindow;

  // The reported window is the spent one; with none spent, primary as before.
  const shown = exhaustedWindow === 'secondary' ? secondary : primary;
  if (shown) Object.assign(snapshot, shown);
  return snapshot;
}

interface ModelListReply {
  id?: number;
  result?: {
    data?: Array<{ id?: string; model?: string; hidden?: boolean }> | null;
    nextCursor?: string | null;
  };
}

/** The `model/list` reply as `{ models }`, or null when the line is not that reply. `models` is
 *  absent for an error (an older codex) or a partial page: neither proves a model is missing. */
export function parseModelListReply(
  line: string,
): Pick<CodexRateLimits, 'models' | 'visibleModels'> | null {
  let parsed: ModelListReply;
  try {
    // SAFETY: every field is optional and re-checked below, as in parseRateLimitsReply.
    parsed = JSON.parse(line) as ModelListReply;
  } catch {
    return null;
  }
  if (parsed.id !== MODEL_LIST_ID) return null;
  const data = parsed.result?.data;
  if (!Array.isArray(data) || parsed.result?.nextCursor) return {};
  const ids = (list: typeof data): string[] => [
    ...new Set(
      list
        .flatMap((m) => [usableText(m?.id), usableText(m?.model)])
        .filter((id) => id !== undefined),
    ),
  ];
  return { models: ids(data), visibleModels: ids(data.filter((m) => m?.hidden !== true)) };
}

/** Ask the local codex install for its rate-limit state. Resolves null for every unhappy path;
 *  never throws, never blocks, never spends. */
export function readCodexRateLimits(
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<CodexRateLimits | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        codexBin(),
        [
          'app-server',
          '--stdio',
          // This server starts no conversation, so it should launch no MCP server — but
          // judge-mcp-profiles wants that true by construction, not by reading upstream correctly.
          '-c',
          'mcp_servers={}',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    let buffered = '';
    let snapshot: CodexRateLimits | null = null;
    let modelList: ReturnType<typeof parseModelListReply> = null;
    // A slow or unknown model/list must not erase a rate-limit answer that already arrived.
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // SIGKILL, not SIGTERM: a trapping child would otherwise outlive the ship (sc-1317).
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
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

    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      if (buffered.length > MAX_OUTPUT) {
        finish();
        return;
      }
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        snapshot = parseRateLimitsReply(line) ?? snapshot;
        modelList = parseModelListReply(line) ?? modelList;
        if (snapshot && modelList) finish();
      }
    });

    // The three JSON-RPC requests this module ever sends; a named shape keeps the writer typed.
    const send = (payload: {
      jsonrpc: string;
      id: number;
      method: string;
      params: object;
    }): void => {
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch {
        finish();
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
    send({
      jsonrpc: '2.0',
      id: MODEL_LIST_ID,
      method: 'model/list',
      params: { includeHidden: true, limit: 200 },
    });
  });
}
