import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devkitVersion } from '../../devkit-version.mts';
import { emitCacheHit, emitGateEvent, emitGateTiming } from '../gate-events.mts';

const SHIP_ENV = ['DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID', 'DEVKIT_SHIP_REPO', 'DEVKIT_SHIP_BRANCH'];

describe('emitGateEvent', () => {
  // A DEVKIT_SHIP_ID puts every case on the ship path, so the DEVKIT_NO_TELEMETRY default (set to '1'
  // suite-wide in vitest.setup) never matters here — we assert the sink-set / sink-unset contract only.
  const saved: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(() => {
    for (const k of SHIP_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(path.join(tmpdir(), 'gate-events-'));
    process.env.DEVKIT_SHIP_ID = 'ship-1';
  });
  afterEach(() => {
    for (const k of SHIP_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
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
      devkit_version: devkitVersion(),
    });
    expect(typeof first.ts).toBe('string');
    expect(JSON.parse(lines[1]).gate).toBe('size');
  });

  it('stamps repo + branch on a ship event so a shared sink stays separable by repo', () => {
    const sink = path.join(dir, 'gate-events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_REPO = 'devkit';
    process.env.DEVKIT_SHIP_BRANCH = 'fix/sc-1239-gate-telemetry';
    emitGateEvent({ type: 'review_result', reviewer: 'commit-guard', status: 'pass' });
    // The default sink is per-MACHINE, so without these two fields a second repo's ship interleaves
    // into the same file indistinguishably — every per-reviewer figure read off it blends repos.
    expect(JSON.parse(readFileSync(sink, 'utf8').trim())).toMatchObject({
      ship_id: 'ship-1',
      repo: 'devkit',
      branch: 'fix/sc-1239-gate-telemetry',
    });
  });

  it('degrades repo/branch to empty rather than mislabelling a ship that never exported them', () => {
    const sink = path.join(dir, 'gate-events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    emitGateEvent({ type: 'gate_result', gate: 'size', status: 'fail' });
    expect(JSON.parse(readFileSync(sink, 'utf8').trim())).toMatchObject({ repo: '', branch: '' });
  });

  it('emitCacheHit rides the judge_exec label, so hit rate needs no join', () => {
    const sink = path.join(dir, 'gate-events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    emitCacheHit('review:correctness-reviewer', 'sonnet', 12_345);
    emitCacheHit('decision-alignment'); // that store records the verdict, not the judge
    const [hit, modelless] = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(hit).toMatchObject({
      type: 'cache_hit',
      judge: 'review:correctness-reviewer',
      model: 'sonnet',
      duration_ms: 12345,
    });
    expect(modelless).toMatchObject({ type: 'cache_hit', judge: 'decision-alignment' });
    expect('model' in modelless).toBe(false); // absent, never an empty-string placeholder
  });

  it('emits a normalized cache-aware stage timing summary', () => {
    const sink = path.join(dir, 'gate-events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    emitGateTiming('review', 125.4, 9_876.6, 'partial', 2.9);
    expect(JSON.parse(readFileSync(sink, 'utf8').trim())).toMatchObject({
      type: 'gate_timing',
      gate: 'review',
      actual_duration_ms: 125,
      effective_duration_ms: 9877,
      cache_state: 'partial',
      parallelism: 2,
    });
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
