// The prior-art subagent runs from its agent file alone and never loads the skill, so the
// linked-worktree fallback must live in the agent's own mandatory Phase 0.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveGuardConfigJson } from '../../config.mts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** The Phase 0 section of the agent file: from its heading to the next phase heading. */
function phaseZero(agent: string): string {
  const start = agent.indexOf('### Phase 0');
  const end = agent.indexOf('### Phase 1', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return agent.slice(start, end);
}

describe('prior-art agent: reference checkouts resolve from a linked worktree', () => {
  const phase0 = phaseZero(read('agents/prior-art.md'));

  it('retries an unmatched pattern against the main worktree, skipping a bare one', () => {
    expect(phase0).toContain('LINKED worktree');
    expect(phase0).toContain('git worktree list --porcelain');
    expect(phase0).toContain('`bare`');
  });

  it('counts only non-blank string patterns, and skips an unresolved one silently', () => {
    expect(phase0).toContain('non-blank string patterns');
    expect(phase0).toContain('skipped silently and counts only as declared');
  });

  it('Q6 carries what an earlier attempt at the same problem cost', () => {
    const q6 = read('agents/prior-art.md').split('**Q6 — Cost symmetry.**')[1]?.split('**Q7')[0];
    expect(q6).toContain('earlier PR, branch or commit');
    expect(q6).toContain('review rounds, rewrites or');
  });

  it('ships the same text to every synced agent surface', () => {
    const source = read('agents/prior-art.md');
    expect(read('.claude/agents/prior-art.md')).toBe(source);
    expect(read('.cursor/agents/prior-art.md')).toBe(source);
  });
});

describe('resolveGuardConfig: research.referenceCheckouts', () => {
  /** The resolved list for a guard.config.json whose referenceCheckouts is this raw JSON text. */
  const resolve = (json: string) =>
    resolveGuardConfigJson(`{"research":{"referenceCheckouts":${json}}}`, '/repo').research
      .referenceCheckouts;

  it('keeps declared globs verbatim', () => {
    expect(resolve('["../a", "cloned/*"]')).toEqual(['../a', 'cloned/*']);
  });

  it('drops entries that cannot name a directory, so none of them counts as a declaration', () => {
    expect(resolve('["", "  ", 42, null, {}, "../a"]')).toEqual(['../a']);
    expect(resolve('["", "  "]')).toEqual([]);
  });

  it('reads a non-list value, or none at all, as nothing declared', () => {
    expect(resolve('"../a"')).toEqual([]);
    expect(resolveGuardConfigJson('{}', '/repo').research.referenceCheckouts).toEqual([]);
  });
});
