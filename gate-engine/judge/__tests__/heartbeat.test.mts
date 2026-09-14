// sc-2422 judge heartbeat units, on an injected clock + timer; execJudgeAsync wiring is covered in
// judge-exec-telemetry.test.mts.
import { describe, expect, it } from 'vitest';
import {
  createJudgeHeartbeat,
  formatSpan,
  type HeartbeatDeps,
  type HeartbeatTimer,
  renderJudgeHeartbeat,
} from '../process/heartbeat.mts';

function harness(env: NodeJS.ProcessEnv = { DEVKIT_GATE_DEADLINE_MS: String(10 * 60_000) }) {
  let now = 0;
  const lines: string[] = [];
  const timers = new Map<HeartbeatTimer, { fn: () => void; ms: number }>();
  const deps: HeartbeatDeps = {
    env,
    now: () => now,
    write: (line) => lines.push(line),
    setInterval: (fn, ms) => {
      const handle: HeartbeatTimer = {};
      timers.set(handle, { fn, ms });
      return handle;
    },
    clearInterval: (handle) => {
      timers.delete(handle);
    },
  };
  const beat = createJudgeHeartbeat(deps);
  const tick = (ms: number) => {
    now += ms;
    for (const t of [...timers.values()]) t.fn();
  };
  return { beat, lines, timers, tick, deps, setNow: (n: number) => (now = n) };
}

describe('formatSpan', () => {
  it('renders seconds under a minute and minutes+seconds above, never negative', () => {
    expect(formatSpan(0)).toBe('0s');
    expect(formatSpan(45_000)).toBe('45s');
    expect(formatSpan(59_999)).toBe('59s');
    expect(formatSpan(60_000)).toBe('1m00s');
    expect(formatSpan(185_000)).toBe('3m05s');
    expect(formatSpan(-5_000)).toBe('0s');
    expect(formatSpan(Number.NaN)).toBe('0s');
  });
});

