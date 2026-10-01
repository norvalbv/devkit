/**
 * `devkit ship --queue` — the view of the machine-wide ship slot. It takes no slot and changes no
 * queue state: it holds the queue lock only for the read, and a dead ticket is merely skipped.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROBE, holderAlive, parseTicket, queueRoot, readHolder, withSlotLock, } from './ship-queue.mjs';
/** The last non-empty line of the gate log the holder's bash recorded (dry-gates logs included). */
export function currentGate(holder) {
    if (!holder.gateLog)
        return 'not started';
    try {
        const lines = readFileSync(holder.gateLog, 'utf8')
            .split('\n')
            .map((line) => line.trim());
        const last = lines.filter(Boolean).at(-1);
        return last ? last.slice(0, 120) : 'starting';
    }
    catch {
        return 'unknown';
    }
}
/** One consistent snapshot: claims and their ticket drops happen under the same slot lock. */
export function readShipQueue(root = queueRoot(), probe = DEFAULT_PROBE) {
    if (!existsSync(root))
        return { waiters: [] };
    return withSlotLock(root, () => {
        const view = { waiters: [] };
        const holder = readHolder(root);
        if (holder && holderAlive(holder, probe))
            view.holder = { ...holder, gate: currentGate(holder) };
        let names = [];
        try {
            names = readdirSync(join(root, 'tickets'));
        }
        catch {
            // no tickets yet
        }
        for (const name of names) {
            if (!name.endsWith('.json'))
                continue;
            let ticket;
            try {
                ticket = parseTicket(readFileSync(join(root, 'tickets', name), 'utf8'));
            }
            catch {
                // a dead waiter's ticket pruned meanwhile
            }
            if (ticket && !probe.ownerGone(ticket.pid, ticket.identity))
                view.waiters.push(ticket);
        }
        view.waiters.sort((a, b) => a.seq - b.seq || a.pid - b.pid);
        return view;
    });
}
function elapsed(since, now) {
    const minutes = Math.max(0, Math.floor((now - since) / 60_000));
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
}
export function formatShipQueue(view, now = Date.now()) {
    const lines = [];
    if (view.holder) {
        const h = view.holder;
        lines.push(`running: ${h.branch}  ${h.repo}  ${elapsed(h.startedAt, now)}  pid ${h.pid}`);
        lines.push(`         gate: ${h.gate}`);
    }
    else {
        lines.push('running: (none)');
    }
    if (view.waiters.length === 0)
        lines.push('waiting: (none)');
    view.waiters.forEach((w, index) => {
        lines.push(`waiting ${index + 1}: ${w.branch}  ${w.repo}  queued ${elapsed(w.startedAt, now)}  pid ${w.pid}`);
    });
    return lines.join('\n');
}
