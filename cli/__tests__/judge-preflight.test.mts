/** The ship-time judge reachability report (sc-2538). The property that matters most is NEGATIVE:
 *  this check may never change what a ship does — a dark provider is not a doomed ship. */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseRateLimitsReply,
  readCodexRateLimits,
} from '../../gate-engine/judge/codex/rate-limits.mts';
import {
  judgeReachability,
  type PreflightDeps,
  renderPreflight,
  reviewGuardSelected,
} from '../lib/ship/preflight/judge.mts';

/** The payload `codex app-server` returned on this machine while the account was locked. */
const LOCKED_REPLY = JSON.stringify({
  id: 2,
  result: {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1788786135 },
      planType: 'pro',
      rateLimitReachedType: 'rate_limit_reached',
    },
  },
});

function repo(guards: string[], review?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'judge-preflight-'));
  mkdirSync(join(dir, '.devkit'), { recursive: true });
  writeFileSync(join(dir, '.devkit', 'config.json'), JSON.stringify({ components: { guards } }));
  if (review) writeFileSync(join(dir, 'guard.config.json'), JSON.stringify({ review }));
  return dir;
}

const deps = (over: Partial<PreflightDeps> = {}): PreflightDeps => ({
  resolvable: () => true,
  codexOut: () => false,
  claudeOut: () => false,
  rateLimits: async () => null,
  ...over,
});

describe('parseRateLimitsReply', () => {
  it('reads the locked payload this machine actually returned, seconds converted to ms', () => {
    const snap = parseRateLimitsReply(LOCKED_REPLY);
    expect(snap).toMatchObject({
      reached: true,
      reachedType: 'rate_limit_reached',
      usedPercent: 100,
      windowDurationMins: 10080,
      planType: 'pro',
    });
    // The wire carries epoch SECONDS; every devkit consumer works in ms (JudgeOutage.resetsAt).
    expect(snap?.resetsAt).toBe(1788786135 * 1000);
  });

  it('a healthy account reports reached:false rather than nothing at all', () => {
    const snap = parseRateLimitsReply(
      JSON.stringify({
        id: 2,
        result: { rateLimits: { primary: { usedPercent: 18, windowDurationMins: 10080 } } },
      }),
    );
    expect(snap?.reached).toBe(false);
    expect(snap?.usedPercent).toBe(18);
  });

  it('ignores every line that is not this reply — handshake, notifications, noise', () => {
    for (const line of [
      JSON.stringify({ id: 1, result: { userAgent: 'x' } }), // the initialize answer
      JSON.stringify({ method: 'remoteControl/status/changed', params: {} }), // a notification
      JSON.stringify({ id: 2, result: {} }), // right id, no payload this version understands
      'not json at all',
      '',
    ])
      expect(parseRateLimitsReply(line)).toBeNull();
  });
});

describe('reviewGuardSelected', () => {
  it('is false when the reviewer gate is not selected — a judge-less repo stays untouched', () => {
    expect(reviewGuardSelected(repo(['size', 'dup']))).toBe(false);
  });

  it('is false, not a throw, when there is no recorded selection to read', () => {
    expect(reviewGuardSelected(mkdtempSync(join(tmpdir(), 'no-devkit-')))).toBe(false);
  });

  it('is true only when review is actually in the recorded guard set', () => {
    expect(reviewGuardSelected(repo(['size', 'review']))).toBe(true);
  });
});

