import { describe, expect, it } from 'vitest';
import { phaseTimes } from './run.mts';

describe('phaseTimes', () => {
  it('times a lone setup phase until now', () => {
    expect(phaseTimes([{ name: 'setup', at: 1_000 }], 7_400)).toBe('setup 6s');
  });

  it('ends each phase where the next begins, the last at now, in whole seconds', () => {
    const marks = [
      { name: 'setup', at: 0 },
      { name: 'red', at: 6_200 },
      { name: 'green', at: 218_700 },
      { name: 'cleanup', at: 259_900 },
    ];
    expect(phaseTimes(marks, 260_300)).toBe('setup 6s, red 213s, green 41s, cleanup 0s');
  });
});
