import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { processStartIdentity } from '../../gate-engine/judge/process/identity.mts';
import { enterShipQueue, joinAncestorSlot } from '../lib/ship/queue/enter.mts';
import {
  acquireShipSlot,
  ensureRoot,
  queueRoot,
  liveTickets,
  enqueue,
  type QueueProbe,
  holderAlive,
  readHolder,
  reapSlotIfDead,
  releaseSlot,
  registerGroup,
  retryBudgetMs,
  type SlotHolder,
} from '../lib/ship/queue/ship-queue.mts';
import {
  LockHeldError,
  reapIfDead,
  withProcessLock,
} from '../../gate-engine/judge/process/process-lock.mts';
import { currentGate, formatShipQueue, readShipQueue } from '../lib/ship/queue/status.mts';

const HOLDER = fileURLToPath(new URL('./_ship-queue-holder.mts', import.meta.url));
const ARGS_SH = fileURLToPath(new URL('../lib/ship/wait-ci/args.sh', import.meta.url));
const SLOT_SH = fileURLToPath(new URL('../lib/ship/queue/slot.sh', import.meta.url));

const temps: string[] = [];
const children: ChildProcess[] = [];
const groups: number[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ship-queue-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A probe where exactly the listed pids (and groups) are alive. */
function probe(alive: number[], aliveGroups: number[] = []): QueueProbe {
  return {
    ownerGone: (pid) => !alive.includes(pid),
    groupAlive: (pgid) => aliveGroups.includes(pgid),
  };
}

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

function seatHolder(root: string, h: SlotHolder): void {
  mkdirSync(join(root, 'slot'), { recursive: true });
  writeFileSync(join(root, 'slot', 'holder.json'), JSON.stringify(h));
}

function seatTicket(
  root: string,
  seq: number,
  pid: number,
  identity = 'ps:x',
  branch = `b${seq}`,
): void {
  mkdirSync(join(root, 'tickets'), { recursive: true });
  const ticket = {
    seq,
    pid,
    identity,
    repo: '/repo',
    branch,
    mode: 'ship-branch',
    startedAt: Date.now(),
  };
  writeFileSync(
    join(root, 'tickets', `${String(seq).padStart(12, '0')}-${pid}.json`),
    JSON.stringify(ticket),
  );
}

function runHolder(root: string, label: string, out: string, ...rest: string[]): ChildProcess {
  const child = spawn(process.execPath, [HOLDER, root, label, out, ...rest], { stdio: 'ignore' });
  children.push(child);
  return child;
}

async function until(predicate: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A ticket can vanish between readdir and read (its ship just acquired). */
function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];

describe('ship queue across real processes', () => {
  it('serves three ships one at a time in arrival order', async () => {
    const root = tempRoot();
    const out = join(root, 'out');
    // Arrival order is the order tickets are written: wait until THIS label has queued (or already
    // started) before the next one spawns.
    const queued = (label: string) =>
      lines(out).some((line) => line.startsWith(`start ${label} `)) ||
      (existsSync(join(root, 'tickets')) &&
        readdirSync(join(root, 'tickets')).some((name) =>
          readIfPresent(join(root, 'tickets', name)).includes(`"branch":"${label}"`),
        ));
    for (const label of ['a', 'b', 'c']) {
      runHolder(root, label, out, 'hold', '300');
      await until(() => queued(label));
    }
    await until(() => lines(out).length === 6);
    const order = lines(out).map((line) => line.split(' ').slice(0, 2).join(' '));
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  }, 30_000);

  it('allocates distinct arrival numbers to concurrent enqueuers', async () => {
    const root = tempRoot();
    const out = join(root, 'out');
    // Each exit promise is attached in the same tick as its spawn, so no exit can be missed.
    const exits = Array.from({ length: 8 }, (_, i) => {
      const child = runHolder(root, `s${i}`, out, 'seq');
      return new Promise((resolve) => child.once('exit', resolve));
    });
    await Promise.all(exits);
    const seqs = lines(out).map(Number);
    expect(seqs).toHaveLength(8);
    expect(new Set(seqs).size).toBe(8);
  }, 30_000);

  it('keeps the slot held while a SIGKILLed dispatcher leaves its process group running', async () => {
    const root = tempRoot();
    const out = join(root, 'out');
    const first = runHolder(root, 'a', out, 'group');
    await until(() => lines(out).some((line) => line.startsWith('group ')));
    const pgid = Number(
      lines(out)
        .find((line) => line.startsWith('group '))
        ?.split(' ')[1],
    );
    groups.push(pgid);
    runHolder(root, 'b', out, 'hold', '10');
    first.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(lines(out).some((line) => line.startsWith('start b'))).toBe(false);

    process.kill(-pgid, 'SIGKILL');
    groups.splice(groups.indexOf(pgid), 1); // reaped: teardown must not signal a reused id
    await until(() => lines(out).some((line) => line.startsWith('start b')));
  }, 30_000);

  it('refuses a late group registration once a dead dispatcher claim has moved on', async () => {
    const root = tempRoot();
    const out = join(root, 'out');
    const dead = runHolder(root, 'a', out, 'die');
    await new Promise((resolve) => dead.once('exit', resolve));
    const staleToken =
      lines(out)
        .find((line) => line.startsWith('start a'))
        ?.split(' ')[2] ?? '';
    expect(staleToken).not.toBe('');
    runHolder(root, 'b', out, 'hold', '2000');
    await until(() => lines(out).some((line) => line.startsWith('start b')));

    // The orphaned bash of ship 'a' would now try to register: it must be told to stand down.
    expect(registerGroup(root, staleToken, 4242)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'slot', 'holder.json'), 'utf8')).branch).toBe('b');
  }, 30_000);

  it('frees the slot when the whole holder is SIGKILLed', async () => {
    const root = tempRoot();
    const out = join(root, 'out');
    const first = runHolder(root, 'a', out, 'hold', '60000');
    await until(() => lines(out).some((line) => line.startsWith('start a')));
    runHolder(root, 'b', out, 'hold', '10');
    await new Promise((resolve) => setTimeout(resolve, 200));
    first.kill('SIGKILL');
    await until(() => lines(out).some((line) => line.startsWith('start b')));
  }, 30_000);
});

