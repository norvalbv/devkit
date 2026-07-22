import { describe, expect, it } from 'vitest';
import { flagReader } from '../argv.mts';

// Both gates coerce these values with Number(...), so a reader that can return undefined turns a
// malformed command line into a NaN threshold — and every comparison against NaN is false, which
// silently disables the tier it gates rather than erroring.
describe('flagReader', () => {
  it('reads the token after the flag', () => {
    expect(flagReader(['--min-loc', '2'])('--min-loc', 15)).toBe('2');
  });

  it('falls back to the default when the flag is absent', () => {
    expect(flagReader(['--other', '1'])('--min-loc', 15)).toBe(15);
  });

  it('falls back when the flag is the LAST token, with no value after it', () => {
    expect(flagReader(['--min-loc'])('--min-loc', 15)).toBe(15);
    expect(Number(flagReader(['--min-loc'])('--min-loc', 15))).not.toBeNaN();
  });

  it('reads the first occurrence when a flag is repeated', () => {
    expect(flagReader(['--min-loc', '2', '--min-loc', '9'])('--min-loc', 15)).toBe('2');
  });
});
