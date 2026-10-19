import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ProcessRecord } from '../lib/ship/review/process/process-table.mts';
import {
  describeSurvivors,
  readSurvivorArgs,
  type SurvivorArgs,
  survivingPids,
} from '../lib/ship/review/process/reap-notice.mts';

function record(pid: number, identity: string): ProcessRecord {
  return { pid, parentPid: 1, groupId: pid, identity, ownershipToken: false };
}

function owned(...pids: number[]) {
  return {
    table: new Map(pids.map((pid) => [pid, record(pid, `start-${pid}`)])),
    identities: new Map(pids.map((pid) => [pid, `start-${pid}`])),
  };
}

function row(pid: number, parentPid: number, name: string, args = ''): SurvivorArgs {
  return { pid, parentPid, groupId: 900, elapsed: '00:07', name, args };
}

describe('survivingPids', () => {
  it('keeps only owned pids whose live identity still matches', () => {
    const { table, identities } = owned(10, 11);
    identities.set(12, 'start-12');
    table.set(11, record(11, 'recycled'));

    expect(survivingPids(table, identities)).toEqual([10]);
  });
});

describe('describeSurvivors', () => {
  it('lists topmost survivors first with pid, parent, group, age and executable', () => {
    const { table, identities } = owned(20, 21);
    const notice = describeSurvivors(table, identities, () => [
      row(21, 20, 'sleep', '/usr/bin/sleep 30'),
      row(20, 1, 'node', '/opt/node/bin/node /srv/mcp/server.mjs --port 9'),
    ]);

    expect(notice.split('\n')).toEqual([
      '20 ppid=1 pgid=900 up=00:07 node server.mjs',
      '21 ppid=20 pgid=900 up=00:07 sleep',
    ]);
  });

  it('never prints arguments past a path-shaped script name', () => {
    const { table, identities } = owned(30, 31, 32);
    const notice = describeSurvivors(table, identities, () => [
      row(
        30,
        1,
        'npm',
        'npm exec mcp-remote https://example.test/mcp --header Bearer:sentinel-arg',
      ),
      row(31, 1, 'node', 'node --token=sentinel-flag /srv/x.mjs'),
      row(32, 1, 'node', 'node ./bin/a=sentinel-eq.mjs'),
    ]);

    expect(notice).not.toContain('sentinel');
    expect(notice).not.toContain('mcp-remote');
    expect(notice.split('\n').map((line) => line.split(' ').slice(4).join(' '))).toEqual([
      'npm',
      'node',
      'node',
    ]);
  });

  it('replaces control bytes so a process name cannot forge banner lines', () => {
    const { table, identities } = owned(40);
    const notice = describeSurvivors(table, identities, () => [row(40, 1, 'ev\u001b[31mil\u0007')]);

    expect(notice).toBe('40 ppid=1 pgid=900 up=00:07 ev?[31mil?');
  });

  it('caps the list and counts the rest', () => {
    const pids = [50, 51, 52, 53, 54, 55, 56];
    const { table, identities } = owned(...pids);
    const notice = describeSurvivors(table, identities, () =>
      pids.map((pid) => row(pid, 1, 'sleep', 'sleep 30')),
    );

    expect(notice.split('\n')).toHaveLength(6);
    expect(notice.split('\n').at(-1)).toBe('+2 more');
  });

  it('names nothing when the process read throws, so the reap still proceeds', () => {
    const { table, identities } = owned(60);
    const notice = describeSurvivors(table, identities, () => {
      throw new Error('ps unavailable');
    });

    expect(notice).toBe('');
  });
});

describe('readSurvivorArgs', () => {
  it('reads a live pid and skips one that is gone', () => {
    const gone = spawnSync('/usr/bin/true').pid;
    const rows = readSurvivorArgs([process.pid, gone]);

    expect(rows.map((entry) => entry.pid)).toEqual([process.pid]);
    expect(rows[0]?.parentPid).toBe(process.ppid);
  });

  it('never names an environment entry that ps prints in place of an empty argv[0]', async () => {
    // macOS ps fills an empty argv[0] slot from the environment block that follows argv.
    const child = spawn('/bin/cat', [], {
      argv0: '',
      env: { LEAK_PROBE: '/probe/sentinel-env-leak' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const pid = Number(child.pid);
      const notice = describeSurvivors(new Map([[pid, record(pid, 'x')]]), new Map([[pid, 'x']]));

      expect(notice).toMatch(new RegExp(`^${pid} ppid=\\d+ pgid=\\d+ up=\\S+ \\S+$`));
      expect(notice).not.toMatch(/sentinel|LEAK_PROBE/);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