describe('slot reaping', () => {
  it('leaves a live holder alone and reaps a dead one', () => {
    const root = tempRoot();
    seatHolder(root, holder({ pid: 111 }));
    reapSlotIfDead(root, probe([111]));
    expect(existsSync(join(root, 'slot'))).toBe(true);
    reapSlotIfDead(root, probe([]));
    expect(existsSync(join(root, 'slot'))).toBe(false);
  });

  it('keeps a dead dispatcher slot while its recorded process group lives', () => {
    const root = tempRoot();
    seatHolder(root, holder({ pid: 111, pgid: 900 }));
    reapSlotIfDead(root, probe([], [900]));
    expect(existsSync(join(root, 'slot'))).toBe(true);
  });

  it('reclaims an empty claim only once it is older than the grace period', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'slot'));
    reapSlotIfDead(root, probe([]));
    expect(existsSync(join(root, 'slot'))).toBe(true);
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(root, 'slot'), old, old);
    reapSlotIfDead(root, probe([]));
    expect(existsSync(join(root, 'slot'))).toBe(false);
  });

  it('holds the slot lock across the liveness check, so no claim or release can interleave', () => {
    const root = tempRoot();
    seatHolder(root, holder({ token: 'dead' }));
    const lockHeldDuringCheck: boolean[] = [];
    const observing: QueueProbe = {
      ownerGone: () => {
        lockHeldDuringCheck.push(existsSync(join(root, 'slot.lock')));
        return true;
      },
      groupAlive: () => false,
    };
    reapSlotIfDead(root, observing);
    expect(lockHeldDuringCheck).toEqual([true]);
    expect(existsSync(join(root, 'slot'))).toBe(false);
    expect(existsSync(join(root, 'slot.lock'))).toBe(false);
  });
});

