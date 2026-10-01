/**
 * The one decision `devkit ship` makes before its first gate: queue for the machine-wide slot, or
 * run without it — and every unqueued path is loud (gate-opt-out-is-visible-and-detectable).
 */
import { join } from 'node:path';
import { emitGateBypass, emitGateEvent } from '../../../../gate-engine/judge/gate-events.mjs';
import { processStartIdentity } from '../../../../gate-engine/judge/process/identity.mjs';
import { readProcessTable } from '../review/process/process-table.mjs';
import { acquireShipSlot, DEFAULT_PROBE, ensureRoot, holderAlive, queueRoot, readHolder, SLOT_ENV, setGuest, withSlotLock, writeGuestLocked, } from './ship-queue.mjs';
export { SLOT_ENV };
export const NO_QUEUE_ENV = 'DEVKIT_SHIP_NO_QUEUE';
export const SLOT_DIR_ENV = 'DEVKIT_SHIP_SLOT_DIR';
/** Set only by the acquirer: tells its bash that IT may release the slot before --wait-ci. */
export const SLOT_RELEASE_ENV = 'DEVKIT_SHIP_SLOT_RELEASE';
/** An inherited token counts only while its holder lives and is an ancestor (by pid or group), so a
 * token leaked into an unrelated shell is never a silent bypass. Joins as a guest in the same lock. */
export function joinAncestorSlot(token, root, probe, table) {
    let processes;
    try {
        processes = table();
        return withSlotLock(root, () => {
            if (!isAncestorHolder(token, root, probe, processes))
                return false;
            return writeGuestLocked(root, token, { pid: process.pid, identity: processStartIdentity() });
        });
    }
    catch {
        return false;
    }
}
function isAncestorHolder(token, root, probe, processes) {
    const holder = readHolder(root);
    if (!holder || holder.token !== token || !holderAlive(holder, probe))
        return false;
    const seen = new Set();
    let pid = process.pid;
    while (pid > 1 && !seen.has(pid)) {
        seen.add(pid);
        const record = processes.get(pid);
        if (!record)
            return false;
        // The holder itself is never "nested". Its group is its detached bash tree, so every member —
        // this process included, when a gate spawned it there — is a descendant of the holder.
        if (pid === holder.pid)
            return pid !== process.pid;
        if (holder.pgid !== undefined && record.groupId === holder.pgid)
            return true;
        pid = record.parentPid;
    }
    return false;
}
function unqueued(reason, log) {
    log(`⚠️  ship queue BYPASSED (${reason}) — this ship runs alongside any other ship on this machine.`);
    return { env: { [SLOT_RELEASE_ENV]: '' } };
}
export async function enterShipQueue(options) {
    const log = options.log ?? ((line) => console.error(line));
    const probe = options.probe ?? DEFAULT_PROBE;
    const root = queueRoot(options.env);
    if (options.env[NO_QUEUE_ENV] === '1') {
        emitGateBypass('ship-queue', NO_QUEUE_ENV);
        return unqueued(`${NO_QUEUE_ENV}=1`, log);
    }
    const inherited = options.env[SLOT_ENV];
    if (inherited) {
        if (joinAncestorSlot(inherited, root, probe, options.processTable ?? readProcessTable)) {
            // Running under the enclosing ship's slot as a guest; the slot stays held until we leave.
            const guest = { pid: process.pid, identity: processStartIdentity() };
            const leave = () => {
                try {
                    setGuest(root, inherited, guest, true);
                }
                catch {
                    // a dead guest is pruned by liveness anyway
                }
            };
            process.once('exit', leave);
            return {
                env: { [SLOT_RELEASE_ENV]: '' },
                handle: { token: inherited, slotDir: join(root, 'slot'), release: leave },
            };
        }
        log(`ship: ignoring a stale ${SLOT_ENV} (its holder is gone or is not an ancestor); queueing.`);
    }
    // Only an uncreatable queue root may run unqueued. Any later failure propagates and stops the ship
    // rather than silently dropping mutual exclusion.
    try {
        ensureRoot(root);
    }
    catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        emitGateEvent({
            type: 'gate_result',
            gate: 'ship-queue',
            status: 'could_not_run',
            detail: `ship-queue(unavailable:${message})`,
        });
        return unqueued(`queue unavailable at ${root}: ${message}`, log);
    }
    const handle = await (options.acquire ?? acquireShipSlot)({
        repo: options.repo,
        branch: options.branch,
        mode: options.mode,
        root,
        probe,
        pollMs: options.pollMs,
        log,
    });
    return {
        handle,
        env: { [SLOT_ENV]: handle.token, [SLOT_DIR_ENV]: handle.slotDir, [SLOT_RELEASE_ENV]: '1' },
    };
}
