import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readShipEvents, render, summarise } from './gate-digest.mts';

const SHIP = 'ship-1';
const FP = 'aaaaaaaaaaaa';
const FP2 = 'bbbbbbbbbbbb';
const RLO = String.fromCharCode(0x202e);
const JUDGE = 'review:correctness-reviewer';

interface Waiver {
  lens: string;
  fingerprint: string;
  rationale?: string;
}

function waiver(fingerprint: string, lens: string, rationale?: string): Waiver {
  const w: Waiver = { lens, fingerprint };
  if (rationale !== undefined) w.rationale = rationale;
  return w;
}

const list = (...waivers: Waiver[]): string => JSON.stringify(waivers);
/** A sink row as JSONL text, so a hostile `waivers` value reaches the reader raw. */
const row = (fields: string): string => `{"ship_id":"${SHIP}",${fields}}`;
const review = (status: string, waivers: string, extra = ''): string =>
  row(
    `"type":"review_result","reviewer":"correctness-reviewer","status":"${status}","waivers":${waivers}${extra}`,
  );
const cacheHit = (waivers: string, extra = '', judge = JUDGE): string =>
  row(`"type":"cache_hit","judge":${JSON.stringify(judge)},"waivers":${waivers}${extra}`);
const GREEN = row('"type":"ship_result","blocked_gate":null,"exit_code":0');

/** Through the real JSONL boundary, so each value reaches the digest as it would live. */
const digest = (...rows: string[]): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-digest-waived-')), 'gate-events.jsonl');
  writeFileSync(file, rows.join('\n'));
  return render(summarise(readShipEvents(file, SHIP), SHIP));
};

describe('a reviewer PASS that rests on waivers', () => {
  it('prints one non-blocking row per waived finding on an otherwise green run', () => {
    const text = digest(
      review(
        'pass',
        list(waiver(FP, 'concurrency-races', 'one writer'), waiver(FP2, 'state', 'ok')),
      ),
      GREEN,
    );
    expect(text.split('\n')).toEqual([
      '📋 Gate findings this run (1 gate(s) / 0 finding(s)):',
      `   · ${JUDGE} — concurrency-races waived [${FP}]: one writer`,
      `   · ${JUDGE} — state waived [${FP2}]: ok`,
    ]);
  });

  it('names a waiver replayed from the review cache beside its drifted-base row', () => {
    const drift = ',"base_state":"moved-overlap","judged_base_sha":"abcdef1234567"';
    const text = digest(cacheHit(list(waiver(FP, 'concurrency-races')), drift), GREEN);
    expect(text).toContain(`· ${JUDGE} — cached PASS judged against abcdef123456`);
    expect(text).toContain(`· ${JUDGE} — concurrency-races waived [${FP}] (cached PASS)`);
  });

  it('says a waiver without a rationale was replayed, never leaving a dangling colon', () => {
    const text = digest(
      review('pass', list(waiver(FP, 'races'), waiver(FP2, 'state', '  '))),
      GREEN,
    );
    expect(text).toContain(`races waived [${FP}] (cached PASS)`);
    expect(text).toContain(`state waived [${FP2}] (cached PASS)`);
    expect(text).not.toContain(']: ');
  });

  it('keeps the rationale when the same waiver is also replayed from cache', () => {
    const cached = cacheHit(list(waiver(FP, 'races')));
    const text = digest(cached, review('pass', list(waiver(FP, 'races', 'why'))), cached, GREEN);
    expect(text.match(/waived/g)).toHaveLength(1);
    expect(text).toContain(`races waived [${FP}]: why`);
  });

  it('a clean PASS still prints nothing', () => {
    expect(digest(review('pass', 'null'), GREEN)).toBe('');
    expect(digest(review('pass', '[]'), cacheHit('null'), GREEN)).toBe('');
  });

  it('never names a waiver from an earlier attempt of the same ship, or from another ship', () => {
    const attempt = row('"type":"ship_attempt"');
    const other = `{"ship_id":"ship-2","type":"review_result","status":"pass","waivers":${list(waiver(FP2, 'state', 'b'))}}`;
    const stale = review('pass', list(waiver(FP, 'races', 'revoked since')));
    expect(digest(attempt, stale, attempt, other, review('pass', '[]'), GREEN)).toBe('');
  });

  it('keeps the fingerprint whole when the lens and rationale run long', () => {
    const text = digest(review('pass', list(waiver(FP, 'l'.repeat(400), 'r'.repeat(400)))), GREEN);
    const line = text.split('\n')[1] ?? '';
    expect(line).toContain(`… waived [${FP}]: `);
    expect(line.length).toBeLessThan(340);
  });
});

describe('a blocked reviewer that also waived findings', () => {
  it('lists the waived IDs beside the blocker without counting or blocking them', () => {
    const text = digest(
      review(
        'fail',
        list(waiver(FP, 'races', 'a'), waiver(FP2, 'state', 'b')),
        ',"blocking":[{"lens":"leaks","fp":"cccccccccccc"}]',
      ),
      row('"type":"ship_result","blocked_gate":"review","exit_code":1'),
    );
    expect(text).toContain('Gate findings this run (1):'); // one reviewer, one ID to clear
    expect(text).toContain(`✗ ${JUDGE} — BLOCKED this run: leaks [cccccccccccc]`);
    expect(text).toContain(`   · ${JUDGE} — races waived [${FP}]: a`);
    expect(text).toContain(`   · ${JUDGE} — state waived [${FP2}]: b`);
    expect(text.match(/BLOCKED/g)).toHaveLength(1);
  });
});

describe('untrusted waiver fields', () => {
  it('flattens control bytes and bidi in the lens, rationale and judge to one line', () => {
    const text = digest(
      cacheHit(list(waiver(FP, 'ra\u001b[31mces\nx')), '', `review:evil\n${RLO}reviewer`),
      review('pass', list(waiver(FP2, 'state', 'line one\nline two \u0007'))),
      GREEN,
    );
    // Header, two waived rows, and the cache_hit's own `✓ served from cache` line.
    expect(text.split('\n')).toHaveLength(4);
    for (const ch of ['\u0007', '\u001b', RLO]) expect(text).not.toContain(ch);
    expect(text).toContain(`[${FP}] (cached PASS)`);
    expect(text).toContain(`state waived [${FP2}]: line one line two`);
  });

  it.each([
    ['a non-array list', '"nope"'],
    ['an object list', `{"0":{"lens":"x","fingerprint":"${FP}"}}`],
    ['null entries', '[null,7,"x"]'],
    ['a malformed fingerprint', '[{"lens":"x","fingerprint":"AAAAAAAAAAAA"}]'],
    ['a non-string fingerprint', '[{"lens":"x","fingerprint":{"toString":1}}]'],
  ])('drops %s without throwing', (_name, waivers) => {
    expect(digest(review('pass', waivers), GREEN)).toBe('');
  });

  it('labels a waiver whose lens is not a string', () => {
    const text = digest(
      review('pass', `[{"lens":5,"fingerprint":"${FP}","rationale":"r"}]`),
      GREEN,
    );
    expect(text).toContain(`(finding) waived [${FP}]: r`);
  });
});
