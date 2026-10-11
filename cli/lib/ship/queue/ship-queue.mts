// Machine-wide FIFO slot for `devkit ship`; why an mkdir claim with pid/group liveness rather than
// a kernel lock is ruled in docs/decisions/ship-machine-wide-queue.md.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import {
  processOwnerIsProvablyGone,
  processStartIdentity,
} from '../../../../gate-engine/judge/process/identity.mts';
import { z } from 'zod';
import { writeFileAtomic } from '../../atomic-write.mts';
import {
  LockHeldError,
  withProcessLock,
} from '../../../../gate-engine/judge/process/process-lock.mts';
import { readSlotCount, slotDirs, takeFreeSlot } from './slots.mts';

/** An empty claim (acquirer died between mkdir and its holder write) is reclaimable after this. */
const EMPTY_SLOT_STALE_MS = 60_000;
const POLL_MS = 2_000;

export interface QueueTicket {
  seq: number;
  pid: number;
  identity: string;
  repo: string;
  branch: string;
  mode: string;
  startedAt: number;
}

/** A nested ship running under the holder's slot (it never queues behind its own ancestor). */
export interface SlotGuest {
  pid: number;
  identity: string;
}

export interface SlotHolder extends QueueTicket {
  token: string;
  pgid?: number;
  gateLog?: string;
  guests?: SlotGuest[];
}

/** The holder's token, inherited by its bash tree; see ./slot.sh. */
export const SLOT_ENV = 'DEVKIT_SHIP_SLOT';

/** Liveness probes, injectable so tests can model pid reuse and surviving process groups. */
export interface QueueProbe {
  ownerGone: (pid: number, identity: string) => boolean;
  groupAlive: (pgid: number) => boolean;
}

export const DEFAULT_PROBE: QueueProbe = {
  ownerGone: (pid, identity) => processOwnerIsProvablyGone({ pid, processStart: identity }),
  groupAlive: (pgid) => {
    if (process.platform === 'win32' || !(pgid > 1)) return false;
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (cause) {
      return errnoCode(cause) === 'EPERM';
    }
  },
};

/** The machine's one queue. Read from the passwd entry, never the environment: an env-chosen root
 * (or $HOME, which os.homedir() honours) would hand an agent a private, silent queue. */
export function queueRoot(home: string = userInfo().homedir): string {
  return join(home, '.devkit', 'ship-queue');
}

const slotLock = (root: string) => join(root, 'slot.lock');
const QUEUE_LOCK = { label: 'queue' };
const holderFile = (slot: string) => join(slot, 'holder.json');
const ticketsDir = (root: string) => join(root, 'tickets');

function errnoCode(cause: unknown): string | undefined {
  return cause instanceof Error && 'code' in cause ? String(cause.code) : undefined;
}

/** A real OS process id: positive and within the kernel's pid range (identity.mts isProcessId). */
const ProcessId = z.number().int().min(1).max(2_147_483_647);

const TicketFile = z.object({
  seq: z.number().int().min(1),
  pid: ProcessId,
  // processStartIdentity()'s two forms; anything else cannot be judged for liveness.
  identity: z.string().regex(/^(ps|node):\S/),
  repo: z.string(),
  branch: z.string(),
  mode: z.string(),
  startedAt: z.number(),
  token: z.string().optional(),
  pgid: ProcessId.optional(),
  gateLog: z.string().min(1).optional(),
  guests: z
    .array(z.object({ pid: ProcessId, identity: z.string().regex(/^(ps|node):\S/) }))
    .optional(),
});

