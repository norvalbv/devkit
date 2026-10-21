import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GateEvent, readShipEvents, render, summarise } from './gate-digest.mts';
import { issuesUnder } from './trend.mts';

const SHIP = 'ship-1';
const REVIEWER = 'correctness-reviewer';
const LENS = 'error-and-edge-classification';
const FP = 'ec3f343cfc74';
const ONE_ID = [{ lens: LENS, fp: FP }];
const WAIVE = `guard-review waive ${REVIEWER}:${LENS} ${FP} --kind 'false-positive|deferred|pre-existing|accepted' "why this finding is waived"`;
const MANY = 'issues, each listed in the log';

const ev = (o: GateEvent): GateEvent => ({ ship_id: SHIP, ...o });
const shipResult = (blocked: string | null) => ev({ type: 'ship_result', blocked_gate: blocked });
/** A failing checklist item carrying `issues` findings, as the gate snapshots it. */
const item = (issues: number, over: { lens?: string; disposition?: string } = {}) => ({
  lens: LENS,
  status: 'fail',
  disposition: 'blocking',
  issues: Array.from({ length: issues }, (_, i) => `src/a.ts:${i + 1} — defect ${i}`),
  ...over,
});
const PASSED = { lens: 'state-transitions', status: 'pass', issues: [] };
const fail = (items: GateEvent['items'], blocking: GateEvent['blocking'] = ONE_ID): GateEvent =>
  ev({ type: 'review_result', reviewer: REVIEWER, status: 'fail', reason: 'r', blocking, items });
const digest = (events: GateEvent[]): string => render(summarise(events, SHIP));
const blockedOn = (failed: GateEvent): string =>
  digest([ev({ type: 'ship_attempt' }), failed, shipResult('review')]);
/** What the digest printed before it read the item vector: the row a count-less ID keeps. */
const UNCOUNTED = blockedOn(fail(undefined));

describe('a blocking ID whose lens recorded several issues', () => {
  it('says how many sit under the one ID, and counts them in the header', () => {
    const text = blockedOn(fail([item(2), PASSED]));
    expect(text).toContain('Gate findings this run (1 gate(s) / 2 finding(s))');
    expect(text).toContain(
      `✗ review:${REVIEWER} — BLOCKED this run: ${LENS} [${FP}] · 2 ${MANY} — fix them all, or: ${WAIVE}`,
    );
  });

  it('leaves a single-issue row and its header exactly as they were', () => {
    expect(UNCOUNTED).toContain('Gate findings this run (1):');
    expect(UNCOUNTED).toContain(`${LENS} [${FP}] — fix it, or: ${WAIVE}`);
    expect(blockedOn(fail([item(1), PASSED]))).toBe(UNCOUNTED);
    expect(blockedOn(fail([item(0)]))).toBe(UNCOUNTED);
  });

  it('counts each ID from its own lens, and the header sums counted and uncounted rows', () => {
    const races = { lens: 'concurrency-races', fp: 'a5421e88403c' };
    const states = { lens: 'state-transitions', fp: '30d8dce61eb3' };
    const items = [item(2), item(1, { lens: races.lens }), item(3, { lens: states.lens })];
    const text = blockedOn(fail(items, [ONE_ID[0], races, states]));
    expect(text).toContain('Gate findings this run (1 gate(s) / 6 finding(s))');
    expect(text).toContain(`${LENS} [${FP}] · 2 ${MANY}`);
    expect(text).toContain(`${races.lens} [${races.fp}] — fix it, or:`);
    expect(text).toContain(`${states.lens} [${states.fp}] · 3 ${MANY}`);
  });

  it('keeps the count on a run whose blocker is unknown, without claiming it did not block', () => {
    const others = Array.from({ length: 10 }, (_, i) =>
      ev({ type: 'gate_result', gate: `gate-${i}`, status: 'fail', detail: 'd' }),
    );
    const result = ev({ type: 'ship_result', blocked_gate: 'unknown', exit_code: 1 });
    const text = digest([...others, fail([item(3)]), result]);
    expect(text).toContain(
      `⚠ review:${REVIEWER} — finding recorded — read it before retrying: ${LENS} [${FP}] · 3 ${MANY}`,
    );
    expect(text).not.toContain('did NOT block');
  });
});

