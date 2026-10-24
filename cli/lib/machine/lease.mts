/** Machine slots: one per worktree under the passwd home, so no two agents share a port block,
 * browser profile or app-data dir. Every mutation runs under one machine-wide process lock. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  processOwnerIsProvablyGone,
  processStartIdentity,
} from '../../../gate-engine/judge/process/identity.mts';
import { withProcessLock } from '../../../gate-engine/judge/process/process-lock.mts';
import { writeFileAtomic } from '../atomic-write.mts';

export const PORT_BASE = 40_000;
export const PORTS_PER_SLOT = 10;
const DEFAULT_SLOTS = 3;
const MAX_SLOTS = 8;
/** A lease no `devkit machine` command has touched for this long is reaped by the next `up`. */
export const IDLE_MS = 30 * 60 * 1000;

// Loose, so a lease rewritten here keeps the keys another devkit version on this Mac wrote.
const leaseSchema = z.looseObject({
  id: z.string().min(1),
  slot: z.number().int().nonnegative(),
  worktree: z.string().min(1),
  port: z.number().int().positive(),
  pgid: z.number().int().positive().nullable(),
  identity: z.string().nullable(),
  seeded: z.boolean(),
  starter: z.looseObject({ pid: z.number().int().positive(), identity: z.string() }).nullable(),
  /** Full mode's container and the host ports of its live view and DevTools. */
  box: z
    .looseObject({
      name: z.string().min(1),
      view: z.number().int(),
      cdp: z.number().int(),
      password: z.string(),
    })
    .nullable()
    .default(null),
  touchedAt: z.number(),
});
export type Lease = z.infer<typeof leaseSchema>;

/** One acquisition of a slot: its number plus the id minted then, so a write can never land on a
 * later lease of the same slot (by another worktree, or this one after a `down`). */
export type LeaseRef = Pick<Lease, 'slot' | 'id'>;

const configSchema = z.object({ slots: z.number().int().min(1).max(MAX_SLOTS) });

/** The machine-wide root, from the passwd entry: $HOME must not hand an agent a private pool. */
export function machinesRoot(home: string = userInfo().homedir): string {
  return join(home, '.devkit', 'machines');
}

/** Every mutation of the slot pool runs under this one machine-wide lock. */
const withSlotsLock = <T,>(root: string, fn: () => T): T =>
  withProcessLock(join(root, 'lock'), fn, { label: 'machine slots' });

export const slotDir = (root: string, slot: number): string => join(root, `slot-${slot}`);
const holderFile = (root: string, slot: number) => join(slotDir(root, slot), 'holder.json');

/** The owner's cap from `<root>/config.json` {"slots": N}; anything else is the default. */
export function slotCap(root: string): number {
  try {
    return configSchema.parse(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).slots;
  } catch {
    return DEFAULT_SLOTS;
  }
}

function readLease(root: string, slot: number): Lease | null {
  try {
    return leaseSchema.parse(JSON.parse(readFileSync(holderFile(root, slot), 'utf8')));
  } catch {
    return null;
  }
}

/** Every slot directory: its lease, or null when the holder file is missing or unreadable. */
function slots(root: string): { slot: number; lease: Lease | null }[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => /^slot-(\d+)$/.exec(name)?.[1])
    .filter((n) => n !== undefined)
    .map((n) => ({ slot: Number(n), lease: readLease(root, Number(n)) }));
}

export function listLeases(root: string): Lease[] {
  return slots(root).flatMap(({ lease }) => (lease ? [lease] : []));
}

export function findLease(root: string, worktree: string): Lease | undefined {
  return listLeases(root).find((lease) => lease.worktree === worktree);
}

// Atomic, because status, run and down read holder files without the lock.
const writeLease = (root: string, lease: Lease) =>
  writeFileAtomic(holderFile(root, lease.slot), `${JSON.stringify(lease, null, 2)}\n`);

/** Stops what a lease started: its app group and its box. */
export type KillLease = (lease: Lease) => void;

/** Stop a lease's processes (by the caller's `kill`) and delete its slot directory. */
function reap(root: string, slot: number, lease: Lease | null, kill: KillLease) {
  if (lease) kill(lease);
  rmSync(slotDir(root, slot), { recursive: true, force: true });
}

export interface LeaseOptions {
  root: string;
  kill: KillLease;
  now?: number;
}

/** The live leases left once abandoned ones (worktree gone, unreadable, idle past IDLE_MS) are
 * reaped, so a forgotten machine is freed by the next `up` anywhere. */
function reclaim(root: string, now: number, kill: KillLease): Lease[] {
  for (const { slot, lease } of slots(root))
    if (!lease || !existsSync(lease.worktree) || now - lease.touchedAt > IDLE_MS)
      reap(root, slot, lease, kill);
  return listLeases(root);
}

const lowestFree = (live: Lease[]): number => {
  const taken = new Set(live.map((lease) => lease.slot));
  let slot = 0;
  while (taken.has(slot)) slot++;
  return slot;
};

