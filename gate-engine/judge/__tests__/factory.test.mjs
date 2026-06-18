import { describe, expect, it } from 'vitest';
import { gateExit, makeJudgeGate, makeVerdictParser } from '../factory.mjs';

describe('makeVerdictParser', () => {
  const parse = makeVerdictParser(['FIT', 'DRIFT', 'OUT']);

  it('parses a clean single-word verdict', () => {
    expect(parse('OUT')).toBe('OUT');
    expect(parse('  fit  ')).toBe('FIT');
  });

  it('uses word boundaries — "about"/"benefit" do not match OUT/FIT', () => {
    // Substring includes() would misread "about" as OUT and "benefit" as FIT.
    expect(parse('this is about the design')).toBeNull();
    expect(parse('a clear benefit here')).toBeNull();
  });

  it('returns null on an ambiguous reply (two distinct verdicts)', () => {
    expect(parse('OUT but really FIT')).toBeNull();
  });

  it('returns null on unknown / empty', () => {
    expect(parse('MAYBE')).toBeNull();
    expect(parse('')).toBeNull();
  });

  it('firstLineOnly reads only the first line (verdict + why-line shape)', () => {
    const head = makeVerdictParser(['MONITOR', 'SKIP'], { firstLineOnly: true });
    expect(head('MONITOR\nexecutor / dead-chat signal path')).toBe('MONITOR');
    // A why-line containing the OTHER verdict word must not flip a first-line MONITOR.
    expect(head('MONITOR\nthis is safe to SKIP otherwise')).toBe('MONITOR');
  });

  it('whole-reply mode (default) scans every line', () => {
    expect(parse('reasoning here\nverdict: OUT')).toBe('OUT');
  });

  it('throws on an empty vocabulary', () => {
    expect(() => makeVerdictParser([])).toThrow();
  });
});

describe('gateExit (warn-by-default mapping)', () => {
  it('blocks ONLY on hard mode AND the block-verdict', () => {
    expect(gateExit('OUT', true, 'OUT')).toBe(1);
  });

  it('warns (exit 0) on the block-verdict without hard mode', () => {
    expect(gateExit('OUT', false, 'OUT')).toBe(0);
  });

  it('passes any non-block verdict even in hard mode', () => {
    expect(gateExit('DRIFT', true, 'OUT')).toBe(0);
    expect(gateExit('FIT', true, 'OUT')).toBe(0);
  });

  it('passes a null verdict (fail toward not blocking)', () => {
    expect(gateExit(null, true, 'OUT')).toBe(0);
  });
});

describe('makeJudgeGate validation', () => {
  const base = {
    label: 'demo',
    prompt: 'judge it',
    verdicts: ['FIT', 'OUT'],
    blockVerdict: 'OUT',
    readInput: () => '',
    env: { skip: 'X_SKIP', noLlm: 'X_NO_LLM', hard: 'X_HARD' },
  };

  it('builds a gate with all required params', () => {
    const g = makeJudgeGate(base);
    expect(typeof g.run).toBe('function');
    expect(g.parse('OUT')).toBe('OUT');
  });

  it('throws when a required param is missing', () => {
    expect(() => makeJudgeGate({ ...base, prompt: '' })).toThrow(/prompt/);
    expect(() => makeJudgeGate({ ...base, env: { skip: 'X', noLlm: 'Y' } })).toThrow(/env\.hard/);
  });

  it('throws when blockVerdict is not in the vocab', () => {
    expect(() => makeJudgeGate({ ...base, blockVerdict: 'NOPE' })).toThrow(
      /not in the verdict vocab/,
    );
  });
});