describe('an ID that cannot be matched to one item shows no count', () => {
  it('two IDs under one lens, whether both chunk items are inline or one spilled', () => {
    const chunked = [ONE_ID[0], { lens: LENS, fp: 'a5421e88403c' }];
    for (const items of [[item(2), item(2)], [item(2)]]) {
      const text = blockedOn(fail(items, chunked));
      expect(text).not.toContain(MANY);
      expect(text).toContain('Gate findings this run (1 gate(s) / 2 finding(s))');
    }
  });

  it('an event that dropped IDs for its byte budget, since a dropped one may share the lens', () => {
    const text = blockedOn({ ...fail([item(2)]), blocking_omitted: 4 });
    expect(text).not.toContain(MANY);
    expect(text).toContain('Gate findings this run (1 gate(s) / 5 finding(s))');
  });

  it('a waived sibling item of the same lens is not counted as blocking', () => {
    expect(blockedOn(fail([item(2, { disposition: 'waived' }), item(1)]))).toBe(UNCOUNTED);
  });

  it('issues recorded under another lens stay with that lens', () => {
    expect(blockedOn(fail([item(1), item(3, { lens: 'concurrency-races' })]))).toBe(UNCOUNTED);
  });

  it('a lens label the emitter cut, even when an item carries the same cut text', () => {
    const cut = `${'x'.repeat(119)}…`;
    const text = blockedOn(fail([item(2, { lens: cut })], [{ lens: cut, fp: FP }]));
    expect(text).toContain(`[${FP}] — the waive command is in the log`);
    expect(text).not.toContain(MANY);
  });
});

describe('an item vector the digest cannot trust', () => {
  /** Through the real JSONL boundary, so the value reaches the reader as it would live. */
  const fromSink = (fields: string): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'gate-digest-issues-')), 'gate-events.jsonl');
    const row = `{"ship_id":"${SHIP}","type":"review_result","reviewer":"${REVIEWER}","status":"fail","reason":"r","blocking":${JSON.stringify(ONE_ID)}${fields}}`;
    writeFileSync(file, [row, JSON.stringify(shipResult('review'))].join('\n'));
    return digest(readShipEvents(file, SHIP));
  };
  const plain = fromSink('');
  const two = '"issues":["src/a.ts:1 — a","src/a.ts:9 — b"]';

  it('reads a well-formed vector off the sink', () => {
    expect(fromSink(`,"items":[{"lens":"${LENS}","status":"fail",${two}}]`)).toContain(`2 ${MANY}`);
  });

  it.each([
    ['spilled to a sidecar', ',"items_ref":"transcripts/ship-1/items.json"'],
    ['a string', ',"items":"not-a-vector"'],
    ['an array-like object', ',"items":{"length":2,"0":{}}'],
    ['a null entry', `,"items":[null,{"lens":"${LENS}","status":"fail",${two}}]`],
    ['a lens that is an object', `,"items":[{"lens":{"toString":1},"status":"fail",${two}}]`],
    ['issues that are not text', `,"items":[{"lens":"${LENS}","status":"fail","issues":[1,2]}]`],
    ['an unknown status', `,"items":[{"lens":"${LENS}","status":"exploded",${two}}]`],
  ])('%s prints the uncounted row and never throws', (_name, fields) => {
    expect(fromSink(fields)).toBe(plain);
  });
});

describe('issuesUnder', () => {
  it('counts the one blocking item of the lens, with or without a recorded disposition', () => {
    expect(issuesUnder({ items: [item(3), PASSED] }, LENS)).toBe(3);
    expect(issuesUnder({ items: [{ lens: LENS, status: 'fail', issues: ['a', 'b'] }] }, LENS)).toBe(
      2,
    );
  });

  it('is unknown without a vector, without the lens, or with the lens twice', () => {
    expect(issuesUnder({}, LENS)).toBeNull();
    expect(issuesUnder({ items: [PASSED] }, LENS)).toBeNull();
    expect(issuesUnder({ items: [item(1), item(2)] }, LENS)).toBeNull();
  });
});
