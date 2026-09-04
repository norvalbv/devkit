/** classifyJudgeOutage picks the cause the operator chases and whether the cascade pays a second
 *  spawn. The non-regressions matter as much: unknown stays `transient`, Node's message is unread. */
import { describe, expect, it } from 'vitest';
import {
  classifyJudgeOutage,
  formatResetDelta,
  parseResetTime,
  plausibleReset,
} from '../outage/classify.mts';

/** The exact wording codex 0.152.0 emits on a quota lock, captured 2026-09-03. */
const CODEX_QUOTA =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 8th, 2026 3:38 PM.";
const codexStream = (message: string): string =>
  JSON.stringify({ type: 'turn.failed', error: { message } });

/** The same wording with a reset computed from NOW. classifyJudgeOutage has no clock seam, so any
 *  test asserting a parsed resetsAt must not pin an absolute instant the wall clock will pass. */
function quotaResettingIn(days: number): string {
  const at = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const when = `${at.toLocaleString('en-US', { month: 'short' })} ${at.getDate()}, ${at.getFullYear()} ${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${when}.`;
}

describe('classifyJudgeOutage', () => {
  it('a kill at the cap is a timeout, decided before any provider text is read', () => {
    // Even carrying quota text: the cap kill is the gate's OWN, and "wait for the reset" is the
    // wrong remedy for it (sc-1049/sc-1227).
    const outage = classifyJudgeOutage({ killed: true, stdout: codexStream(CODEX_QUOTA) });
    expect(outage.kind).toBe('timeout');
    expect(outage.permanent).toBe(true);
  });

  it('ENOENT is an absent binary, and no retry can install one', () => {
    const outage = classifyJudgeOutage({ code: 'ENOENT' });
    expect(outage.kind).toBe('absent');
    expect(outage.permanent).toBe(true);
  });

  it('reads the codex usage lock out of the stream stdout it was always attached to', () => {
    const outage = classifyJudgeOutage({ status: 1, stdout: codexStream(quotaResettingIn(6)) });
    expect(outage.kind).toBe('rate-limited');
    expect(outage.permanent).toBe(true);
    expect(outage.resetsAt).toBeTypeOf('number');
    expect(outage.detail).toContain('usage limit');
  });

  it('reads a rate limit off stderr too — the channel the claude family uses', () => {
    const outage = classifyJudgeOutage({ status: 1, stderr: 'Error: rate limit exceeded' });
    expect(outage.kind).toBe('rate-limited');
    expect(outage.resetsAt).toBeUndefined(); // named no reset; none is invented
  });

  it('classifies a logged-out CLI as auth, never as quota', () => {
    for (const stderr of ['Not logged in.', 'authentication required', 'Invalid API key']) {
      const outage = classifyJudgeOutage({ status: 1, stderr });
      expect(outage.kind).toBe('unauthenticated');
      expect(outage.permanent).toBe(true);
    }
  });

  it('an unrecognised failure stays transient and RETRYABLE — the honest unknown', () => {
    const outage = classifyJudgeOutage({ status: 1, stderr: 'segmentation fault' });
    expect(outage.kind).toBe('transient');
    expect(outage.permanent).toBe(false);
  });

  it('a bare non-zero exit with no text is not guessed at', () => {
    // codex exits 1 for quota AND for a dozen unrelated faults; an exit code alone proves nothing.
    expect(classifyJudgeOutage({ status: 401 }).kind).toBe('transient');
    expect(classifyJudgeOutage({ status: 429 }).kind).toBe('transient');
  });

  it('NEVER classifies from the Node error message, which renders the judge prompt', () => {
    // execFileSync throws `Command failed: <bin> <argv...>`, and a review judge's argv carries the
    // staged diff. A commit that merely discusses usage limits must not be read as rate-limited.
    const outage = classifyJudgeOutage({
      status: 1,
      message: "Command failed: codex exec -p 'handle the usage limit error' --model gpt-5",
    });
    expect(outage.kind).toBe('transient');
  });
});

describe('parseResetTime', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');

  it('parses the ordinal date form codex actually prints', () => {
    const at = parseResetTime(CODEX_QUOTA, now);
    // Sep 8th 2026 is five days past the pinned `now`, so the codex window round-trips intact.
    expect(at).toBe(Date.parse('Sep 8, 2026 3:38 PM'));
  });

  it('honours a Retry-After header in seconds', () => {
    expect(parseResetTime('HTTP 429\nRetry-After: 120', now)).toBe(now + 120_000);
  });

  it('is TOTAL — nonsense, absent and unparseable input all yield undefined, never a throw', () => {
    for (const text of [
      undefined,
      '',
      'no reset here',
      'try again at some point',
      'resets at ????',
    ])
      expect(parseResetTime(text, now)).toBeUndefined();
  });

  it('rejects a time in the past or absurdly far ahead rather than reporting it', () => {
    expect(parseResetTime('try again at Jan 1st, 2020 3:00 PM', now)).toBeUndefined();
    expect(parseResetTime('try again at Jan 1st, 2999 3:00 PM', now)).toBeUndefined();
  });
});

