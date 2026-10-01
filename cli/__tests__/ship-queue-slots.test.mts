import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { psProcessStart } from '../../gate-engine/judge/process/identity.mts';
import { enterShipQueue } from '../lib/ship/queue/enter.mts';
import {
  acquireShipSlot,
  enqueue,
  ensureRoot,
  findHolder,
  type QueueProbe,
  readHolder,
  registerGroup,
  releaseSlot,
  type SlotHolder,
} from '../lib/ship/queue/ship-queue.mts';
import { MAX_SLOTS, readSlotCount, slotDirs } from '../lib/ship/queue/slots.mts';
import { formatShipQueue, readShipQueue } from '../lib/ship/queue/status.mts';

const HOLDER = fileURLToPath(new URL('./_ship-queue-holder.mts', import.meta.url));

const temps: string[] = [];
const children: ChildProcess[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ship-slots-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const probe = (alive: number[]): QueueProbe => ({
  ownerGone: (pid) => !alive.includes(pid),
  groupAlive: () => false,
});

function holder(overrides: Partial<SlotHolder> = {}): SlotHolder {
  return {
    seq: 1,
    pid: 111,
    identity: 'ps:x',
    repo: '/repo',
    branch: 'feat/a',
    mode: 'ship-branch',
    startedAt: Date.now(),
    token: 'tok-a',
    ...overrides,
  };
}

function seatHolderAt(root: string, name: string, h: SlotHolder): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'holder.json'), JSON.stringify(h));
}

const setSlots = (root: string, text: string) => writeFileSync(join(root, 'config.json'), text);

const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];

async function until(predicate: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('slot count config', () => {
  it('defaults to one ship when there is no config file', () => {
    expect(readSlotCount(tempRoot())).toBe(1);
  });

  it.each([
    ['{"slots":2}', 2],
    [`{"slots":${MAX_SLOTS}}`, MAX_SLOTS],
  ])('reads %s as %d', (text, expected) => {
    const root = tempRoot();
    setSlots(root, text);
    expect(readSlotCount(root)).toBe(expected);
  });

  it.each([
    '{"slots":0}',
    `{"slots":${MAX_SLOTS + 1}}`,
    '{"slots":1.5}',
    '{"slots":"2"}',
    '{"slots":-1}',
    '{torn',
    '{}',
    '{"slot":2}',
    '{"slots":2,"extra":true}',
    '[2]',
    'null',
  ])('falls back to one ship for %s, warning once per distinct content', (text) => {
    const root = tempRoot();
    setSlots(root, text);
    const warned: string[] = [];
    expect(readSlotCount(root, (line) => warned.push(line))).toBe(1);
    expect(readSlotCount(root, (line) => warned.push(line))).toBe(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`must be a whole number 1..${MAX_SLOTS}`);
  });
});

describe('slot count config edge cases', () => {
  it('does not let a silent read swallow the warning a later ship should print', () => {
    const root = tempRoot();
    setSlots(root, '{"slots":"silent-first"}');
    expect(readSlotCount(root)).toBe(1); // e.g. `devkit ship --queue`, which never warns
    const warned: string[] = [];
    readSlotCount(root, (line) => warned.push(line));
    expect(warned).toHaveLength(1);
  });

  it('warns once for each distinct invalid content, even when contents alternate', () => {
    const root = tempRoot();
    const warned: string[] = [];
    for (const text of ['{"slots":"x1"}', '{"slots":"x2"}', '{"slots":"x1"}', '{"slots":"x2"}']) {
      setSlots(root, text);
      readSlotCount(root, (line) => warned.push(line));
    }
    expect(warned).toHaveLength(2);
  });

  it('ignores a stray regular file or symlink named like a slot', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'slot'), 'not a claim');
    symlinkSync(tempRoot(), join(root, 'slot-1'));
    mkdirSync(join(root, 'slot-2'));
    expect(slotDirs(root)).toEqual([join(root, 'slot-2')]);
  });

  it('claims through a stray file at the only slot name instead of waiting forever', async () => {
    const root = tempRoot();
    ensureRoot(root);
    writeFileSync(join(root, 'slot'), 'not a claim');
    const handle = await acquireShipSlot({
      repo: '/r',
      branch: 'b',
      mode: 't',
      root,
      pollMs: 10,
      log: () => undefined,
    });
    expect(handle.slotDir).toBe(join(root, 'slot'));
    expect(readHolder(join(root, 'slot'))?.token).toBe(handle.token);
    handle.release();
  });
});

