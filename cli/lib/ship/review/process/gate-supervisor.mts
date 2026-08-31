import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:os';
import { runDirectReviewCli } from '../run-direct.mts';
import { type ProcessRecord, type ProcessTableReader, readProcessTable } from './process-table.mts';

const KILL_GRACE_MS = 10_000;
const FORCED_CLEANUP_MAX_MS = KILL_GRACE_MS * 2;
// The leader has exited but something in its group still holds the gate's stdio. Waiting for that to
// resolve itself is how a REJECTED gate used to wedge a ship forever (sc-1199): the reviewer exits 1
// in seconds, nothing signals the group, and the leaked child keeps the capture pipe's write-end open
// so the reader never sees EOF. The expiry timeout is not the bound here — it is measured in the hour
// for a ship. Give the stragglers a short grace to drain on their own, then reap the group.
const LINGER_GRACE_MS = 5_000;
const GROUP_POLL_MS = 25;
const OWNERSHIP_SAMPLE_MS = 250;
const MAX_TIMEOUT_MS = 2_147_483_647;
const FORWARDED_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'] as const;
const LEGACY_PID_FILE_ENV = 'DEVKIT_REVIEW_SUPERVISOR_PID_FILE';
const OWNERSHIP_TOKEN_ENV = 'DEVKIT_REVIEW_GATE_OWNER';
const OWNERSHIP_SEED_ENV = 'DEVKIT_REVIEW_SUPERVISOR_OWNER_TOKEN';
// Absolute epoch (ms) at which this supervisor kills the gate chain. Read by
// gate-engine/review/recovery/settle.mts; keep the two spellings in sync.
const GATE_DEADLINE_ENV = 'DEVKIT_GATE_DEADLINE_MS';
const OWNERSHIP_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const NATURAL_RESERVED_STATUSES = new Set([124, 129, 130, 131, 143]);
type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];
const SIGNAL_EXIT_CODES: Record<ForwardedSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
};
function usage(): never {
  throw new Error('usage: gate-supervisor <timeout-seconds> -- <command...>');
}
function timeoutMilliseconds(raw: string): number {
  const seconds = Number(raw);
  const milliseconds = seconds * 1_000;
  if (!Number.isFinite(seconds) || seconds <= 0 || milliseconds > MAX_TIMEOUT_MS) return usage();
  return milliseconds;
}
function errorCode(cause: unknown): string | undefined {
  return cause !== null && typeof cause === 'object' && 'code' in cause
    ? String(cause.code)
    : undefined;
}
function signalGroup(groupId: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (cause) {
    if (errorCode(cause) === 'ESRCH') return false;
    // A terminated group can transiently report EPERM while macOS reaps its members. That window is
    // not specific to the liveness probe — a real SIGTERM/SIGKILL lands in it just as often, and the
    // tolerance used to be wired for `signal === 0` only, so an ordinary group signal arriving mid-reap
    // THREW. That throw becomes terminalFailure and settles the supervisor at 1. Measured on macOS
    // under parallel load: 39 of 40 supervised runs took EPERM on the group SIGTERM. It stayed latent
    // while only `devkit review` was supervised; the moment ship joined, it began failing commits that
    // had already landed with every gate green. Report the group as still present and let the poll
    // loop settle it on ESRCH — the same conservative reading the probe already took.
    if (errorCode(cause) === 'EPERM') return true;
    throw new Error(`could not signal gate process group ${groupId} with ${String(signal)}`, {
      cause,
    });
  }
}
function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal === null) return 1;
  return 128 + (constants.signals[signal] ?? 0);
}
function naturalExitCode(status: number): number {
  return NATURAL_RESERVED_STATUSES.has(status) ? 1 : status;
}
interface OwnedProcessState {
  rootGroupId: number;
  table: Map<number, ProcessRecord>;
  identities: Map<number, string>;
}
interface ProcessSignalState extends OwnedProcessState {
  signal: NodeJS.Signals;
  signalled: Set<string>;
}
function matchesIdentity(record: ProcessRecord | undefined, identity: string | undefined): boolean {
  return identity !== undefined && record?.identity === identity;
}
function ownedGroups(state: OwnedProcessState): Set<number> {
  const groups = new Set([state.rootGroupId]);
  for (const record of state.table.values()) {
    if (
      record.pid === record.groupId &&
      matchesIdentity(record, state.identities.get(record.pid))
    ) {
      groups.add(record.groupId);
    }
  }
  return groups;
}
function belongsToOwnedTree(
  record: ProcessRecord,
  groups: Set<number>,
  state: OwnedProcessState,
): boolean {
  if (record.ownershipToken || groups.has(record.groupId)) return true;
  const parent = state.table.get(record.parentPid);
  return matchesIdentity(parent, state.identities.get(record.parentPid));
}
function discoverOwnedProcesses(state: OwnedProcessState): boolean {
  const groups = ownedGroups(state);
  let changed = false;
  for (const record of state.table.values()) {
    if (record.pid <= 1 || record.pid === process.pid) continue;
    if (matchesIdentity(record, state.identities.get(record.pid))) continue;
    if (!belongsToOwnedTree(record, groups, state)) continue;
    state.identities.set(record.pid, record.identity);
    changed = true;
  }
  return changed;
}
function refreshOwnedProcesses(
  rootGroupId: number,
  identities: Map<number, string>,
  inspectProcesses: ProcessTableReader,
  ownershipMarker?: string,
): Map<number, ProcessRecord> {
  const table = inspectProcesses(ownershipMarker);
  const state = { rootGroupId, table, identities };
  while (discoverOwnedProcesses(state)) {}
  return table;
}
function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (cause) {
    if (errorCode(cause) !== 'ESRCH') {
      throw new Error(`could not signal escaped gate process ${pid} with ${signal}`, { cause });
    }
  }
}
function escapedOwnedGroups(state: OwnedProcessState): Set<number> {
  const groups = new Set<number>();
  for (const record of state.table.values()) {
    if (record.groupId === state.rootGroupId || record.pid !== record.groupId) continue;
    if (matchesIdentity(record, state.identities.get(record.pid))) groups.add(record.groupId);
  }
  return groups;
}
function markOwnedGroupMembers(groupId: number, state: ProcessSignalState): void {
  for (const record of state.table.values()) {
    if (record.groupId !== groupId) continue;
    if (matchesIdentity(record, state.identities.get(record.pid))) {
      state.signalled.add(`pid:${record.pid}:${record.identity}`);
    }
  }
}
function signalOwnedGroup(groupId: number, key: string, state: ProcessSignalState): void {
  if (state.signalled.has(key)) return;
  signalGroup(groupId, state.signal);
  state.signalled.add(key);
  markOwnedGroupMembers(groupId, state);
}
function signalOwnedPids(state: ProcessSignalState, outsideRootOnly: boolean): void {
  for (const [pid, identity] of state.identities) {
    const record = state.table.get(pid);
    if (record === undefined) continue;
    if (!matchesIdentity(record, identity)) continue;
    const key = `pid:${pid}:${identity}`;
    if (state.signalled.has(key)) continue;
    if (outsideRootOnly && record.groupId === state.rootGroupId) continue;
    signalProcess(pid, state.signal);
    state.signalled.add(key);
  }
}
function signalOwnedProcesses(
  rootGroupId: number,
  identities: Map<number, string>,
  signal: NodeJS.Signals,
  signalled: Set<string>,
  inspectProcesses: ProcessTableReader,
  ownershipMarker?: string,
): Map<number, ProcessRecord> {
  const table = refreshOwnedProcesses(rootGroupId, identities, inspectProcesses, ownershipMarker);
  const state = { rootGroupId, table, identities, signal, signalled };
  for (const groupId of escapedOwnedGroups(state)) {
    const key = `group:${groupId}:${table.get(groupId)?.identity ?? ''}`;
    signalOwnedGroup(groupId, key, state);
  }
  signalOwnedPids(state, true);
  signalOwnedGroup(rootGroupId, `group:${rootGroupId}`, state);
  signalOwnedPids(state, false);
  return table;
}
function trackedProcessAlive(
  table: Map<number, ProcessRecord>,
  identities: Map<number, string>,
): boolean {
  for (const [pid, identity] of identities) {
    if (table.get(pid)?.identity === identity) return true;
  }
  return false;
}
function knownProcessAlive(identities: Map<number, string>): boolean {
  for (const pid of identities.keys()) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      if (errorCode(cause) !== 'ESRCH') return true;
    }
  }
  return false;
}
function signalKnownProcesses(identities: Map<number, string>, signal: NodeJS.Signals): void {
  let signalFailure: unknown;
  for (const pid of identities.keys()) {
    try {
      signalProcess(pid, signal);
    } catch (cause) {
      signalFailure ??= cause;
    }
  }
  if (signalFailure !== undefined) throw signalFailure;
}
/** Run one gate command and own the lifetime of its complete POSIX process group. */
export function superviseGateCommand(
  timeoutMs: number,
  command: readonly string[],
  inspectProcesses: ProcessTableReader = readProcessTable,
  seededOwnershipToken?: string,
  normalizeReservedStatuses = true,
): Promise<number> {
  if (process.platform === 'win32') {
    return Promise.reject(new Error('gate-supervisor requires POSIX process-group signals'));
  }
  const executable = command[0];
  if (!executable) return Promise.reject(new Error('gate-supervisor requires a command'));
  const ownershipToken = seededOwnershipToken ?? randomBytes(32).toString('hex');
  if (!OWNERSHIP_TOKEN_PATTERN.test(ownershipToken)) {
    return Promise.reject(new Error('gate-supervisor received an invalid private ownership token'));
  }
  const ownershipMarker = `${OWNERSHIP_TOKEN_ENV}=${ownershipToken}`;
  const childEnvironment = { ...process.env, [OWNERSHIP_TOKEN_ENV]: ownershipToken };
  try {
    // Validate both process-table views before target-controlled code can run.
    inspectProcesses(ownershipMarker);
  } catch (cause) {
    return Promise.reject(cause);
  }
  return new Promise((resolve, reject) => {
    let groupId: number | undefined;
    let childDone = false;
    let childStatus = 1;
    let forcedStatus: number | undefined;
    let finished = false;
    let cleanupDeadlineTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let ownershipTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let lingerTimer: NodeJS.Timeout | undefined;
    let terminationSignal: NodeJS.Signals = 'SIGTERM';
    let inspectionFailure: unknown;
    let terminalFailure: unknown;
    let lastProcessTable = new Map<number, ProcessRecord>();
    const ownedProcesses = new Map<number, string>();
    let signalledProcesses = new Set<string>();
    let timeoutTimer: NodeJS.Timeout | undefined;
    const handlers = Object.fromEntries(
      FORWARDED_SIGNALS.map((signal) => [signal, () => terminate(SIGNAL_EXIT_CODES[signal])]),
    ) as Record<ForwardedSignal, () => void>;
    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (cleanupDeadlineTimer) clearTimeout(cleanupDeadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (ownershipTimer) clearTimeout(ownershipTimer);
      if (pollTimer) clearTimeout(pollTimer);
      if (lingerTimer) clearTimeout(lingerTimer);
    };
    const settle = (status: number, cause?: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimers();
      for (const signal of FORWARDED_SIGNALS) process.off(signal, handlers[signal]);
      if (cause === undefined) resolve(status);
      else reject(cause);
    };
    const groupAlive = (): boolean => groupId !== undefined && signalGroup(groupId, 0);
    const completionReady = (ownedProcessAlive: boolean): boolean =>
      childDone && inspectionFailure === undefined && !groupAlive() && !ownedProcessAlive;
    const ownedProcessAlive = (): boolean =>
      inspectionFailure === undefined
        ? trackedProcessAlive(lastProcessTable, ownedProcesses)
        : knownProcessAlive(ownedProcesses);
    const inspectOwnedProcesses = (discoverDetached = false): void => {
      if (groupId === undefined) return;
      lastProcessTable = refreshOwnedProcesses(
        groupId,
        ownedProcesses,
        inspectProcesses,
        discoverDetached ? ownershipMarker : undefined,
      );
      if (discoverDetached) inspectionFailure = undefined;
    };
    const signalForcedProcesses = (): void => {
      if (groupId === undefined) return;
      try {
        lastProcessTable = signalOwnedProcesses(
          groupId,
          ownedProcesses,
          terminationSignal,
          signalledProcesses,
          inspectProcesses,
          ownershipMarker,
        );
        inspectionFailure = undefined;
      } catch (cause) {
        inspectionFailure ??= cause;
        terminalFailure ??= cause;
        try {
          signalKnownProcesses(ownedProcesses, terminationSignal);
        } catch (signalCause) {
          inspectionFailure ??= signalCause;
        }
        try {
          signalGroup(groupId, terminationSignal);
        } catch (signalCause) {
          inspectionFailure ??= signalCause;
        }
      }
    };
    // What a reaped-after-linger run reports. A gate that REJECTED must still read as a rejection —
    // `naturalExitCode(childStatus)` is byte-for-byte what settle() would have resolved had the group
    // drained on its own, so the reap is invisible to the caller's attribution (a ship keeps blaming
    // the reviewer, not a timeout). A leader that exited CLEAN while leaking a live tree is the one
    // case we override: it verified nothing conclusive, so it takes the expiry status.
    const reportedChildStatus = (): number =>
      normalizeReservedStatuses ? naturalExitCode(childStatus) : childStatus;
    const lingerStatus = (): number => (childStatus === 0 ? 124 : reportedChildStatus());
    const checkForCompletion = (): void => {
      if (finished) return;
      try {
        if (forcedStatus !== undefined) signalForcedProcesses();
        if (completionReady(ownedProcessAlive())) {
          settle(forcedStatus ?? reportedChildStatus(), terminalFailure);
          return;
        }
      } catch (cause) {
        settle(1, cause);
        return;
      }
      if (!childDone && forcedStatus === undefined) return;
      // The leader is gone and the group is not. Arm the reap once (not per poll); after this the
      // outcome is bounded by LINGER_GRACE + KILL_GRACE rather than by the expiry timeout.
      if (childDone && forcedStatus === undefined && lingerTimer === undefined) {
        lingerTimer = setTimeout(() => {
          lingerTimer = undefined;
          beginForcedCleanup(lingerStatus());
        }, LINGER_GRACE_MS);
      }
      if (pollTimer !== undefined) return;
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        checkForCompletion();
      }, GROUP_POLL_MS);
    };
    const sampleOwnership = (): void => {
      if (finished || forcedStatus !== undefined) return;
      ownershipTimer = undefined;
      try {
        inspectOwnedProcesses(childDone || inspectionFailure !== undefined);
      } catch (cause) {
        beginForcedCleanup(1, cause);
        return;
      }
      checkForCompletion();
      if (!finished && forcedStatus === undefined) {
        ownershipTimer = setTimeout(sampleOwnership, OWNERSHIP_SAMPLE_MS);
      }
    };
    function beginForcedCleanup(status: number, cause?: unknown): void {
      if (cause !== undefined) {
        inspectionFailure = cause;
        terminalFailure ??= cause;
      }
      if (finished || forcedStatus !== undefined) return;
      forcedStatus = status;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (ownershipTimer) clearTimeout(ownershipTimer);
      ownershipTimer = undefined;
      if (lingerTimer) clearTimeout(lingerTimer);
      lingerTimer = undefined;
      signalForcedProcesses();
      cleanupDeadlineTimer = setTimeout(() => {
        terminationSignal = 'SIGKILL';
        try {
          signalKnownProcesses(ownedProcesses, terminationSignal);
        } catch (cleanupCause) {
          terminalFailure ??= cleanupCause;
        }
        try {
          if (groupId !== undefined) signalGroup(groupId, terminationSignal);
        } catch (cleanupCause) {
          terminalFailure ??= cleanupCause;
        }
        settle(1, terminalFailure ?? new Error(`gate cleanup exceeded ${FORCED_CLEANUP_MAX_MS}ms`));
      }, FORCED_CLEANUP_MAX_MS);
      graceTimer = setTimeout(() => {
        terminationSignal = 'SIGKILL';
        signalledProcesses = new Set<string>();
        signalForcedProcesses();
        checkForCompletion();
      }, KILL_GRACE_MS);
      checkForCompletion();
    }
    function terminate(status: number): void {
      beginForcedCleanup(status);
    }
    for (const signal of FORWARDED_SIGNALS) process.on(signal, handlers[signal]);
    try {
      // ONE clock for the whole gate chain (sc-2088). The deadline published to the child and the
      // timer armed here are the SAME number, so no downstream phase can believe it has budget this
      // supervisor will not grant. It must be an ABSOLUTE epoch, not a duration: the timeout covers
      // the entire `git commit` — deterministic prefix, decisions cascade, then the review gate —
      // and a gate deep in that chain cannot see how much of it already burned. guard-review's
      // deferred checklist recovery reads it before starting a judge it could not finish.
      const deadlineMs = Date.now() + timeoutMs;
      const child = spawn(executable, command.slice(1), {
        detached: true,
        env: { ...childEnvironment, [GATE_DEADLINE_ENV]: String(deadlineMs) },
        stdio: 'inherit',
      });
      groupId = child.pid;
      timeoutTimer = setTimeout(() => terminate(124), Math.max(0, deadlineMs - Date.now()));
      child.once('error', (cause) => {
        childDone = true;
        childStatus = errorCode(cause) === 'ENOENT' ? 127 : 1;
        try {
          inspectOwnedProcesses(true);
        } catch (cause) {
          beginForcedCleanup(1, cause);
          return;
        }
        checkForCompletion();
      });
      child.once('exit', (code, signal) => {
        childDone = true;
        childStatus = childExitCode(code, signal);
        try {
          inspectOwnedProcesses(true);
        } catch (cause) {
          beginForcedCleanup(1, cause);
          return;
        }
        checkForCompletion();
      });
      ownershipTimer = setTimeout(sampleOwnership, 0);
    } catch (cause) {
      settle(1, cause);
    }
  });
}
async function runCli(args: string[]): Promise<void> {
  if (args.length < 3 || args[1] !== '--') return usage();
  const timeoutMs = timeoutMilliseconds(args[0] as string);
  delete process.env[LEGACY_PID_FILE_ENV];
  const token = process.env[OWNERSHIP_SEED_ENV];
  delete process.env[OWNERSHIP_SEED_ENV];
  process.exitCode = await superviseGateCommand(timeoutMs, args.slice(2), readProcessTable, token);
}

runDirectReviewCli(import.meta.url, (args) => {
  void runCli(args).catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
});
