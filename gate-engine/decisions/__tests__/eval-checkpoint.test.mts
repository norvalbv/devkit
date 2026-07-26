import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_CHECKPOINT, openCheckpoint, progressFile } from '../eval/checkpoint.mts';

const META = { config: 'model=haiku K=3', gateHash: 'aaa111', corpusHash: 'bbb222' };
const row = (id, got = 'DECISION') => ({ id, expected: 'DECISION', got, ok: true, stable: true });

describe('decisions-eval checkpoint', () => {
  let dir: string;
  const open = (over = {}) => openCheckpoint('detect', { ...META, dir, ...over });
  const lines = () =>
    readFileSync(progressFile('detect', dir), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dk-ckpt-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('replays a row recorded under identical config and hashes', () => {
    open().record(row('orm-swap'));
    expect(open().take('orm-swap')).toMatchObject({ id: 'orm-swap', got: 'DECISION' });
    expect(open().size).toBe(1);
  });

  it('starts empty when no checkpoint exists', () => {
    expect(open().size).toBe(0);
    expect(open().take('orm-swap')).toBeUndefined();
  });

  // The whole safety argument for resume: a checkpoint from a DIFFERENT measurement must be inert.
  // If any of these salvaged, a resumed run would silently blend two configurations into one score.
  it.each([
    ['a different model/K', { config: 'model=sonnet K=1' }],
    ['an edited gate', { gateHash: 'zzz999' }],
    ['a re-labelled corpus', { corpusHash: 'zzz999' }],
  ])('refuses to replay rows from %s', (_label, drift) => {
    open().record(row('orm-swap'));
    const after = open(drift);
    expect(after.size).toBe(0);
    expect(after.take('orm-swap')).toBeUndefined();
  });

  it('never replays an outage — NULL is the work a resume exists to redo', () => {
    open().record(row('storage-swap', 'NULL'));
    expect(open().size).toBe(0);
    expect(open().take('storage-swap')).toBeUndefined();
  });

  it('salvages alignment rows on their final verdict, and free-skip rows count as done', () => {
    const c = openCheckpoint('alignment', { ...META, dir });
    c.record({ id: 'a1', expected: 'ALIGN', first: 'NULL', final: 'ALIGN', ok: true });
    c.record({ id: 'a2', expected: 'ALIGN', first: 'NO-MATCH', final: 'NO-MATCH', ok: false });
    c.record({ id: 'a3', expected: 'ALIGN', first: 'NULL', final: 'NULL', ok: false });
    const after = openCheckpoint('alignment', { ...META, dir });
    expect(after.take('a1')).toBeTruthy(); // escalated past a dark first pass — a real verdict
    expect(after.take('a2')).toBeTruthy(); // scope free-skip — completed, cost nothing
    expect(after.take('a3')).toBeUndefined(); // dark judge — retry it
  });

  // A run killed mid-append leaves a half-written final line. Losing 40 good rows to the 41st
  // would defeat the point, so the reader drops torn lines instead of failing the load.
  it('keeps intact rows when the file is torn mid-write', () => {
    const c = open();
    c.record(row('orm-swap'));
    c.record(row('cache-tier-replace'));
    const file = progressFile('detect', dir);
    appendFileSync(file, '{"sub":"detect","config":"model=haiku K=3","res":{"id":"tor');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    const after = open();
    expect(after.size).toBe(2);
    expect(after.take('orm-swap')).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 unreadable line'));
  });

  it('--fresh discards the file so every row is re-judged', () => {
    open().record(row('orm-swap'));
    expect(open({ fresh: true }).size).toBe(0);
    expect(open().size).toBe(0); // and the discard is durable, not just for that handle
  });

  it('a re-recorded row supersedes the earlier one', () => {
    open().record(row('orm-swap', 'ROUTINE'));
    open().record(row('orm-swap', 'DECISION'));
    expect(open().take('orm-swap').got).toBe('DECISION');
  });

  it('warns once — and only once — when the checkpoint cannot be written', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(progressFile('detect', dir), '');
    const c = openCheckpoint('detect', { ...META, dir: join(dir, 'nope') });

    expect(() => {
      c.record(row('orm-swap'));
      c.record(row('storage-swap'));
    }).not.toThrow(); // an unwritable checkpoint must not take the run down with it
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toContain('NOT resumable');
  });

  it('NO_CHECKPOINT touches no disk, so a direct bench caller never writes progress files', () => {
    expect(NO_CHECKPOINT.take('anything')).toBeUndefined();
    expect(NO_CHECKPOINT.record(row('orm-swap'))).toBeUndefined();
    expect(NO_CHECKPOINT.size).toBe(0);
  });

  it('records the identity alongside the row so a later run can check it', () => {
    open().record(row('orm-swap'));
    expect(lines()[0]).toMatchObject({ sub: 'detect', ...META });
  });
});
