import { describe, expect, it } from 'vitest';
import { renderAlsoStaged } from '../cascade/reviewer.mts';

describe('renderAlsoStaged', () => {
  it('names a staged file outside the review list as staged (a test reading an out-of-root template)', () => {
    const test = 'gate-engine/review/__tests__/empty-roots.test.mts';
    const template = 'templates/electron/guard.config.json';
    const line = renderAlsoStaged([test], [template, test]);
    expect(line).toContain(template);
    expect(line).not.toContain(test);
    expect(line).toContain('ARE staged');
  });

  it('never forbids calling a path missing, since a staged deletion an in-scope test reads IS missing', () => {
    expect(renderAlsoStaged(['a.test.ts'], ['a.test.ts', 'fixtures/deleted.json'])).not.toMatch(
      /missing/i,
    );
  });

  it('is empty when every staged file is in the review list', () => {
    expect(renderAlsoStaged(['a.ts', 'b.ts'], ['a.ts', 'b.ts'])).toBe('');
    expect(renderAlsoStaged(['a.ts'], [])).toBe('');
  });

  it('caps the list at 40 paths and counts the rest', () => {
    const others = Array.from({ length: 45 }, (_, i) => `other/${i}.ts`);
    const line = renderAlsoStaged(['a.ts'], ['a.ts', ...others]);
    expect(line).toContain('other/39.ts, and 5 more');
    expect(line).not.toContain('other/40.ts');
  });
});