describe('two slots across real processes', () => {
  it('runs two ships at once, holds the third, and starts it when one finishes', async () => {
    const root = tempRoot();
    ensureRoot(root);
    setSlots(root, '{"slots":2}');
    const out = join(root, 'out');
    const run = (label: string, ms: string) => {
      const child = spawn(process.execPath, [HOLDER, root, label, out, 'hold', ms], {
        stdio: 'ignore',
      });
      children.push(child);
      return child;
    };
    // a and b hold until killed, so no scheduler delay can end one before the other starts.
    const a = run('a', '600000');
    await until(() => lines(out).some((l) => l.startsWith('start a')));
    run('b', '600000');
    await until(() => lines(out).some((l) => l.startsWith('start b')));
    run('c', '10');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(lines(out).some((l) => l.startsWith('start c'))).toBe(false);

    a.kill('SIGKILL'); // its slot is reaped as dead, and c takes it
    await until(() => lines(out).some((l) => l.startsWith('start c')));
  }, 30_000);
});

describe('claiming with several slots', () => {
  const fields = (pid: number) => ({
    pid,
    identity: 'ps:x',
    repo: '/r',
    branch: `b${pid}`,
    mode: 't',
    startedAt: 0,
  });

  it('counts a legacy `slot` holder and claims the next index', async () => {
    const root = tempRoot();
    ensureRoot(root);
    setSlots(root, '{"slots":2}');
    seatHolderAt(root, 'slot', holder({ pid: 111 }));
    const handle = await acquireShipSlot({
      repo: '/r',
      branch: 'b',
      mode: 't',
      root,
      probe: probe([111, process.pid]),
      pollMs: 10,
      log: () => undefined,
    });
    expect(handle.slotDir).toBe(join(root, 'slot-1'));
    handle.release();
  });

  it('never lets a later ticket take a free slot while an earlier one is still waiting', async () => {
    const root = tempRoot();
    ensureRoot(root);
    setSlots(root, '{"slots":2}');
    // An earlier waiter (seq 1) that is genuinely alive, so enqueue's real liveness pass keeps it.
    const parentIdentity = `ps:${psProcessStart(process.ppid)}`;
    enqueue(root, { ...fields(process.ppid), identity: parentIdentity });
    const alive = [process.ppid, process.pid];
    const logged: string[] = [];
    let claimed = false;
    const pending = acquireShipSlot({
      repo: '/r',
      branch: 'late',
      mode: 't',
      root,
      probe: { ownerGone: (pid) => !alive.includes(pid), groupAlive: () => false },
      pollMs: 10,
      log: (line) => logged.push(line),
    }).then((handle) => {
      claimed = true;
      return handle;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(claimed).toBe(false); // two free slots, but seq 1 is ahead
    alive.shift(); // the earlier waiter dies
    const handle = await pending;
    expect(handle.slotDir).toBe(join(root, 'slot'));
    expect(logged.join('\n')).toContain('runs up to 2 ships at once');
    handle.release();
  });

  it('claims nothing after a shrink until the occupied count drops below the new limit', async () => {
    const root = tempRoot();
    ensureRoot(root);
    setSlots(root, '{"slots":1}');
    seatHolderAt(root, 'slot', holder({ pid: 111, token: 'a' }));
    seatHolderAt(root, 'slot-1', holder({ pid: 112, token: 'b' }));
    const alive = [111, 112, process.pid];
    let claimed = false;
    const pending = acquireShipSlot({
      repo: '/r',
      branch: 'c',
      mode: 't',
      root,
      probe: { ownerGone: (pid) => !alive.includes(pid), groupAlive: () => false },
      pollMs: 10,
      log: () => undefined,
    }).then((handle) => {
      claimed = true;
      return handle;
    });
    alive.splice(alive.indexOf(111), 1); // one of two holders dies: 1 occupied, limit 1
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(claimed).toBe(false);
    alive.splice(alive.indexOf(112), 1);
    const handle = await pending;
    expect(handle.slotDir).toBe(join(root, 'slot'));
    handle.release();
  });

  it('applies a capacity change to a ship that is already waiting', async () => {
    const root = tempRoot();
    ensureRoot(root);
    setSlots(root, '{"slots":1}');
    seatHolderAt(root, 'slot', holder({ pid: 111 }));
    let claimed = false;
    const pending = acquireShipSlot({
      repo: '/r',
      branch: 'c',
      mode: 't',
      root,
      probe: probe([111, process.pid]),
      pollMs: 10,
      log: () => undefined,
    }).then((handle) => {
      claimed = true;
      return handle;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(claimed).toBe(false); // limit 1, one running
    setSlots(root, '{"slots":2}'); // the owner raises capacity while it waits
    const handle = await pending;
    expect(handle.slotDir).toBe(join(root, 'slot-1'));
    handle.release();
  });

  it('warns once about an invalid config even though both the poll and the claim read it', async () => {
    const root = tempRoot();
    ensureRoot(root);
    setSlots(root, '{"slots":"read-twice"}');
    const logged: string[] = [];
    const handle = await acquireShipSlot({
      repo: '/r',
      branch: 'b',
      mode: 't',
      root,
      pollMs: 10,
      log: (line) => logged.push(line),
    });
    expect(handle.slotDir).toBe(join(root, 'slot'));
    expect(logged.filter((line) => line.includes('must be a whole number'))).toHaveLength(1);
    handle.release();
  });

  it('records the capacity it claimed under, once, when above one', async () => {
    const root = tempRoot();
    ensureRoot(root);
    setSlots(root, '{"slots":3}');
    const noted: number[] = [];
    const handle = await acquireShipSlot({
      repo: '/r',
      branch: 'b',
      mode: 't',
      root,
      pollMs: 10,
      log: () => undefined,
      onCapacity: (slots) => noted.push(slots),
    });
    expect(noted).toEqual([3]);
    handle.release();
  });
});

describe('token-addressed operations in any slot', () => {
  it('registers, notes and releases a holder that lives in slot-1', () => {
    const root = tempRoot();
    seatHolderAt(root, 'slot', holder({ token: 'other', pid: 111 }));
    seatHolderAt(root, 'slot-1', holder({ token: 'mine', pid: 222 }));
    expect(findHolder(root, 'mine')?.dir).toBe(join(root, 'slot-1'));
    expect(registerGroup(root, 'mine', 4242)).toBe(true);
    expect(readHolder(join(root, 'slot-1'))?.pgid).toBe(4242);
    expect(readHolder(join(root, 'slot'))?.pgid).toBeUndefined();
    expect(releaseSlot(root, 'mine', { probe: probe([]), handOff: true })).toBe('released');
    expect(slotDirs(root)).toEqual([join(root, 'slot')]);
  });

  it('gives a nested ship under a slot-1 holder that slot, not the legacy one', async () => {
    const root = tempRoot();
    seatHolderAt(root, 'slot-1', holder({ pid: process.ppid, token: 'outer' }));
    const entered = await enterShipQueue({
      env: { DEVKIT_SHIP_SLOT: 'outer' },
      root,
      repo: '/r',
      branch: 'b',
      mode: 't',
      probe: probe([process.ppid]),
      acquire: async () => {
        throw new Error('a nested ship must not queue behind its ancestor');
      },
      log: () => undefined,
    });
    expect(entered.handle?.slotDir).toBe(join(root, 'slot-1'));
    expect(readHolder(join(root, 'slot-1'))?.guests?.map((g) => g.pid)).toEqual([process.pid]);
    entered.handle?.release();
  });
});

describe('status with several slots', () => {
  it('lists every running ship oldest first, with occupied/configured slots', () => {
    const root = tempRoot();
    setSlots(root, '{"slots":2}');
    seatHolderAt(root, 'slot-1', holder({ pid: 222, branch: 'feat/new', startedAt: 2_000 }));
    seatHolderAt(root, 'slot', holder({ pid: 111, branch: 'feat/old', startedAt: 1_000 }));
    const view = readShipQueue(root, probe([111, 222]));
    expect(view.running.map((h) => h.branch)).toEqual(['feat/old', 'feat/new']);
    expect(view).toMatchObject({ slots: 2, occupied: 2 });
    const text = formatShipQueue(view, 3_000);
    expect(text.split('\n')[0]).toBe('slots: 2/2 in use');
    expect(text.indexOf('feat/old')).toBeLessThan(text.indexOf('feat/new'));
  });
});