/** Parse a ticket or holder file at its I/O boundary; anything torn or foreign reads as absent. */
export function parseTicket(
  text: string,
):
  | (QueueTicket & { token?: string; pgid?: number; gateLog?: string; guests?: SlotGuest[] })
  | undefined {
  try {
    const parsed = TicketFile.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readTicketFile(path: string): ReturnType<typeof parseTicket> {
  try {
    return parseTicket(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The holder of one slot directory. */
export function readHolder(slot: string): SlotHolder | undefined {
  const holder = readTicketFile(holderFile(slot));
  return holder?.token ? { ...holder, token: holder.token } : undefined;
}

export interface SlotEntry {
  dir: string;
  holder?: SlotHolder;
}

/** Every slot directory with its holder (absent for an empty or torn claim). */
export function readHolders(root: string): SlotEntry[] {
  return slotDirs(root).map((dir) => ({ dir, holder: readHolder(dir) }));
}

/** The slot whose claim carries `token`: token-addressed operations work in any slot. */
export function findHolder(root: string, token: string): Required<SlotEntry> | undefined {
  for (const entry of readHolders(root)) {
    if (entry.holder?.token === token) return { dir: entry.dir, holder: entry.holder };
  }
  return undefined;
}

function liveGuests(holder: SlotHolder, probe: QueueProbe): SlotGuest[] {
  return (holder.guests ?? []).filter((guest) => !probe.ownerGone(guest.pid, guest.identity));
}

export function holderAlive(holder: SlotHolder, probe: QueueProbe = DEFAULT_PROBE): boolean {
  if (!probe.ownerGone(holder.pid, holder.identity)) return true;
  if (holder.pgid !== undefined && probe.groupAlive(holder.pgid)) return true;
  return liveGuests(holder, probe).length > 0;
}

/** Caller holds the slot lock. Add (or, with `leave`, remove) a guest on the claim carrying `token`. */
export function writeGuestLocked(
  root: string,
  token: string,
  guest: SlotGuest,
  leave = false,
): boolean {
  const found = findHolder(root, token);
  if (!found) return false;
  const others = (found.holder.guests ?? []).filter((g) => g.pid !== guest.pid);
  writeFileAtomic(
    holderFile(found.dir),
    JSON.stringify({ ...found.holder, guests: leave ? others : [...others, guest] }),
  );
  return true;
}

export function setGuest(root: string, token: string, guest: SlotGuest, leave = false): boolean {
  return withSlotLock(root, () => writeGuestLocked(root, token, guest, leave));
}

/** Live tickets in seq order. Dead ones are pruned; a torn ticket file is skipped, never fatal. */
export function liveTickets(root: string, probe: QueueProbe = DEFAULT_PROBE): QueueTicket[] {
  let names: string[];
  try {
    names = readdirSync(ticketsDir(root));
  } catch {
    return [];
  }
  const live: QueueTicket[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(ticketsDir(root), name);
    const ticket = readTicketFile(path);
    if (!ticket) continue;
    if (probe.ownerGone(ticket.pid, ticket.identity)) rmSync(path, { force: true });
    else live.push(ticket);
  }
  return live.sort((a, b) => a.seq - b.seq || a.pid - b.pid);
}

/** Every mutation of the slot (claim, reap, release, group update) runs under this one lock. */
export function withSlotLock<T>(root: string, fn: () => T): T {
  return withProcessLock(slotLock(root), fn, QUEUE_LOCK);
}

/** A contended lock is "not now" inside the wait loop: the next poll retries it. */
function unlessContended<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (cause) {
    if (cause instanceof LockHeldError) return undefined;
    throw cause;
  }
}

/** Remove each slot that is provably a dead holder's (or an empty claim past its grace period). */
export function reapSlotIfDead(root: string, probe: QueueProbe = DEFAULT_PROBE): void {
  withSlotLock(root, () => {
    for (const dir of slotDirs(root)) {
      let mtimeMs: number;
      try {
        mtimeMs = lstatSync(dir).mtimeMs;
      } catch {
        continue;
      }
      const holder = readHolder(dir);
      if (holder ? holderAlive(holder, probe) : Date.now() - mtimeMs <= EMPTY_SLOT_STALE_MS)
        continue;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/**
 * The acquirer's bash records its process group before any gate runs (./slot.sh). False when the
 * claim already moved on — its dispatcher died first — and that bash must not run at all.
 */
export function registerGroup(root: string, token: string, pgid: number): boolean {
  return withSlotLock(root, () => {
    const found = findHolder(root, token);
    if (!found) return false;
    writeFileAtomic(holderFile(found.dir), JSON.stringify({ ...found.holder, pgid }));
    return true;
  });
}

/** Record the gate log this ship's attempt allocated, for `devkit ship --queue`. */
export function noteGateLog(root: string, token: string, gateLog: string): boolean {
  return withSlotLock(root, () => {
    const found = findHolder(root, token);
    if (!found || !gateLog) return false;
    writeFileAtomic(holderFile(found.dir), JSON.stringify({ ...found.holder, gateLog }));
    return true;
  });
}

export type ReleaseOutcome = 'released' | 'not-held' | 'in-use';

/** Remove the slot only while it carries `token`, no nested guest still runs under it, and (unless
 * Bash's pre-CI `handOff`) its group is gone. Anything still in use keeps the slot until reaped. */
export function releaseSlot(
  root: string,
  token: string,
  { handOff = false, probe = DEFAULT_PROBE }: { handOff?: boolean; probe?: QueueProbe } = {},
): ReleaseOutcome {
  return withSlotLock(root, () => {
    const found = findHolder(root, token);
    if (!found) return 'not-held';
    const { dir, holder } = found;
    if (liveGuests(holder, probe).length > 0) return 'in-use';
    if (!handOff && holder.pgid !== undefined && probe.groupAlive(holder.pgid)) return 'in-use';
    rmSync(dir, { recursive: true, force: true });
    return 'released';
  });
}

/** Retry budget for ./slot.mts: finite and positive or the 75s default, so it can never be endless. */
export function retryBudgetMs(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 600_000) : 75_000;
}

type TicketFields = Omit<QueueTicket, 'seq'>;

/**
 * Allocate the arrival number AND publish the ticket under one lock, so a later arrival can never
 * see an empty queue while an earlier number is still unpublished.
 */
export function enqueue(root: string, fields: TicketFields): { ticket: QueueTicket; path: string } {
  return withProcessLock(
    join(root, 'seq.lock'),
    () => {
      const counter = join(root, 'seq');
      // Only plain digits count: a negative, fractional or torn counter restarts from the live tickets
      // instead of handing out a number at or below 0 that liveTickets would never see.
      const text = readFileSync(counter, 'utf8').trim();
      let last = /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : 0;
      for (const ticket of liveTickets(root)) last = Math.max(last, ticket.seq);
      const ticket: QueueTicket = { ...fields, seq: last + 1 };
      const path = join(
        ticketsDir(root),
        `${String(ticket.seq).padStart(12, '0')}-${ticket.pid}.json`,
      );
      writeFileAtomic(path, JSON.stringify(ticket));
      writeFileAtomic(counter, `${ticket.seq}\n`);
      return { ticket, path };
    },
    QUEUE_LOCK,
  );
}

export function ensureRoot(root: string): void {
  mkdirSync(ticketsDir(root), { recursive: true });
  try {
    writeFileSync(join(root, 'seq'), '0\n', { flag: 'wx' });
  } catch (cause) {
    if (errnoCode(cause) !== 'EEXIST') throw cause;
  }
}

export interface SlotHandle {
  token: string;
  slotDir: string;
  release: () => void;
}

export interface AcquireOptions {
  repo: string;
  branch: string;
  mode: string;
  root?: string;
  probe?: QueueProbe;
  pollMs?: number;
  log?: (line: string) => void;
  /** Called once, at a claim made under a capacity above 1, so the caller can record it. */
  onCapacity?: (slots: number) => void;
}

function describe(running: SlotHolder[], now: number): string {
  const [only] = running;
  if (!only) return 'a ship that is starting';
  if (running.length > 1) return `${running.length} running ships`;
  const minutes = Math.max(0, Math.round((now - only.startedAt) / 60_000));
  return `${only.branch} (${only.repo}, running ${minutes}m)`;
}

/** Under the lock: only the queue head (re-checked here, so a stale outside view cannot jump FIFO)
 * claims, only while fewer than `slots` slot dirs exist, into the lowest free index. */
function claimSlot(
  root: string,
  ticket: QueueTicket,
  ticketPath: string,
  probe: QueueProbe,
  log: (line: string) => void,
  onCapacity: ((slots: number) => void) | undefined,
): SlotHandle | undefined {
  const holder: SlotHolder = { ...ticket, startedAt: Date.now(), token: randomUUID() };
  const dir = withSlotLock(root, () => {
    const [head] = liveTickets(root, probe);
    if (head?.seq !== ticket.seq || head.pid !== ticket.pid) return undefined;
    // Capacity is read under the lock too: an owner's shrink binds the very next claim.
    // The claim's own read can warn too: a config made invalid since the last poll is never silent.
    const slots = readSlotCount(root, log);
    if (slotDirs(root).length >= slots) return undefined;
    const free = takeFreeSlot(root, slots);
    if (!free) return undefined;
    try {
      mkdirSync(free);
    } catch (cause) {
      if (errnoCode(cause) === 'EEXIST') return undefined;
      throw cause;
    }
    try {
      writeFileAtomic(holderFile(free), JSON.stringify(holder));
    } catch (cause) {
      rmSync(free, { recursive: true, force: true }); // never leave an ownerless claim
      throw cause;
    }
    rmSync(ticketPath, { force: true }); // claim and leave the queue in one step, for --queue
    // Recorded inside the claim's synchronous locked step, with the capacity it read: one per claim.
    if (slots > 1) {
      log(`ship: this machine runs up to ${slots} ships at once (${join(root, 'config.json')})`);
      onCapacity?.(slots);
    }
    return free;
  });
  if (!dir) return undefined;
  const release = () => unlessContended(() => releaseSlot(root, holder.token));
  process.once('exit', release);
  return { token: holder.token, slotDir: dir, release };
}

const WAIT_SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/** Wait for the machine-wide slot in arrival order. Prints one line per change in position. */
export async function acquireShipSlot(options: AcquireOptions): Promise<SlotHandle> {
  const root = options.root ?? queueRoot();
  const probe = options.probe ?? DEFAULT_PROBE;
  const log = options.log ?? ((line: string) => console.error(line));
  ensureRoot(root);
  const { ticket, path: ticketPath } = enqueue(root, {
    pid: process.pid,
    identity: processStartIdentity(),
    repo: options.repo,
    branch: options.branch,
    mode: options.mode,
    startedAt: Date.now(),
  });
  const dropTicket = () => rmSync(ticketPath, { force: true });
  const handlers = Object.entries(WAIT_SIGNALS).map(([signal, status]) => {
    const handler = () => {
      dropTicket();
      process.exit(status);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  process.once('exit', dropTicket);
  let announced = '';
  try {
    for (;;) {
      readSlotCount(root, log); // surfaces an invalid config to a waiting ship, once per content
      unlessContended(() => reapSlotIfDead(root, probe));
      const ahead = liveTickets(root, probe).filter(
        (other) => other.seq < ticket.seq || (other.seq === ticket.seq && other.pid < ticket.pid),
      );
      if (ahead.length === 0) {
        const handle = unlessContended(() =>
          claimSlot(root, ticket, ticketPath, probe, log, options.onCapacity),
        );
        if (handle) return handle;
      }
      const running = readHolders(root).flatMap((entry) => (entry.holder ? [entry.holder] : []));
      const state = `${ahead.length}:${running.map((h) => h.token).join(',')}`;
      if (state !== announced) {
        announced = state;
        log(
          `ship: queued — position ${ahead.length + 1}, waiting behind ${describe(running, Date.now())}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS));
    }
  } finally {
    // Leave the queue at ACQUIRE, not at exit: a ship that later releases early (before --wait-ci)
    // must not linger as a waiter.
    dropTicket();
    process.removeListener('exit', dropTicket);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}
