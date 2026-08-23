import { describe, expect, it } from 'vitest';
import { strictRemedy, unavailableMessage } from '../run-judge.mts';

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

// sc-1227: the gate-level SKIP lines never learned sc-1049's lesson — every fail-closed gate printed
// "check `claude` CLI auth/quota" no matter the cause, and a 420s cap kill sent the operator there
// on a healthy CLI. One wording seam, branched on the actual cause.
describe('strictRemedy', () => {
  it('a timeout says so explicitly and rules auth/quota OUT', () => {
    const r = strictRemedy('timeout');
    expect(r).toContain('hit its time cap');
    expect(r).toContain('NOT an auth/quota problem');
    expect(r).not.toContain('check `claude` CLI auth/quota');
  });

  it('the timeout remedy names the levers that actually work', () => {
    const r = strictRemedy('timeout');
    expect(r).toContain('Re-run `devkit ship`');
    expect(r).toContain('600s agent tool cap'); // the real killer for an agent-driven commit
    expect(r).toContain('smaller commit');
  });

  it('a sync gap points at the sync commands, not at the CLI', () => {
    expect(strictRemedy('sync')).toContain('devkit sync-agents && devkit sync-skills');
    expect(strictRemedy('sync')).not.toContain('auth/quota');
  });

  it('an evidence gap names the conventions protocol, not auth or quota', () => {
    const r = strictRemedy('evidence');
    expect(r).toContain('complete cited VIOLATION/OFFENDING pair');
    expect(r).toContain('inspect the transcript above');
    expect(r).not.toContain('auth/quota');
  });

  it('a genuine outage KEEPS the auth/quota remedy — that cause really is auth/quota', () => {
    expect(strictRemedy('outage')).toBe('check `claude` CLI auth/quota, then re-run devkit ship');
  });

  it('every cause yields a distinct remedy — no two gates can print the same wrong line', () => {
    const all = (['timeout', 'sync', 'evidence', 'outage'] as const).map(strictRemedy);
    expect(new Set(all).size).toBe(4);
  });
});
