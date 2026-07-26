import { describe, expect, it } from 'vitest';
import { renderTarget } from '../decision-format.mts';
import { CATEGORIES, isCategory, validateCategory } from '../recall/categories.mts';

// A minimal valid Target field set (Context/Ruling/Consequences/Tradeoff/Vision-fit) — the
// required spine renderTarget checks nothing else about here, only Category.
const minTarget = (category: string) => ({
  context: 'c',
  ruling: 'r',
  consequences: 'v',
  tradeoff: 't',
  visionFit: 'f',
  category,
});

describe('validateCategory / isCategory', () => {
  it('accepts every frozen category', () => {
    for (const category of CATEGORIES) {
      expect(isCategory(category)).toBe(true);
      expect(validateCategory(category)).toBeNull();
    }
  });

  it('rejects an unknown value, naming the allowed list', () => {
    expect(isCategory('made-up-category')).toBe(false);
    const err = validateCategory('made-up-category');
    expect(err).toContain('Unknown category "made-up-category"');
    // The whole point of a closed vocabulary is a caller can read the allowed values off the
    // error — not just learn that it failed.
    for (const category of CATEGORIES) expect(err).toContain(category);
  });

  it('rejects the empty string (never treated as "no category given")', () => {
    expect(validateCategory('')).not.toBeNull();
  });
});

describe('renderTarget + Category (write-time enforcement)', () => {
  it('renders **Category:** when given a frozen value', () => {
    const block = renderTarget('2026-07-26', minTarget('commit-gates'));
    expect(block).toContain('**Category:** commit-gates');
  });

  it('omits **Category:** entirely when none is given', () => {
    const block = renderTarget('2026-07-26', {
      context: 'c',
      ruling: 'r',
      consequences: 'v',
      tradeoff: 't',
      visionFit: 'f',
    });
    expect(block).not.toContain('**Category:**');
  });

  it('throws on an unknown category rather than writing it silently', () => {
    expect(() => renderTarget('2026-07-26', minTarget('not-a-real-category'))).toThrow(
      /Unknown category/,
    );
  });
});
