import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForPath } from '../../../cli/__tests__/_helpers.mts';
import {
  ensureLegacyRationalesMigrated,
  listRationales,
  loadWorkingRationales,
  pruneRationales,
  RATIONALES_FILE,
  recordRationale,
} from '../rationales.mts';
import { isJsonObject, parseJson } from '../types.mts';

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

function rationaleFile(root: string): string {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return path.join(common, RATIONALES_FILE);
}

function loadFileEntries(file: string): string[] {
  const value = parseJson(readFileSync(file, 'utf8'));
  if (!isJsonObject(value) || !isJsonObject(value.entries)) {
    throw new Error('test rationale store must contain an entries object');
  }
  return Object.keys(value.entries).sort();
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
  it('records specific evidence in ignored local state without staging it', () => {
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
    expect(existsSync(path.join(root, '.devkit', 'comment-firewall-rationales.json'))).toBe(false);
    expect(
      execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
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

  it('rejects manually edited rationale values that bypass the CLI policy', () => {
    const root = repo();
    const file = rationaleFile(root);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({
        version: 1,
        entries: {
          a1b2c3d4e5f6: { rationale: 'x', at: '2026-08-18T00:00:00.000Z' },
        },
      })}\n`,
    );
    expect(() => loadWorkingRationales(root)).toThrow(/malformed evidence.*specific/);

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
    expect(() => loadWorkingRationales(root)).toThrow(/malformed evidence.*ticket/);
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
    expect(existsSync(rationaleFile(root))).toBe(true);
    expect(existsSync(path.join(nested, '.devkit', 'comment-firewall-rationales.json'))).toBe(
      false,
    );
    expect(listRationales(nested).map(([id]) => id)).toEqual(['a1b2c3d4e5f6']);
    expect(loadWorkingRationales(nested).entries.a1b2c3d4e5f6).toBeDefined();
    expect(pruneRationales(nested, new Set())).toBe(1);
    expect(loadWorkingRationales(nested).entries).toEqual({});
  });

  it('reads the tracked pre-migration rationale store when Git-local state is absent', () => {
    const root = repo();
    const legacy = path.join(root, '.devkit', 'comment-firewall-rationales.json');
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      `${JSON.stringify({
        version: 1,
        entries: {
          a1b2c3d4e5f6: {
            rationale: 'This existing rationale survives the move into Git-local metadata.',
            at: '2026-08-18T00:00:00.000Z',
          },
        },
      })}\n`,
    );
    expect(loadWorkingRationales(root).entries.a1b2c3d4e5f6?.rationale).toContain(
      'survives the move',
    );
  });

  it('migrates legacy evidence from HEAD when this change stages the tracked file deletion', () => {
    const root = repo();
    const legacy = path.join(root, '.devkit', 'comment-firewall-rationales.json');
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      `${JSON.stringify({
        version: 1,
        entries: {
          a1b2c3d4e5f6: {
            rationale: 'This committed rationale is recoverable after its tracked file is deleted.',
            at: '2026-08-18T00:00:00.000Z',
          },
        },
      })}\n`,
    );
    execFileSync('git', ['add', '.devkit/comment-firewall-rationales.json'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-qm',
        'legacy evidence',
      ],
      { cwd: root },
    );
    rmSync(legacy);
    execFileSync('git', ['add', '-u'], { cwd: root });
    ensureLegacyRationalesMigrated(root);
    expect(loadWorkingRationales(root).entries.a1b2c3d4e5f6?.rationale).toContain('recoverable');
    expect(existsSync(rationaleFile(root))).toBe(true);
  });

  it('keeps each linked worktree legacy evidence visible after a sibling creates shared state', () => {
    const root = repo();
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-qm',
        'base',
      ],
      { cwd: root },
    );
    const linked = mkdtempSync(path.join(tmpdir(), 'guard-comment-legacy-linked-'));
    rmSync(linked, { recursive: true });
    roots.push(linked);
    execFileSync('git', ['worktree', 'add', '-q', '--detach', linked], { cwd: root });
    for (const [cwd, id, rationale] of [
      [
        root,
        'a1b2c3d4e5f6',
        'The primary worktree keeps this migrated protocol rationale visible.',
      ],
      [linked, 'b1c2d3e4f5a6', 'The linked worktree keeps its distinct legacy rationale visible.'],
    ] as const) {
      const legacy = path.join(cwd, '.devkit', 'comment-firewall-rationales.json');
      mkdirSync(path.dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        `${JSON.stringify({
          version: 1,
          entries: { [id]: { rationale, at: '2026-08-18T00:00:00.000Z' } },
        })}\n`,
      );
    }
    recordRationale(
      root,
      'c1d2e3f4a5b6',
      'Creating unrelated shared evidence must not hide a sibling legacy rationale.',
    );
    expect(Object.keys(loadWorkingRationales(linked).entries).sort()).toEqual([
      'a1b2c3d4e5f6',
      'b1c2d3e4f5a6',
      'c1d2e3f4a5b6',
    ]);
  });

  it('redirects rationale mutations into the private managed-review data root', () => {
    const root = repo();
    recordRationale(
      root,
      'a1b2c3d4e5f6',
      'Developer evidence remains readable while managed review writes stay isolated.',
    );
    const requested = mkdtempSync(path.join(tmpdir(), 'guard-comment-review-data-'));
    roots.push(requested);
    const dataRoot = realpathSync(requested);
    const savedMode = process.env.DEVKIT_RUN_MODE;
    const savedRoot = process.env.DEVKIT_REVIEW_DATA_ROOT;
    try {
      process.env.DEVKIT_RUN_MODE = 'review';
      process.env.DEVKIT_REVIEW_DATA_ROOT = dataRoot;
      expect(loadWorkingRationales(root).entries.a1b2c3d4e5f6?.rationale).toContain(
        'remains readable',
      );
      recordRationale(
        root,
        'b1c2d3e4f5a6',
        'Managed review evidence must stay isolated from the developer shared store.',
      );
      expect(existsSync(path.join(dataRoot, 'comment-firewall-rationales.json'))).toBe(true);
      expect(loadFileEntries(rationaleFile(root))).toEqual(['a1b2c3d4e5f6']);
    } finally {
      if (savedMode === undefined) delete process.env.DEVKIT_RUN_MODE;
      else process.env.DEVKIT_RUN_MODE = savedMode;
      if (savedRoot === undefined) delete process.env.DEVKIT_REVIEW_DATA_ROOT;
      else process.env.DEVKIT_REVIEW_DATA_ROOT = savedRoot;
    }
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
    expect(Object.keys(loadWorkingRationales(root).entries)).toEqual(['a1b2c3d4e5f6']);
  });

  it('never prunes a rationale recorded after the obsolete-entry snapshot', () => {
    const root = repo();
    recordRationale(
      root,
      'a1b2c3d4e5f6',
      'This old rationale is absent from the current staged findings and may be removed.',
    );
    expect(
      pruneRationales(root, new Set(), {
        afterSnapshot: () => {
          recordRationale(
            root,
            'b1c2d3e4f5a6',
            'This concurrent rationale was created after pruning selected its candidates.',
          );
        },
      }),
    ).toBe(1);
    expect(Object.keys(loadWorkingRationales(root).entries)).toEqual(['b1c2d3e4f5a6']);
  });

  it('does not prune the same finding after its rationale changes beyond the snapshot', () => {
    const root = repo();
    recordRationale(
      root,
      'a1b2c3d4e5f6',
      'This original rationale is obsolete before a concurrent author updates it.',
    );
    expect(
      pruneRationales(root, new Set(), {
        afterSnapshot: () => {
          recordRationale(
            root,
            'a1b2c3d4e5f6',
            'This replacement rationale was recorded after pruning took its snapshot.',
          );
        },
      }),
    ).toBe(0);
    expect(loadWorkingRationales(root).entries.a1b2c3d4e5f6?.rationale).toContain('replacement');
  });

  it('prunes only rationales owned by the calling linked worktree', () => {
    const root = repo();
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-qm',
        'base',
      ],
      { cwd: root },
    );
    const linked = mkdtempSync(path.join(tmpdir(), 'guard-comment-linked-'));
    rmSync(linked, { recursive: true });
    roots.push(linked);
    execFileSync('git', ['worktree', 'add', '-q', '--detach', linked], { cwd: root });
    recordRationale(
      root,
      'a1b2c3d4e5f6',
      'This rationale belongs exclusively to the primary worktree staged state.',
    );
    recordRationale(
      linked,
      'b1c2d3e4f5a6',
      'This rationale belongs exclusively to the linked worktree staged state.',
    );
    expect(pruneRationales(root, new Set())).toBe(1);
    expect(Object.keys(loadWorkingRationales(root).entries)).toEqual(['b1c2d3e4f5a6']);
  });

  it('rejects conflicting rationale text owned by another linked worktree', () => {
    const root = repo();
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-qm',
        'base',
      ],
      { cwd: root },
    );
    const linked = mkdtempSync(path.join(tmpdir(), 'guard-comment-conflict-'));
    rmSync(linked, { recursive: true });
    roots.push(linked);
    execFileSync('git', ['worktree', 'add', '-q', '--detach', linked], { cwd: root });
    recordRationale(
      root,
      'a1b2c3d4e5f6',
      'The primary worktree records this specific external protocol constraint.',
    );
    expect(() =>
      recordRationale(
        linked,
        'a1b2c3d4e5f6',
        'The linked worktree attempts to replace it with different evidence text.',
      ),
    ).toThrow(/another worktree owns different evidence/);
    expect(loadWorkingRationales(root).entries.a1b2c3d4e5f6?.rationale).toContain(
      'primary worktree',
    );
  });

  it('preserves a legacy-conflict error discovered inside prune locking', () => {
    const root = repo();
    recordRationale(
      root,
      'a1b2c3d4e5f6',
      'The shared store contains the authoritative external protocol rationale.',
    );
    expect(() =>
      pruneRationales(root, new Set(), {
        afterSnapshot: () => {
          const legacy = path.join(root, '.devkit', 'comment-firewall-rationales.json');
          mkdirSync(path.dirname(legacy), { recursive: true });
          writeFileSync(
            legacy,
            `${JSON.stringify({
              version: 1,
              entries: {
                a1b2c3d4e5f6: {
                  rationale: 'The newly appeared legacy file contains conflicting evidence text.',
                  at: '2026-08-18T00:00:00.000Z',
                },
              },
            })}\n`,
          );
        },
      }),
    ).toThrow(/legacy evidence.*conflicts with another worktree/);
  });

  it('treats a corrupt local store as unreadable evidence, never empty approval state', () => {
    const root = repo();
    mkdirSync(path.dirname(rationaleFile(root)), { recursive: true });
    writeFileSync(rationaleFile(root), '{broken');
    expect(() => loadWorkingRationales(root)).toThrow(/not valid JSON/);
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
