/** sc-3207: a codex window at 100% is a lock even without `rateLimitReachedType`, unless usable
 *  credits carry it — codex's own TUI cap test (codex-rs/tui/src/chatwidget/rate_limits.rs). */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRateLimitsReply } from '../../gate-engine/judge/codex/rate-limits.mts';
import {
  judgeReachability,
  type PreflightDeps,
  renderPreflight,
} from '../lib/ship/preflight/judge.mts';

const PRIMARY_RESET = 1788786135;
const SECONDARY_RESET = PRIMARY_RESET + 2 * 24 * 60 * 60;
// Four days before the primary reset: both resets are plausible, neither has passed.
const NOW = PRIMARY_RESET * 1000 - 4 * 24 * 60 * 60 * 1000;

/** The rateLimits object as the wire may send it — values deliberately loose, because several
 *  cases model a malformed reply the parser must survive. */
type WireValue = number | string | boolean | null;
interface WireWindow {
  usedPercent?: WireValue;
  windowDurationMins?: WireValue;
  resetsAt?: WireValue;
}
interface WireRateLimits {
  primary?: WireWindow | null;
  secondary?: WireWindow | string | null;
  credits?: { hasCredits?: WireValue; unlimited?: WireValue; balance?: WireValue } | null;
  rateLimitReachedType?: string;
  planType?: string;
}
const reply = (rateLimits: WireRateLimits): string =>
  JSON.stringify({ id: 2, result: { rateLimits: { limitId: 'codex', ...rateLimits } } });

/** The story's payload: a fully consumed weekly window, and no reached-type field at all. */
const WINDOW_FULL_REPLY = reply({
  primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: PRIMARY_RESET },
  planType: 'pro',
});

const ENV_KEYS = [
  'GUARD_REVIEW_MODEL',
  'FRINK_REVIEW_MODEL',
  'GUARD_REVIEW_ESCALATION_MODEL',
  'GUARD_CORRECTNESS_MODEL',
  'GUARD_CORRECTNESS_CHUNK',
  'GUARD_SENTRY_MODEL',
  'FRINK_SENTRY_MODEL',
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function repo(review: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'judge-preflight-exhausted-'));
  mkdirSync(join(dir, '.devkit'), { recursive: true });
  writeFileSync(
    join(dir, '.devkit', 'config.json'),
    JSON.stringify({ components: { guards: ['review'] } }),
  );
  writeFileSync(join(dir, 'guard.config.json'), JSON.stringify({ review }));
  return dir;
}

const CODEX_FAMILY = {
  model: 'gpt-5.6-terra',
  escalationModel: 'gpt-5.6-sol',
  correctnessModel: 'gpt-5.6-sol',
};

const deps = (payload: string): PreflightDeps => ({
  resolvable: () => true,
  codexOut: () => false,
  claudeOut: () => false,
  rateLimits: async () => parseRateLimitsReply(payload),
});

