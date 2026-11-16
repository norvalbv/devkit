import { describe, expect, it } from 'vitest';
import { parseModelSpec } from '../codex/model-spec.mts';

describe('parseModelSpec — model@effort', () => {
  it('splits a reasoning-effort suffix and leaves a bare id untouched', () => {
    expect(parseModelSpec('gpt-5.6-terra@high')).toEqual({
      model: 'gpt-5.6-terra',
      effort: 'high',
    });
    expect(parseModelSpec('gpt-5.6-sol')).toEqual({ model: 'gpt-5.6-sol', effort: null });
  });
  it('refuses an unknown effort or an empty model rather than spawning at the wrong effort', () => {
    expect(() => parseModelSpec('gpt-5.6-terra@ultra')).toThrow(/unknown reasoning effort "ultra"/);
    expect(() => parseModelSpec('@high')).toThrow(/model spec/);
    expect(() => parseModelSpec('gpt@5.6@high')).toThrow(/model spec/); // multiple separators
    expect(() => parseModelSpec('gpt-5.6-terra@')).toThrow(/model spec/);
  });
});