describe('judgeReachability', () => {
  const CLAUDE_FAMILY = { model: 'haiku', escalationModel: 'opus', correctnessModel: 'sonnet' };
  const CODEX_FAMILY = {
    model: 'gpt-5.6-terra',
    escalationModel: 'gpt-5.6-sol',
    correctnessModel: 'gpt-5.6-sol',
  };

  it('reports the three ROLES separately — a provider-level verdict hides a locked escalation', async () => {
    const statuses = await judgeReachability(repo(['review'], CODEX_FAMILY), deps());
    expect(statuses.map((s) => s.role)).toEqual(['review', 'escalation', 'correctness']);
    expect(statuses.map((s) => s.model)).toEqual(['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-sol']);
  });

  it('asks the rate-limit RPC ONCE even with three codex roles — one account, one answer', async () => {
    let calls = 0;
    await judgeReachability(
      repo(['review'], CODEX_FAMILY),
      deps({
        rateLimits: async () => {
          calls += 1;
          return parseRateLimitsReply(LOCKED_REPLY);
        },
      }),
    );
    expect(calls).toBe(1);
  });

  it('names a locked account, with its reset, on every codex role', async () => {
    const statuses = await judgeReachability(
      repo(['review'], CODEX_FAMILY),
      deps({ rateLimits: async () => parseRateLimitsReply(LOCKED_REPLY) }),
    );
    for (const s of statuses) {
      expect(s.state).toBe('rate-limited');
      expect(s.resetsAt).toBe(1788786135 * 1000);
    }
  });

  it('never spends a rate-limit call on a claude family — there is no such query to make', async () => {
    let calls = 0;
    const statuses = await judgeReachability(
      repo(['review'], CLAUDE_FAMILY),
      deps({
        rateLimits: async () => {
          calls += 1;
          return null;
        },
      }),
    );
    expect(calls).toBe(0);
    // Binary + auth is the whole truth available for claude (anthropics/claude-code#40395 is open),
    // so it reports reachable and claims nothing about headroom.
    for (const s of statuses) expect(s.state).toBe('ok');
  });

  it('an unresolvable binary is absent, and a logged-out CLI is auth — not one fused label', async () => {
    const absent = await judgeReachability(
      repo(['review'], CODEX_FAMILY),
      deps({ resolvable: () => false }),
    );
    expect(absent[0].state).toBe('absent');
    const out = await judgeReachability(
      repo(['review'], CODEX_FAMILY),
      deps({ codexOut: () => true }),
    );
    expect(out[0].state).toBe('unauthenticated');
  });

  it('an RPC that says nothing this version understands is "unknown", never a false green', async () => {
    const statuses = await judgeReachability(
      repo(['review'], CODEX_FAMILY),
      deps({ rateLimits: async () => null }),
    );
    for (const s of statuses) expect(s.state).toBe('unknown');
  });
});

describe('renderPreflight', () => {
  const now = 1788786135000 - 4 * 24 * 60 * 60 * 1000;
  const locked = [
    {
      role: 'review' as const,
      model: 'gpt-5.6-sol',
      bin: 'codex',
      state: 'rate-limited' as const,
      resetsAt: 1788786135000,
      usedPercent: 100,
      windowMins: 10080,
    },
  ];

  it('names the limit, the window and the wait — and never the word transient', () => {
    const out = renderPreflight(locked, now).join('\n');
    expect(out).toContain('USAGE LIMIT REACHED');
    expect(out).toContain('100% of a 7d window used');
    expect(out).toContain('resets in 4d');
    expect(out).not.toContain('transient');
  });

  it('says re-running will not help, and names the override that will', () => {
    const out = renderPreflight(locked, now).join('\n');
    expect(out).toContain('re-running will not help');
    expect(out).toContain('devkit doctor --fix');
    expect(out).toContain('GUARD_REVIEW_MODEL');
  });

  it('warns that the gates STILL RUN — it is a report, never a decision', () => {
    expect(renderPreflight(locked, now).join('\n')).toContain('the gates below will still run');
  });

  it('a healthy provider gets one quiet line per role and no warning at all', () => {
    const out = renderPreflight(
      [{ role: 'review' as const, model: 'haiku', bin: 'claude', state: 'ok' as const }],
      now,
    ).join('\n');
    expect(out).toContain('reachable');
    expect(out).not.toContain('⚠️');
    expect(out).not.toContain('devkit doctor --fix');
  });

  it('reports "not verified" for unknown rather than inventing either verdict', () => {
    const out = renderPreflight(
      [{ role: 'review' as const, model: 'gpt-5.6-sol', bin: 'codex', state: 'unknown' as const }],
      now,
    ).join('\n');
    expect(out).toContain('not verified');
    // Unknown is not a finding: it must not drag in the remedy block.
    expect(out).not.toContain('devkit doctor --fix');
  });
});

/** Shapes a real codex install can return that the captured happy-path payload never models —
 *  including one that was a defect when written: an unbounded resetsAt, reported as fact. */
