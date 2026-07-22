import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:os';
import { runDirectReviewCli } from "../run-direct.mjs";
const KILL_GRACE_MS = 10_000;
const FORCED_CLEANUP_MAX_MS = KILL_GRACE_MS * 2;
const GROUP_POLL_MS = 25;
const OWNERSHIP_SAMPLE_MS = 250;
const MAX_TIMEOUT_MS = 2_147_483_647;
const FORWARDED_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'];
const LEGACY_PID_FILE_ENV = 'DEVKIT_REVIEW_SUPERVISOR_PID_FILE';
const OWNERSHIP_TOKEN_ENV = 'DEVKIT_REVIEW_GATE_OWNER';
const OWNERSHIP_SEED_ENV = 'DEVKIT_REVIEW_SUPERVISOR_OWNER_TOKEN';
const OWNERSHIP_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const NATURAL_RESERVED_STATUSES = new Set([124, 129, 130, 131, 143]);
const PROCESS_TABLE_MAX_BYTES = 16 * 1024 * 1024;
const PROCESS_LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+?)\s*$/;
const PROCESS_PID_PATTERN = /^\s*(\d+)/;
const SIGNAL_EXIT_CODES = {
    SIGHUP: 129,
    SIGINT: 130,
    SIGQUIT: 131,
    SIGTERM: 143,
};
function usage() {
    throw new Error('usage: gate-supervisor <timeout-seconds> -- <command...>');
}
function timeoutMilliseconds(raw) {
    const seconds = Number(raw);
    const milliseconds = seconds * 1_000;
    if (!Number.isFinite(seconds) || seconds <= 0 || milliseconds > MAX_TIMEOUT_MS)
        return usage();
    return milliseconds;
}
function errorCode(cause) {
    return cause !== null && typeof cause === 'object' && 'code' in cause
        ? String(cause.code)
        : undefined;
}
function signalGroup(groupId, signal) {
    try {
        process.kill(-groupId, signal);
        return true;
    }
    catch (cause) {
        if (errorCode(cause) === 'ESRCH')
            return false;
        // A terminated group can transiently report EPERM while macOS reaps its members.
        if (signal === 0 && errorCode(cause) === 'EPERM')
            return true;
        throw new Error(`could not signal gate process group ${groupId} with ${String(signal)}`, {
            cause,
        });
    }
}
function childExitCode(code, signal) {
    if (code !== null)
        return code;
    if (signal === null)
        return 1;
    return 128 + (constants.signals[signal] ?? 0);
}
function naturalExitCode(status) {
    return NATURAL_RESERVED_STATUSES.has(status) ? 1 : status;
}
function processTableOutput(args) {
    const result = spawnSync('/bin/ps', args, {
        encoding: 'utf8',
        maxBuffer: PROCESS_TABLE_MAX_BYTES,
    });
    if (result.error)
        throw new Error('could not inspect the gate process tree', { cause: result.error });
    if (result.status !== 0) {
        throw new Error(`could not inspect the gate process tree (ps exit ${String(result.status)})`);
    }
    return result.stdout;
}
function readProcessTable(ownershipMarker) {
    const output = processTableOutput('-A -o pid= -o ppid= -o pgid= -o stat= -o lstart='.split(' '));
    const table = new Map();
    for (const line of output.split('\n')) {
        const match = PROCESS_LINE_PATTERN.exec(line);
        if (!match)
            continue;
        const pid = Number(match[1]);
        table.set(pid, {
            pid,
            parentPid: Number(match[2]),
            groupId: Number(match[3]),
            identity: match[4],
            ownershipToken: false,
        });
    }
    if (ownershipMarker) {
        const environmentArgs = process.platform === 'linux'
            ? ['-A', 'eww', '-o', 'pid=', '-o', 'command=']
            : ['-A', '-wwE', '-o', 'pid=', '-o', 'command='];
        for (const line of processTableOutput(environmentArgs).split('\n')) {
            const pid = Number(PROCESS_PID_PATTERN.exec(line)?.[1]);
            const record = table.get(pid);
            if (record && line.includes(ownershipMarker))
                record.ownershipToken = true;
        }
    }
    return table;
}
function matchesIdentity(record, identity) {
    return identity !== undefined && record?.identity === identity;
}
function ownedGroups(state) {
    const groups = new Set([state.rootGroupId]);
    for (const record of state.table.values()) {
        if (record.pid === record.groupId &&
            matchesIdentity(record, state.identities.get(record.pid))) {
            groups.add(record.groupId);
        }
    }
    return groups;
}
function belongsToOwnedTree(record, groups, state) {
    if (record.ownershipToken || groups.has(record.groupId))
        return true;
    const parent = state.table.get(record.parentPid);
    return matchesIdentity(parent, state.identities.get(record.parentPid));
}
function discoverOwnedProcesses(state) {
    const groups = ownedGroups(state);
    let changed = false;
    for (const record of state.table.values()) {
        if (record.pid <= 1 || record.pid === process.pid)
            continue;
        if (matchesIdentity(record, state.identities.get(record.pid)))
            continue;
        if (!belongsToOwnedTree(record, groups, state))
            continue;
        state.identities.set(record.pid, record.identity);
        changed = true;
    }
    return changed;
}
function refreshOwnedProcesses(rootGroupId, identities, inspectProcesses, ownershipMarker) {
    const table = inspectProcesses(ownershipMarker);
    const state = { rootGroupId, table, identities };
    while (discoverOwnedProcesses(state)) { }
    return table;
}
function signalProcess(pid, signal) {
    try {
        process.kill(pid, signal);
    }
    catch (cause) {
        if (errorCode(cause) !== 'ESRCH') {
            throw new Error(`could not signal escaped gate process ${pid} with ${signal}`, { cause });
        }
    }
}
function escapedOwnedGroups(state) {
    const groups = new Set();
    for (const record of state.table.values()) {
        if (record.groupId === state.rootGroupId || record.pid !== record.groupId)
            continue;
        if (matchesIdentity(record, state.identities.get(record.pid)))
            groups.add(record.groupId);
    }
    return groups;
}
function markOwnedGroupMembers(groupId, state) {
    for (const record of state.table.values()) {
        if (record.groupId !== groupId)
            continue;
        if (matchesIdentity(record, state.identities.get(record.pid))) {
            state.signalled.add(`pid:${record.pid}:${record.identity}`);
        }
    }
}
function signalOwnedGroup(groupId, key, state) {
    if (state.signalled.has(key))
        return;
    signalGroup(groupId, state.signal);
    state.signalled.add(key);
    markOwnedGroupMembers(groupId, state);
}
function signalOwnedPids(state, outsideRootOnly) {
    for (const [pid, identity] of state.identities) {
        const record = state.table.get(pid);
        if (record === undefined)
            continue;
        if (!matchesIdentity(record, identity))
            continue;
        const key = `pid:${pid}:${identity}`;
        if (state.signalled.has(key))
            continue;
        if (outsideRootOnly && record.groupId === state.rootGroupId)
            continue;
        signalProcess(pid, state.signal);
        state.signalled.add(key);
    }
}
function signalOwnedProcesses(rootGroupId, identities, signal, signalled, inspectProcesses, ownershipMarker) {
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
function trackedProcessAlive(table, identities) {
    for (const [pid, identity] of identities) {
        if (table.get(pid)?.identity === identity)
            return true;
    }
    return false;
}
function knownProcessAlive(identities) {
    for (const pid of identities.keys()) {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (cause) {
            if (errorCode(cause) !== 'ESRCH')
                return true;
        }
    }
    return false;
}
function signalKnownProcesses(identities, signal) {
    let signalFailure;
    for (const pid of identities.keys()) {
        try {
            signalProcess(pid, signal);
        }
        catch (cause) {
            signalFailure ??= cause;
        }
    }
    if (signalFailure !== undefined)
        throw signalFailure;
}
/** Run one gate command and own the lifetime of its complete POSIX process group. */
export function superviseGateCommand(timeoutMs, command, inspectProcesses = readProcessTable, seededOwnershipToken) {
    if (process.platform === 'win32') {
        return Promise.reject(new Error('gate-supervisor requires POSIX process-group signals'));
    }
    const executable = command[0];
    if (!executable)
        return Promise.reject(new Error('gate-supervisor requires a command'));
    const ownershipToken = seededOwnershipToken ?? randomBytes(32).toString('hex');
    if (!OWNERSHIP_TOKEN_PATTERN.test(ownershipToken)) {
        return Promise.reject(new Error('gate-supervisor received an invalid private ownership token'));
    }
    const ownershipMarker = `${OWNERSHIP_TOKEN_ENV}=${ownershipToken}`;
    const childEnvironment = { ...process.env, [OWNERSHIP_TOKEN_ENV]: ownershipToken };
    try {
        // Validate both process-table views before target-controlled code can run.
        inspectProcesses(ownershipMarker);
    }
    catch (cause) {
        return Promise.reject(cause);
    }
    return new Promise((resolve, reject) => {
        let groupId;
        let childDone = false;
        let childStatus = 1;
        let forcedStatus;
        let finished = false;
        let cleanupDeadlineTimer;
        let graceTimer;
        let ownershipTimer;
        let pollTimer;
        let terminationSignal = 'SIGTERM';
        let inspectionFailure;
        let terminalFailure;
        let lastProcessTable = new Map();
        const ownedProcesses = new Map();
        let signalledProcesses = new Set();
        let timeoutTimer;
        const handlers = Object.fromEntries(FORWARDED_SIGNALS.map((signal) => [signal, () => terminate(SIGNAL_EXIT_CODES[signal])]));
        const clearTimers = () => {
            if (timeoutTimer)
                clearTimeout(timeoutTimer);
            if (cleanupDeadlineTimer)
                clearTimeout(cleanupDeadlineTimer);
            if (graceTimer)
                clearTimeout(graceTimer);
            if (ownershipTimer)
                clearTimeout(ownershipTimer);
            if (pollTimer)
                clearTimeout(pollTimer);
        };
        const settle = (status, cause) => {
            if (finished)
                return;
            finished = true;
            clearTimers();
            for (const signal of FORWARDED_SIGNALS)
                process.off(signal, handlers[signal]);
            if (cause === undefined)
                resolve(status);
            else
                reject(cause);
        };
        const groupAlive = () => groupId !== undefined && signalGroup(groupId, 0);
        const completionReady = (ownedProcessAlive) => childDone && inspectionFailure === undefined && !groupAlive() && !ownedProcessAlive;
        const ownedProcessAlive = () => inspectionFailure === undefined
            ? trackedProcessAlive(lastProcessTable, ownedProcesses)
            : knownProcessAlive(ownedProcesses);
        const inspectOwnedProcesses = (discoverDetached = false) => {
            if (groupId === undefined)
                return;
            lastProcessTable = refreshOwnedProcesses(groupId, ownedProcesses, inspectProcesses, discoverDetached ? ownershipMarker : undefined);
            if (discoverDetached)
                inspectionFailure = undefined;
        };
        const signalForcedProcesses = () => {
            if (groupId === undefined)
                return;
            try {
                lastProcessTable = signalOwnedProcesses(groupId, ownedProcesses, terminationSignal, signalledProcesses, inspectProcesses, ownershipMarker);
                inspectionFailure = undefined;
            }
            catch (cause) {
                inspectionFailure ??= cause;
                terminalFailure ??= cause;
                try {
                    signalKnownProcesses(ownedProcesses, terminationSignal);
                }
                catch (signalCause) {
                    inspectionFailure ??= signalCause;
                }
                try {
                    signalGroup(groupId, terminationSignal);
                }
                catch (signalCause) {
                    inspectionFailure ??= signalCause;
                }
            }
        };
        const checkForCompletion = () => {
            if (finished)
                return;
            try {
                if (forcedStatus !== undefined)
                    signalForcedProcesses();
                if (completionReady(ownedProcessAlive())) {
                    settle(forcedStatus ?? naturalExitCode(childStatus), terminalFailure);
                    return;
                }
            }
            catch (cause) {
                settle(1, cause);
                return;
            }
            if (!childDone && forcedStatus === undefined)
                return;
            if (pollTimer !== undefined)
                return;
            pollTimer = setTimeout(() => {
                pollTimer = undefined;
                checkForCompletion();
            }, GROUP_POLL_MS);
        };
        const sampleOwnership = () => {
            if (finished || forcedStatus !== undefined)
                return;
            ownershipTimer = undefined;
            try {
                inspectOwnedProcesses(inspectionFailure !== undefined);
            }
            catch (cause) {
                beginForcedCleanup(1, cause);
                return;
            }
            checkForCompletion();
            if (!finished && forcedStatus === undefined) {
                ownershipTimer = setTimeout(sampleOwnership, OWNERSHIP_SAMPLE_MS);
            }
        };
        function beginForcedCleanup(status, cause) {
            if (cause !== undefined) {
                inspectionFailure = cause;
                terminalFailure ??= cause;
            }
            if (finished || forcedStatus !== undefined)
                return;
            forcedStatus = status;
            if (timeoutTimer)
                clearTimeout(timeoutTimer);
            if (ownershipTimer)
                clearTimeout(ownershipTimer);
            ownershipTimer = undefined;
            signalForcedProcesses();
            cleanupDeadlineTimer = setTimeout(() => {
                terminationSignal = 'SIGKILL';
                try {
                    signalKnownProcesses(ownedProcesses, terminationSignal);
                }
                catch (cleanupCause) {
                    terminalFailure ??= cleanupCause;
                }
                try {
                    if (groupId !== undefined)
                        signalGroup(groupId, terminationSignal);
                }
                catch (cleanupCause) {
                    terminalFailure ??= cleanupCause;
                }
                settle(1, terminalFailure ?? new Error(`gate cleanup exceeded ${FORCED_CLEANUP_MAX_MS}ms`));
            }, FORCED_CLEANUP_MAX_MS);
            graceTimer = setTimeout(() => {
                terminationSignal = 'SIGKILL';
                signalledProcesses = new Set();
                signalForcedProcesses();
                checkForCompletion();
            }, KILL_GRACE_MS);
            checkForCompletion();
        }
        function terminate(status) {
            beginForcedCleanup(status);
        }
        for (const signal of FORWARDED_SIGNALS)
            process.on(signal, handlers[signal]);
        try {
            const child = spawn(executable, command.slice(1), {
                detached: true,
                env: childEnvironment,
                stdio: 'inherit',
            });
            groupId = child.pid;
            timeoutTimer = setTimeout(() => terminate(124), timeoutMs);
            child.once('error', (cause) => {
                childDone = true;
                childStatus = errorCode(cause) === 'ENOENT' ? 127 : 1;
                try {
                    inspectOwnedProcesses(true);
                }
                catch (cause) {
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
                }
                catch (cause) {
                    beginForcedCleanup(1, cause);
                    return;
                }
                checkForCompletion();
            });
            ownershipTimer = setTimeout(sampleOwnership, 0);
        }
        catch (cause) {
            settle(1, cause);
        }
    });
}
async function runCli(args) {
    if (args.length < 3 || args[1] !== '--')
        return usage();
    const timeoutMs = timeoutMilliseconds(args[0]);
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