describe('tickets and acquisition', () => {
  it.each(['', 'garbage', 'ps:', 'node:', ' ps:x'])(
    'rejects a ticket with identity %j',
    (identity) => {
      const root = tempRoot();
      seatTicket(root, 1, process.pid, identity);
      expect(liveTickets(root)).toEqual([]);
    },
  );

  it.each([0, -1, 1.5, 2_147_483_648])('rejects a slot holder with pid %d', (pid) => {
    const root = tempRoot();
    seatHolder(root, holder({ pid }));
    expect(readHolder(join(root, 'slot'))).toBeUndefined();
  });

  it('prunes a ticket whose pid was reused by an unrelated process', () => {
    const root = tempRoot();
    seatTicket(root, 1, process.pid, 'ps:Thu Jan  1 00:00:00 1970');
    seatTicket(root, 2, process.pid, processStartIdentity());
    expect(liveTickets(root).map((t) => t.seq)).toEqual([2]);
  });

  it.each(['-1', '-100', '5abc', '1e3', '1.5', '', ' ', 'garbage', '99999999999999999999'])(
    'never hands out a number below 1 for counter %j with an empty queue',
    (counter) => {
      const root = tempRoot();
      ensureRoot(root);
      writeFileSync(join(root, 'seq'), counter);
      const fields = {
        pid: process.pid,
        identity: processStartIdentity(),
        repo: '/r',
        branch: 'b',
        mode: 't',
        startedAt: 0,
      };
      const { ticket } = enqueue(root, fields);
      expect(ticket.seq).toBe(1);
      expect(liveTickets(root).map((t) => t.seq)).toEqual([1]);
    },
  );

  it('continues numbering past live tickets when the counter file is torn', () => {
    const root = tempRoot();
    ensureRoot(root);
    writeFileSync(join(root, 'seq'), 'garbage');
    seatTicket(root, 7, process.pid, processStartIdentity());
    const { ticket, path } = enqueue(root, {
      pid: process.pid,
      identity: processStartIdentity(),
      repo: '/r',
      branch: 'b',
      mode: 'test',
      startedAt: 0,
    });
    expect(ticket.seq).toBe(8);
    // Published inside the allocation lock: the ticket exists the moment its number does.
    expect(JSON.parse(readFileSync(path, 'utf8')).seq).toBe(8);
    expect(readFileSync(join(root, 'seq'), 'utf8').trim()).toBe('8');
  });

  it('skips a dead head-of-queue ticket instead of waiting on it forever', async () => {
    const root = tempRoot();
    seatTicket(root, 1, 999_991);
    const handle = await acquireShipSlot({
      repo: '/r',
      branch: 'feat/b',
      mode: 'test',
      root,
      probe: {
        ownerGone: (pid) => pid !== process.pid,
        groupAlive: () => false,
      },
      pollMs: 10,
      log: () => undefined,
    });
    expect(existsSync(join(root, 'slot'))).toBe(true);
    handle.release();
  });

  it('leaves the queue at acquire time and releases only its own claim', async () => {
    const root = tempRoot();
    const handle = await acquireShipSlot({
      repo: '/r',
      branch: 'feat/c',
      mode: 'test',
      root,
      log: () => undefined,
    });
    expect(readdirSync(join(root, 'tickets'))).toEqual([]);

    seatHolder(root, holder({ token: 'successor' }));
    handle.release();
    expect(existsSync(join(root, 'slot', 'holder.json'))).toBe(true);
    expect(registerGroup(root, handle.token, 1234)).toBe(false);
    expect(
      JSON.parse(readFileSync(join(root, 'slot', 'holder.json'), 'utf8')).pgid,
    ).toBeUndefined();
  });

  it('announces its position once per change and acquires when the holder dies', async () => {
    const root = tempRoot();
    seatHolder(root, holder({ pid: 111, branch: 'feat/running' }));
    const alive = [111, process.pid];
    const logged: string[] = [];
    const pending = acquireShipSlot({
      repo: '/r',
      branch: 'feat/d',
      mode: 'test',
      root,
      probe: {
        ownerGone: (pid) => !alive.includes(pid),
        groupAlive: () => false,
      },
      pollMs: 10,
      log: (line) => logged.push(line),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    alive.shift();
    const handle = await pending;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/position 1, waiting behind feat\/running \(\/repo, running 0m\)/);
    handle.release();
  });
});

describe('ship queue status', () => {
  it('lists the running ship, then live waiters next-first, skipping dead and torn tickets', () => {
    const root = tempRoot();
    const repo = tempRoot();
    mkdirSync(join(repo, '.devkit'));
    // A --dry-gates attempt's suffixed log: status reads the path bash recorded, never a guess.
    const gateLog = join(repo, '.devkit', 'last-ship-gates-feat-a-dry-x-123.log');
    writeFileSync(gateLog, 'first\nguard-review: running\n\n');
    seatHolder(root, holder({ pid: 111, repo, branch: 'feat/a', startedAt: 0, gateLog }));
    seatTicket(root, 3, 333, 'ps:x', 'feat/late');
    seatTicket(root, 2, 222, 'ps:x', 'feat/next');
    seatTicket(root, 4, 444, 'ps:x', 'feat/dead');
    writeFileSync(join(root, 'tickets', 'torn.json'), '{');
    const before = readdirSync(join(root, 'tickets')).sort();

    const view = readShipQueue(root, probe([111, 222, 333]));
    expect(view.running.map((h) => h.gate)).toEqual(['guard-review: running']);
    expect(view).toMatchObject({ slots: 1, occupied: 1 });
    expect(view.waiters.map((w) => w.branch)).toEqual(['feat/next', 'feat/late']);
    expect(readdirSync(join(root, 'tickets')).sort()).toEqual(before);

    const text = formatShipQueue(view, 125 * 60_000);
    expect(text.split('\n')[0]).toBe('slots: 1/1 in use');
    expect(text.split('\n')[1]).toContain('running: feat/a');
    expect(text).toContain('stuck? inspect it with: ps -o pid,lstart,command -p 111');
    expect(text).not.toMatch(/\bkill\b/); // devkit never hands out a signal command
    const grouped = formatShipQueue({
      running: [{ ...holder({ pgid: 900 }), gate: 'g' }],
      waiters: [],
      slots: 2,
      occupied: 1,
    });
    expect(grouped).toContain('ps -o pid,lstart,command -g 900');
    expect(text).toContain('2h5m');
    expect(text.indexOf('feat/next')).toBeLessThan(text.indexOf('feat/late'));
  });

  it('reports no holder when the claimed holder is dead, and an unknown gate without a log', () => {
    const root = tempRoot();
    seatHolder(root, holder({ pid: 111 }));
    expect(readShipQueue(root, probe([])).running).toEqual([]);
    expect(formatShipQueue({ running: [], waiters: [], slots: 1, occupied: 0 })).toBe(
      'slots: 0/1 in use\nrunning: (none)\nwaiting: (none)',
    );
    expect(currentGate({})).toBe('not started');
    expect(currentGate({ gateLog: join(root, 'missing.log') })).toBe('unknown');
  });
});

describe('entering the queue', () => {
  it.each([
    ['DEVKIT_SHIP_NO_QUEUE', '1'],
    ['DEVKIT_SHIP_NO_QUEUE', ''],
    ['DEVKIT_SHIP_QUEUE_DIR', '/tmp/private-queue'],
    ['DEVKIT_SHIP_QUEUE_DIR', ''],
  ])('ignores the retired %s=%j with a notice, and still queues', async (name, value) => {
    const root = tempRoot();
    const logged: string[] = [];
    let acquired = false;
    const entered = await enterShipQueue({
      env: { [name]: value },
      root,
      repo: '/r',
      branch: 'b',
      mode: 'test',
      acquire: async (options) => {
        acquired = true;
        expect(options.root).toBe(root); // never redirected by the environment
        return { token: 't', slotDir: join(root, 'slot'), release: () => undefined };
      },
      log: (line) => logged.push(line),
    });
    expect(acquired).toBe(true);
    expect(entered.env.DEVKIT_SHIP_SLOT_RELEASE).toBe('1');
    expect(logged.join('\n')).toContain(`${name} no longer exists and is ignored`);
  });

  it('resolves the machine queue from the passwd home, not $HOME or any env var', () => {
    const previous = process.env.HOME;
    process.env.HOME = tempRoot();
    try {
      expect(queueRoot()).toBe(join(userInfo().homedir, '.devkit', 'ship-queue'));
    } finally {
      process.env.HOME = previous;
    }
  });

  it('stops the ship, never running unqueued, when the queue root cannot be created', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'file'), '');
    let acquired = false;
    await expect(
      enterShipQueue({
        env: { DEVKIT_GATE_EVENTS: '' },
        root: join(root, 'file', 'queue'),
        repo: '/r',
        branch: 'b',
        mode: 'test',
        acquire: async () => {
          acquired = true;
          throw new Error('unreachable');
        },
        log: () => undefined,
      }),
    ).rejects.toThrow(/cannot create the queue at .*grant that path/);
    expect(acquired).toBe(false);
  });

  it('stops the ship, rather than running unqueued, when acquisition fails past root creation', async () => {
    const root = tempRoot();
    await expect(
      enterShipQueue({
        env: {},
        root,
        repo: '/r',
        branch: 'b',
        mode: 'test',
        acquire: async () => {
          throw new Error('timed out acquiring manifest lock');
        },
        log: () => undefined,
      }),
    ).rejects.toThrow('timed out acquiring');
  });

  it('ignores a leaked slot token whose holder is gone, and queues', async () => {
    const root = tempRoot();
    const logged: string[] = [];
    const entered = await enterShipQueue({
      env: { DEVKIT_SHIP_SLOT: 'leaked' },
      root,
      repo: '/r',
      branch: 'b',
      mode: 'test',
      log: (line) => logged.push(line),
    });
    expect(logged[0]).toMatch(/ignoring a stale DEVKIT_SHIP_SLOT/);
    expect(entered.handle).toBeDefined();
    entered.handle?.release();
  });

  it('runs a nested ship as a guest under its ancestor slot, without release rights', async () => {
    const root = tempRoot();
    seatHolder(root, holder({ pid: process.ppid, identity: 'ps:x', token: 'outer' }));
    const entered = await enterShipQueue({
      env: { DEVKIT_SHIP_SLOT: 'outer' },
      root,
      repo: '/r',
      branch: 'b',
      mode: 'test',
      probe: probe([process.ppid]),
      acquire: async () => {
        throw new Error('a nested ship must not wait behind its own ancestor');
      },
      log: () => undefined,
    });
    expect(entered.env).toEqual({ DEVKIT_SHIP_SLOT_RELEASE: '' });
    expect(readHolder(join(root, 'slot'))?.guests?.map((g) => g.pid)).toEqual([process.pid]);
    // While the guest runs, neither the outer dispatcher nor Bash's pre-CI hand-off may free the slot.
    expect(releaseSlot(root, 'outer', { probe: probe([process.pid]), handOff: true })).toBe(
      'in-use',
    );
    entered.handle?.release();
    expect(readHolder(join(root, 'slot'))?.guests).toEqual([]);
    expect(releaseSlot(root, 'outer', { probe: probe([]), handOff: true })).toBe('released');
  });

  it('keeps a dead dispatcher slot alive while a nested guest still runs', () => {
    const guest = { pid: 222, identity: 'ps:g' };
    expect(holderAlive(holder({ pid: 111, guests: [guest] }), probe([222]))).toBe(true);
    expect(holderAlive(holder({ pid: 111, guests: [guest] }), probe([]))).toBe(false);
  });

  it('matches an ancestor by pid or by the holder group, never itself or a sibling', () => {
    const root = tempRoot();
    const table = () =>
      new Map([
        [
          process.pid,
          { pid: process.pid, parentPid: 50, groupId: 7, identity: '', ownershipToken: false },
        ],
        [50, { pid: 50, parentPid: 1, groupId: 900, identity: '', ownershipToken: false }],
      ]);
    seatHolder(root, holder({ pid: 50, token: 't' }));
    expect(joinAncestorSlot('t', root, probe([50]), table)).toBe(true);
    seatHolder(root, holder({ pid: 61, pgid: 900, token: 't' }));
    expect(joinAncestorSlot('t', root, probe([], [900]), table)).toBe(true);
    seatHolder(root, holder({ pid: 62, token: 't' }));
    expect(joinAncestorSlot('t', root, probe([62]), table)).toBe(false);
    seatHolder(root, holder({ pid: process.pid, token: 't' }));
    expect(joinAncestorSlot('t', root, probe([process.pid]), table)).toBe(false);
    expect(joinAncestorSlot('wrong', root, probe([process.pid]), table)).toBe(false);
  });
});

