import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearEntries,
  devkitDataFile,
  loadEntries,
  saveEntries,
  saveEntriesIfGeneration,
  verdictStoreGeneration,
} from '../verdict-store.mts';

const REVIEW_ENV = ['DEVKIT_RUN_MODE', 'DEVKIT_REVIEW_ID', 'DEVKIT_REVIEW_DATA_ROOT'] as const;
const saved: Partial<Record<(typeof REVIEW_ENV)[number], string>> = {};
const tempRoots: string[] = [];
const VERDICT_STORE_URL = new URL('../verdict-store.mts', import.meta.url).href;
const WORKER_SOURCE = String.raw`
  import { existsSync, writeFileSync } from 'node:fs';
  const [moduleUrl, operation, file, key, started, loaded, release, finished] = process.argv.slice(1);
  const { clearEntries, saveEntries, saveEntriesIfGeneration, verdictStoreGeneration } = await import(moduleUrl);
  writeFileSync(started, 'started\n', { flag: 'wx' });
  if (operation !== 'clear') {
    const hold = () => {
      writeFileSync(loaded, 'loaded\n', { flag: 'wx' });
      const waiter = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 8_000;
      while (!existsSync(release) && Date.now() < deadline) Atomics.wait(waiter, 0, 0, 10);
      if (!existsSync(release)) process.exit(2);
    };
    if (operation === 'conditional') {
      const generation = verdictStoreGeneration(file);
      hold();
      const result = saveEntriesIfGeneration(file, generation, { [key]: { at: '2026-07-19T00:00:00.000Z', worker: key } });
      writeFileSync(finished, String(result) + '\n', { flag: 'wx' });
      process.exit(0);
    }
    const hooks = { candidate: 'afterLockCandidateReady', final: 'afterFinalStoreOwnershipCheck', publish: 'afterStoreFenceCheck', reap: 'afterAbandonedOwnerChecked', 'reap-crash': 'afterAbandonedOwnerChecked', release: 'beforeLockRemoval' };
    const exit = () => { writeFileSync(loaded, 'loaded\n', { flag: 'wx' }); process.exit(0); };
    const options = { [hooks[operation] ?? 'afterLoad']: operation.endsWith('crash') ? exit : hold };
    saveEntries(file, { [key]: { at: '2026-07-19T00:00:00.000Z', worker: key } }, options);
  } else clearEntries(file);
  writeFileSync(finished, 'finished\n', { flag: 'wx' });
`;
type WorkerMarkers = { finished: string; loaded: string; release: string; started: string };
function markers(root: string, name: string): WorkerMarkers {
  return {
    started: path.join(root, `${name}.started`),
    loaded: path.join(root, `${name}.loaded`),
    release: path.join(root, `${name}.release`),
    finished: path.join(root, `${name}.finished`),
  };
}
function spawnWorker(
  operation: string,
  file: string,
  key: string,
  state: WorkerMarkers,
  environment?: NodeJS.ProcessEnv,
) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      WORKER_SOURCE,
      VERDICT_STORE_URL,
      operation,
      file,
      key,
      state.started,
      state.loaded,
      state.release,
      state.finished,
    ],
    {
      env: environment ?? (operation === 'fallback' ? { ...process.env, PATH: '' } : process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`verdict worker exited ${String(code ?? signal)}: ${stderr.trim()}`));
    });
  });
  return { done };
}
function replacePublishedLock(file: string, label: string): { displaced: string; token: string } {
  const lockDir = `${file}.lock`;
  const displaced = `${lockDir}.${label}.displaced`;
  renameSync(lockDir, displaced);
  mkdirSync(lockDir);
  const processStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  })
    .trim()
    .replace(/\s+/g, ' ');
  const token = randomUUID();
  writeFileSync(
    path.join(lockDir, 'owner.json'),
    `${JSON.stringify({ fenced: true, pid: process.pid, processStart: `ps:${processStart}`, token })}\n`,
  );
  return { displaced, token };
}
async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(file)) throw new Error(`timed out waiting for ${file}`);
}
async function assertFilePresence(file: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 200;
  while (Date.now() < deadline) {
    expect(existsSync(file)).toBe(expected);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function tempRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `devkit-${label}-`));
  tempRoots.push(root);
  return root;
}
beforeEach(() => {
  for (const name of REVIEW_ENV) {
    const value = process.env[name];
    if (value === undefined) delete saved[name];
    else saved[name] = value;
    delete process.env[name];
  }
});
afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
  for (const name of REVIEW_ENV) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
