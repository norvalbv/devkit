/**
 * `devkit ship --queue` — the view of the machine-wide ship slot. It takes no slot and changes no
 * queue state: it holds the queue lock only for the read, and a dead ticket is merely skipped.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PROBE,
  holderAlive,
  parseTicket,
  type QueueProbe,
  type QueueTicket,
  queueRoot,
  readHolders,
  type SlotHolder,
  withSlotLock,
} from './ship-queue.mts';
import { readSlotCount } from './slots.mts';

export interface QueueView {
  /** Live holders, oldest first. */
  running: Array<SlotHolder & { gate: string }>;
  waiters: QueueTicket[];
  /** Configured concurrent ships, and slot dirs in use (which can exceed it after a shrink). */
  slots: number;
  occupied: number;
}

/** The last non-empty line of the gate log the holder's bash recorded (dry-gates logs included). */
export function currentGate(holder: Pick<SlotHolder, 'gateLog'>): string {
  if (!holder.gateLog) return 'not started';
  try {
    const lines = readFileSync(holder.gateLog, 'utf8')
      .split('\n')
      .map((line) => line.trim());
    const last = lines.filter(Boolean).at(-1);
    return last ? last.slice(0, 120) : 'starting';
  } catch {
    return 'unknown';
  }
}

/** One consistent snapshot: claims and their ticket drops happen under the same slot lock. */
export function readShipQueue(root = queueRoot(), probe: QueueProbe = DEFAULT_PROBE): QueueView {
  if (!existsSync(root)) return { running: [], waiters: [], slots: 1, occupied: 0 };
  return withSlotLock(root, () => {
    const entries = readHolders(root);
    const view: QueueView = {
      running: entries
        .flatMap(({ holder }) => (holder && holderAlive(holder, probe) ? [holder] : []))
        .map((holder) => ({ ...holder, gate: currentGate(holder) }))
        .sort((a, b) => a.startedAt - b.startedAt),
      waiters: [],
      slots: readSlotCount(root),
      occupied: entries.length,
    };
    let names: string[] = [];
    try {
      names = readdirSync(join(root, 'tickets'));
    } catch {
      // no tickets yet
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let ticket: QueueTicket | undefined;
      try {
        ticket = parseTicket(readFileSync(join(root, 'tickets', name), 'utf8'));
      } catch {
        // a dead waiter's ticket pruned meanwhile
      }
      if (ticket && !probe.ownerGone(ticket.pid, ticket.identity)) view.waiters.push(ticket);
    }
    view.waiters.sort((a, b) => a.seq - b.seq || a.pid - b.pid);
    return view;
  });
}

function elapsed(since: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
}

export function formatShipQueue(view: QueueView, now = Date.now()): string {
  const lines: string[] = [`slots: ${view.occupied}/${view.slots} in use`];
  if (view.running.length === 0) lines.push('running: (none)');
  for (const h of view.running) {
    lines.push(`running: ${h.branch}  ${h.repo}  ${elapsed(h.startedAt, now)}  pid ${h.pid}`);
    lines.push(`         gate: ${h.gate}`);
    // devkit never signals it: holder.json is same-user writable, so the owner checks what runs first.
    const scope = h.pgid === undefined ? `-p ${h.pid}` : `-g ${h.pgid}`;
    lines.push(
      `         stuck? inspect it with: ps -o pid,lstart,command ${scope} — then stop it yourself`,
    );
  }
  if (view.waiters.length === 0) lines.push('waiting: (none)');
  view.waiters.forEach((w, index) => {
    lines.push(
      `waiting ${index + 1}: ${w.branch}  ${w.repo}  queued ${elapsed(w.startedAt, now)}  pid ${w.pid}`,
    );
  });
  return lines.join('\n');
}
