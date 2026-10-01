/** Before its first gate, `devkit ship` joins the machine-wide slot: as the acquirer, or as a guest
 * under an ancestor ship. There is no unqueued path. */
import { join } from 'node:path';
import { emitGateEvent } from '../../../../gate-engine/judge/gate-events.mts';
import { processStartIdentity } from '../../../../gate-engine/judge/process/identity.mts';
import { type ProcessRecord, readProcessTable } from '../review/process/process-table.mts';
import {
  acquireShipSlot,
  DEFAULT_PROBE,
  ensureRoot,
  holderAlive,
  type QueueProbe,
  queueRoot,
  findHolder,
  SLOT_ENV,
  type SlotHandle,
  setGuest,
  withSlotLock,
  writeGuestLocked,
} from './ship-queue.mts';

export { SLOT_ENV };

/** Retired: neither skips nor redirects the queue any more (see ship-machine-wide-queue). */
export const RETIRED_ENVS = ['DEVKIT_SHIP_NO_QUEUE', 'DEVKIT_SHIP_QUEUE_DIR'] as const;
export const SLOT_DIR_ENV = 'DEVKIT_SHIP_SLOT_DIR';
/** Set only by the acquirer: tells its bash that IT may release the slot before --wait-ci. */
export const SLOT_RELEASE_ENV = 'DEVKIT_SHIP_SLOT_RELEASE';

export interface EnteredQueue {
  env: Record<string, string>;
  handle?: SlotHandle;
}

export interface EnterOptions {
  env: NodeJS.ProcessEnv;
  /** Tests only; production always uses queueRoot(). */
  root?: string;
  repo: string;
  branch: string;
  mode: string;
  probe?: QueueProbe;
  processTable?: () => Map<number, ProcessRecord>;
  acquire?: typeof acquireShipSlot;
  pollMs?: number;
  log?: (line: string) => void;
}

/** An inherited token counts only while its holder lives and is an ancestor (by pid or group), so a
 * token leaked into an unrelated shell is never a silent bypass. Joins as a guest in the same lock. */
export function joinAncestorSlot(
  token: string,
  root: string,
  probe: QueueProbe,
  table: () => Map<number, ProcessRecord>,
): boolean {
  let processes: Map<number, ProcessRecord>;
  try {
    processes = table();
    return withSlotLock(root, () => {
      if (!isAncestorHolder(token, root, probe, processes)) return false;
      return writeGuestLocked(root, token, { pid: process.pid, identity: processStartIdentity() });
    });
  } catch {
    return false;
  }
}

function isAncestorHolder(
  token: string,
  root: string,
  probe: QueueProbe,
  processes: Map<number, ProcessRecord>,
): boolean {
  const holder = findHolder(root, token)?.holder;
  if (!holder || !holderAlive(holder, probe)) return false;
  const seen = new Set<number>();
  let pid = process.pid;
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const record = processes.get(pid);
    if (!record) return false;
    // The holder itself is never "nested". Its group is its detached bash tree, so every member —
    // this process included, when a gate spawned it there — is a descendant of the holder.
    if (pid === holder.pid) return pid !== process.pid;
    if (holder.pgid !== undefined && record.groupId === holder.pgid) return true;
    pid = record.parentPid;
  }
  return false;
}

export async function enterShipQueue(options: EnterOptions): Promise<EnteredQueue> {
  const log = options.log ?? ((line: string) => console.error(line));
  const probe = options.probe ?? DEFAULT_PROBE;
  const root = options.root ?? queueRoot();
  for (const name of RETIRED_ENVS) {
    if (options.env[name] !== undefined) {
      log(`ship: ${name} no longer exists and is ignored; this ship queues.`);
    }
  }
  const inherited = options.env[SLOT_ENV];
  if (inherited) {
    if (joinAncestorSlot(inherited, root, probe, options.processTable ?? readProcessTable)) {
      // Running under the enclosing ship's slot as a guest; the slot stays held until we leave.
      const guest = { pid: process.pid, identity: processStartIdentity() };
      const leave = () => {
        try {
          setGuest(root, inherited, guest, true);
        } catch {
          // a dead guest is pruned by liveness anyway
        }
      };
      process.once('exit', leave);
      const slotDir = findHolder(root, inherited)?.dir ?? join(root, 'slot');
      return {
        env: { [SLOT_RELEASE_ENV]: '' },
        handle: { token: inherited, slotDir, release: leave },
      };
    }
    log(`ship: ignoring a stale ${SLOT_ENV} (its holder is gone or is not an ancestor); queueing.`);
  }
  // No unqueued path exists: an uncreatable root stops the ship (a sandbox must grant the write).
  try {
    ensureRoot(root);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    emitGateEvent({
      type: 'gate_result',
      gate: 'ship-queue',
      status: 'could_not_run',
      detail: `ship-queue(unavailable:${message})`,
    });
    throw new Error(
      `cannot create the queue at ${root} (${message}); run ship where it can write there, or grant that path`,
    );
  }
  const handle = await (options.acquire ?? acquireShipSlot)({
    repo: options.repo,
    branch: options.branch,
    mode: options.mode,
    root,
    probe,
    pollMs: options.pollMs,
    log,
    // A capacity above one is the owner's call, but it must stay countable after the fact.
    onCapacity: (slots) =>
      emitGateEvent({
        type: 'gate_result',
        gate: 'ship-queue',
        status: 'pass',
        detail: `ship-queue(slots:${slots})`,
      }),
  });
  return {
    handle,
    env: { [SLOT_ENV]: handle.token, [SLOT_DIR_ENV]: handle.slotDir, [SLOT_RELEASE_ENV]: '1' },
  };
}
