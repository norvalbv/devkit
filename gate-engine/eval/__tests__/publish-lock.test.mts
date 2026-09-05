import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withFileLock, withFileLockAsync } from '../publish-lock.mts';

it('keeps an asynchronous owner through suspension and releases after resolution or rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'async-file-lock-'));
  const lock = join(root, 'operation.lock');
  const barrier = Promise.withResolvers<void>();
  try {
    const action = withFileLockAsync(lock, 'probe', async () => {
      await barrier.promise;
      expect(() => withFileLock(lock, 'probe', () => undefined)).toThrow(
        'Another probe is in progress',
      );
      return 'published';
    });
    expect(existsSync(lock)).toBe(true);
    barrier.resolve();
    await expect(action).resolves.toBe('published');
    expect(existsSync(lock)).toBe(false);
    await expect(
      withFileLockAsync(lock, 'probe', async () => {
        await Promise.resolve();
        throw new Error('publication failed');
      }),
    ).rejects.toThrow('publication failed');
    expect(existsSync(lock)).toBe(false);
    expect(withFileLock(lock, 'probe', () => 'resumed')).toBe('resumed');
  } finally {
    barrier.resolve();
    rmSync(root, { recursive: true, force: true });
  }
});

// Hang detector for real process startup and cleanup under parallel suite load.
const PROCESS_TIMEOUT_MS = 30_000;

function signalOwner(root: string, signal: 'SIGINT' | 'SIGTERM', cleanup: boolean) {
  const script = `import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const { withFileLockAsync } = await import(process.argv[1]);
    const lock = join(process.argv[2], 'operation.lock');
    await withFileLockAsync(lock, 'probe', async () => {
      if (process.argv[4] !== 'cleanup') {
        process.stdin.resume();
        console.log(JSON.stringify({ workerPid: null }));
        await new Promise(() => {});
        return;
      }
      const worker = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      const closed = once(worker, 'close');
      await once(worker, 'spawn');
      await new Promise(resolve => {
        process.once(process.argv[3], async () => {
          const beforeCleanup = existsSync(lock);
          worker.kill(process.argv[3]);
          await closed;
          writeFileSync(join(process.argv[2], 'cleanup.json'), JSON.stringify({
            beforeCleanup, afterChildReaped: existsSync(lock),
          }));
          resolve();
        });
        console.log(JSON.stringify({ workerPid: worker.pid }));
      });
    });`;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    script,
    new URL('../publish-lock.mts', import.meta.url).href,
    root,
    signal,
    cleanup ? 'cleanup' : 'default',
  ]);
  let stdout = '';
  let stderr = '';
  const ready = Promise.withResolvers<number | null>();
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (stdout.includes('\n')) ready.resolve(JSON.parse(stdout.split('\n')[0]).workerPid);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const completed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', (error) => {
      ready.reject(error);
      reject(error);
    });
    child.once('close', (code, signal) => {
      ready.reject(new Error(`owner exited before ready: ${stderr}`));
      resolve({ code, signal, stderr });
    });
  });
  return { child, ready: ready.promise, completed };
}

it.each(['SIGINT', 'SIGTERM'] as const)(
  'lets action-owned %s cleanup reap its child before releasing ownership',
  async (signal) => {
    const root = mkdtempSync(join(tmpdir(), 'async-lock-cleanup-'));
    const owner = signalOwner(root, signal, true);
    let workerPid: number | null = null;
    try {
      workerPid = await owner.ready;
      owner.child.kill(signal);
      expect(await owner.completed).toEqual({ code: 0, signal: null, stderr: '' });
      expect(JSON.parse(readFileSync(join(root, 'cleanup.json'), 'utf8'))).toEqual({
        beforeCleanup: true,
        afterChildReaped: true,
      });
      expect(existsSync(join(root, 'operation.lock'))).toBe(false);
      expect(workerPid).not.toBeNull();
      expect(() => process.kill(workerPid!, 0)).toThrow();
    } finally {
      owner.child.kill('SIGKILL');
      if (workerPid !== null) {
        try {
          process.kill(workerPid, 'SIGKILL');
        } catch {
          /* Already reaped by its owner. */
        }
      }
      await owner.completed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  PROCESS_TIMEOUT_MS,
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'preserves default %s termination and permits recovery of the dead owner',
  async (signal) => {
    const root = mkdtempSync(join(tmpdir(), 'async-lock-default-signal-'));
    const lock = join(root, 'operation.lock');
    const owner = signalOwner(root, signal, false);
    try {
      await owner.ready;
      owner.child.kill(signal);
      expect(await owner.completed).toEqual({ code: null, signal, stderr: '' });
      // Node does not emit exit for default signal termination; stale-owner recovery owns this case.
      expect(existsSync(lock)).toBe(true);
      await expect(withFileLockAsync(lock, 'probe', async () => 'resumed')).resolves.toBe(
        'resumed',
      );
      expect(existsSync(lock)).toBe(false);
    } finally {
      owner.child.kill('SIGKILL');
      await owner.completed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  PROCESS_TIMEOUT_MS,
);
