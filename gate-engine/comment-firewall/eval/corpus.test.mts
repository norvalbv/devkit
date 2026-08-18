import { describe, expect, it } from 'vitest';
import { loadCorpus } from './run.mts';

describe('comment-firewall focused corpus', () => {
  it('has balanced, uniquely named PASS/FAIL cases with specific rationales', () => {
    const rows = loadCorpus();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.filter((row) => row.expected === 'PASS').length).toBeGreaterThanOrEqual(4);
    expect(rows.filter((row) => row.expected === 'FAIL').length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      expect(row.comment.length).toBeGreaterThan(5);
      expect(row.rationale.length).toBeGreaterThan(20);
    }
  });
});
