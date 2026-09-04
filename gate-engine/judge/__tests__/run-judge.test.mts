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

  // The fused triple now splits wherever the provider says which cause applies. A bare non-zero
  // exit says nothing, so it keeps the honest residue label.
  it('an outage whose cause the provider did not state KEEPS the offline/quota/absent label', () => {
    expect(unavailableMessage('review:x', { status: 401 })).toContain(
      '(exit 401; offline/quota/absent)',
    );
    // A 401 with no explanatory text stays unclassified ON PURPOSE: an exit code alone is ambiguous
    // across these CLIs (codex exits 1 for quota), and guessing sends the operator to the wrong fix.
    expect(unavailableMessage('review:x', { status: 401 })).not.toContain('not authenticated');
  });

  it('a missing binary names itself instead of hiding in the fused triple', () => {
    const msg = unavailableMessage('review:x', { code: 'ENOENT' });
    expect(msg).toBe(
      '⚠️  review:x: claude judge unavailable — `claude` is not installed or not on PATH — judgement skipped',
    );
    expect(msg).not.toContain('offline/quota/absent');
  });

  // The failure this whole change exists for: a six-day lock that read as `(1; offline/quota/absent)`
  // and was then retried as "transient". The provider's own stdout said otherwise all along.
  it('a codex usage lock names the limit and the wait — and never the word transient', () => {
    // The reset is computed from NOW, never a literal date. unavailableMessage has no clock seam,
    // so a hardcoded instant would pass today and fail for real once the wall clock passed it.
    const reset = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const when = `${reset.toLocaleString('en-US', { month: 'short' })} ${reset.getDate()}, ${reset.getFullYear()} ${reset.getHours()}:${String(reset.getMinutes()).padStart(2, '0')}`;
    const stdout = JSON.stringify({
      type: 'turn.failed',
      error: {
        message: `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${when}.`,
      },
    });
    const msg = unavailableMessage('review:x', { status: 1, stdout }, undefined, 'codex');
    expect(msg).toContain('usage limit reached');
    expect(msg).toMatch(/resets in \d+[dhm]/);
    expect(msg).not.toContain('transient');
    expect(msg).not.toContain('offline/quota/absent');
  });

  it('a usage limit with no reset time says so rather than inventing one', () => {
    const msg = unavailableMessage('review:x', { status: 1, stderr: 'rate limit exceeded' });
    expect(msg).toContain('usage limit reached (no reset time given)');
  });

  it('a logged-out CLI is named as auth, not as quota', () => {
    const msg = unavailableMessage('review:x', { status: 1, stderr: 'Not logged in.' });
    expect(msg).toContain('is not authenticated');
    expect(msg).not.toContain('usage limit');
  });

  // Rule 2: execFileSync renders the full argv into the Node message, and a review judge's prompt
  // IS the staged diff — so a commit discussing rate limits must not read as rate-limited.
  it('never classifies from the Node error message, which carries the judge prompt', () => {
    const msg = unavailableMessage('review:x', {
      status: 1,
      message: "Command failed: claude -p 'fix the usage limit handling' --model haiku",
    });
    expect(msg).toContain('offline/quota/absent');
    expect(msg).not.toContain('usage limit reached');
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

  it('a genuine outage KEEPS the auth/quota remedy — that cause really is auth/quota', () => {
    expect(strictRemedy('outage')).toBe('check `claude` CLI auth/quota, then re-run devkit ship');
  });

  // The remedy that sc-2538's operator was given for six days was "re-run devkit ship", which could
  // not work. This arm must say the opposite and offer the one lever that ships during the window.
  it('a rate-limited remedy refuses the re-run advice and names the family override', () => {
    const r = strictRemedy('rate-limited', 'codex', Date.now() + 5 * 24 * 60 * 60 * 1000);
    expect(r).toContain('cannot succeed');
    expect(r).toMatch(/for another \d+d/);
    expect(r).toContain('devkit doctor --fix');
    expect(r).toContain('GUARD_REVIEW_MODEL');
  });

  it('a rate-limited remedy without a known reset still refuses to promise a re-run works', () => {
    const r = strictRemedy('rate-limited', 'codex');
    expect(r).toContain('until the limit resets');
    expect(r).not.toContain('then re-run devkit ship');
  });

  it('an outage remedy names the binary that went dark — codex outages must not say claude', () => {
    const r = strictRemedy('outage', 'codex');
    expect(r).toBe('check `codex` CLI auth/quota, then re-run devkit ship');
    expect(r).not.toContain('claude');
  });

  it('every cause yields a distinct remedy — no two gates can print the same wrong line', () => {
    const all = (['timeout', 'sync', 'outage', 'rate-limited'] as const).map((c) =>
      strictRemedy(c),
    );
    expect(new Set(all).size).toBe(4);
  });
});
