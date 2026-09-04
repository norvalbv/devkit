#!/usr/bin/env node
/**
 * `wait.mjs --pr <n> --repo <owner/repo> --timeout <s> [--interval-ms <n>] [--required]` — stderr
 * only; stdout belongs to the PR URL. Why: docs/decisions/ship-ci-wait-is-observation-not-intent.md.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { UnknownReason } from '../../baseline-status/gh.mts';

/** The five states gh collapses `state` into. Ordered for stable rendering, not by severity. */
export const CHECK_BUCKETS = ['pass', 'fail', 'pending', 'skipping', 'cancel'] as const;
export type CheckBucket = (typeof CHECK_BUCKETS)[number];

/** The `--json` fields this reader dereferences, as one gh argument. */
export const CHECKS_JSON_FIELDS = 'bucket,name,state,link,workflow';

/** Every outcome line starts here, including the not-run one ship-branch.sh echoes on a skip. */
export const VERDICT_PREFIX = 'ship: ci-outcome=';

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_CONFIRMATIONS = 2;
const DEFAULT_SETTLE_GRACE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_TRANSIENT_BUDGET = 3;
/** Per-poll cap on gh itself: an exec with no bound defeats the deadline this feature exists for. */
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

const MAX_TIMEOUT_S = 7200;
/** Below this a `no-checks` verdict is unreachable, so a CI-less repo would report a bogus timeout. */
export const MIN_TIMEOUT_S = 60;

export interface CheckRow {
  bucket: CheckBucket;
  name: string;
  state: string;
  link: string;
  workflow: string;
}

/**
 * The first four members are baseline-status/gh.mts's vocabulary, narrowed by Extract so a rename
 * there breaks this compile. The last two only this caller can produce.
 */
export type WaitCiUnavailable =
  | Extract<UnknownReason, 'gh-missing' | 'gh-unauthenticated' | 'not-a-github-repo' | 'gh-failed'>
  | 'pr-not-found'
  | 'gh-json-unparseable';

/** Reasons no amount of waiting fixes — returned on first sighting instead of retried. */
const PERMANENT: ReadonlySet<WaitCiUnavailable> = new Set([
  'gh-missing',
  'gh-unauthenticated',
  'not-a-github-repo',
]);

/** One poll's answer. gh trouble is a VALUE here; the driver never catches. */
export type PollResult =
  | { kind: 'rows'; rows: CheckRow[] }
  | { kind: 'unavailable'; reason: WaitCiUnavailable; message: string };

export type TerminalOutcome = 'passed' | 'failed' | 'cancelled' | 'no-checks';
export type WaitOutcome = TerminalOutcome | 'timed-out' | 'unavailable';

export interface Summary {
  counts: CheckCounts;
  failures: CheckRow[];
  pending: CheckRow[];
  cancelled: CheckRow[];
  terminal: boolean;
  outcome: TerminalOutcome;
}

/** One tally per bucket. A named contract, so adding a bucket breaks every reader at compile time. */
export interface CheckCounts {
  pass: number;
  fail: number;
  pending: number;
  skipping: number;
  cancel: number;
}

const emptyCounts = (): CheckCounts => ({
  pass: 0,
  fail: 0,
  pending: 0,
  skipping: 0,
  cancel: 0,
});

/**
 * Collapse one poll into a verdict. `cancel` is its own outcome: calling it green reports a PR whose
 * checks never ran, calling it red makes every concurrency-superseded run a false alarm.
 */
export function summarise(rows: CheckRow[]): Summary {
  const counts = emptyCounts();
  for (const row of rows) counts[row.bucket]++;
  const outcome: TerminalOutcome =
    rows.length === 0
      ? 'no-checks'
      : counts.fail > 0
        ? 'failed'
        : counts.cancel > 0
          ? 'cancelled'
          : 'passed';
  return {
    counts,
    failures: rows.filter((r) => r.bucket === 'fail'),
    pending: rows.filter((r) => r.bucket === 'pending'),
    cancelled: rows.filter((r) => r.bucket === 'cancel'),
    terminal: counts.pending === 0,
    outcome,
  };
}

/** The progress line, and the change-detection key: two polls with equal tallies are one state. */
export function renderProgress(summary: Summary): string {
  const parts = CHECK_BUCKETS.filter((b) => summary.counts[b] > 0).map(
    (b) => `${summary.counts[b]} ${b}`,
  );
  return parts.length === 0 ? 'ci: no checks registered yet' : `ci: ${parts.join(' · ')}`;
}

const mins = (ms: number): string => `${Math.max(0, Math.round(ms / 60_000))}m`;