describe('formatResetDelta', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  it('says how long the wait is in the unit that decides what the operator does', () => {
    expect(formatResetDelta(now + 5 * 86_400_000 + 19 * 3_600_000, now)).toBe('5d 19h');
    expect(formatResetDelta(now + 3 * 3_600_000 + 20 * 60_000, now)).toBe('3h 20m');
    expect(formatResetDelta(now + 45 * 60_000, now)).toBe('45m');
    expect(formatResetDelta(now + 5_000, now)).toBe('under a minute');
  });
});

/** Shapes a real provider can emit that the happy paths miss. Two were defects when written:
 *  ANSI-coloured output read as `transient`, and an unbounded reset from the RPC path. */
describe('classifyJudgeOutage — real-world input shapes', () => {
  const ESC = String.fromCharCode(27);

  it('sees through ANSI colour — FORCE_COLOR must not resurrect the fused label', () => {
    // FORCE_COLOR=1 is routine in CI, and the escape sits flush against the first letter — so the
    // `\b` anchor fails and the whole classification reverts to `transient`, unwatched.
    const outage = classifyJudgeOutage({
      status: 1,
      stderr: `${ESC}[31mRate limit exceeded${ESC}[0m`,
    });
    expect(outage.kind).toBe('rate-limited');
    expect(outage.permanent).toBe(true);
  });

  it('prefers the quota reading when a stream says quota and stderr says logged-out', () => {
    // Both can be true at once (a lock often follows a re-auth prompt). Quota is the more specific
    // claim and the one with a wait attached, so it wins — pinned so the order is a decision.
    const outage = classifyJudgeOutage({
      status: 1,
      stdout: codexStream('usage limit reached'),
      stderr: 'Not logged in.',
    });
    expect(outage.kind).toBe('rate-limited');
  });

  it("reads codex's top-level `error` event, not only `turn.failed`", () => {
    // codex's taxonomy has both; a parser that knows only turn.failed misses half the outages.
    const outage = classifyJudgeOutage({
      status: 1,
      stdout: JSON.stringify({ type: 'error', message: 'You have hit your usage limit.' }),
    });
    expect(outage.kind).toBe('rate-limited');
  });

  it('names a limit with no stated reset rather than inventing one', () => {
    // "retry after 30 seconds" is prose, not the Retry-After header, and Date.parse cannot read it.
    // Classifying is still right; fabricating a time the remedy would quote back as fact is not.
    const outage = classifyJudgeOutage({
      status: 1,
      stderr: 'rate limit hit, retry after 30 seconds',
    });
    expect(outage.kind).toBe('rate-limited');
    expect(outage.resetsAt).toBeUndefined();
  });

  it('caps `detail` — it rides telemetry, and a judge transcript is not a cause', () => {
    const outage = classifyJudgeOutage({
      status: 1,
      stderr: `rate limit exceeded ${'x'.repeat(50_000)}`,
    });
    expect(outage.detail?.length ?? 0).toBeLessThanOrEqual(201);
  });

  it('drops a stderr line echoing the judge argv — rule 2, via the other channel', () => {
    // A CLI usage error prints the invocation, and a judge's argv carries `-p <prompt>` — the
    // staged diff. A commit discussing usage limits must not become a permanent rate-limit.
    const outage = classifyJudgeOutage({
      status: 2,
      stderr: "error: unexpected argument\n  claude -p 'fix the usage limit handling' --model opus",
    });
    expect(outage.kind).toBe('transient');
    expect(outage.permanent).toBe(false);
  });

  it('survives an empty error object without claiming to know anything', () => {
    const outage = classifyJudgeOutage({});
    expect(outage.kind).toBe('transient');
    expect(outage.permanent).toBe(false);
  });
});

describe('reset-time boundaries', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');

  it('plausibleReset brackets the window both text and RPC paths share', () => {
    expect(plausibleReset(now + 60_000, now)).toBe(true);
    // Slightly behind is clock skew, not a stale reset.
    expect(plausibleReset(now - 60_000, now)).toBe(true);
    expect(plausibleReset(now - 6 * 60 * 60_000, now)).toBe(false);
    expect(plausibleReset(now + 401 * 24 * 3_600_000, now)).toBe(false);
    // The shape a unit change produces: seconds re-read as seconds when they became milliseconds.
    expect(plausibleReset(Number.MAX_SAFE_INTEGER, now)).toBe(false);
    expect(plausibleReset(Number.NaN, now)).toBe(false);
  });

  it('ignores a Retry-After of 0 rather than reporting "resets now"', () => {
    expect(parseResetTime('Retry-After: 0', now)).toBeUndefined();
  });

  it('renders a reset that already passed as imminent, never as a negative wait', () => {
    // The window can roll between the RPC answering and the line being printed.
    expect(formatResetDelta(now - 90_000, now)).toBe('under a minute');
  });
});
