import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeFamilyEnvLine,
  familyOverrideRemedy,
  JUDGE_MODEL_ENVS,
  judgeEnvUnsetLine,
} from '../outage/family-override.mts';
import { strictRemedy, unavailableMessage } from '../run-judge.mts';

// A developer who pins a codex build exports GUARD_CODEX_BIN, which turns the bare word "codex" into
// an unknown bin; isolate it so every remedy assertion below reads the same resolution.
let savedCodexBin: string | undefined;
beforeEach(() => {
  savedCodexBin = process.env.GUARD_CODEX_BIN;
  delete process.env.GUARD_CODEX_BIN;
});
afterEach(() => {
  if (savedCodexBin === undefined) delete process.env.GUARD_CODEX_BIN;
  else process.env.GUARD_CODEX_BIN = savedCodexBin;
});

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

  it('a genuine outage LEADS with the auth/quota remedy — that cause really is auth/quota', () => {
    expect(
      strictRemedy('outage').startsWith('check `claude` CLI auth/quota, then re-run devkit ship'),
    ).toBe(true);
  });

  // The generic cause also covers an ABSENT binary — the one state doctor --fix can bind — so the
  // escape hatch has to be reachable from here, not only from the rate-limited arm.
  it('a genuine outage also names the escape hatch, in full', () => {
    const r = strictRemedy('outage', 'codex');
    expect(r).toContain('GUARD_REVIEW_MODEL=haiku');
    expect(r).toContain('GUARD_CORRECTNESS_CHUNK=off');
    expect(r).toContain('devkit doctor --fix');
    expect(r).toContain('cached PASS is discarded');
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

  // The DIAGNOSIS half must name only the dark binary: "check claude auth" on a codex outage sends
  // the operator to the wrong subscription. The redirect half may name the other family, never to authenticate.
  it('an outage remedy names the binary that went dark — codex outages must not send you to claude auth', () => {
    const r = strictRemedy('outage', 'codex');
    const diagnosis = r.slice(0, r.indexOf(familyOverrideRemedy('codex')));
    expect(diagnosis).toContain('check `codex` CLI auth/quota, then re-run devkit ship');
    expect(diagnosis).not.toContain('claude');
    expect(r).not.toContain('check `claude`');
    expect(r).not.toContain('claude CLI auth');
  });

  // run-review builds a COMPOUND bin when one judge's two models span both families. Either may be
  // the dark one, so offering EITHER family could send the operator straight into the outage.
  it('a compound dark bin names no family move — either provider may be the dark one', () => {
    const r = strictRemedy('outage', 'codex` or `claude');
    expect(r).toContain('no family move is safe yet');
    expect(r).not.toContain('move the judges to the claude family');
    expect(r).not.toContain('the packaged codex family');
    expect(r).not.toContain('GUARD_REVIEW_MODEL=haiku');
  });

  // Both directions must move a PINNED sentry judge too, or following the remedy is a partial move.
  it('each direction tells the operator to move a pinned sentry judge as well', () => {
    expect(familyOverrideRemedy('claude')).toContain('GUARD_SENTRY_MODEL FRINK_SENTRY_MODEL');
    // Unsetting alone reveals a doctor-bound claude family in guard.config.json: both steps, not either.
    expect(familyOverrideRemedy('claude')).toContain('AND delete any review.model');
    expect(familyOverrideRemedy('codex')).toContain('unset GUARD_SENTRY_MODEL FRINK_SENTRY_MODEL');
  });

  // A remedy is only a remedy if it RUNS. `env` lists exported variables alone, so a bare
  // `VAR=x` line — set in the shell, invisible to `devkit ship` — fails here exactly as it does in use.
  it('the printed export and unset commands really set and clear every knob in a child shell', () => {
    const runEnv = (cmd: string, seed: Record<string, string> = {}) =>
      execFileSync('sh', ['-c', `${cmd} && env`], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...seed },
      }).split('\n');
    // Seed a sentry pin under BOTH spellings: one printed command has to move that judge as well.
    const set = runEnv(claudeFamilyEnvLine(), {
      GUARD_SENTRY_MODEL: 'gpt-5.6-sol',
      FRINK_SENTRY_MODEL: 'gpt-5.6-sol',
    });
    expect(set.some((l) => /^(GUARD|FRINK)_SENTRY_MODEL=/.test(l))).toBe(false);
    for (const pair of [
      'GUARD_REVIEW_MODEL=haiku',
      'GUARD_REVIEW_ESCALATION_MODEL=opus',
      'GUARD_CORRECTNESS_MODEL=sonnet',
      'GUARD_CORRECTNESS_CHUNK=off',
    ])
      expect(set).toContain(pair);
    const pinned = Object.fromEntries(JUDGE_MODEL_ENVS.map((k) => [k, 'gpt-5.6-sol']));
    const cleared = runEnv(judgeEnvUnsetLine(), pinned);
    for (const k of JUDGE_MODEL_ENVS)
      expect(cleared.some((l) => l.startsWith(`${k}=`))).toBe(false);
    // The remedy prints these exact commands, not a paraphrase of them.
    expect(familyOverrideRemedy('codex')).toContain(`\`${claudeFamilyEnvLine()}\``);
    expect(familyOverrideRemedy('claude')).toContain(`\`${judgeEnvUnsetLine()}\``);
  });

  // With GUARD_CODEX_BIN set the dark bin is a PATH, not the word "codex". Reading that as unknown
  // withheld the four-knob hatch from exactly the operators who pinned a codex build.
  it('a GUARD_CODEX_BIN path still reads as codex — its outage offers the claude move', () => {
    process.env.GUARD_CODEX_BIN = '/opt/codex-0.151/bin/codex';
    const pinned = '/opt/codex-0.151/bin/codex';
    expect(familyOverrideRemedy(pinned)).toContain('move the judges to the claude family');
    expect(strictRemedy('rate-limited', pinned)).toContain(claudeFamilyEnvLine());
    // Once pinned, the bare word no longer names the codex build the gate would spawn.
    expect(familyOverrideRemedy('codex')).toContain('no family move is safe yet');
    expect(familyOverrideRemedy(`${pinned}\` or \`claude`)).toContain('no family move is safe yet');
  });

  // GUARD_CODEX_BIN=claude gives a codex judge the bin `claude` too, so that bin cannot say which is dark.
  it('a codex bin pinned to the literal name claude is ambiguous, never read as the claude route', () => {
    process.env.GUARD_CODEX_BIN = 'claude';
    expect(familyOverrideRemedy('claude')).toContain('no family move is safe yet');
  });

  it('each direction fires only on its exact bin; anything else offers no move', () => {
    expect(familyOverrideRemedy('claude')).toContain('the packaged codex family');
    expect(familyOverrideRemedy('codex')).toContain('move the judges to the claude family');
    for (const unknown of ['claude-code', 'CODEX', ''])
      expect(familyOverrideRemedy(unknown)).toContain('no family move is safe yet');
  });

  // Never a subset: a three-knob move runs the correctness reviewer at a cap benched for sol only.
  it('the claude direction always names all four knobs together', () => {
    const r = familyOverrideRemedy('codex');
    for (const knob of [
      'GUARD_REVIEW_MODEL=haiku',
      'GUARD_REVIEW_ESCALATION_MODEL=opus',
      'GUARD_CORRECTNESS_MODEL=sonnet',
      'GUARD_CORRECTNESS_CHUNK=off',
    ])
      expect(r).toContain(knob);
  });

  it('every cause yields a distinct remedy — no two gates can print the same wrong line', () => {
    const all = (['timeout', 'sync', 'outage', 'rate-limited'] as const).map((c) =>
      strictRemedy(c),
    );
    expect(new Set(all).size).toBe(4);
  });
});