describe('parseRateLimitsReply — payloads a real install can return', () => {
  it('a JSON-RPC error is "unknown", not a crash — this is what an OLDER codex returns', () => {
    // A codex predating account/rateLimits/read answers `error: Method not found`. That is the most
    // likely real-world non-happy shape, and it must degrade to silence rather than a false verdict.
    expect(
      parseRateLimitsReply(
        JSON.stringify({ id: 2, error: { code: -32601, message: 'Method not found' } }),
      ),
    ).toBeNull();
  });

  it('drops an implausible resetsAt instead of stating it — the unit-change trap', () => {
    // If this field ever becomes milliseconds, the `* 1000` below it produces a year-billion instant
    // that renders as "re-running will not help for another 104249970674d", stated as fact.
    const snap = parseRateLimitsReply(
      JSON.stringify({
        id: 2,
        result: {
          rateLimits: {
            rateLimitReachedType: 'rate_limit_reached',
            primary: { resetsAt: Number.MAX_SAFE_INTEGER },
          },
        },
      }),
    );
    // Still LOCKED — the lock is the load-bearing fact; only the unbelievable time is dropped.
    expect(snap?.reached).toBe(true);
    expect(snap?.resetsAt).toBeUndefined();
  });

  it('keeps a usedPercent of 0 — a falsy check here would silently hide a fresh window', () => {
    const snap = parseRateLimitsReply(
      JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 0 } } } }),
    );
    expect(snap?.usedPercent).toBe(0);
  });

  it('ignores a resetsAt of 0 rather than reporting a 1970 reset', () => {
    const snap = parseRateLimitsReply(
      JSON.stringify({ id: 2, result: { rateLimits: { primary: { resetsAt: 0 } } } }),
    );
    expect(snap?.resetsAt).toBeUndefined();
  });

  it('drops a field carrying the wrong TYPE instead of forwarding it', () => {
    // The interface DECLARES these as numbers; the wire is not obliged to agree.
    const snap = parseRateLimitsReply(
      JSON.stringify({
        id: 2,
        result: { rateLimits: { primary: { usedPercent: 'lots', windowDurationMins: null } } },
      }),
    );
    expect(snap?.usedPercent).toBeUndefined();
    expect(snap?.windowDurationMins).toBeUndefined();
  });
});

/** The spawn itself: handshake, line buffering across chunk boundaries, and every way the child
 *  can fail to answer. A fake binary stands in for codex, via GUARD_CODEX_BIN. */
