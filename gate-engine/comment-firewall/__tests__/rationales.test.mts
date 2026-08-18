import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForPath } from '../../../cli/__tests__/_helpers.mts';
import {
  listRationales,
  loadStagedRationales,
  loadWorkingRationales,
  pruneRationales,
  RATIONALES_FILE,
  recordRationale,
} from '../rationales.mts';

const roots: string[] = [];
const RATIONALES_URL = new URL('../rationales.mts', import.meta.url).href;
const WORKER_SOURCE = String.raw`
  import { existsSync, writeFileSync } from 'node:fs';
  const [moduleUrl, cwd, id, started, release, finished] = process.argv.slice(1);
  const { recordRationale } = await import(moduleUrl);
  const options = started === '-' ? {} : { afterLoad: () => {
    writeFileSync(started, 'loaded\n', { flag: 'wx' });
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 8_000;
    while (!existsSync(release) && Date.now() < deadline) Atomics.wait(waiter, 0, 0, 10);
    if (!existsSync(release)) process.exit(2);
  }};
  recordRationale(cwd, id, 'A specific concurrent rationale that must survive the other writer.', undefined, '2026-08-18T00:00:00.000Z', options);
  writeFileSync(finished, 'finished\n', { flag: 'wx' });
`;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-comment-rationales-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function rationaleWorker(
  root: string,
  id: string,
  started: string,
  release: string,
  finished: string,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      WORKER_SOURCE,
      RATIONALES_URL,
      root,
      id,
      started,
      release,
      finished,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`rationale worker exited ${String(code ?? signal)}: ${stderr.trim()}`));
    });
  });
}

describe('comment rationale store', () => {
  it('records specific evidence and stages only the audit store', () => {
    const root = repo();
    const entry = recordRationale(
      root,
      'a1b2c3d4e5f6',
      'A vendor protocol requires this temporary translation until version 4 is available.',
      'SC-123',
      '2026-08-15T00:00:00.000Z',
    );
    expect(entry.ticket).toBe('SC-123');
    expect(loadWorkingRationales(root).entries.a1b2c3d4e5f6).toEqual(entry);
    expect(loadStagedRationales(root).entries.a1b2c3d4e5f6).toEqual(entry);
    expect(
      execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe(RATIONALES_FILE);
  });

  it('rejects placeholders and malformed tickets', () => {
    const root = repo();
    expect(() => recordRationale(root, 'a1b2c3d4e5f6', 'false positive')).toThrow(/specific/);
    expect(() =>
      recordRationale(
        root,
        'a1b2c3d4e5f6',
        'This is otherwise specific enough to pass the rationale length floor.',
        'some words',
      ),
    ).toThrow(/ticket/);
  });

  it('rejects manually staged rationale values that bypass the CLI policy', () => {
    const root = repo();
    mkdirSync(path.join(root, '.devkit'));
    const file = path.join(root, RATIONALES_FILE);
    writeFileSync(
      file,
      `${JSON.stringify({
        version: 1,
        entries: {
          a1b2c3d4e5f6: { rationale: 'x', at: '2026-08-18T00:00:00.000Z' },
        },
      })}\n`,
    );
    execFileSync('git', ['add', RATIONALES_FILE], { cwd: root });
    expect(() => loadStagedRationales(root)).toThrow(/malformed evidence.*specific/);

    writeFileSync(
      file,
      `${JSON.stringify({
        version: 1,
        entries: {
          a1b2c3d4e5f6: {
            rationale: 'A specific rationale long enough to satisfy the content policy.',
            at: '2026-08-18T00:00:00.000Z',
            ticket: 'not a canonical ticket',
          },
        },
      })}\n`,
    );
    execFileSync('git', ['add', RATIONALES_FILE], { cwd: root });
    expect(() => loadStagedRationales(root)).toThrow(/malformed evidence.*ticket/);
  });

  it('reads, records, lists, and prunes the root store from a nested directory', () => {
    const root = repo();
    const nested = path.join(root, 'packages', 'consumer');
    mkdirSync(nested, { recursive: true });
    recordRationale(
      nested,
      'a1b2c3d4e5f6',
      'A durable protocol constraint applies to every package in this repository.',
    );
    expect(existsSync(path.join(root, RATIONALES_FILE))).toBe(true);
    expect(existsSync(path.join(nested, RATIONALES_FILE))).toBe(false);
    expect(listRationales(nested).map(([id]) => id)).toEqual(['a1b2c3d4e5f6']);
    expect(loadStagedRationales(nested).entries.a1b2c3d4e5f6).toBeDefined();
    expect(pruneRationales(nested, new Set())).toBe(1);
    expect(loadStagedRationales(nested).entries).toEqual({});
  });

  it('prunes obsolete evidence while retaining current staged findings', () => {
    const root = repo();
    recordRationale(
      root,
      'a1b2c3d4e5f6',
      'This rationale remains attached to a current changed-comment finding.',
    );
    recordRationale(
      root,
      'b1c2d3e4f5a6',
      'This rationale belongs to a finding that no longer exists in the staged diff.',
    );
    expect(pruneRationales(root, new Set(['a1b2c3d4e5f6']))).toBe(1);
    expect(Object.keys(loadStagedRationales(root).entries)).toEqual(['a1b2c3d4e5f6']);
  });

  it('treats a corrupt staged store as unreadable evidence, never empty approval state', () => {
    const root = repo();
    mkdirSync(path.join(root, '.devkit'));
    writeFileSync(path.join(root, RATIONALES_FILE), '{broken');
    execFileSync('git', ['add', RATIONALES_FILE], { cwd: root });
    expect(() => loadStagedRationales(root)).toThrow(/not valid JSON/);
  });

  it('serializes concurrent read-modify-write calls without dropping either rationale', async () => {
    const root = repo();
    const firstStarted = path.join(root, 'first.started');
    const firstRelease = path.join(root, 'first.release');
    const firstFinished = path.join(root, 'first.finished');
    const secondFinished = path.join(root, 'second.finished');
    const first = rationaleWorker(root, 'a1b2c3d4e5f6', firstStarted, firstRelease, firstFinished);
    await waitForPath(firstStarted);
    const second = rationaleWorker(root, 'b1c2d3e4f5a6', '-', '-', secondFinished);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(secondFinished)).toBe(false);
    writeFileSync(firstRelease, 'release\n', { flag: 'wx' });
    await Promise.all([first, second]);
    expect(Object.keys(loadWorkingRationales(root).entries).sort()).toEqual([
      'a1b2c3d4e5f6',
      'b1c2d3e4f5a6',
    ]);
  });
});