/** A stable tally would otherwise emit one line then silence, which reads as a hung wait. */
export function renderHeartbeat(line: string, elapsedMs: number, budgetMs: number): string {
  return `${line} (${mins(elapsedMs)} elapsed, ${mins(budgetMs - elapsedMs)} budget)`;
}

/**
 * The verdict is ONE line and callers grep it line-wise, so any whitespace a check name carries —
 * GitHub does not forbid a newline — collapses rather than splitting the line or forging a second.
 */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const named = (rows: CheckRow[]): string => rows.map((r) => oneLine(r.name)).join(',') || 'none';
const linked = (rows: CheckRow[]): string =>
  rows.map((r) => (r.link ? `${oneLine(r.name)}:${oneLine(r.link)}` : oneLine(r.name))).join(' ') ||
  'none';

/** The one machine-readable line. A caller branches on this, never on ship's exit code. */
export function verdictLine(result: WaitCiResult, pr: string): string {
  const head = `${VERDICT_PREFIX}${result.outcome} pr=${pr}`;
  switch (result.outcome) {
    case 'failed':
      return `${head} failing=${linked(result.failures)}`;
    case 'cancelled':
      return `${head} cancelled=${linked(result.cancelled)}`;
    case 'timed-out':
      return `${head} pending=${named(result.pending)} waited=${Math.round(result.elapsedMs / 1000)}s`;
    case 'unavailable':
      return `${head} reason=${result.unavailableReason ?? 'gh-failed'}`;
    default:
      return `${head} checks=${Object.values(result.counts).reduce((a, b) => a + b, 0)}`;
  }
}

/** The shape gh emits, every field optional so a malformed entry is REJECTED, not dereferenced. */
interface CheckRowCandidate {
  bucket?: unknown;
  name?: unknown;
  state?: unknown;
  link?: unknown;
  workflow?: unknown;
}

const BUCKET_NAMES: ReadonlySet<string> = new Set(CHECK_BUCKETS);
/** Blank for non-Actions checks (CodeRabbit reports both), so presence is proven, not content. */
const TEXT_FIELDS = ['name', 'state', 'link', 'workflow'] as const;

/** Every field this reader dereferences, compared by round-trip rather than a representation check. */
function isCheckRow(value: CheckRowCandidate | null): value is CheckRow {
  return (
    !!value &&
    `${value.bucket}` === value.bucket &&
    BUCKET_NAMES.has(String(value.bucket)) &&
    TEXT_FIELDS.every((f) => `${value[f]}` === value[f])
  );
}

/** Parse gh's `--json` array, rejecting any row that fails the guard above. */
export function parseChecksJson(raw: string): CheckRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: CheckRow[] = [];
  for (const entry of parsed) {
    if (!isCheckRow(entry)) return null;
    rows.push(entry);
  }
  return rows;
}

export interface WaitCiOptions {
  /** THE seam: one poll's answer. Injected so a 15-minute wait runs in microseconds under test. */
  poll: (attempt: number) => PollResult | Promise<PollResult>;
  timeoutMs: number;
  intervalMs?: number;
  confirmations?: number;
  settleGraceMs?: number;
  heartbeatMs?: number;
  transientBudget?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  emit?: (line: string) => void;
}

export interface WaitCiResult {
  outcome: WaitOutcome;
  polls: number;
  elapsedMs: number;
  counts: CheckCounts;
  failures: CheckRow[];
  pending: CheckRow[];
  cancelled: CheckRow[];
  unavailableReason?: WaitCiUnavailable;
  unavailableMessage?: string;
}

/**
 * Poll until the check set settles, the deadline passes, or gh proves unreachable. The deadline is
 * an absolute epoch computed once, the discipline gate-supervisor.mts uses.
 */
