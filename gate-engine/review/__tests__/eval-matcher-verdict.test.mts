import { describe, expect, it } from 'vitest';
import { parseFindings } from '../eval/matcher.mts';

const FINDING = 'CRITICAL: bug | a.ts:1 | boom';
const contextAfter = (line: string) => parseFindings(`${FINDING}\n${line}`).findings[0].context;

describe('parseFindings verdict line', () => {
  it.each([
    'VERDICT: FAIL — bug',
    '✅ VERDICT: PASS',
    '⚠️ **VERDICT**: FAIL',
    '> **VERDICT:** FAIL',
    '✅ VERDICT: PASS\r',
    '\rVERDICT: FAIL',
  ])('skips %s instead of reading it as finding context', (line) => {
    expect(contextAfter(line)).toEqual([]);
  });

  it.each(['\r\n', '\r'])('parses a finding line ended by %j before the verdict', (eol) => {
    const { findings } = parseFindings(`${FINDING}${eol}VERDICT: FAIL${eol}`);
    expect(findings).toEqual([
      { severity: 'CRITICAL', desc: 'bug', paths: 'a.ts:1', impact: 'boom', context: [] },
    ]);
  });

  it.each(['see VERDICT: FAIL above', 'sVERDICT: FAIL', '`VERDICT: FAIL` is the closing line'])(
    'keeps a verdict mention that does not open its line as context: %s',
    (line) => {
      expect(contextAfter(line)).toEqual([line]);
    },
  );
});
