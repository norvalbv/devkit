import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import getPort from 'get-port';
import {
  type AppGroup,
  groupAlive,
  ownsGroup,
  pickPort,
  seedSlot,
  signalGroup,
  slotProcessEnv,
  startApp,
  stopGroup,
  waitForHttp,
} from '../lib/machine/app.mts';
import { acquireLease, findLease } from '../lib/machine/lease.mts';

const temps: string[] = [];
const groups: number[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const pgid of groups.splice(0)) signalGroup(pgid, 'SIGKILL');
  for (const server of servers.splice(0)) server.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function start(script: string, env: NodeJS.ProcessEnv = process.env): AppGroup {
  const dir = mkdtempSync(join(tmpdir(), 'machine-app-'));
  temps.push(dir);
  const group = startApp(['node', '-e', script], { cwd: dir, env, log: join(dir, 'app.log') });
  groups.push(group.pgid);
  return group;
}

function hold(port: number, host: string): Promise<void> {
  const server = createServer();
  servers.push(server);
  return new Promise((done) => server.listen(port, host, () => done()));
}

const IDLE = 'setInterval(() => {}, 1000)';

function seedFixture() {
  const base = mkdtempSync(join(tmpdir(), 'machine-seed-'));
  temps.push(base);
  const [machines, worktree] = [join(base, 'machines'), join(base, 'wt')];
  mkdirSync(worktree);
  const { lease } = acquireLease(worktree, { root: machines, kill: () => undefined });
  const data = join(machines, `slot-${lease.slot}`, 'data');
  const vars = { port: 40000, data, profile: join(base, 'profile'), slot: lease.slot };
  return { machines, worktree, data, lease, input: { root: worktree, machines, lease, vars } };
}

describe('machine app process', () => {
  it('skips a port another program holds on any local host, not only 127.0.0.1', async () => {
    const base = await getPort();
    await hold(base, '0.0.0.0');
    expect(await pickPort(base)).not.toBe(base);
  });

  it('stops only its own process group', async () => {
    const mine = start(IDLE);
    const other = start(IDLE);
    expect(groupAlive(mine.pgid)).toBe(true);
    await stopGroup(mine.pgid, mine.identity);
    expect(groupAlive(mine.pgid)).toBe(false);
    expect(groupAlive(other.pgid)).toBe(true);
  });

  it('never signals a group whose leader pid now belongs to another process', async () => {
    const group = start(IDLE);
    expect(ownsGroup(group.pgid, group.identity)).toBe(true);
    expect(ownsGroup(group.pgid, 'Mon Jan  1 00:00:00 2001')).toBe(false);
    await stopGroup(group.pgid, 'Mon Jan  1 00:00:00 2001');
    expect(groupAlive(group.pgid)).toBe(true);
  });

  it('waits for the app to answer HTTP, and gives up when the app exits first', async () => {
    const port = await getPort();
    const serve = `require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')`;
    const alive = (code: string) => {
      const { pgid } = start(code);
      return () => groupAlive(pgid);
    };
    expect(await waitForHttp(`http://127.0.0.1:${port}`, alive(serve), 10_000)).toBe(true);
    const dead = await getPort();
    expect(await waitForHttp(`http://127.0.0.1:${dead}`, alive('process.exit(3)'), 10_000)).toBe(
      false,
    );
  });

  it("starts the app without ship's own env or a host app's run mode, plus the slot's", () => {
    const base = { PATH: '/bin', DEVKIT_SHIP_SLOT: 'x', NODE_ENV: 'development', KEEP: '1' };
    expect(slotProcessEnv(base, { PORT: '40000' })).toEqual({
      PATH: '/bin',
      KEEP: '1',
      PORT: '40000',
    });
  });

  it('trusts an unknown leader identity only once the leader is gone', async () => {
    const group = start(IDLE);
    expect(ownsGroup(group.pgid, null)).toBe(false);
    // `ps` failing (a timeout) on the live leader is not proof it is gone.
    expect(ownsGroup(group.pgid, group.identity, () => null)).toBe(false);
    signalGroup(group.pgid, 'SIGKILL');
    for (let i = 0; i < 50 && groupAlive(group.pgid); i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(ownsGroup(group.pgid, null)).toBe(true);
  });

  it('seeds an emptied data dir once, and again after a seed that failed', () => {
    const { machines, worktree, data, lease, input } = seedFixture();
    mkdirSync(data);
    writeFileSync(join(data, 'stale'), 'x');
    expect(() => seedSlot({ ...input, seed: ['node', '-e', 'process.exit(1)'] })).toThrow();
    expect(findLease(machines, worktree)?.seeded).toBe(false);
    expect(existsSync(join(data, 'stale'))).toBe(true);
    const write = "require('node:fs').writeFileSync(process.argv[1] + '/seeded', '1')";
    expect(seedSlot({ ...input, seed: ['node', '-e', write, '{data}'] })).toBe(true);
    expect(existsSync(join(data, 'seeded'))).toBe(true);
    expect(existsSync(join(data, 'stale'))).toBe(false);
    expect(findLease(machines, worktree)).toMatchObject({ id: lease.id, seeded: true });
  });

  it('never touches the data of a slot re-leased while its seed ran', () => {
    const { machines, data, lease, input } = seedFixture();
    const holder = join(machines, `slot-${lease.slot}`, 'holder.json');
    // The seed plays the other worktree: it takes the slot over, then writes into its own {data}.
    const takeOver = [
      "const fs = require('node:fs');",
      `const h = JSON.parse(fs.readFileSync(${JSON.stringify(holder)}, 'utf8'));`,
      `fs.writeFileSync(${JSON.stringify(holder)}, JSON.stringify({ ...h, id: 'other' }));`,
      `fs.mkdirSync(${JSON.stringify(data)}, { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(join(data, 'theirs'))}, '1');`,
      "fs.writeFileSync(process.argv[1] + '/mine', '1');",
    ].join(' ');
    expect(seedSlot({ ...input, seed: ['node', '-e', takeOver, '{data}'] })).toBe(false);
    expect(readdirSync(data)).toEqual(['theirs']);
    expect(existsSync(join(machines, 'seeding', lease.id))).toBe(false);
  });
});
