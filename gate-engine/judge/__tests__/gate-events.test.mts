import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitGateEvent } from '../gate-events.mts';

describe('emitGateEvent', () => {
  const saved = { file: process.env.DEVKIT_GATE_EVENTS, id: process.env.DEVKIT_SHIP_ID };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gate-events-'));
    process.env.DEVKIT_SHIP_ID = 'ship-1';
  });
  afterEach(() => {
    if (saved.file === undefined) delete process.env.DEVKIT_GATE_EVENTS;
    else process.env.DEVKIT_GATE_EVENTS = saved.file;
    if (saved.id === undefined) delete process.env.DEVKIT_SHIP_ID;
    else process.env.DEVKIT_SHIP_ID = saved.id;
  });

  it('appends one JSON line stamped with ship_id + ts when the sink env is set', () => {
    const sink = path.join(dir, 'nested', 'gate-events.jsonl'); // nested dir must be created
    process.env.DEVKIT_GATE_EVENTS = sink;
    emitGateEvent({ type: 'review_result', reviewer: 'correctness-reviewer', status: 'fail' });
    emitGateEvent({ type: 'gate_result', gate: 'size', status: 'fail' });

    const lines = readFileSync(sink, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      type: 'review_result',
      reviewer: 'correctness-reviewer',
      status: 'fail',
      ship_id: 'ship-1',
    });
    expect(typeof first.ts).toBe('string');
    expect(JSON.parse(lines[1]).gate).toBe('size');
  });

  it('is a no-op when the sink env is unset (ad-hoc commit, not a ship)', () => {
    delete process.env.DEVKIT_GATE_EVENTS;
    expect(() =>
      emitGateEvent({ type: 'gate_result', gate: 'size', status: 'fail' }),
    ).not.toThrow();
  });

  it('never throws when the sink path is unwritable', () => {
    // A path whose parent is a file, not a dir → mkdir/append both fail; must be swallowed.
    const notADir = path.join(dir, 'file');
    writeFileSync(notADir, 'x');
    process.env.DEVKIT_GATE_EVENTS = path.join(notADir, 'events.jsonl');
    expect(() =>
      emitGateEvent({ type: 'gate_result', gate: 'size', status: 'fail' }),
    ).not.toThrow();
  });
});