describe('parseRateLimitsReply — a fully consumed window is a lock', () => {
  it('reads the story payload (100%, no reached-type) as reached, reset in ms', () => {
    const snap = parseRateLimitsReply(WINDOW_FULL_REPLY);
    expect(snap?.reached).toBe(true);
    // Nothing was reported, so nothing is forwarded as the provider's own label.
    expect(snap?.reachedType).toBeUndefined();
    expect(snap?.usedPercent).toBe(100);
    expect(snap?.windowDurationMins).toBe(10080);
    expect(snap?.resetsAt).toBe(PRIMARY_RESET * 1000);
    expect(snap?.exhaustedWindow).toBe('primary');
  });

  it('reads a value over 100 as reached — overshoot is not a healthy window', () => {
    expect(parseRateLimitsReply(reply({ primary: { usedPercent: 104.2 } }))?.reached).toBe(true);
  });

  it('keeps 99.99% unreached — the boundary belongs to the provider, not to rounding', () => {
    expect(parseRateLimitsReply(reply({ primary: { usedPercent: 99.99 } }))?.reached).toBe(false);
  });

  it('a string "100" is not a number, so it proves nothing', () => {
    const snap = parseRateLimitsReply(reply({ primary: { usedPercent: '100' } }));
    expect(snap?.reached).toBe(false);
    expect(snap?.usedPercent).toBeUndefined();
  });

  it('a full SECONDARY window locks, and its reset and window are the ones reported', () => {
    const snap = parseRateLimitsReply(
      reply({
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: PRIMARY_RESET },
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: SECONDARY_RESET },
      }),
    );
    expect(snap?.reached).toBe(true);
    expect(snap?.exhaustedWindow).toBe('secondary');
    expect(snap?.usedPercent).toBe(100);
    expect(snap?.windowDurationMins).toBe(10080);
    expect(snap?.resetsAt).toBe(SECONDARY_RESET * 1000);
  });

  it('with BOTH windows full, the later reset wins — the lock lasts until the last one clears', () => {
    const snap = parseRateLimitsReply(
      reply({
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: PRIMARY_RESET },
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: SECONDARY_RESET },
      }),
    );
    expect(snap?.resetsAt).toBe(SECONDARY_RESET * 1000);
    expect(snap?.exhaustedWindow).toBe('secondary');
  });

  // Review finding 871ad998e991 / fd0c19dd1c87: an unknown reset on EITHER exhausted window means
  // the lock's end is unknown — reporting the other window's reset would promise a false retry time.
  it('with both windows full and either reset unknown, no clearing time is reported', () => {
    for (const [primaryReset, secondaryReset] of [
      [undefined, SECONDARY_RESET],
      [PRIMARY_RESET, undefined],
      [Number.MAX_SAFE_INTEGER, SECONDARY_RESET],
      [PRIMARY_RESET, Number.MAX_SAFE_INTEGER],
    ]) {
      const snap = parseRateLimitsReply(
        reply({
          primary: { usedPercent: 100, resetsAt: primaryReset },
          secondary: { usedPercent: 100, resetsAt: secondaryReset },
        }),
      );
      expect(snap?.reached).toBe(true);
      expect(snap?.resetsAt).toBeUndefined();
    }
  });

  it('with neither window full, primary is reported exactly as before', () => {
    const snap = parseRateLimitsReply(
      reply({
        primary: { usedPercent: 30, windowDurationMins: 300 },
        secondary: { usedPercent: 90, windowDurationMins: 10080 },
      }),
    );
    expect(snap?.reached).toBe(false);
    expect(snap?.usedPercent).toBe(30);
    expect(snap?.windowDurationMins).toBe(300);
    expect(snap?.exhaustedWindow).toBeUndefined();
  });

  it('a null or garbled secondary window is ignored, never a crash', () => {
    for (const secondary of [null, 'x', { usedPercent: 'full' }]) {
      const snap = parseRateLimitsReply(reply({ primary: { usedPercent: 12 }, secondary }));
      expect(snap?.reached).toBe(false);
      expect(snap?.usedPercent).toBe(12);
    }
  });

  it('usable credits keep a full window serving — hasCredits or unlimited', () => {
    for (const credits of [{ hasCredits: true }, { unlimited: true }]) {
      const snap = parseRateLimitsReply(reply({ primary: { usedPercent: 100 }, credits }));
      expect(snap?.reached).toBe(false);
      // The consumption is still reported: the reader sees how close to the edge it is.
      expect(snap?.usedPercent).toBe(100);
    }
  });

  it('credits that are absent, false, or not a real boolean do not excuse a full window', () => {
    for (const credits of [
      null,
      { hasCredits: false, unlimited: false },
      { hasCredits: 'true' },
      { balance: '0' },
    ]) {
      expect(parseRateLimitsReply(reply({ primary: { usedPercent: 100 }, credits }))?.reached).toBe(
        true,
      );
    }
  });

  it("a provider-reported limit stays reached even with credits — the provider's word wins", () => {
    const snap = parseRateLimitsReply(
      reply({
        primary: { usedPercent: 20 },
        rateLimitReachedType: 'rate_limit_reached',
        credits: { hasCredits: true },
      }),
    );
    expect(snap?.reached).toBe(true);
    expect(snap?.reachedType).toBe('rate_limit_reached');
  });

  it('a full window with an implausible reset is still locked; only the time is dropped', () => {
    const snap = parseRateLimitsReply(
      reply({ primary: { usedPercent: 100, resetsAt: Number.MAX_SAFE_INTEGER } }),
    );
    expect(snap?.reached).toBe(true);
    expect(snap?.resetsAt).toBeUndefined();
  });
});

