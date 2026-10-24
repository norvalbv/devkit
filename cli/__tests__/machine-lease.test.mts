import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireLease,
  claimStart,
  findLease,
  IDLE_MS,
  type Lease,
  listLeases,
  PORT_BASE,
  PORTS_PER_SLOT,
  releaseLease,
  slotCap,
  slotDir,
  updateLease,
} from '../lib/machine/lease.mts';

const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pool() {
  const root = join(temp('machines-'), 'machines');
  const killed: number[] = [];
  return { root, killed, kill: (lease: Lease) => void (lease.pgid && killed.push(lease.pgid)) };
}

describe('machine leases', () => {
  it('gives two worktrees distinct slots and port blocks, and the same worktree its own again', () => {
    const { root, kill } = pool();
    const [a, b] = [temp('wt-a-'), temp('wt-b-')];
    const first = acquireLease(a, { root, kill });
    const second = acquireLease(b, { root, kill });
    expect(first).toMatchObject({ fresh: true, lease: { slot: 0, port: PORT_BASE } });
    expect(second).toMatchObject({
      fresh: true,
      lease: { slot: 1, port: PORT_BASE + PORTS_PER_SLOT },
    });
    expect(slotDir(root, 0)).not.toBe(slotDir(root, 1));
    expect(acquireLease(a, { root, kill })).toMatchObject({ fresh: false, lease: { slot: 0 } });
    expect(listLeases(root)).toHaveLength(2);
  });

  it('reaps a lease whose worktree is gone, killing its process group', () => {
    const { root, killed, kill } = pool();
    const gone = temp('wt-gone-');
    const { lease } = acquireLease(gone, { root, kill });
    updateLease(root, lease, { pgid: 4242 });
    rmSync(gone, { recursive: true, force: true });
    const next = acquireLease(temp('wt-next-'), { root, kill });
    expect(killed).toEqual([4242]);
    expect(next.lease.slot).toBe(0);
    expect(findLease(root, gone)).toBeUndefined();
  });

  it('refuses a new worktree at the cap and names the worktrees holding the slots', () => {
    const { root, kill } = pool();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), '{"slots": 1}');
    const holder = temp('wt-holder-');
    acquireLease(holder, { root, kill });
    expect(() => acquireLease(temp('wt-late-'), { root, kill })).toThrow(holder);
  });

  it('reaps a lease idle past IDLE_MS on the next up, even with slots free', () => {
    const { root, killed, kill } = pool();
    const then = Date.now();
    const idle = acquireLease(temp('wt-idle-'), { root, kill, now: then });
    const busy = acquireLease(temp('wt-busy-'), { root, kill, now: then });
    updateLease(root, idle.lease, { pgid: 77, touchedAt: then - IDLE_MS - 1 });
    updateLease(root, busy.lease, { pgid: 88 });
    acquireLease(temp('wt-third-'), { root, kill });
    expect(killed).toEqual([77]);
    expect(findLease(root, idle.lease.worktree)).toBeUndefined();
    expect(findLease(root, busy.lease.worktree)).toMatchObject({ pgid: 88 });
  });

  it("lets an idle worktree's own up keep its lease", () => {
    const { root, killed, kill } = pool();
    const worktree = temp('wt-back-');
    const { lease } = acquireLease(worktree, { root, kill });
    updateLease(root, lease, { pgid: 5, touchedAt: Date.now() - IDLE_MS - 1 });
    expect(acquireLease(worktree, { root, kill })).toMatchObject({
      fresh: false,
      lease: { id: lease.id },
    });
    expect(killed).toEqual([]);
  });

  it('treats an unreadable holder file as a free slot', () => {
    const { root, kill } = pool();
    mkdirSync(slotDir(root, 0), { recursive: true });
    writeFileSync(join(slotDir(root, 0), 'holder.json'), '{not json');
    expect(acquireLease(temp('wt-'), { root, kill }).lease.slot).toBe(0);
  });

  it('reads the owner cap from config.json and falls back to 3 on anything invalid', () => {
    const { root } = pool();
    mkdirSync(root, { recursive: true });
    expect(slotCap(root)).toBe(3);
    writeFileSync(join(root, 'config.json'), '{"slots": 99}');
    expect(slotCap(root)).toBe(3);
    writeFileSync(join(root, 'config.json'), '{"slots": 5}');
    expect(slotCap(root)).toBe(5);
  });

  it('keeps the keys another devkit version wrote when it rewrites a lease', () => {
    const { root, kill } = pool();
    const { lease } = acquireLease(temp('wt-'), { root, kill });
    const holder = join(slotDir(root, lease.slot), 'holder.json');
    const box = { name: 'b', view: 1, cdp: 2, password: 'p', future: 1 };
    writeFileSync(holder, JSON.stringify({ ...lease, box, future: { kept: true } }));
    expect(findLease(root, lease.worktree)).toMatchObject({ id: lease.id });
    updateLease(root, lease, { pgid: 5 });
    expect(JSON.parse(readFileSync(holder, 'utf8'))).toMatchObject({
      pgid: 5,
      box,
      future: { kept: true },
    });
  });

  it('keeps a released slot released when a late update arrives', async () => {
    const { root, kill } = pool();
    const { lease } = acquireLease(temp('wt-'), { root, kill });
    await releaseLease(root, lease, () => undefined);
    expect(updateLease(root, lease, { pgid: 1 })).toBeNull();
    expect(existsSync(slotDir(root, lease.slot))).toBe(false);
  });

  it('lets one `up` start a slot at a time, and reports an app that already runs', async () => {
    const { root, kill } = pool();
    const { lease } = acquireLease(temp('wt-'), { root, kill });
    const none = () => false;
    expect(claimStart(root, lease, none)).toBe('claimed');
    expect(claimStart(root, lease, none)).toBe('busy');
    updateLease(root, lease, { pgid: 99, starter: null });
    expect(claimStart(root, lease, () => true)).toBe('running');
    await releaseLease(root, lease, () => undefined);
    expect(claimStart(root, lease, none)).toBe('released');
  });

  it("holds a slot until down's stop returns, so neither this worktree nor another reuses it", async () => {
    const { root, kill } = pool();
    const { lease } = acquireLease(temp('wt-a-'), { root, kill });
    writeFileSync(join(root, 'config.json'), '{"slots": 1}');
    const other = temp('wt-b-');
    expect(claimStart(root, lease, () => false)).toBe('claimed');
    expect(await releaseLease(root, lease, () => undefined)).toBe('busy');
    updateLease(root, lease, { starter: null });
    const freed = await releaseLease(root, lease, () => {
      expect(claimStart(root, lease, () => false)).toBe('busy');
      expect(() => acquireLease(other, { root, kill })).toThrow('machine slots are in use');
    });
    expect(freed).toBe('freed');
    expect(acquireLease(other, { root, kill }).lease.slot).toBe(lease.slot);
  });

  it('makes a second `up` wait while a live one is starting the slot, even if it looks up', () => {
    const { root, kill } = pool();
    const { lease } = acquireLease(temp('wt-'), { root, kill });
    expect(claimStart(root, lease, () => false)).toBe('claimed');
    expect(claimStart(root, lease, () => true)).toBe('busy');
  });

  it('takes over the start claim of an `up` that died', () => {
    const { root, kill } = pool();
    const { lease } = acquireLease(temp('wt-'), { root, kill });
    updateLease(root, lease, { starter: { pid: 4_000_000, identity: 'ps:gone' } });
    expect(claimStart(root, lease, () => false)).toBe('claimed');
  });

  it('never writes onto a later lease of the same slot, from another worktree or this one', async () => {
    const { root, kill } = pool();
    const worktree = temp('wt-');
    const first = acquireLease(worktree, { root, kill }).lease;
    updateLease(root, first, { pgid: 31 });
    const stopped: number[] = [];
    await releaseLease(root, first, ({ pgid }) => void stopped.push(pgid ?? 0));
    expect(stopped).toEqual([31]);
    const second = acquireLease(temp('wt-other-'), { root, kill }).lease;
    expect(second.slot).toBe(first.slot);
    expect(updateLease(root, first, { pgid: 1 })).toBeNull();
    expect(claimStart(root, first, () => false)).toBe('released');
    await releaseLease(root, first, () => void stopped.push(0));
    expect(stopped).toEqual([31]);
    expect(findLease(root, second.worktree)).toMatchObject({ id: second.id, pgid: null });
  });
});
