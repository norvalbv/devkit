import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findingTally } from '../../../../gate-engine/review/contracts/response.mts';
import { readShipEvents, render, summarise } from './gate-digest.mts';

const SHIP = 'ship-1';
const HEADLINE = 'moving an importer out of the alias root does not enforce aliases';
const SUFFIX = 'each listed in the log — fix them all';
const FLEET = `{"ship_id":"${SHIP}","type":"review_result","reviewer":"correctness","status":"fail","reason":"r"}`;
const RESULT = `{"ship_id":"${SHIP}","type":"ship_result","blocked_gate":"review"}`;
/** A completeness FAIL row as JSONL text, `tally` spliced in raw so a hostile value reaches the reader. */
const completeness = (tally = ''): string =>
  `{"ship_id":"${SHIP}","type":"gate_result","gate":"completeness","family":"review","status":"fail","detail":"${HEADLINE}"${tally && `,"tally":${tally}`}}`;

/** Through the real JSONL boundary, so each value reaches the digest as it would live. */
const digest = (...rows: string[]): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'gate-digest-tally-')), 'gate-events.jsonl');
  writeFileSync(file, rows.join('\n'));
  return render(summarise(readShipEvents(file, SHIP), SHIP));
};
const UNCOUNTED = digest(FLEET, completeness(), RESULT);

describe('a completeness FAIL whose judge listed several findings', () => {
  it('says how many sit behind the headline, and counts them in the header', () => {
    const text = digest(FLEET, completeness('{"critical":1,"important":1}'), RESULT);
    expect(text).toContain('Gate findings this run (2 gate(s) / 3 finding(s))');
    expect(text).toContain(
      `⚠ completeness — finding recorded, did NOT block this run — read it before retrying: ${HEADLINE} · 2 findings (1 critical, 1 important), ${SUFFIX}`,
    );
  });

  it('keeps the count on the row when completeness is the blocker', () => {
    const text = digest(completeness('{"critical":0,"important":3}'), RESULT);
    expect(text).toContain(
      `✗ completeness — BLOCKED this run: ${HEADLINE} · 3 findings (0 critical, 3 important), ${SUFFIX}`,
    );
  });

  it('leaves a single finding, or a row with no tally, exactly as it was', () => {
    expect(UNCOUNTED.endsWith(`read it before retrying: ${HEADLINE}`)).toBe(true);
    for (const tally of ['{"critical":1,"important":0}', '{"critical":0,"important":0}', '{}']) {
      expect(digest(FLEET, completeness(tally), RESULT)).toBe(UNCOUNTED);
    }
  });

  it.each([
    ['a string', '"two"'],
    ['null', 'null'],
    ['an array', '[2,2]'],
    ['string counts', '{"critical":"1","important":"1"}'],
    ['a negative count', '{"critical":-1,"important":1}'],
    ['a coercing object', '{"critical":{"valueOf":1,"toString":1},"important":1}'],
  ])('a tally that is %s prints the uncounted row and never throws', (_name, tally) => {
    expect(digest(FLEET, completeness(tally), RESULT)).toBe(UNCOUNTED);
  });
});

describe('findingTally', () => {
  const lines = (...l: string[]) => l.join('\n');

  it('counts prefixed CRITICAL and IMPORTANT lines through markdown dressing, never LOW', () => {
    const raw = lines('**CRITICAL**: a | x.ts', '- IMPORTANT: b', '### IMPORTANT: c', 'LOW: d');
    expect(findingTally(raw)).toEqual({ critical: 1, important: 2 });
  });

  it("takes the judge's own ISSUES tally when its gap lines carry no severity prefix", () => {
    const raw = lines(
      '1. the alias rule is unenforced',
      '2. SKILL.md drifted',
      'ISSUES: 1 critical, 1 important, 0 low',
    );
    expect(findingTally(raw)).toEqual({ critical: 1, important: 1 });
  });

  it('takes the larger count per severity when lines and tally disagree', () => {
    const raw = lines('CRITICAL: a', 'CRITICAL: b', 'ISSUES: 1 critical, 2 important, 0 low');
    expect(findingTally(raw)).toEqual({ critical: 2, important: 2 });
  });

  it('reads the last ISSUES line, so a judge that revised its tally is counted as revised', () => {
    const raw = lines(
      'ISSUES: 0 critical, 0 important, 0 low',
      'ISSUES: 1 critical, 2 important, 0 low',
    );
    expect(findingTally(raw)).toEqual({ critical: 1, important: 2 });
  });

  it('reads CRLF transcripts, and ignores a severity word in prose', () => {
    expect(findingTally('IMPORTANT: a\r\nIMPORTANT: b\r\n')).toEqual({ critical: 0, important: 2 });
    expect(findingTally('this is a CRITICAL gap\nVERDICT: FAIL — x')).toEqual({
      critical: 0,
      important: 0,
    });
  });
});