function fullError(root: string, cap: number, live: Lease[]): Error {
  const held = live.map((lease) => `slot ${lease.slot}: ${lease.worktree}`).join('; ');
  const remedy = `run \`devkit machine down\` in one of those worktrees, or raise "slots" in ${join(root, 'config.json')}`;
  return new Error(`all ${cap} machine slots are in use (${held}); ${remedy}`);
}

/** This worktree's lease, reusing its own or taking the lowest free slot. Throws when every slot is
 * held by a live, recently used worktree. */
export function acquireLease(worktree: string, { root, kill, now = Date.now() }: LeaseOptions) {
  mkdirSync(root, { recursive: true });
  return withSlotsLock(root, () => {
    const own = findLease(root, worktree);
    if (own) {
      const lease = { ...own, touchedAt: now };
      writeLease(root, lease);
      return { lease, fresh: false };
    }
    const cap = slotCap(root);
    const live = reclaim(root, now, kill);
    if (live.length >= cap) throw fullError(root, cap, live);
    const slot = lowestFree(live);
    mkdirSync(slotDir(root, slot), { recursive: true });
    const port = PORT_BASE + slot * PORTS_PER_SLOT;
    const blank = { pgid: null, identity: null, seeded: false, starter: null, box: null };
    const lease: Lease = { id: randomUUID(), slot, worktree, port, ...blank, touchedAt: now };
    writeLease(root, lease);
    return { lease, fresh: true };
  });
}

/** The slot's lease if it is still `ref`'s acquisition, else null. */
function readOwn(root: string, ref: LeaseRef): Lease | null {
  const lease = readLease(root, ref.slot);
  return lease?.id === ref.id ? lease : null;
}

type LeasePatch = Partial<Omit<Lease, 'id' | 'slot' | 'worktree'>>;

/** Rewrite `ref`'s lease under the lock; null when it was released (or re-leased) meanwhile. */
export function updateLease(root: string, ref: LeaseRef, patch: LeasePatch): Lease | null {
  return withSlotsLock(root, () => {
    const lease = readOwn(root, ref);
    if (!lease) return null;
    const next = { ...lease, touchedAt: Date.now(), ...patch };
    writeLease(root, next);
    return next;
  });
}

/** What `up` may do with a slot: start it, or not, because it runs, another `up` is starting it, or
 * the slot was released meanwhile. */
export type StartClaim = 'claimed' | 'running' | 'busy' | 'released';

/** Under the lock, claim the right to start this slot's app and box. A starter that died is taken
 * over. */
export function claimStart(
  root: string,
  ref: LeaseRef,
  running: (lease: Lease) => boolean,
): StartClaim {
  return withSlotsLock(root, () => {
    const lease = readOwn(root, ref);
    if (!lease) return 'released';
    // A live starter comes first: what it is starting may already look up while it is not ready.
    const { starter } = lease;
    if (
      starter &&
      !processOwnerIsProvablyGone({ pid: starter.pid, processStart: starter.identity })
    )
      return 'busy';
    if (running(lease)) return 'running';
    const me = { pid: process.pid, identity: processStartIdentity() };
    writeLease(root, { ...lease, starter: me, touchedAt: Date.now() });
    return 'claimed';
  });
}

/** Under the lock, swap `staging` in as the slot's `data` and mark the lease seeded, only while
 * `ref` still holds the slot: false, with nothing moved, once it was released or re-leased. */
export function publishSeed(root: string, ref: LeaseRef, staging: string, data: string): boolean {
  return withSlotsLock(root, () => {
    const lease = readOwn(root, ref);
    if (!lease) return false;
    rmSync(data, { recursive: true, force: true });
    renameSync(staging, data);
    writeLease(root, { ...lease, seeded: true, touchedAt: Date.now() });
    return true;
  });
}

/** Stop `ref`'s app with `stop`, then free its slot. Claimed until then, so no other `up` reuses the
 * slot's data mid-stop; 'busy' while an `up` starts it. A slot re-leased meanwhile is left alone. */
export async function releaseLease(
  root: string,
  ref: LeaseRef,
  stop: (lease: Lease) => Promise<void> | void,
): Promise<'freed' | 'busy'> {
  if (claimStart(root, ref, () => false) === 'busy') return 'busy';
  const held = readOwn(root, ref);
  if (held) await stop(held);
  withSlotsLock(root, () => {
    if (readOwn(root, ref)) rmSync(slotDir(root, ref.slot), { recursive: true, force: true });
  });
  return 'freed';
}

/** macOS memory pressure: 1 normal, 2 warn, 4 critical; any other host reads as normal. */
export function memoryPressure(): number {
  if (process.platform !== 'darwin') return 1;
  try {
    const level = Number(
      execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' }),
    );
    return Number.isInteger(level) ? level : 1;
  } catch {
    return 1;
  }
}
