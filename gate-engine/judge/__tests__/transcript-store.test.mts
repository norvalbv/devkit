import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTranscript, saveTranscript } from '../transcript-store.mts';

describe('transcript-store', () => {
  const saved = { file: process.env.DEVKIT_GATE_EVENTS, id: process.env.DEVKIT_SHIP_ID };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'transcript-store-'));
    process.env.DEVKIT_GATE_EVENTS = path.join(dir, 'gate-events.jsonl');
    process.env.DEVKIT_SHIP_ID = 'ship-1';
  });
  afterEach(() => {
    if (saved.file === undefined) delete process.env.DEVKIT_GATE_EVENTS;
    else process.env.DEVKIT_GATE_EVENTS = saved.file;
    if (saved.id === undefined) delete process.env.DEVKIT_SHIP_ID;
    else process.env.DEVKIT_SHIP_ID = saved.id;
  });

  it('writes <telemetry-dir>/transcripts/<ship>/<agent>.txt and returns the relative ref', () => {
    const ref = saveTranscript('review-correctness-reviewer', 'full reasoning\nVERDICT: PASS');
    expect(ref).toBe(path.join('transcripts', 'ship-1', 'review-correctness-reviewer.txt'));
    const abs = path.join(dir, ref as string);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe('full reasoning\nVERDICT: PASS');
  });

  it('round-trips: readTranscript(ref) returns what saveTranscript wrote', () => {
    const ref = saveTranscript('decisions', 'evidence\n--- VERDICT: ROUTINE ---\nROUTINE');
    expect(readTranscript(ref as string)).toBe('evidence\n--- VERDICT: ROUTINE ---\nROUTINE');
  });

  it('is a no-op → null off-ship (DEVKIT_GATE_EVENTS unset)', () => {
    delete process.env.DEVKIT_GATE_EVENTS;
    expect(saveTranscript('review-x', 'x')).toBeNull();
  });

  it('is a no-op → null when the ship id is unset', () => {
    delete process.env.DEVKIT_SHIP_ID;
    expect(saveTranscript('review-x', 'x')).toBeNull();
  });

  it('sanitises agent/ship labels into a single safe segment (no traversal)', () => {
    process.env.DEVKIT_SHIP_ID = '../evil';
    const ref = saveTranscript('review/../../etc', 'x') as string;
    // `/` → `-` (dots are legal filename chars); the ship id's leading dots are stripped. The result
    // is a single flat segment per level — no `..` path COMPONENT, so it can't escape the dir.
    expect(ref).toBe(path.join('transcripts', '-evil', 'review-..-..-etc.txt'));
    expect(path.resolve(dir, ref).startsWith(dir + path.sep)).toBe(true);
  });

  it('readTranscript rejects a relative ref that escapes the telemetry dir', () => {
    writeFileSync(path.join(dir, 'secret.txt'), 'nope');
    expect(readTranscript('../secret.txt')).toBeNull();
  });

  it('readTranscript returns null for a missing ref', () => {
    expect(readTranscript('transcripts/ship-1/absent.txt')).toBeNull();
  });

  it('never throws when the sink dir is unwritable', () => {
    const notADir = path.join(dir, 'file');
    writeFileSync(notADir, 'x');
    process.env.DEVKIT_GATE_EVENTS = path.join(notADir, 'gate-events.jsonl');
    expect(() => saveTranscript('review-x', 'x')).not.toThrow();
    expect(saveTranscript('review-x', 'x')).toBeNull();
  });
});