describe('devkitDataFile', () => {
  it('stores review convergence data only under the explicit private data root', () => {
    const target = tempRoot('review-target');
    const runtime = tempRoot('review-runtime');
    const requestedDataRoot = path.join(runtime, 'data');
    mkdirSync(requestedDataRoot);
    const dataRoot = realpathSync(requestedDataRoot);
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_DATA_ROOT = dataRoot;
    const file = devkitDataFile(target, 'review-cache.json');
    saveEntries(file, { pass: { at: '2026-07-18T00:00:00.000Z' } });
    expect(file).toBe(path.join(dataRoot, 'review-cache.json'));
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number;
      generation: string;
      entries: Record<string, unknown>;
    };
    expect(persisted).toEqual({
      version: 2,
      generation: persisted.generation,
      entries: { pass: { at: '2026-07-18T00:00:00.000Z' } },
    });
    expect(readFileSync(`${file}.generation`, 'utf8')).toBe(`${persisted.generation}\n`);
    expect(existsSync(path.join(target, '.devkit'))).toBe(false);
  });
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['relative', 'private/review-data'],
  ])('rejects a %s review data root instead of falling back to the checkout', (_label, root) => {
    const target = tempRoot('invalid-review-target');
    process.env.DEVKIT_RUN_MODE = 'review';
    if (root === undefined) process.env.DEVKIT_REVIEW_ID = 'managed-review';
    else process.env.DEVKIT_REVIEW_DATA_ROOT = root;
    expect(() => devkitDataFile(target, 'review-cache.json')).toThrow(
      /DEVKIT_REVIEW_DATA_ROOT.*absolute, existing physical directory/,
    );
    expect(existsSync(path.join(target, '.devkit'))).toBe(false);
  });
  it.each(['missing', 'file'])('rejects an unavailable review data-root %s', (kind) => {
    const target = tempRoot('unavailable-review-target');
    const runtime = realpathSync(tempRoot('unavailable-review-runtime'));
    const root = path.join(runtime, kind);
    if (kind === 'file') writeFileSync(root, 'not a directory\n');
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_DATA_ROOT = root;
    expect(() => devkitDataFile(target, 'review-cache.json')).toThrow(
      /DEVKIT_REVIEW_DATA_ROOT.*absolute, existing physical directory/,
    );
  });
  it('rejects a review data-root symlink rather than following a redirected write target', () => {
    const target = tempRoot('symlink-review-target');
    const runtime = realpathSync(tempRoot('symlink-review-runtime'));
    const physical = path.join(runtime, 'physical');
    const linked = path.join(runtime, 'linked');
    mkdirSync(physical);
    symlinkSync(physical, linked, 'dir');
    process.env.DEVKIT_RUN_MODE = 'review';
    process.env.DEVKIT_REVIEW_DATA_ROOT = linked;
    expect(() => devkitDataFile(target, 'review-cache.json')).toThrow(
      /DEVKIT_REVIEW_DATA_ROOT.*physical directory/,
    );
  });
  it('ignores the review data root outside review mode and preserves main-checkout anchoring', () => {
    const base = tempRoot('ship-cache');
    const main = path.join(base, 'main');
    const linked = path.join(base, 'linked');
    mkdirSync(main);
    execFileSync('git', ['init', '-q'], { cwd: main });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: main });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: main });
    writeFileSync(path.join(main, 'tracked.txt'), 'tracked\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: main });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: main });
    execFileSync('git', ['worktree', 'add', '--detach', '-q', linked, 'HEAD'], { cwd: main });
    process.env.DEVKIT_RUN_MODE = 'ship';
    process.env.DEVKIT_REVIEW_DATA_ROOT = 'invalid-relative-root';
    expect(devkitDataFile(linked, 'review-cache.json')).toBe(
      path.join(realpathSync(main), '.devkit', 'review-cache.json'),
    );
  });
  it.each([undefined, 'review'])('preserves the non-repository cwd fallback in %s mode', (mode) => {
    const cwd = tempRoot('commit-cache');
    if (mode) process.env.DEVKIT_RUN_MODE = mode;
    else process.env.DEVKIT_REVIEW_DATA_ROOT = '/ignored/in/commit/mode';
    expect(devkitDataFile(cwd, 'prefix-cache.json')).toBe(
      path.join(cwd, '.devkit', 'prefix-cache.json'),
    );
  });
});
describe('verdict store mutations', () => {
  it('conditionally merges into a matching generation with newest-entry pruning', () => {
    const file = path.join(tempRoot('verdict-generation-match'), 'review-cache.json');
    const entries = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `old-${index}`,
        { at: String(index).padStart(3, '0') },
      ]),
    );
    expect(saveEntries(file, entries)).toBe(true);
    const generation = verdictStoreGeneration(file);
    expect(generation).not.toBeNull();
    expect(saveEntriesIfGeneration(file, generation, { newest: { at: '999' } })).toBe('saved');
    expect(verdictStoreGeneration(file)).toBe(generation);
    expect(Object.keys(loadEntries(file))).toHaveLength(100);
    expect(loadEntries(file)).toMatchObject({ newest: { at: '999' } });
    expect(loadEntries(file)).not.toHaveProperty('old-0');
  });
  it('reports a generation mismatch without mutating the active store', () => {
    const file = path.join(tempRoot('verdict-generation-mismatch'), 'review-cache.json');
    expect(saveEntries(file, { prior: { at: '1' } })).toBe(true);
    expect(saveEntriesIfGeneration(file, randomUUID(), { stale: { at: '2' } })).toBe(
      'generation-changed',
    );
    expect(loadEntries(file)).toEqual({ prior: { at: '1' } });
  });
  it.each([
    ['absent', {}],
    ['legacy', { prior: { at: '1' } }],
  ])('treats a %s store generation as null', (kind, entries) => {
    const file = path.join(tempRoot(`verdict-generation-${kind}`), 'review-cache.json');
    if (kind === 'legacy') writeFileSync(file, `${JSON.stringify({ version: 1, entries })}\n`);
    expect(verdictStoreGeneration(file)).toBeNull();
    expect(saveEntriesIfGeneration(file, null, { current: { at: '2' } })).toBe('saved');
    expect(loadEntries(file)).toEqual({ ...entries, current: { at: '2' } });
    expect(verdictStoreGeneration(file)).not.toBeNull();
  });
  it('distinguishes an operational failure from a generation mismatch', () => {
    const blocker = path.join(tempRoot('verdict-generation-failure'), 'blocked');
    writeFileSync(blocker, 'not a directory\n');
    expect(saveEntriesIfGeneration(path.join(blocker, 'store.json'), null, {})).toBe('failed');
  });
  it('cannot overwrite a generation rotated while a conditional saver is in flight', async () => {
    const root = tempRoot('verdict-generation-rotation');
    const file = path.join(root, 'review-cache.json');
    expect(saveEntries(file, { prior: { at: '1' } })).toBe(true);
    const originalGeneration = verdictStoreGeneration(file);
    const state = markers(root, 'conditional');
    const worker = spawnWorker('conditional', file, 'stale', state);
    await waitForFile(state.loaded);
    expect(clearEntries(file)).toBe(true);
    const rotatedGeneration = verdictStoreGeneration(file);
    expect(rotatedGeneration).not.toBe(originalGeneration);
    writeFileSync(state.release, 'release\n');
    await worker.done;
    expect(readFileSync(state.finished, 'utf8')).toBe('generation-changed\n');
    expect(verdictStoreGeneration(file)).toBe(rotatedGeneration);
    expect(loadEntries(file)).toEqual({});
  }, 10_000);
  it('never deletes a replacement lock when a paused candidate loses publication', async () => {
    const root = tempRoot('verdict-lock-publication');
    const file = path.join(root, 'review-cache.json');
    const candidate = markers(root, 'candidate');
    const replacement = markers(root, 'replacement');
    const candidateWorker = spawnWorker('candidate', file, 'candidate', candidate);
    await waitForFile(candidate.loaded);
    const replacementWorker = spawnWorker('save', file, 'replacement', replacement);
    await waitForFile(replacement.loaded);
    writeFileSync(candidate.release, 'release\n');
    await assertFilePresence(`${file}.lock`, true);
    writeFileSync(replacement.release, 'release\n');
    await replacementWorker.done;
    await candidateWorker.done;
    expect(loadEntries(file)).toEqual({
      replacement: { at: '2026-07-19T00:00:00.000Z', worker: 'replacement' },
      candidate: { at: '2026-07-19T00:00:00.000Z', worker: 'candidate' },
    });
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 10_000);
  it('serializes two process read-merge-write saves without losing either checkpoint', async () => {
    const root = tempRoot('verdict-save-race');
    const file = path.join(root, 'review-cache.json');
    const first = markers(root, 'first');
    const second = markers(root, 'second');
    const firstWorker = spawnWorker('save', file, 'first', first);
    await waitForFile(first.loaded);
    const secondWorker = spawnWorker('save', file, 'second', second);
    await waitForFile(second.started);
    await assertFilePresence(second.loaded, false);
    writeFileSync(first.release, 'release\n');
    await firstWorker.done;
    await waitForFile(second.loaded);
    writeFileSync(second.release, 'release\n');
    await secondWorker.done;
    expect(loadEntries(file)).toEqual({
      first: { at: '2026-07-19T00:00:00.000Z', worker: 'first' },
      second: { at: '2026-07-19T00:00:00.000Z', worker: 'second' },
    });
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 10_000);
  it('keeps a live owner exclusive across the final store-rename syscall gap', async () => {
    const root = tempRoot('verdict-final-store-gap');
    const file = path.join(root, 'review-cache.json');
    saveEntries(file, { prior: { at: '2026-07-18T00:00:00.000Z' } });
    const stale = markers(root, 'live-holder');
    const replacement = markers(root, 'replacement');
    const staleWorker = spawnWorker('final', file, 'late', stale);
    await waitForFile(stale.loaded);
    const expired = new Date(Date.now() - 120_000);
    utimesSync(`${file}.lock`, expired, expired);
    const replacementWorker = spawnWorker('save', file, 'replacement', replacement);
    await waitForFile(replacement.started);
    await assertFilePresence(replacement.loaded, false);
    writeFileSync(stale.release, 'release\n');
    await staleWorker.done;
    await waitForFile(replacement.loaded);
    writeFileSync(replacement.release, 'release\n');
    await replacementWorker.done;
    expect(loadEntries(file)).toEqual({
      prior: { at: '2026-07-18T00:00:00.000Z' },
      late: { at: '2026-07-19T00:00:00.000Z', worker: 'late' },
      replacement: { at: '2026-07-19T00:00:00.000Z', worker: 'replacement' },
    });
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 10_000);
  it('orders clear after a holder paused at its final publication syscall', async () => {
    const root = tempRoot('verdict-final-clear-gap');
    const file = path.join(root, 'review-cache.json');
    saveEntries(file, { prior: { at: '2026-07-18T00:00:00.000Z' } });
    const beforeGeneration = readFileSync(`${file}.generation`, 'utf8');
    const saving = markers(root, 'saving');
    const clearing = markers(root, 'clearing');
    const saveWorker = spawnWorker('final', file, 'late', saving);
    await waitForFile(saving.loaded);
    const expired = new Date(Date.now() - 120_000);
    utimesSync(`${file}.lock`, expired, expired);
    const clearWorker = spawnWorker('clear', file, 'unused', clearing);
    await waitForFile(clearing.started);
    await assertFilePresence(clearing.finished, false);
    writeFileSync(saving.release, 'release\n');
    await saveWorker.done;
    await clearWorker.done;
    const afterGeneration = readFileSync(`${file}.generation`, 'utf8');
    expect(afterGeneration).not.toBe(beforeGeneration);
    expect(loadEntries(file)).toEqual({});
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 10_000);
  it('does not mistake a live node-fallback start identity for PID reuse', async () => {
    const root = tempRoot('verdict-process-start-fallback');
    const file = path.join(root, 'review-cache.json');
    const fallback = markers(root, 'fallback');
    const replacement = markers(root, 'replacement');
    const fallbackWorker = spawnWorker('fallback', file, 'fallback', fallback);
    await waitForFile(fallback.loaded);
    const replacementWorker = spawnWorker('save', file, 'replacement', replacement);
    await waitForFile(replacement.started);
    await assertFilePresence(replacement.loaded, false);
    writeFileSync(fallback.release, 'release\n');
    await fallbackWorker.done;
    await waitForFile(replacement.loaded);
    writeFileSync(replacement.release, 'release\n');
    await replacementWorker.done;
    expect(Object.keys(loadEntries(file)).sort()).toEqual(['fallback', 'replacement']);
  }, 10_000);
  it('compares process starts consistently across different worker time zones', async () => {
    const root = tempRoot('verdict-process-start-timezone');
    const file = path.join(root, 'review-cache.json');
    const holder = markers(root, 'honolulu');
    const replacement = markers(root, 'london');
    const holderWorker = spawnWorker('save', file, 'honolulu', holder, {
      ...process.env,
      TZ: 'Pacific/Honolulu',
    });
    await waitForFile(holder.loaded);
    const replacementWorker = spawnWorker('save', file, 'london', replacement, {
      ...process.env,
      TZ: 'Europe/London',
    });
    await waitForFile(replacement.started);
    await assertFilePresence(replacement.loaded, false);
    writeFileSync(holder.release, 'release\n');
    await holderWorker.done;
    await waitForFile(replacement.loaded);
    writeFileSync(replacement.release, 'release\n');
    await replacementWorker.done;
    expect(Object.keys(loadEntries(file)).sort()).toEqual(['honolulu', 'london']);
  }, 10_000);
  it('recovers after both the lock owner and its first reaper exit', async () => {
    const root = tempRoot('verdict-dead-owner');
    const file = path.join(root, 'review-cache.json');
    await spawnWorker('crash', file, 'crashed', markers(root, 'crashed')).done;
    await spawnWorker('reap-crash', file, 'reaper', markers(root, 'reaper')).done;
    const replacement = markers(root, 'replacement');
    const worker = spawnWorker('save', file, 'replacement', replacement);
    await waitForFile(replacement.loaded);
    writeFileSync(replacement.release, 'release\n');
    await worker.done;
    expect(loadEntries(file)).toEqual({
      replacement: { at: '2026-07-19T00:00:00.000Z', worker: 'replacement' },
    });
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 10_000);
  it.each([
    'release',
    'reap',
  ] as const)('preserves a replacement installed at the %s pathname gap', async (operation) => {
    const root = tempRoot(`verdict-${operation}-replacement`);
    const file = path.join(root, 'review-cache.json');
    const state = markers(root, operation);
    if (operation === 'reap') {
      const crashed = markers(root, 'crashed');
      await spawnWorker('crash', file, 'crashed', crashed).done;
      expect(existsSync(`${file}.lock`)).toBe(true);
    }
    const worker = spawnWorker(operation, file, operation, state);
    await waitForFile(state.loaded);
    const replacement = replacePublishedLock(file, operation);
    writeFileSync(state.release, 'release\n');
    await worker.done;
    const owner = JSON.parse(readFileSync(`${file}.lock/owner.json`, 'utf8')) as {
      token: string;
    };
    expect(owner.token).toBe(replacement.token);
    expect(existsSync(replacement.displaced)).toBe(true);
    expect(loadEntries(file)).toEqual(
      operation === 'release'
        ? { release: { at: '2026-07-19T00:00:00.000Z', worker: 'release' } }
        : {},
    );
  }, 10_000);
  it('orders clear after an in-flight save instead of resurrecting cleared checkpoints', async () => {
    const root = tempRoot('verdict-clear-race');
    const file = path.join(root, 'review-cache.json');
    saveEntries(file, { existing: { at: '2026-07-18T00:00:00.000Z' } });
    const saving = markers(root, 'saving');
    const clearing = markers(root, 'clearing');
    const saveWorker = spawnWorker('save', file, 'in-flight', saving);
    await waitForFile(saving.loaded);
    const clearWorker = spawnWorker('clear', file, 'unused', clearing);
    await waitForFile(clearing.started);
    await assertFilePresence(clearing.finished, false);
    writeFileSync(saving.release, 'release\n');
    await saveWorker.done;
    await clearWorker.done;
    expect(loadEntries(file)).toEqual({});
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 10_000);
});
