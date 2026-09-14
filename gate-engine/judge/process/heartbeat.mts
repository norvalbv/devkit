// sc-2422: while a supervised judge runs, one stderr line per interval names each lane, its elapsed
// time and kill bound. Narration only — never a verdict, never prompt/diff/model content.

/** Default gap between heartbeat lines; inside the 30–60s window the story asks for. */
export const DEFAULT_JUDGE_HEARTBEAT_MS = 45_000;
// Node clamps a delay above this to 1ms, which would turn a heartbeat into a stderr flood.
const MAX_TIMER_MS = 2_147_483_647;
// Absolute epoch (ms) at which the supervisor kills the gate chain. Written by
// cli/lib/ship/review/process/gate-supervisor.mts; keep the two spellings in sync.
const GATE_DEADLINE_ENV = 'DEVKIT_GATE_DEADLINE_MS';
// The gate log run-gates-with-capture.sh tees this chain into — the file a poller should open.
const GATE_LOG_ENV = 'DEVKIT_GATE_LOG';
const INTERVAL_ENV = 'DEVKIT_JUDGE_HEARTBEAT_MS';

/** One in-flight judge as the renderer sees it. */
interface ActiveJudge {
  label: string;
  startedAt: number;
  killAt: number;
}

/** The repeating timer this module owns: Node's own handle, or a test double shaped like one. */
export interface HeartbeatTimer {
  /** Present on a real Node timer; a heartbeat must never hold the gate process open. */
  unref?: () => void;
}

/** Injected seams: env, clock, sink and timer, so ticks are deterministic under test. */
export interface HeartbeatDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  write: (line: string) => void;
  setInterval: (fn: () => void, ms: number) => HeartbeatTimer;
  clearInterval: (handle: HeartbeatTimer) => void;
}

/** `45s` under a minute, `3m05s` above; negative or non-finite spans clamp to `0s`. */
export function formatSpan(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

/** The single heartbeat line (newline-terminated, so one write can't interleave mid-line). */
export function renderJudgeHeartbeat(
  active: readonly ActiveJudge[],
  now: number,
  logPath?: string,
): string {
  const lanes = active
    .map(
      (j) =>
        `${j.label} ${formatSpan(now - j.startedAt)} (killed in ≤${formatSpan(j.killAt - now)})`,
    )
    .join(', ');
  return `guard-review: still running — ${lanes}${logPath ? ` · log: ${logPath}` : ''}\n`;
}

function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function intervalMs(env: NodeJS.ProcessEnv): number {
  const n = positiveNumber(env[INTERVAL_ENV]);
  return n !== null && n <= MAX_TIMER_MS ? n : DEFAULT_JUDGE_HEARTBEAT_MS;
}

/** A process-wide heartbeat: `track` registers a judge and returns its idempotent `stop`. */
export function createJudgeHeartbeat(deps: HeartbeatDeps) {
  const active = new Map<symbol, ActiveJudge>();
  let timer: HeartbeatTimer | null = null;

  const tick = () => {
    if (active.size === 0) return;
    try {
      deps.write(renderJudgeHeartbeat([...active.values()], deps.now(), deps.env[GATE_LOG_ENV]));
    } catch {
      /* narration is best-effort — a closed stderr must never reach the judge's promise */
    }
  };

  const track = ({ label, timeoutMs }: { label: string; timeoutMs: number }): (() => void) => {
    const deadline = positiveNumber(deps.env[GATE_DEADLINE_ENV]);
    if (deadline === null) return () => {};
    const startedAt = deps.now();
    const token = Symbol(label);
    active.set(token, { label, startedAt, killAt: Math.min(startedAt + timeoutMs, deadline) });
    if (timer === null) {
      timer = deps.setInterval(tick, intervalMs(deps.env));
      timer.unref?.();
    }
    return () => {
      if (!active.delete(token) || active.size > 0 || timer === null) return;
      deps.clearInterval(timer);
      timer = null;
    };
  };

  return { track };
}

const processHeartbeat = createJudgeHeartbeat({
  env: process.env,
  now: Date.now,
  write: (line) => process.stderr.write(line),
  setInterval: (fn, ms) => setInterval(fn, ms),
  // SAFETY: this sink's own setInterval above produced the handle, so it is always a Node timer.
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
});

/** Register an in-flight judge with this process's heartbeat; call the result when it settles. */
export const trackJudge = processHeartbeat.track;
