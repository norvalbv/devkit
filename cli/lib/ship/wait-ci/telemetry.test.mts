import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devkitVersion } from '../../../../gate-engine/devkit-version.mts';
import { recordCiEvent } from './telemetry.mts';
import { type CheckBucket, type CheckRow, summarise } from './wait.mts';

const row = (bucket: CheckBucket, name: string, link = ''): CheckRow => ({
  bucket,
  name,
  state: bucket.toUpperCase(),
  link,
  workflow: name,
});

describe('recordCiEvent', () => {
  const result = {
    outcome: 'failed' as const,
    polls: 3,
    elapsedMs: 90_000,
    counts: summarise([]).counts,
    failures: [row('fail', 'gate', 'https://x/1')],
    pending: [],
    cancelled: [],
  };

  it('appends a queryable row beside ship_pr on the same stream', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ci-events-')), 'events.jsonl');
    recordCiEvent(result, '514', { DEVKIT_GATE_EVENTS: file, DEVKIT_SHIP_ID: 'ship-1' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      type: 'ship_ci',
      ship_id: 'ship-1',
      devkit_version: devkitVersion(),
      pr_number: 514,
      outcome: 'failed',
      failing: ['gate'],
      waited_s: 90,
    });
  });

  it('names the root agent session that ran the ship, and omits it when there is none', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ci-events-')), 'events.jsonl');
    const env = { DEVKIT_GATE_EVENTS: file, DEVKIT_SHIP_ID: 'ship-1' };
    recordCiEvent(result, '514', { ...env, CLAUDE_CODE_SESSION_ID: 'root-1' });
    recordCiEvent(result, '514', env);
    const [stamped, bare] = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(stamped.parent_session_id).toBe('root-1');
    expect(bare).not.toHaveProperty('parent_session_id');
  });

  it('stays silent when the ship is not collecting telemetry', () => {
    // No throw, no file: a telemetry miss costs a row, never the ship.
    expect(() => recordCiEvent(result, '514', {})).not.toThrow();
  });
});

describe('recordCiEvent edge cases', () => {
  const eventsFile = () => join(mkdtempSync(join(tmpdir(), 'ci-events-')), 'events.jsonl');
  const base = {
    outcome: 'failed' as const,
    polls: 1,
    elapsedMs: 1_000,
    counts: summarise([]).counts,
    pending: [],
    cancelled: [],
  };

  it('keeps one JSONL row per line even when a check name carries a newline', () => {
    // A stray newline in this stream corrupts every downstream reader, not just this row.
    const file = eventsFile();
    recordCiEvent({ ...base, failures: [row('fail', 'gate\n{"type":"forged"}')] }, '514', {
      DEVKIT_GATE_EVENTS: file,
      DEVKIT_SHIP_ID: 'ship-1',
    });
    const written = readFileSync(file, 'utf8').trimEnd();
    expect(written.split('\n')).toHaveLength(1);
    expect(JSON.parse(written).failing).toEqual(['gate\n{"type":"forged"}']);
  });

  it('appends rather than truncating, so two waits on one stream both survive', () => {
    // Parallel Frink panes shipping at once share $DEVKIT_GATE_EVENTS.
    const file = eventsFile();
    const env = { DEVKIT_GATE_EVENTS: file, DEVKIT_SHIP_ID: 'ship-1' };
    recordCiEvent({ ...base, failures: [] }, '1', env);
    recordCiEvent({ ...base, failures: [] }, '2', env);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l).pr_number)).toEqual([1, 2]);
  });

  it('records a null pr_number rather than NaN when the PR is unresolvable', () => {
    const file = eventsFile();
    recordCiEvent({ ...base, failures: [] }, '?', {
      DEVKIT_GATE_EVENTS: file,
      DEVKIT_SHIP_ID: 'ship-1',
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).pr_number).toBeNull();
  });
});

describe('recordCiEvent attribution', () => {
  it('records the attribution beside the verdict, and null when none was computed', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ci-events-')), 'events.jsonl');
    const env = { DEVKIT_GATE_EVENTS: file, DEVKIT_SHIP_ID: 'ship-1' };
    const base = {
      outcome: 'failed' as const,
      polls: 1,
      elapsedMs: 1_000,
      counts: summarise([]).counts,
      failures: [row('fail', 'gate')],
      pending: [],
      cancelled: [],
    };
    const attribution = { token: 'new' as const, inherited: 6, fresh: 1, line: 'attribution=new' };
    recordCiEvent({ ...base, attribution }, '1', env);
    recordCiEvent(base, '2', env);
    const [known, none] = readFileSync(file, 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(known).toMatchObject({ attribution: 'new', inherited: 6, new_failures: 1 });
    expect(none).toMatchObject({ attribution: null, inherited: null, new_failures: null });
  });
});