describe('the preflight report for an exhausted window (sc-3207 acceptance)', () => {
  it('labels every codex role EXHAUSTED and prints the four-knob re-target before the chain', async () => {
    const statuses = await judgeReachability(repo(CODEX_FAMILY), deps(WINDOW_FULL_REPLY));
    expect(statuses.every((s) => s.state === 'rate-limited')).toBe(true);

    const out = renderPreflight(statuses, NOW).join('\n');
    expect(out).toContain('EXHAUSTED');
    expect(out).toContain('100% of a 7d window used');
    expect(out).toContain('resets in 4d');
    expect(out).toContain('re-running will not help');
    for (const knob of [
      'GUARD_REVIEW_MODEL=haiku',
      'GUARD_REVIEW_ESCALATION_MODEL=opus',
      'GUARD_CORRECTNESS_MODEL=sonnet',
      'GUARD_CORRECTNESS_CHUNK=off',
    ])
      expect(out).toContain(knob);
    // The regression itself: a spent window was called reachable.
    expect(out).not.toContain('— reachable');
    expect(out).not.toContain('transient');
  });

  it('a mixed family names the exhausted codex role and keeps the claude roles reachable', async () => {
    const statuses = await judgeReachability(
      repo({ model: 'haiku', escalationModel: 'gpt-5.6-sol', correctnessModel: 'sonnet' }),
      deps(WINDOW_FULL_REPLY),
    );
    expect(statuses.map((s) => `${s.role}:${s.state}`)).toEqual([
      'review:ok',
      'escalation:rate-limited',
      'correctness:ok',
    ]);
    const out = renderPreflight(statuses, NOW).join('\n');
    expect(out).toContain('gpt-5.6-sol via codex — EXHAUSTED');
    expect(out).toContain('haiku via claude — reachable');
  });

  it('an exhausted window with no plausible reset still warns, without inventing a time', () => {
    const out = renderPreflight(
      [
        {
          role: 'review' as const,
          model: 'gpt-5.6-sol',
          bin: 'codex',
          state: 'rate-limited' as const,
          usedPercent: 100,
          windowMins: 10080,
        },
      ],
      NOW,
    ).join('\n');
    expect(out).toContain('EXHAUSTED');
    expect(out).toContain('re-running will not help.');
    expect(out).not.toContain('resets in');
  });

  it('credits keep a full window reachable, and no remedy is printed', async () => {
    const statuses = await judgeReachability(
      repo(CODEX_FAMILY),
      deps(reply({ primary: { usedPercent: 100 }, credits: { unlimited: true } })),
    );
    expect(statuses.every((s) => s.state === 'ok')).toBe(true);
    expect(renderPreflight(statuses, NOW).join('\n')).not.toContain('⚠️');
  });
});

describe('renderPreflight — the percentage never contradicts the verdict', () => {
  const at = (usedPercent: number) =>
    renderPreflight(
      [
        {
          role: 'review' as const,
          model: 'gpt-5.6-sol',
          bin: 'codex',
          state: 'ok' as const,
          usedPercent,
          windowMins: 10080,
        },
      ],
      NOW,
    ).join('\n');

  it('99.6% renders as 99%, never "100% … reachable"', () => {
    const out = at(99.6);
    expect(out).toContain('99% of a 7d window used');
    expect(out).not.toContain('100%');
    expect(out).toContain('reachable');
  });

  it('a fractional low value floors too — 0.4% is 0%, not a rounding surprise', () => {
    expect(at(0.4)).toContain('0% of a 7d window used');
  });
});
