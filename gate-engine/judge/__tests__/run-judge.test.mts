import { describe, expect, it } from 'vitest';
import { unavailableMessage } from '../run-judge.mts';

// sc-1049: a 143/SIGTERM timeout-kill is the gate's OWN contention kill, NOT auth/quota. It must not
// read as "offline/quota/absent" (that label sent an operator chasing a phantom quota problem on a
// healthy subscription). unavailableMessage is the pure wording seam so this is testable without
// spawning `claude`.
describe('unavailableMessage', () => {
  it('a timeout kill reads as a timeout with the cap in seconds — never offline/quota/absent', () => {
    const msg = unavailableMessage('review:x', { killed: true }, 300000);
    expect(msg).toBe(
      '⚠️  review:x: claude judge timed out after 300s (machine contention?) — judgement skipped',
    );
    expect(msg).not.toContain('offline/quota/absent');
  });

  it('SIGTERM and ETIMEDOUT are timeouts too (all three isJudgeTimeout branches)', () => {
    for (const e of [{ signal: 'SIGTERM' }, { code: 'ETIMEDOUT' }]) {
      const msg = unavailableMessage('review:x', e, 420000);
      expect(msg).toContain('claude judge timed out after 420s (machine contention?)');
      expect(msg).not.toContain('offline/quota/absent');
    }
  });

  it('a genuine outage (ENOENT / non-zero exit) KEEPS the offline/quota/absent label', () => {
    expect(unavailableMessage('review:x', { code: 'ENOENT' })).toBe(
      '⚠️  review:x: claude judge unavailable (ENOENT; offline/quota/absent) — judgement skipped',
    );
    expect(unavailableMessage('review:x', { status: 401 })).toContain(
      '(exit 401; offline/quota/absent)',
    );
  });

  it('a timeout with no cap omits the "after Ns" segment (no double space)', () => {
    expect(unavailableMessage('review:x', { killed: true })).toBe(
      '⚠️  review:x: claude judge timed out (machine contention?) — judgement skipped',
    );
    // 0ms cap would be nonsense "after 0s" — also omitted.
    expect(unavailableMessage('review:x', { killed: true }, 0)).not.toContain('after');
  });
});
