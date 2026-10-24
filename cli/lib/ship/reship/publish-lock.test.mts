import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { psProcessStart } from '../../../../gate-engine/judge/process/identity.mts';
import { run } from './publish-lock.mts';
import {
  acquireProcessLock,
  LockHeldError,
} from '../../../../gate-engine/judge/process/process-lock.mts';

const dirs: string[] = [];
const children: number[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { force: true, recursive: true });
});

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'publish-lock-'));
  dirs.push(dir);
  return join(dir, 'branch.mutex');
}

/** A live process other than this one, standing in for the publishing bash. */
function livePid(): number {
  const pid = spawn('sleep', ['600'], { stdio: 'ignore' }).pid;
  if (pid === undefined) throw new Error('could not spawn the stand-in publisher');
  children.push(pid);
  return pid;
}

function acquire(pid: number, lock: string) {
  let nonce = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    nonce += String(chunk);
    return true;
  });
  const status = run(['acquire', String(pid), lock]);
  vi.restoreAllMocks();
  return { status, nonce };
}

describe('publish-lock.mts', () => {
  it('holds the lock for the pid it is given, not for itself, and releases it by nonce', () => {
    const lock = lockPath();
    const pid = livePid();

    const { status, nonce } = acquire(pid, lock);

    expect(status).toBe(0);
    expect(readdirSync(lock)).toEqual([nonce]);
    expect(readFileSync(join(lock, nonce), 'utf8')).toBe(`${pid}\nps:${psProcessStart(pid)}`);
    expect(run(['release', lock, nonce])).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("stamps a live publisher so that another acquirer's reap check keeps it", () => {
    // A stamp the reaper reads as a recycled pid would hand a live publisher's lock to a rival.
    const lock = lockPath();
    const { nonce } = acquire(livePid(), lock);

    expect(() => acquireProcessLock(lock, { label: 'test', waitMs: 50 })).toThrow(LockHeldError);
    expect(readdirSync(lock)).toEqual([nonce]);
  });

  it('refuses a publisher whose start time cannot be read, leaving no lock behind', () => {
    const lock = lockPath();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(acquire(999_999_999, lock).status).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('fails, naming the lock, when the lock cannot be created, never reporting it busy', () => {
    const parent = lockPath();
    writeFileSync(parent, 'not a directory\n');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)));

    expect(acquire(livePid(), join(parent, 'x.mutex')).status).toBe(1);
    expect(errors.join('\n')).toContain(`cannot take ${join(parent, 'x.mutex')}`);
  });

  it('a release with a stale nonce leaves the holder that re-took the lock', () => {
    const lock = lockPath();
    mkdirSync(lock);
    writeFileSync(join(lock, 'other'), `${livePid()}\nps:x`);

    expect(run(['release', lock, 'stale'])).toBe(0);
    expect(readdirSync(lock)).toEqual(['other']);
  });

  it('rejects malformed arguments with usage', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(run(['acquire', '1'])).toBe(1);
    expect(run(['bogus', 'a', 'b'])).toBe(1);
  });
});
