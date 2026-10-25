// The completeness judge's closing instruction: one FAIL discloses every material gap, bounded.
import { describe, expect, it } from 'vitest';
import { wrapCompleteness } from '../completeness.mts';

describe('wrapCompleteness closing instruction', () => {
  const prompt = wrapCompleteness('brief', 'feat: x', ['a.ts'], 'targets');

  it('keeps reviewing after the first gap and lists every gap, bounded', () => {
    expect(prompt).toContain('A found gap does not end the review');
    expect(prompt).toContain('list EVERY gap');
    expect(prompt).toContain('at most 12 lines');
    expect(prompt).toContain('Never list to fill');
  });

  it('asks for the full list before the verdict line, and the FAIL bar is unchanged', () => {
    expect(prompt.indexOf('list EVERY gap')).toBeLessThan(prompt.indexOf('VERDICT: PASS | FAIL'));
    expect(prompt).toContain('on FAIL the most severe gap first, then the gap count');
    expect(prompt.endsWith('makes the shipped change misleading or operationally unsafe.')).toBe(
      true,
    );
  });
});