describe('readCodexRateLimits — the spawn, not just the parser', () => {
  /** Write an executable stand-in for `codex` and point GUARD_CODEX_BIN at it. */
  function fakeCodex(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
    const bin = join(dir, 'codex');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    chmodSync(bin, 0o755);
    return bin;
  }
  const withFake = async (body: string, timeout = 5000) => {
    const prior = process.env.GUARD_CODEX_BIN;
    process.env.GUARD_CODEX_BIN = fakeCodex(body);
    try {
      return await readCodexRateLimits(timeout);
    } finally {
      if (prior === undefined) delete process.env.GUARD_CODEX_BIN;
      else process.env.GUARD_CODEX_BIN = prior;
    }
  };

  it('finds the reply among the handshake and notification traffic around it', async () => {
    // The real server interleaves an initialize answer and remoteControl notifications; the reader
    // must select by id rather than by position.
    const snap = await withFake(
      [
        `echo '{"id":1,"result":{"userAgent":"x"}}'`,
        `echo '{"method":"remoteControl/status/changed","params":{}}'`,
        `echo '{"id":2,"result":{"rateLimits":{"rateLimitReachedType":"rate_limit_reached","primary":{"usedPercent":100,"resetsAt":0}}}}'`,
        'sleep 5',
      ].join('\n'),
    );
    expect(snap?.reached).toBe(true);
  });

  it('reassembles a reply split across chunk boundaries', async () => {
    // A pipe read can land mid-line. Parsing per-chunk instead of per-line loses the whole answer.
    const snap = await withFake(
      [
        `printf '{"id":2,"result":{"rateLimits":'`,
        'sleep 0.2',
        `printf '{"rateLimitReachedType":"rate_limit_reached"}}}\\n'`,
        'sleep 5',
      ].join('\n'),
    );
    expect(snap?.reached).toBe(true);
  });

  it('resolves null — never hangs — when the child answers nothing', async () => {
    // The whole point of the preflight is speed; a silent daemon must not become a new stall.
    const started = Date.now();
    expect(await withFake('sleep 30', 700)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('resolves null when the child exits before replying', async () => {
    expect(await withFake('exit 1')).toBeNull();
  });

  it('resolves null when the binary does not exist at all', async () => {
    const prior = process.env.GUARD_CODEX_BIN;
    process.env.GUARD_CODEX_BIN = join(tmpdir(), 'definitely-not-a-codex-binary');
    try {
      expect(await readCodexRateLimits(2000)).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.GUARD_CODEX_BIN;
      else process.env.GUARD_CODEX_BIN = prior;
    }
  });

  it('resolves null on a flood of non-answers rather than buffering without bound', async () => {
    expect(await withFake(`yes '{"noise":true}' | head -c 2000000`, 5000)).toBeNull();
  });
});

/** The worst outcome for a check whose justification is early truth: a report saying "reachable"
 *  while the model that will block the ship is locked. Per-PROVIDER reporting produces exactly that. */
describe('mixed-family configuration', () => {
  const MIXED = {
    model: 'haiku',
    escalationModel: 'gpt-5.6-sol',
    correctnessModel: 'sonnet',
  };

  it('names the locked codex escalation while the claude roles report reachable', async () => {
    const statuses = await judgeReachability(
      repo(['review'], MIXED),
      deps({ rateLimits: async () => parseRateLimitsReply(LOCKED_REPLY) }),
    );
    expect(statuses.map((s) => `${s.role}:${s.state}`)).toEqual([
      'review:ok',
      'escalation:rate-limited',
      'correctness:ok',
    ]);
  });

  it('warns on a PARTIAL outage — one dark role is still a reviewer that cannot grade', async () => {
    const statuses = await judgeReachability(
      repo(['review'], MIXED),
      deps({ rateLimits: async () => parseRateLimitsReply(LOCKED_REPLY) }),
    );
    const out = renderPreflight(statuses, 1788786135000 - 86_400_000).join('\n');
    expect(out).toContain('USAGE LIMIT REACHED');
    expect(out).toContain('will still run');
    // The healthy roles are still reported, so the reader sees WHICH half works.
    expect(out).toContain('haiku via claude — reachable');
  });

  it('checks codex auth only for the codex role, never for the claude ones', async () => {
    // A logged-out codex must not make the haiku roles report logged-out, and vice versa.
    const statuses = await judgeReachability(
      repo(['review'], MIXED),
      deps({ codexOut: () => true }),
    );
    expect(statuses.map((s) => s.state)).toEqual(['ok', 'unauthenticated', 'ok']);
  });
});

/**
 * Frink runs parallel agents against one working tree, so two ships can preflight at the same
 * moment. Each spawns its own stdio app-server, and neither may see the other's answer.
 */
describe('concurrent preflights', () => {
  it('keeps two simultaneous reports independent', async () => {
    const [locked, healthy] = await Promise.all([
      judgeReachability(
        repo(['review'], {
          model: 'gpt-5.6-sol',
          escalationModel: 'gpt-5.6-sol',
          correctnessModel: 'gpt-5.6-sol',
        }),
        deps({ rateLimits: async () => parseRateLimitsReply(LOCKED_REPLY) }),
      ),
      judgeReachability(
        repo(['review'], {
          model: 'gpt-5.6-sol',
          escalationModel: 'gpt-5.6-sol',
          correctnessModel: 'gpt-5.6-sol',
        }),
        deps({
          rateLimits: async () =>
            parseRateLimitsReply(
              JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 12 } } } }),
            ),
        }),
      ),
    ]);
    expect(locked.every((s) => s.state === 'rate-limited')).toBe(true);
    expect(healthy.every((s) => s.state === 'ok')).toBe(true);
    // No shared module state leaked the locked run's reset into the healthy one.
    expect(healthy.every((s) => s.resetsAt === undefined)).toBe(true);
  });
});