export async function waitForChecks(options: WaitCiOptions): Promise<WaitCiResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms));
  const emit = options.emit ?? ((line: string) => console.error(line));
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const confirmations = options.confirmations ?? DEFAULT_CONFIRMATIONS;
  const settleGraceMs = options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const transientBudget = options.transientBudget ?? DEFAULT_TRANSIENT_BUDGET;

  const started = now();
  const deadline = started + options.timeoutMs;
  let lastLine = '';
  let lastEmitAt = started;
  let streakOutcome: TerminalOutcome | null = null;
  let streak = 0;
  let firstTerminalAt: number | null = null;
  let transient = 0;
  let overrunUsed = false;
  let polls = 0;
  let last = summarise([]);

  const say = (line: string): void => {
    if (line === lastLine && now() - lastEmitAt < heartbeatMs) return;
    const heartbeat = line === lastLine;
    lastLine = line;
    lastEmitAt = now();
    emit(heartbeat ? renderHeartbeat(line, now() - started, options.timeoutMs) : line);
  };
  const done = (
    outcome: WaitOutcome,
    unavailable?: PollResult & { kind: 'unavailable' },
  ): WaitCiResult => {
    // On an unavailable exit the last snapshot is stale, so counts and rows are cleared TOGETHER —
    // a zero total beside a non-empty failure list is a contradiction a strict caller would read.
    const result: WaitCiResult = {
      outcome,
      polls,
      elapsedMs: now() - started,
      counts: unavailable ? emptyCounts() : last.counts,
      failures: unavailable ? [] : last.failures,
      pending: unavailable ? [] : last.pending,
      cancelled: unavailable ? [] : last.cancelled,
    };
    if (!unavailable) return result;
    result.unavailableReason = unavailable.reason;
    result.unavailableMessage = unavailable.message;
    return result;
  };

  for (;;) {
    polls++;
    const result = await options.poll(polls);

    if (result.kind === 'unavailable') {
      if (PERMANENT.has(result.reason) || ++transient >= transientBudget)
        return done('unavailable', result);
      say(`ci: ${result.reason} — retrying (${transient}/${transientBudget})`);
    } else {
      transient = 0;
      last = summarise(result.rows);
      say(renderProgress(last));
      if (!last.terminal) {
        firstTerminalAt = null;
        streak = 0;
        streakOutcome = null;
      } else {
        // A flip between two TERMINAL outcomes (pass -> fail without passing through pending)
        // changes the set, so the grace restarts with it instead of inheriting the replaced clock.
        if (last.outcome === streakOutcome && firstTerminalAt !== null) streak += 1;
        else {
          firstTerminalAt = now();
          streak = 1;
        }
        streakOutcome = last.outcome;
        // Both bars, not either: the poll count survives a flap, the wall-clock grace survives a
        // workflow_run job or a stale re-push rollup that registers after the first terminal poll.
        if (streak >= confirmations && now() - firstTerminalAt >= settleGraceMs)
          return done(streakOutcome);
      }
    }

    if (now() >= deadline) {
      if (streak < 1 || overrunUsed) return done('timed-out');
      overrunUsed = true; // one confirming poll past the bound, never more
    }
    await sleep(intervalMs);
  }
}

/** What `execFileSync` throws. Every field optional: this is read to CLASSIFY, never to trust. */
interface ExecFailure {
  code?: string;
  status?: number;
  killed?: boolean;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

/**
 * A deliberate SIBLING of classify() in baseline-status/gh.mts, not an import: that one is reachable
 * only through a helper which discards `e.stdout`, which is exactly the exit-8 path this caller needs.
 */
export function classifyChecksFailure(e: ExecFailure): PollResult {
  if (e?.code === 'ENOENT')
    return { kind: 'unavailable', reason: 'gh-missing', message: 'the `gh` CLI is not on PATH' };
  // A killed exec is the per-poll cap firing. Transient on purpose: a stalled network may recover
  // inside the budget, and the overall deadline still bounds how long that is tried for.
  if (e?.killed)
    return { kind: 'unavailable', reason: 'gh-failed', message: 'gh pr checks timed out' };
  const stderr = String(e?.stderr ?? '');
  const msg = stderr.trim() || e?.message || String(e);
  // gh exits 1 both for a PR with no checks and for --required on an unprotected branch. Both are
  // an empty check set — an answer — not a failure to reach gh.
  if (/no (required )?checks reported/i.test(stderr)) return { kind: 'rows', rows: [] };
  if (/gh auth login|authentication|not logged/i.test(stderr))
    return {
      kind: 'unavailable',
      reason: 'gh-unauthenticated',
      message: `gh is not authenticated: ${msg}`,
    };
  if (/could not resolve to a pullrequest|no pull requests found/i.test(stderr))
    return { kind: 'unavailable', reason: 'pr-not-found', message: msg };
  if (
    /no git remotes|not a git repository|could not determine|none of the git remotes/i.test(stderr)
  )
    return {
      kind: 'unavailable',
      reason: 'not-a-github-repo',
      message: `no GitHub remote to query: ${msg}`,
    };
  return { kind: 'unavailable', reason: 'gh-failed', message: msg };
}

/** The gh invocation, injectable so the mapping above is testable without a network or a PR. */
export type ChecksExec = (args: string[], cwd: string) => string;

const defaultExec =
  (timeout: number): ChecksExec =>
  (args, cwd) =>
    execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });

