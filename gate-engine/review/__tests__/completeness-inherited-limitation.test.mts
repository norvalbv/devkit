/** The completeness judge inherits a limitation the unchanged code already documents as accepted,
 *  but never when the commit overclaims past it or writes that note itself. */
import { describe, expect, it } from 'vitest';
import { wrapCompleteness } from '../completeness.mts';

const prompt = wrapCompleteness('brief', 'feat: x', ['a.ts'], 'targets');

describe('wrapCompleteness — inherited accepted limitations', () => {
  it('treats a HEAD-documented limitation in reused, unchanged code as inherited', () => {
    expect(prompt).toContain('A limitation a code comment present at HEAD records as accepted');
    expect(prompt).toContain('in code this commit reuses unchanged, is inherited, not a gap');
  });

  it('still flags a message that claims a guarantee the limitation rules out', () => {
    expect(prompt).toContain('IS one if the message claims a guarantee it rules out');
  });

  it('does not honour a note this diff adds or edits', () => {
    expect(prompt).toContain('or this diff adds or edits that note');
  });

  it('keeps the inheritance rule ahead of the single VERDICT line', () => {
    const rule = prompt.indexOf('is inherited, not a gap');
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(prompt.indexOf('VERDICT:'));
    expect(prompt.match(/^VERDICT: PASS \| FAIL/gm)).toHaveLength(1);
  });
});