describe('nested ship inside the holder process group', () => {
  it('counts this process as held when it is a member of the holder group (a gate spawning ship)', () => {
    const root = tempRoot();
    const table = () =>
      new Map([
        [
          process.pid,
          { pid: process.pid, parentPid: 1, groupId: 900, identity: '', ownershipToken: false },
        ],
      ]);
    seatHolder(root, holder({ pid: 61, pgid: 900, token: 't' }));
    expect(joinAncestorSlot('t', root, probe([61], [900]), table)).toBe(true);
  });
});

describe('ship_queue_slot_release (bash, before --wait-ci)', () => {
  function release(env: Record<string, string>, call = 'ship_queue_slot_release') {
    return spawnSync('bash', ['-c', `set -euo pipefail; . "${ARGS_SH}"; ${call}`], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 10_000, // parallel project: a native bound at the spawn site
    });
  }

  it('releases only the claim that still carries its token, and only for the acquirer', () => {
    const root = tempRoot();
    seatHolder(root, holder({ token: 'mine' }));
    const slot = join(root, 'slot');
    const base = { DEVKIT_SHIP_SLOT_DIR: slot, DEVKIT_SHIP_SLOT_RELEASE: '1' };

    const stale = release({ ...base, DEVKIT_SHIP_SLOT: 'other' });
    expect(stale.status).toBe(0);
    expect(stale.stderr).toContain('no longer held the queue slot');
    expect(existsSync(slot)).toBe(true);
    expect(
      release({ ...base, DEVKIT_SHIP_SLOT: 'mine', DEVKIT_SHIP_SLOT_RELEASE: '' }).status,
    ).toBe(0);
    expect(existsSync(slot)).toBe(true);
    expect(release({ ...base, DEVKIT_SHIP_SLOT: 'mine' }).status).toBe(0);
    expect(existsSync(slot)).toBe(false);
  });

  it('waits on the shared slot lock instead of racing a concurrent claim or release', () => {
    const root = tempRoot();
    seatHolder(root, holder({ token: 'mine' }));
    mkdirSync(join(root, 'slot.lock'));
    writeFileSync(join(root, 'slot.lock', 'busy'), `${process.pid}\n${processStartIdentity()}`);
    const slot = join(root, 'slot');
    const result = release({
      DEVKIT_SHIP_SLOT_DIR: slot,
      DEVKIT_SHIP_SLOT_RELEASE: '1',
      DEVKIT_SHIP_SLOT: 'mine',
      DEVKIT_SHIP_SLOT_RELEASE_WAIT_MS: '500',
    });
    // The lock never came free: the hand-off gave up LOUDLY and left the slot to the exit backstop.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('ship: queue slot release failed');
    expect(result.stderr).toContain('the queue slot stays held until this ship exits');
    expect(existsSync(slot)).toBe(true);
  }, 20_000);

  it('is a no-op without queue env', () => {
    expect(release({}).status).toBe(0);
  });

  it('releases before the wait even when the PR number is unresolved', () => {
    const root = tempRoot();
    seatHolder(root, holder({ token: 'mine' }));
    const slot = join(root, 'slot');
    const result = release(
      { DEVKIT_SHIP_SLOT_DIR: slot, DEVKIT_SHIP_SLOT_RELEASE: '1', DEVKIT_SHIP_SLOT: 'mine' },
      'ship_run_wait_ci "" o/r 900 ""',
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('reason=pr-number-unresolved');
    expect(existsSync(slot)).toBe(false);
  });
});