describe('renderJudgeHeartbeat', () => {
  it('names every lane with elapsed time and the earlier kill bound, plus the log', () => {
    const line = renderJudgeHeartbeat(
      [
        { label: 'review:completeness', startedAt: 0, killAt: 30 * 60_000 },
        { label: 'review:correctness-reviewer', startedAt: 60_000, killAt: 20 * 60_000 },
      ],
      180_000,
      '/tmp/ship logs/gate.log',
    );
    expect(line).toBe(
      'guard-review: still running — review:completeness 3m00s (killed in ≤27m00s), ' +
        'review:correctness-reviewer 2m00s (killed in ≤17m00s) · log: /tmp/ship logs/gate.log\n',
    );
  });

  it('omits the log segment when no gate log is known', () => {
    const line = renderJudgeHeartbeat([{ label: 'l', startedAt: 0, killAt: 60_000 }], 1_000);
    expect(line).not.toContain('log:');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('clamps a kill bound that has already passed to 0s instead of going negative', () => {
    const line = renderJudgeHeartbeat([{ label: 'l', startedAt: 0, killAt: 1_000 }], 90_000);
    expect(line).toContain('(killed in ≤0s)');
    expect(line).not.toMatch(/-\d/);
  });
});

describe('createJudgeHeartbeat', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['non-numeric', 'soon'],
    ['zero', '0'],
    ['negative', '-1'],
    ['Infinity', 'Infinity'],
  ])('stays silent and arms no timer when the gate deadline is %s', (_name, value) => {
    const env: NodeJS.ProcessEnv = {};
    if (value !== undefined) env.DEVKIT_GATE_DEADLINE_MS = value;
    const h = harness(env);
    const stop = h.beat.track({ label: 'review:completeness', timeoutMs: 60_000 });
    h.tick(10 * 60_000);
    expect(h.timers.size).toBe(0);
    expect(h.lines).toEqual([]);
    expect(() => stop()).not.toThrow();
  });

  it('ticks at the default interval and reports min(judge timeout, gate deadline)', () => {
    const h = harness({ DEVKIT_GATE_DEADLINE_MS: String(10 * 60_000), DEVKIT_GATE_LOG: '/g.log' });
    h.beat.track({ label: 'review:completeness', timeoutMs: 30 * 60_000 });
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([45_000]);
    h.tick(45_000);
    // Gate deadline (10m from epoch 0) is earlier than the 30m judge timeout.
    expect(h.lines).toEqual([
      'guard-review: still running — review:completeness 45s (killed in ≤9m15s) · log: /g.log\n',
    ]);
  });

  it('reports the judge timeout when it lands before the gate deadline', () => {
    const h = harness({ DEVKIT_GATE_DEADLINE_MS: String(60 * 60_000) });
    h.beat.track({ label: 'x', timeoutMs: 2 * 60_000 });
    h.tick(45_000);
    expect(h.lines[0]).toContain('x 45s (killed in ≤1m15s)');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['non-numeric', 'fast'],
    // Node clamps a delay above 2^31-1 to 1ms — a stderr flood, the opposite of a heartbeat.
    ['above the timer ceiling', String(2 ** 31)],
  ])('falls back to the default interval when DEVKIT_JUDGE_HEARTBEAT_MS is %s', (_n, value) => {
    const h = harness({ DEVKIT_GATE_DEADLINE_MS: '600000', DEVKIT_JUDGE_HEARTBEAT_MS: value });
    h.beat.track({ label: 'x', timeoutMs: 60_000 });
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([45_000]);
  });

  it('honours a valid interval override', () => {
    const h = harness({ DEVKIT_GATE_DEADLINE_MS: '600000', DEVKIT_JUDGE_HEARTBEAT_MS: '50' });
    h.beat.track({ label: 'x', timeoutMs: 60_000 });
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([50]);
  });

  it('arms ONE timer for concurrent judges and writes one line per tick naming all of them', () => {
    const h = harness();
    h.beat.track({ label: 'review:a', timeoutMs: 60 * 60_000 });
    h.beat.track({ label: 'review:b', timeoutMs: 60 * 60_000 });
    expect(h.timers.size).toBe(1);
    h.tick(45_000);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatch(/review:a 45s .*review:b 45s/);
  });

  it('keeps ticking for the remaining judge after one stops, then disarms after the last', () => {
    const h = harness();
    const stopA = h.beat.track({ label: 'review:a', timeoutMs: 60 * 60_000 });
    const stopB = h.beat.track({ label: 'review:b', timeoutMs: 60 * 60_000 });
    stopA();
    h.tick(45_000);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).not.toContain('review:a');
    expect(h.lines[0]).toContain('review:b');
    stopB();
    expect(h.timers.size).toBe(0);
    h.tick(45_000);
    expect(h.lines).toHaveLength(1);
  });

  it('tracks same-label judges independently (split reviewer parts share one label)', () => {
    const h = harness();
    const stop1 = h.beat.track({ label: 'review:correctness', timeoutMs: 60 * 60_000 });
    h.beat.track({ label: 'review:correctness', timeoutMs: 60 * 60_000 });
    stop1();
    // A double stop must not remove the sibling that shares the label.
    stop1();
    expect(h.timers.size).toBe(1);
    h.tick(45_000);
    expect(h.lines[0]).toContain('review:correctness 45s');
  });

  it('re-arms exactly one timer when a judge starts after the previous wave disarmed', () => {
    const h = harness();
    h.beat.track({ label: 'first', timeoutMs: 60_000 })();
    expect(h.timers.size).toBe(0);
    h.beat.track({ label: 'second', timeoutMs: 60 * 60_000 });
    h.beat.track({ label: 'third', timeoutMs: 60 * 60_000 });
    expect(h.timers.size).toBe(1);
  });

  it('measures elapsed per judge from its own start, not from when the timer was armed', () => {
    const h = harness({ DEVKIT_GATE_DEADLINE_MS: String(60 * 60_000) });
    h.beat.track({ label: 'early', timeoutMs: 60 * 60_000 });
    h.tick(30_000); // first tick at 30s
    h.beat.track({ label: 'late', timeoutMs: 60 * 60_000 });
    h.tick(45_000);
    expect(h.lines.at(-1)).toMatch(/early 1m15s .*late 45s/);
  });

  it('swallows a failing stderr write (EPIPE after tee drained) and keeps the timer healthy', () => {
    const h = harness();
    let calls = 0;
    const beat = createJudgeHeartbeat({
      ...h.deps,
      write: () => {
        calls++;
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
    });
    beat.track({ label: 'x', timeoutMs: 60 * 60_000 });
    expect(() => h.tick(45_000)).not.toThrow();
    expect(() => h.tick(45_000)).not.toThrow();
    expect(calls).toBe(2);
  });

  it('reads the deadline per judge, so a supervisor-less judge after a supervised one stays silent', () => {
    const env: NodeJS.ProcessEnv = { DEVKIT_GATE_DEADLINE_MS: '600000' };
    const h = harness(env);
    h.beat.track({ label: 'supervised', timeoutMs: 60_000 })();
    delete env.DEVKIT_GATE_DEADLINE_MS;
    h.beat.track({ label: 'plain', timeoutMs: 60_000 });
    h.tick(45_000);
    expect(h.timers.size).toBe(0);
    expect(h.lines).toEqual([]);
  });

  it('unrefs a real timer so a heartbeat never holds the gate process open', () => {
    let handle: NodeJS.Timeout | undefined;
    const beat = createJudgeHeartbeat({
      env: { DEVKIT_GATE_DEADLINE_MS: String(Date.now() + 600_000) },
      now: Date.now,
      write: () => {},
      setInterval: (fn, ms) => {
        handle = setInterval(fn, ms);
        return handle;
      },
      // SAFETY: the setInterval seam directly above returns the real Node handle this clears.
      clearInterval: (id) => clearInterval(id as NodeJS.Timeout),
    });
    const stop = beat.track({ label: 'x', timeoutMs: 60_000 });
    try {
      expect(handle?.hasRef()).toBe(false);
    } finally {
      stop();
    }
  });
});
