/** Locks the two contracts that keep old checkpoints loading: the key format (chunk tasks keyed on
 * file membership, whole-diff on -1) and torn-line tolerance plus identity-gated reuse. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGuardConfig } from '../../../../../config.mts';
import type { runCascade } from '../../../../cascade/reviewer.mts';
import { attachItems } from '../../../../evidence/items.mts';
import { REVIEWERS } from '../../../../reviewers.mts';
import type { ReviewOutcome } from '../../../../runtime.mts';
import type { ResultsFile } from '../labels.mts';
import { researchOutputDirectory } from '../materialize.mts';
import type { ReviewerSelection } from '../../../../reviewers.mts';
import {
  estimateUsd,
  isTerminal,
  openLensCheckpoint,
  planLensTasks,
  runLensWave,
  syncReviewAssets,
  outcomeCapture,
  type CheckpointRow,
} from '../lens-run.mts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.GUARD_CORRECTNESS_SPLIT;
  vi.restoreAllMocks();
});

function privateOutput(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'lens-private-')));
  dirs.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  return researchOutputDirectory(join(home, '.devkit', 'research', 'run'));
}

it('rejects a linked asset ancestor before replacing any projection or touching the link target', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lens-projection-')));
  dirs.push(root);
  const wt = join(root, 'worktree');
  const outside = join(root, 'outside');
  const brief = join(wt, '.claude', 'agents', 'correctness-reviewer.md');
  mkdirSync(join(wt, '.claude', 'agents'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(brief, 'unchanged brief');
  writeFileSync(join(outside, 'sentinel.txt'), 'untouched target');
  symlinkSync(outside, join(wt, '.claude', 'skills'), 'dir');
  const source = join(import.meta.dirname, '../../../../../..');
  expect(() => syncReviewAssets(source, wt)).toThrow('projection ancestor');
  expect(readFileSync(brief, 'utf8')).toBe('unchanged brief');
  expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched target');
});

describe('banked terminal capture', () => {
  const result = (extra: Partial<ReviewOutcome> = {}): ReviewOutcome => ({
    name: 'correctness-reviewer',
    status: 'fail',
    reason: 'finding',
    escalated: false,
    ...extra,
  });
  it('labels event and legacy full vectors as capped fallback and unreadable sidecars as missing', () => {
    const item = { lens: 'state-transitions', status: 'fail', issues: ['a capped finding'] };
    expect(outcomeCapture(result({ items: [item] }))).toEqual({
      version: 1,
      provenance: 'capped-fallback',
      items: [{ ...item, itemIndex: 0 }],
    });
    expect(outcomeCapture(result({ itemsFull: [{ ...item, itemIndex: 4 }] })).provenance).toBe(
      'capped-fallback',
    );
    expect(
      outcomeCapture(result({ itemsRef: 'items.txt' }), () => JSON.stringify([item])).provenance,
    ).toBe('capped-fallback');
    for (const text of [null, '{unreadable', JSON.stringify([{ ...item, issues: [{}] }])]) {
      expect(outcomeCapture(result({ itemsRef: 'items.txt' }), () => text).provenance).toBe(
        'missing-invalid',
      );
    }
    expect(outcomeCapture(result())).toEqual({
      version: 1,
      provenance: 'missing-invalid',
      items: [],
    });
  });
  it('round trips exact claims and scope, with a stable full parent roster across resume and distinct fresh namespaces', async () => {
    const dir = privateOutput();
    const reviewer = REVIEWERS.find((r) => r.name === 'correctness-reviewer')!;
    const selection = { reviewer, files: ['src/a.ts', 'src/b.ts'] };
    const tasks = planLensTasks({ arm: 'whole', sel: selection, diffText: diff, keyPrefix: 'd' });
    const text = `${'full evidence '.repeat(400)}CLAIM-TAIL`;
    let firstAttempt = true;
    const executeCascade = vi.fn<typeof runCascade>(async (task) => {
      const res = result();
      const lens = task.reviewer.lens?.[0] ?? '';
      if (firstAttempt && lens === tasks[3].group[0]) res.status = 'inconclusive';
      attachItems(
        res,
        {
          items: [
            { name: lens, status: 'fail', issues: [text, 'second issue'] },
            { name: 'pending-sibling', status: 'pending' },
          ],
        },
        new Map([[lens, 'blocking']]),
        { full: true },
      );
      return res;
    });
    const opts = {
      tasks,
      sel: selection,
      wt: dir,
      cfg: resolveGuardConfig(dir),
      model: 'test-model',
      issueCap: '3',
      identity: 'conditions',
      diffSha: 'd',
      base: 'base-sha',
      measurementNamespace: dir,
      log: () => {},
      concurrency: 1,
    };
    const file = join(dir, 'checkpoint.jsonl');
    const rows = await runLensWave({ ...opts, ckpt: openLensCheckpoint(file) }, executeCascade);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.capture?.provenance === 'exact-checklist')).toBe(true);
    expect(rows[0].issues).toEqual([
      { lens: tasks[0].group[0], text },
      { lens: tasks[0].group[0], text: 'second issue' },
    ]);
    expect(rows[0].capture?.items[1]).toMatchObject({ itemIndex: 1, status: 'pending' });
    expect(rows[0].scope).toEqual({ lenses: [...tasks[0].group], files: tasks[0].files });
    expect(rows[0].parentReplay?.expectedTaskKeys).toEqual(tasks.map((t) => t.key).sort());
    expect(new Set(rows.map((r) => r.parentReplay?.id)).size).toBe(1);
    firstAttempt = false;
    const resumed = await runLensWave({ ...opts, ckpt: openLensCheckpoint(file) }, executeCascade);
    expect(resumed.slice(0, 3)).toEqual(rows.slice(0, 3));
    expect(rows[3].status).toBe('inconclusive');
    expect(resumed[3].status).toBe('fail');
    expect(resumed[3].parentReplay).toEqual(rows[3].parentReplay);
    expect(executeCascade).toHaveBeenCalledTimes(5);
    const fresh = await runLensWave(
      {
        ...opts,
        measurementNamespace: join(dir, 'fresh'),
        ckpt: openLensCheckpoint(join(dir, 'fresh.jsonl')),
      },
      executeCascade,
    );
    expect(fresh[0].parentReplay?.id).not.toBe(rows[0].parentReplay?.id);
    // SAFETY: this exercises the writer/reader bank contract after JSON serialization.
    const bank = JSON.parse(JSON.stringify({ diff: 'd', base: 'base-sha', rows })) as ResultsFile;
    expect(bank.rows[0]).toMatchObject({
      key: tasks[0].key,
      identity: 'conditions',
      base: 'base-sha',
      at: rows[0].at,
      capture: rows[0].capture,
      scope: rows[0].scope,
      parentReplay: rows[0].parentReplay,
    });
  });
});

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,2 @@',
  ' const a = 1;',
  '+const b = 2;',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,1 +1,2 @@',
  ' const c = 1;',
  '+const d = 2;',
  '',
].join('\n');
// SAFETY: planLensTasks reads only `files` from the selection; the reviewer is opaque to it.
const sel = JSON.parse(
  JSON.stringify({ reviewer: { name: 'correctness-reviewer' }, files: ['src/a.ts', 'src/b.ts'] }),
) as ReviewerSelection;

describe('planLensTasks', () => {
  it('a whole arm plans one task per lens, keyed on prefix|arm|-1|lens with the full file set', () => {
    const tasks = planLensTasks({ arm: 'whole', sel, diffText: diff, keyPrefix: 'sha123' });
    expect(tasks.map((t) => t.key).sort()).toEqual([
      'sha123|whole|-1|concurrency-races',
      'sha123|whole|-1|error-and-edge-classification',
      'sha123|whole|-1|state-transitions',
      'sha123|whole|-1|writer-reader-contracts',
    ]);
    expect(tasks.every((t) => t.files.length === 2 && t.chunk === -1)).toBe(true);
  });
  it('a chunk arm keys chunk tasks on file membership and keeps writer-reader-contracts whole', () => {
    const tasks = planLensTasks({ arm: 'chunk:1', sel, diffText: diff, keyPrefix: 'p' });
    const cross = tasks.filter((t) => t.group[0] === 'writer-reader-contracts');
    expect(cross).toHaveLength(1);
    expect(cross[0].chunk).toBe(-1);
    expect(cross[0].key).toBe('p|chunk:1|-1|writer-reader-contracts');
    const chunked = tasks.filter((t) => t.chunk >= 0);
    expect(chunked.length).toBeGreaterThan(0);
    for (const t of chunked) expect(t.key).toMatch(/^p\|chunk:1\|\d+:[0-9a-f]{12}\|/);
  });
  it('refuses a non-singleton lens grouping and an unknown arm', () => {
    process.env.GUARD_CORRECTNESS_SPLIT = '1';
    expect(() => planLensTasks({ arm: 'whole', sel, diffText: diff, keyPrefix: 'p' })).toThrow(
      /singleton/,
    );
    delete process.env.GUARD_CORRECTNESS_SPLIT;
    expect(() => planLensTasks({ arm: 'bogus', sel, diffText: diff, keyPrefix: 'p' })).toThrow(
      /unknown arm/,
    );
  });
  it('prices a task at $0.55 plus $0.03 per KB of evidence', () => {
    expect(
      estimateUsd([
        { key: 'k', arm: 'whole', chunk: -1, group: ['x'], files: [], evidenceBytes: 2048 },
      ]),
    ).toBeCloseTo(0.61);
  });
});

describe('openLensCheckpoint', () => {
  it('confines full claims to private research and refuses symlink escapes', () => {
    const directory = privateOutput();
    const outside = join(os.homedir(), 'outside');
    mkdirSync(outside);
    expect(() => openLensCheckpoint(join(outside, 'checkpoint.jsonl'))).toThrow(
      /under ~\/\.devkit\/research/,
    );
    symlinkSync(outside, join(directory, 'escape'));
    expect(() => openLensCheckpoint(join(directory, 'escape', 'checkpoint.jsonl'))).toThrow(
      /symlink/,
    );
    const target = join(outside, 'untouched.jsonl');
    writeFileSync(target, 'private sentinel');
    symlinkSync(target, join(directory, 'checkpoint.jsonl'));
    expect(() => openLensCheckpoint(join(directory, 'checkpoint.jsonl'))).toThrow(/symlink/);
    expect(readFileSync(target, 'utf8')).toBe('private sentinel');
  });
  it('writes owner-only claims and rejects a checkpoint symlink introduced after opening', () => {
    const directory = privateOutput();
    const file = join(directory, 'checkpoint.jsonl');
    const ckpt = openLensCheckpoint(file);
    const row: CheckpointRow = {
      key: 'private',
      diff: 'd',
      arm: 'whole',
      chunk: -1,
      group: 'g',
      status: 'fail',
      reason: '',
      issues: [{ lens: 'g', text: 'complete claim' }],
      ms: 1,
      at: 't',
    };
    ckpt.checkpoint(row);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const target = join(os.homedir(), 'untouched.jsonl');
    writeFileSync(target, 'sentinel');
    rmSync(file);
    symlinkSync(target, file);
    expect(() => ckpt.checkpoint({ ...row, key: 'rejected' })).toThrow();
    expect(ckpt.done.has('rejected')).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('sentinel');
  });
  it('loads rows, skips a torn trailing line, and gates reuse on identity', () => {
    const dir = privateOutput();
    const file = join(dir, 'checkpoint.jsonl');
    const row = (key: string, status: string, identity?: string) =>
      JSON.stringify({
        key,
        diff: 'd',
        arm: 'whole',
        chunk: -1,
        group: 'g',
        status,
        reason: '',
        issues: [],
        ms: 1,
        at: 't',
        identity,
      });
    writeFileSync(
      file,
      `${row('a', 'pass', 'id1')}\n${row('b', 'error', 'id1')}\n${row('c', 'fail')}\n{"torn`,
    );
    const ckpt = openLensCheckpoint(file);
    expect(ckpt.tornLines).toBe(1);
    expect(ckpt.done.size).toBe(3);
    expect(ckpt.reusable('a', 'id1')).toBe(true);
    expect(ckpt.reusable('a', 'id2')).toBe(false);
    expect(ckpt.reusable('b', 'id1')).toBe(false);
    expect(ckpt.reusable('c', 'anything')).toBe(true);
    expect(isTerminal(ckpt.done.get('b'))).toBe(false);
    // SAFETY: row() serializes a complete CheckpointRow.
    ckpt.checkpoint(JSON.parse(row('d', 'pass', 'id1')) as CheckpointRow);
    expect(openLensCheckpoint(file).done.has('d')).toBe(true);
  });
});