describe("ship_queue_slot_register (bash, the acquirer's first action)", () => {
  function register(env: Record<string, string>) {
    return spawnSync(
      'bash',
      ['-c', `set -euo pipefail; . "${SLOT_SH}"; ship_queue_slot_register; echo started`],
      { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 20_000 },
    );
  }

  it('records its process group on a claim that still carries its token, then runs', () => {
    const root = tempRoot();
    seatHolder(root, holder({ token: 'mine' }));
    const result = register({
      DEVKIT_SHIP_SLOT_DIR: join(root, 'slot'),
      DEVKIT_SHIP_SLOT_RELEASE: '1',
      DEVKIT_SHIP_SLOT: 'mine',
    });
    expect(result.stdout.trim()).toBe('started');
    expect(
      JSON.parse(readFileSync(join(root, 'slot', 'holder.json'), 'utf8')).pgid,
    ).toBeGreaterThan(0);
  });

  it('refuses to run once the claim has moved on to another ship', () => {
    const root = tempRoot();
    seatHolder(root, holder({ token: 'successor' }));
    const result = register({
      DEVKIT_SHIP_SLOT_DIR: join(root, 'slot'),
      DEVKIT_SHIP_SLOT_RELEASE: '1',
      DEVKIT_SHIP_SLOT: 'mine',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('started');
    expect(result.stderr).toContain('no longer holds the machine-wide queue slot');
    expect(
      JSON.parse(readFileSync(join(root, 'slot', 'holder.json'), 'utf8')).pgid,
    ).toBeUndefined();
  });

  it('refuses to run when its process group cannot be read', () => {
    const root = tempRoot();
    seatHolder(root, holder({ token: 'mine' }));
    const bin = tempRoot();
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = register({
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      DEVKIT_SHIP_SLOT_DIR: join(root, 'slot'),
      DEVKIT_SHIP_SLOT_RELEASE: '1',
      DEVKIT_SHIP_SLOT: 'mine',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read this ship's process group");
    expect(readHolder(join(root, 'slot'))?.pgid).toBeUndefined();
  });

  it('is a no-op for an unqueued or nested ship', () => {
    expect(register({}).stdout.trim()).toBe('started');
    expect(
      register({
        DEVKIT_SHIP_SLOT: 't',
        DEVKIT_SHIP_SLOT_DIR: '/nope',
        DEVKIT_SHIP_SLOT_RELEASE: '',
      }).stdout.trim(),
    ).toBe('started');
  });
});

describe('queue lock', () => {
  const QUEUE = { label: 'queue' };
  /** A held lock: one file named by the holder's nonce, holding its pid and start identity. */
  function seatLock(lock: string, pid: number, identity: string, nonce: string): void {
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, nonce), `${pid}\n${identity}`);
  }

  it('reaps a lock whose holder is provably gone, and keeps a live one', () => {
    const lock = join(tempRoot(), 'l.lock');
    seatLock(lock, 111, 'ps:x', 'n1');
    reapIfDead(lock, () => false);
    expect(existsSync(join(lock, 'n1'))).toBe(true);
    reapIfDead(lock, () => true);
    expect(existsSync(lock)).toBe(false);
  });

  it('takes over an empty lock directory left by a crash mid-release', () => {
    const lock = join(tempRoot(), 'l.lock');
    mkdirSync(lock);
    const held = withProcessLock(lock, () => readdirSync(lock).length, QUEUE);
    expect(held).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('never removes a holder that re-took the lock after the old one was judged dead', () => {
    const lock = join(tempRoot(), 'l.lock');
    seatLock(lock, 111, 'ps:x', 'dead');
    reapIfDead(lock, () => {
      rmSync(join(lock, 'dead'));
      writeFileSync(join(lock, 'live'), '222\nps:y');
      return true;
    });
    expect(readdirSync(lock)).toEqual(['live']);
  });

  it('lets two reapers of one dead holder remove it exactly once', () => {
    const lock = join(tempRoot(), 'l.lock');
    seatLock(lock, 111, 'ps:x', 'dead');
    reapIfDead(lock, () => {
      reapIfDead(lock, () => true); // a second reaper wins the race inside the first one's check
      seatLock(lock, 333, 'ps:z', 'fresh'); // and a fresh holder takes the lock
      return true;
    });
    expect(readdirSync(lock)).toEqual(['fresh']);
  });

  it('refuses an async callback, which would run its awaited half outside the lock', () => {
    const lock = join(tempRoot(), 'l.lock');
    expect(() => withProcessLock(lock, () => Promise.resolve(1), QUEUE)).toThrow(
      'synchronous callback',
    );
    expect(existsSync(lock)).toBe(false);
  });

  it('times out rather than run unlocked while a live holder keeps the lock', () => {
    const lock = join(tempRoot(), 'l.lock');
    seatLock(lock, process.pid, processStartIdentity(), 'held');
    let ran = false;
    expect(() =>
      withProcessLock(
        lock,
        () => {
          ran = true;
        },
        QUEUE,
      ),
    ).toThrow(LockHeldError);
    expect(ran).toBe(false);
  }, 20_000);

  it('takes over a dead holder lock and releases only its own acquisition', () => {
    const lock = join(tempRoot(), 'l.lock');
    seatLock(lock, 999_991, 'ps:gone', 'dead');
    expect(withProcessLock(lock, () => readdirSync(lock).includes('dead'), QUEUE)).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('slot retry budget', () => {
  it.each([
    ['garbage', 75_000],
    ['Infinity', 75_000],
    ['NaN', 75_000],
    ['-5', 75_000],
    ['0', 75_000],
    [undefined, 75_000],
    ['500', 500],
    ['999999999', 600_000],
  ])('%s → %d ms', (raw, expected) => {
    expect(retryBudgetMs(raw)).toBe(expected);
  });
});

describe('status snapshot during a hand-off', () => {
  it('reads under the slot lock, so it can never mix two moments of a hand-off', () => {
    const root = tempRoot();
    seatHolder(root, holder({ pid: process.pid, identity: processStartIdentity() }));
    mkdirSync(join(root, 'slot.lock'));
    writeFileSync(join(root, 'slot.lock', 'busy'), `${process.pid}\n${processStartIdentity()}`);
    expect(() => readShipQueue(root)).toThrow(LockHeldError);
  }, 20_000);

  it('changes no queue state and creates no queue root', () => {
    const root = join(tempRoot(), 'absent');
    expect(readShipQueue(root)).toEqual({ running: [], waiters: [], slots: 1, occupied: 0 });
    expect(existsSync(root)).toBe(false);
  });
});

describe('dispatcher release vs a surviving process group', () => {
  it('keeps the slot while its gate group lives, but Bash hand-off releases it', () => {
    const root = tempRoot();
    seatHolder(root, holder({ token: 'mine', pgid: 900 }));
    const groupLives = probe([], [900]);
    expect(releaseSlot(root, 'mine', { probe: groupLives })).toBe('in-use');
    expect(existsSync(join(root, 'slot'))).toBe(true);
    expect(releaseSlot(root, 'stale', { probe: groupLives, handOff: true })).toBe('not-held');
    expect(releaseSlot(root, 'mine', { probe: groupLives, handOff: true })).toBe('released');
    expect(existsSync(join(root, 'slot'))).toBe(false);
  });
});

describe('ship_queue_slot_note_log (bash)', () => {
  it('records the gate log on its own claim only', () => {
    const root = tempRoot();
    seatHolder(root, holder({ token: 'mine' }));
    const run = (token: string) =>
      spawnSync('bash', ['-c', `. "${SLOT_SH}"; ship_queue_slot_note_log /tmp/g.log`], {
        env: {
          PATH: process.env.PATH ?? '',
          DEVKIT_SHIP_SLOT_DIR: join(root, 'slot'),
          DEVKIT_SHIP_SLOT_RELEASE: '1',
          DEVKIT_SHIP_SLOT: token,
        },
        encoding: 'utf8',
        timeout: 20_000,
      });
    expect(run('other').status).toBe(0);
    expect(readHolder(join(root, 'slot'))?.gateLog).toBeUndefined();
    expect(run('mine').status).toBe(0);
    expect(readHolder(join(root, 'slot'))?.gateLog).toBe('/tmp/g.log');
  });
});