export interface ChecksPollerOptions {
  pr: string;
  repo: string;
  cwd: string;
  /** Narrow to branch-protection required checks. Never the default — see the decision record. */
  required?: boolean;
  /** Per-poll cap handed to gh. Ignored when `exec` is injected. */
  execTimeoutMs?: number;
  exec?: ChecksExec;
}

/** Build the poller `waitForChecks` drives. It never throws: every outcome is a PollResult. */
export function ghChecksPoller(options: ChecksPollerOptions): () => PollResult {
  const exec = options.exec ?? defaultExec(options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
  const args = ['pr', 'checks', options.pr, '--repo', options.repo, '--json', CHECKS_JSON_FIELDS];
  if (options.required) args.push('--required');
  const unparseable = (raw: string): PollResult => ({
    kind: 'unavailable',
    reason: 'gh-json-unparseable',
    message: `gh pr checks returned JSON this reader cannot use: ${raw.slice(0, 200)}`,
  });
  return () => {
    let raw: string;
    try {
      raw = exec(args, options.cwd);
    } catch (e) {
      // SAFETY: execFileSync rejects with an Error carrying optional code/status/stdout/stderr.
      const failure = e as ExecFailure;
      // Exit 8 means pending and gh still prints the rows; read them before classifying.
      const out = failure.stdout === undefined ? '' : String(failure.stdout);
      if (out.trim()) {
        const rows = parseChecksJson(out);
        return rows ? { kind: 'rows', rows } : unparseable(out);
      }
      return classifyChecksFailure(failure);
    }
    const rows = parseChecksJson(raw);
    return rows ? { kind: 'rows', rows } : unparseable(raw);
  };
}

/** Seconds as an integer inside the floor and ceiling, or null. Mirrors the bash-side refusal. */
export function parseTimeoutSeconds(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds >= MIN_TIMEOUT_S && seconds <= MAX_TIMEOUT_S ? seconds : null;
}

/** A bare positive integer, or null. Separate from the seconds parser: different unit, no bounds. */
function positiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value > 0 ? value : null;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * The queryable half of the verdict, beside ship_pr on the same JSONL stream. Best-effort: telemetry
 * must never be the thing that fails a ship (ship-branch.sh writes its own rows under `|| true`).
 */
export function recordCiEvent(result: WaitCiResult, pr: string, env = process.env): void {
  const file = env.DEVKIT_GATE_EVENTS;
  const shipId = env.DEVKIT_SHIP_ID;
  if (!file || !shipId) return;
  const row = {
    type: 'ship_ci',
    ship_id: shipId,
    devkit_version: env.DEVKIT_TELEMETRY_VERSION ?? null,
    pr_number: /^\d+$/.test(pr) ? Number(pr) : null,
    outcome: result.outcome,
    failing: result.failures.map((f) => f.name),
    pending: result.pending.map((p) => p.name),
    waited_s: Math.round(result.elapsedMs / 1000),
    polls: result.polls,
    reason: result.unavailableReason ?? null,
    ts: new Date().toISOString(),
  };
  try {
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch {
    // A telemetry miss costs a queryable row, never the ship.
  }
}

async function main(argv: string[]): Promise<number> {
  const pr = flagValue(argv, '--pr') ?? '';
  const repo = flagValue(argv, '--repo') ?? '';
  const seconds = parseTimeoutSeconds(flagValue(argv, '--timeout'));
  if (!pr || !repo || seconds === null) {
    console.error(
      `wait-ci: --pr <number> --repo <owner/repo> --timeout <${MIN_TIMEOUT_S}..${MAX_TIMEOUT_S} seconds> required`,
    );
    return 1;
  }
  // A test seam, not a ship flag: a bash test waiting 10s per poll would add minutes to the suite.
  const intervalMs =
    positiveInt(flagValue(argv, '--interval-ms')) ??
    positiveInt(process.env.DEVKIT_WAIT_CI_INTERVAL_MS) ??
    DEFAULT_INTERVAL_MS;
  const settleGraceMs =
    positiveInt(process.env.DEVKIT_WAIT_CI_SETTLE_MS) ?? DEFAULT_SETTLE_GRACE_MS;
  const result = await waitForChecks({
    poll: ghChecksPoller({ pr, repo, cwd: process.cwd(), required: argv.includes('--required') }),
    timeoutMs: seconds * 1000,
    intervalMs,
    settleGraceMs,
  });
  console.error(verdictLine(result, pr));
  recordCiEvent(result, pr);
  return 0; // the ship already succeeded; this process never speaks for it
}

// Run only as a CLI entrypoint — a test importing waitForChecks must not exit. Realpath argv[1] so
// the guard also fires through a symlink, matching reconcile-manifest-write.mts.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exit(await main(process.argv.slice(2)));
