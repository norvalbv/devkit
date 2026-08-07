/**
 * The `--output-format json` envelope reader (sc-1527). Two things ride on it: every judge's caller
 * still receives plain verdict text, and the spend it now bills is the spend of THAT run.
 *
 * The failure mode worth guarding is not a crash — it is a plausible zero. A judge whose envelope
 * could not be read must record NO usage rather than a free-looking one, because a zero row is
 * indistinguishable from a real cheap run once it is aggregated.
 */
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_RESULT_ARGS,
  parseJudgeUsage,
  unwrapClaudeResult,
  withResultArgs,
} from '../claude-result.mts';

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    result: 'checked\nVERDICT: PASS',
    session_id: '09d516c0-1ae3-493e-90a1-c534bf4164b0',
    total_cost_usd: 0.0235262,
    usage: {
      input_tokens: 10,
      output_tokens: 36,
      cache_creation_input_tokens: 10777,
      cache_read_input_tokens: 17822,
    },
    ...over,
  });

describe('withResultArgs', () => {
  // Several judges end their argv with a VARIADIC terminal flag (JUDGE_READ_ONLY / --allowedTools
  // after the positional prompt). Appending there would be swallowed as a tool name, so the flag
  // has to lead — the bug this ordering exists to prevent.
  it('PREPENDS, so a variadic terminal flag cannot swallow it', () => {
    const args = withResultArgs(['-p', 'prompt', '--allowedTools', 'Read']);
    expect(args.slice(0, 2)).toEqual([...CLAUDE_RESULT_ARGS]);
    expect(args.at(-1)).toBe('Read');
  });

  it('is idempotent — a caller that already asked for JSON is left alone', () => {
    const already = ['-p', 'x', '--output-format', 'json'];
    expect(withResultArgs(already)).toEqual(already);
    expect(withResultArgs(already).filter((a) => a === '--output-format')).toHaveLength(1);
  });

  it('leaves the caller array untouched', () => {
    const original = ['-p', 'x'];
    withResultArgs(original);
    expect(original).toEqual(['-p', 'x']);
  });
});

describe('unwrapClaudeResult', () => {
  it('returns the result text, not the envelope', () => {
    expect(unwrapClaudeResult(envelope())).toBe('checked\nVERDICT: PASS');
  });

  it('falls back to the raw string for bare text, a test double, or an older CLI', () => {
    expect(unwrapClaudeResult('VERDICT: PASS')).toBe('VERDICT: PASS');
    expect(unwrapClaudeResult('{not json')).toBe('{not json');
    expect(unwrapClaudeResult(null)).toBeNull();
  });

  it('falls back rather than returning an empty verdict', () => {
    // An envelope whose result is blank must not read as "the judge said nothing of substance" —
    // the caller's own empty-output handling should see the original bytes and decide.
    const blank = envelope({ result: '   ' });
    expect(unwrapClaudeResult(blank)).toBe(blank);
  });
});

describe('parseJudgeUsage', () => {
  it('reads tokens, cost and the session id that joins back to the usage tracker', () => {
    expect(parseJudgeUsage(envelope())).toEqual({
      input_tokens: 10,
      output_tokens: 36,
      cache_creation: 10777,
      cache_read: 17822,
      cost_usd: 0.0235262,
      session_id: '09d516c0-1ae3-493e-90a1-c534bf4164b0',
    });
  });

  // The whole point of the null: a zero-filled row aggregates as a genuinely free judge and
  // silently deflates every cost total built on top of it.
  it('returns null — never zeros — when there is no envelope to read', () => {
    expect(parseJudgeUsage('VERDICT: PASS')).toBeNull();
    expect(parseJudgeUsage('{not json')).toBeNull();
    expect(parseJudgeUsage(null)).toBeNull();
    expect(parseJudgeUsage(JSON.stringify({ type: 'other', result: 'x' }))).toBeNull();
  });

  it('keeps cache reads separate from input — folding them in would misrank reviewers', () => {
    // Cache reads dominate the raw token count at these prompt sizes while costing a fraction.
    const usage = parseJudgeUsage(envelope());
    expect(usage?.cache_read).toBe(17822);
    expect(usage?.input_tokens).toBe(10);
  });

  it('a well-formed envelope missing usage still bills what it does know', () => {
    const usage = parseJudgeUsage(envelope({ usage: undefined }));
    expect(usage).toMatchObject({ input_tokens: 0, output_tokens: 0, cost_usd: 0.0235262 });
  });

  it('coerces nonsense counts to 0 instead of propagating them into the ledger', () => {
    const usage = parseJudgeUsage(
      envelope({ total_cost_usd: -1, usage: { input_tokens: 'lots', output_tokens: -5 } }),
    );
    expect(usage).toMatchObject({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  });

  it('omits session_id rather than emitting an empty one', () => {
    expect(parseJudgeUsage(envelope({ session_id: '' }))).not.toHaveProperty('session_id');
  });
});
