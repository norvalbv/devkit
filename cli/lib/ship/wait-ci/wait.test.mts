import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECKS_JSON_FIELDS,
  MIN_TIMEOUT_S,
  VERDICT_PREFIX,
  type CheckBucket,
  type CheckRow,
  type PollResult,
  type WaitCiOptions,
  classifyChecksFailure,
  ghChecksPoller,
  parseChecksJson,
  parseTimeoutSeconds,
  recordCiEvent,
  renderProgress,
  summarise,
  verdictLine,
  waitForChecks,
} from './wait.mts';

const row = (bucket: CheckBucket, name: string, link = ''): CheckRow => ({
  bucket,
  name,
  state: bucket.toUpperCase(),
  link,
  workflow: name,
});
const rows = (...r: CheckRow[]): PollResult => ({ kind: 'rows', rows: r });

/** What execFileSync throws, as the poller reads it — what the stubs below hand back. */
interface GhExecFailure {
  code: string;
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * A scripted poll sequence over a clock the injected sleep advances; the last answer repeats.
 */
function drive(script: PollResult[], options: Partial<WaitCiOptions> = {}) {
  let clock = 0;
  const lines: string[] = [];
  let polls = 0;
  return {
    lines,
    at: () => clock,
    run: () =>
      waitForChecks({
        poll: () => script[Math.min(polls++, script.length - 1)],
        timeoutMs: 60_000,
        intervalMs: 1_000,
        settleGraceMs: 0,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        emit: (line) => lines.push(line),
        ...options,
      }),
  };
}

describe('summarise', () => {
  it('ranks fail above cancel above pass', () => {
    expect(summarise([row('pass', 'a'), row('cancel', 'b'), row('fail', 'c')]).outcome).toBe(
      'failed',
    );
    expect(summarise([row('pass', 'a'), row('cancel', 'b')]).outcome).toBe('cancelled');
    expect(summarise([row('pass', 'a'), row('skipping', 'b')]).outcome).toBe('passed');
  });

  it('treats a skipped check as terminal-benign and an empty set as no-checks', () => {
    expect(summarise([row('skipping', 'a')])).toMatchObject({ terminal: true, outcome: 'passed' });
    expect(summarise([])).toMatchObject({ terminal: true, outcome: 'no-checks' });
  });

  it('is non-terminal while any check is pending, whatever the others say', () => {
    expect(summarise([row('fail', 'a'), row('pending', 'b')]).terminal).toBe(false);
  });
});

describe('waitForChecks', () => {
  it('reports failed on a red check even though no check is required', async () => {
    // The regression this pins: `gh pr checks --required` is EMPTY on a repo without branch
    // protection, so a required-only default would render exactly this PR as green.
    const result = await drive([
      rows(row('fail', 'gate', 'https://x/1'), row('pass', 'lint')),
    ]).run();
    expect(result.outcome).toBe('failed');
    expect(result.failures.map((f) => f.name)).toEqual(['gate']);
  });

  it('requires a terminal tally to hold across two consecutive polls', async () => {
    // A workflow_run-triggered job registers only after the first one concludes, so the opening
    // all-green snapshot is premature.
    const result = await drive([
      rows(row('pass', 'gate')),
      rows(row('pass', 'gate'), row('pending', 'deploy')),
      rows(row('pass', 'gate'), row('fail', 'deploy')),
    ]).run();
    expect(result.outcome).toBe('failed');
  });

  it('confirms a stable terminal state and stops', async () => {
    const harness = drive([rows(row('pass', 'gate'))]);
    const result = await harness.run();
    expect(result.outcome).toBe('passed');
    expect(result.polls).toBe(2);
  });

  it('prints only when the tally changes', async () => {
    const harness = drive([
      rows(row('pending', 'gate')),
      rows(row('pending', 'gate')),
      rows(row('pending', 'gate')),
      rows(row('pass', 'gate'), row('pending', 'deploy')),
      rows(row('pass', 'gate')),
    ]);
    await harness.run();
    expect(harness.lines).toEqual(['ci: 1 pending', 'ci: 1 pass · 1 pending', 'ci: 1 pass']);
  });

  it('times out with the still-pending checks named', async () => {
    const harness = drive([rows(row('pending', 'gate'), row('pass', 'lint'))], {
      timeoutMs: 5_000,
    });
    const result = await harness.run();
    expect(result.outcome).toBe('timed-out');
    expect(result.pending.map((p) => p.name)).toEqual(['gate']);
    expect(harness.at()).toBeLessThanOrEqual(6_000);
  });

  it('spends one poll past the deadline to confirm a terminal state it already saw', async () => {
    // Reporting timed-out on a result already observed as green is the worse error; the overrun is
    // bounded at a single interval.
    const harness = drive([rows(row('pending', 'gate')), rows(row('pass', 'gate'))], {
      timeoutMs: 1_500,
    });
    const result = await harness.run();
    expect(result.outcome).toBe('passed');
    expect(harness.at()).toBeLessThanOrEqual(1_500 + 1_000);
  });

  it('holds a terminal tally for a wall-clock grace, not just two polls', async () => {
    // The two-poll rule alone would have returned `passed` at poll 2. A workflow_run-chained job —
    // or a re-push whose rollup still belongs to the previous head — registers after that.
    const result = await drive(
      [
        rows(row('pass', 'gate')),
        rows(row('pass', 'gate')),
        rows(row('pass', 'gate'), row('pending', 'deploy')),
        rows(row('pass', 'gate'), row('fail', 'deploy')),
      ],
      { settleGraceMs: 10_000 },
    ).run();
    expect(result.outcome).toBe('failed');
  });

  it('reports no-checks only once the grace has proven the set really is empty', async () => {
    const early = await drive([rows(), rows(), rows(row('pass', 'gate'))], {
      settleGraceMs: 10_000,
    }).run();
    expect(early.outcome).toBe('passed');

    const settled = await drive([rows()], { settleGraceMs: 0 }).run();
    expect(settled.outcome).toBe('no-checks');
  });

  it('emits a heartbeat so a stable tally never reads as a hung wait', async () => {
    const harness = drive([rows(row('pending', 'gate'))], {
      timeoutMs: 10_000,
      heartbeatMs: 3_000,
    });
    await harness.run();
    expect(harness.lines[0]).toBe('ci: 1 pending');
    expect(harness.lines.length).toBeGreaterThan(1);
    expect(harness.lines[1]).toMatch(/^ci: 1 pending \(\d+m elapsed, \d+m budget\)$/);
  });

  it('clears the stale snapshot when it gives up, rather than half-keeping it', async () => {
    // A zero total beside a non-empty failure list is a contradiction the deferred --wait-ci-strict
    // would read when it decides whether the failure set is empty.
    const result = await drive(
      [
        rows(row('fail', 'gate'), row('pending', 'deploy')),
        { kind: 'unavailable', reason: 'gh-failed', message: '503' },
      ],
      { transientBudget: 1 },
    ).run();
    expect(result.outcome).toBe('unavailable');
    expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(0);
    expect([...result.failures, ...result.pending, ...result.cancelled]).toEqual([]);
  });

  it('reports a cancelled check as its own outcome, never as passed', async () => {
    const result = await drive([
      rows(row('pass', 'lint'), row('cancel', 'gate', 'https://x/9')),
    ]).run();
    expect(result.outcome).toBe('cancelled');
    expect(result.cancelled.map((c) => c.name)).toEqual(['gate']);
  });

  it('returns at once on a permanent gh problem but retries a transient one', async () => {
    const missing = await drive([
      { kind: 'unavailable', reason: 'gh-missing', message: 'no gh' },
    ]).run();
    expect(missing).toMatchObject({
      outcome: 'unavailable',
      unavailableReason: 'gh-missing',
      polls: 1,
    });

    const blip = await drive([
      { kind: 'unavailable', reason: 'gh-failed', message: '503' },
      rows(row('pass', 'gate')),
    ]).run();
    expect(blip.outcome).toBe('passed');
  });

  it('gives up once a transient gh problem outlasts its budget', async () => {
    const result = await drive([{ kind: 'unavailable', reason: 'gh-failed', message: '503' }], {
      transientBudget: 2,
    }).run();
    expect(result).toMatchObject({
      outcome: 'unavailable',
      unavailableReason: 'gh-failed',
      polls: 2,
    });
  });
});

describe('verdictLine', () => {
  const base = { polls: 1, elapsedMs: 900_000, counts: summarise([]).counts };

  it('carries the failing checks and their URLs', async () => {
    const result = await drive([rows(row('fail', 'gate', 'https://x/1'))]).run();
    expect(verdictLine(result, '514')).toBe(
      'ship: ci-outcome=failed pr=514 failing=gate:https://x/1',
    );
  });

  it('names the pending checks and the time waited on a timeout', () => {
    expect(
      verdictLine(
        {
          ...base,
          outcome: 'timed-out',
          failures: [],
          cancelled: [],
          pending: [row('pending', 'gate')],
        },
        '514',
      ),
    ).toBe('ship: ci-outcome=timed-out pr=514 pending=gate waited=900s');
  });

  it('names the reason when the wait could not run', () => {
    expect(
      verdictLine(
        {
          ...base,
          outcome: 'unavailable',
          failures: [],
          cancelled: [],
          pending: [],
          unavailableReason: 'gh-missing',
        },
        '514',
      ),
    ).toBe('ship: ci-outcome=unavailable pr=514 reason=gh-missing');
  });
});

describe('parseChecksJson', () => {
  it('reads gh output verbatim, tolerating the blank link a non-Actions check reports', () => {
    const parsed = parseChecksJson(
      '[{"bucket":"pass","link":"","name":"CodeRabbit","state":"SUCCESS","workflow":""}]',
    );
    expect(parsed).toEqual([
      { bucket: 'pass', link: '', name: 'CodeRabbit', state: 'SUCCESS', workflow: '' },
    ]);
  });

  it('rejects a row whose bucket it cannot trust rather than yielding undefined', () => {
    expect(parseChecksJson('[{"bucket":"weird","name":"gate"}]')).toBeNull();
    expect(parseChecksJson('[{"name":"gate"}]')).toBeNull();
    expect(parseChecksJson('[{"bucket":"pass","name":7}]')).toBeNull();
    expect(parseChecksJson('not json')).toBeNull();
    expect(parseChecksJson('{}')).toBeNull();
  });
});

describe('ghChecksPoller', () => {
  const fail = (extra: Partial<GhExecFailure>): never => {
    throw Object.assign(new Error('gh failed'), extra);
  };
  const poll = (exec: Parameters<typeof ghChecksPoller>[0]['exec']) =>
    ghChecksPoller({ pr: '514', repo: 'acme/app', cwd: '/tmp', exec })();

  it('asks for every check, not just the required ones', () => {
    let seen: string[] = [];
    poll((args) => {
      seen = args;
      return '[]';
    });
    expect(seen).toEqual([
      'pr',
      'checks',
      '514',
      '--repo',
      'acme/app',
      '--json',
      CHECKS_JSON_FIELDS,
    ]);
    expect(seen).not.toContain('--required');
  });

  it('reads the rows gh prints alongside its exit-8 pending status', () => {
    // The most common state in a whole CI wait. Treating the non-zero exit as a failure would
    // report "gh failed" on every green-but-unfinished PR.
    const result = poll(() =>
      fail({
        status: 8,
        stdout: '[{"bucket":"pending","name":"gate","state":"","link":"","workflow":""}]',
      }),
    );
    expect(result).toEqual({
      kind: 'rows',
      rows: [{ bucket: 'pending', name: 'gate', state: '', link: '', workflow: '' }],
    });
  });

  it('reads a PR with no checks as an empty set, not a failure', () => {
    expect(
      poll(() => fail({ status: 1, stderr: "no checks reported on the 'feat/x' branch" })),
    ).toEqual({ kind: 'rows', rows: [] });
  });

  it.each([
    ['gh-missing', { code: 'ENOENT' }],
    ['gh-unauthenticated', { status: 1, stderr: 'gh auth login required' }],
    ['pr-not-found', { status: 1, stderr: 'GraphQL: Could not resolve to a PullRequest' }],
    ['not-a-github-repo', { status: 1, stderr: 'no git remotes found' }],
    ['gh-failed', { status: 1, stderr: 'HTTP 503' }],
  ])('names a %s failure', (reason, thrown) => {
    expect(poll(() => fail(thrown))).toMatchObject({ kind: 'unavailable', reason });
  });

  it('refuses output it cannot parse instead of guessing', () => {
    expect(poll(() => 'garbage')).toMatchObject({
      kind: 'unavailable',
      reason: 'gh-json-unparseable',
    });
  });
});

describe('classifyChecksFailure', () => {
  it('reads the --required empty set as no checks, not as the exit-1 error it shares', () => {
    expect(
      classifyChecksFailure({ status: 1, stderr: "no required checks reported on the 'x' branch" }),
    ).toEqual({ kind: 'rows', rows: [] });
  });
});

describe('parseTimeoutSeconds', () => {
  it('accepts a value inside the floor and ceiling and nothing else', () => {
    expect(parseTimeoutSeconds('900')).toBe(900);
    expect(parseTimeoutSeconds(String(MIN_TIMEOUT_S))).toBe(MIN_TIMEOUT_S);
    expect(parseTimeoutSeconds('7200')).toBe(7200);
    // Below the floor a no-checks verdict is unreachable, so a CI-less repo would report a timeout.
    for (const bad of ['0', '1', '59', '7201', 'abc', '-1', '9.5', '', undefined])
      expect(parseTimeoutSeconds(bad)).toBeNull();
  });
});

describe('renderProgress', () => {
  it('names the empty set explicitly rather than printing an empty tally', () => {
    expect(renderProgress(summarise([]))).toBe('ci: no checks registered yet');
  });
});

describe('recordCiEvent', () => {
  const result = {
    outcome: 'failed' as const,
    polls: 3,
    elapsedMs: 90_000,
    counts: summarise([]).counts,
    failures: [row('fail', 'gate', 'https://x/1')],
    pending: [],
    cancelled: [],
  };

  it('appends a queryable row beside ship_pr on the same stream', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ci-events-')), 'events.jsonl');
    recordCiEvent(result, '514', { DEVKIT_GATE_EVENTS: file, DEVKIT_SHIP_ID: 'ship-1' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      type: 'ship_ci',
      ship_id: 'ship-1',
      pr_number: 514,
      outcome: 'failed',
      failing: ['gate'],
      waited_s: 90,
    });
  });

  it('stays silent when the ship is not collecting telemetry', () => {
    // No throw, no file: a telemetry miss costs a row, never the ship.
    expect(() => recordCiEvent(result, '514', {})).not.toThrow();
  });
});

describe('edge cases', () => {
  it('restarts the settle grace when the terminal outcome itself changes', async () => {
    // A pass -> fail flip never passes through pending, so the set stays terminal throughout and
    // the grace must restart on the FLIP rather than inherit the replaced observation's clock.
    const harness = drive(
      [
        rows(row('pass', 'gate')),
        rows(row('pass', 'gate')),
        rows(row('pass', 'gate')),
        rows(row('fail', 'gate')),
      ],
      { settleGraceMs: 5_000, intervalMs: 1_000, timeoutMs: 600_000 },
    );
    const result = await harness.run();
    expect(result.outcome).toBe('failed');
    // The flip lands at t=3000; a restarted grace cannot report before t=8000.
    expect(harness.at()).toBeGreaterThanOrEqual(8_000);
  });

  it('keeps the verdict on ONE line whatever a check is named', async () => {
    // The line is the machine-readable contract and callers grep it line-wise, so a name carrying a
    // newline must not split one verdict into two.
    const result = await drive([rows(row('fail', 'gate\nsmuggled: ci-outcome=passed'))]).run();
    const line = verdictLine(result, '514');
    expect(line.split('\n')).toHaveLength(1);
    expect(line.startsWith(VERDICT_PREFIX)).toBe(true);
  });

  it('reports the real GitHub matrix name without losing the outcome or pr field', async () => {
    // Real shape: `build (ubuntu-latest, 20.x)` carries both delimiters the failing list uses.
    const result = await drive([
      rows(row('fail', 'build (ubuntu-latest, 20.x)', 'https://x/9')),
    ]).run();
    const line = verdictLine(result, '514');
    expect(line).toMatch(/^ship: ci-outcome=failed pr=514 /);
    expect(line).toContain('build (ubuntu-latest, 20.x):https://x/9');
  });

  it('names the empty check set as its own verdict rather than a zero-count pass', async () => {
    const result = await drive([rows()], { settleGraceMs: 0 }).run();
    expect(verdictLine(result, '514')).toBe('ship: ci-outcome=no-checks pr=514 checks=0');
  });
});

describe('recordCiEvent edge cases', () => {
  const eventsFile = () => join(mkdtempSync(join(tmpdir(), 'ci-events-')), 'events.jsonl');
  const base = {
    outcome: 'failed' as const,
    polls: 1,
    elapsedMs: 1_000,
    counts: summarise([]).counts,
    pending: [],
    cancelled: [],
  };

  it('keeps one JSONL row per line even when a check name carries a newline', () => {
    // A stray newline in this stream corrupts every downstream reader, not just this row.
    const file = eventsFile();
    recordCiEvent({ ...base, failures: [row('fail', 'gate\n{"type":"forged"}')] }, '514', {
      DEVKIT_GATE_EVENTS: file,
      DEVKIT_SHIP_ID: 'ship-1',
    });
    const written = readFileSync(file, 'utf8').trimEnd();
    expect(written.split('\n')).toHaveLength(1);
    expect(JSON.parse(written).failing).toEqual(['gate\n{"type":"forged"}']);
  });

  it('appends rather than truncating, so two waits on one stream both survive', () => {
    // Parallel Frink panes shipping at once share $DEVKIT_GATE_EVENTS.
    const file = eventsFile();
    const env = { DEVKIT_GATE_EVENTS: file, DEVKIT_SHIP_ID: 'ship-1' };
    recordCiEvent({ ...base, failures: [] }, '1', env);
    recordCiEvent({ ...base, failures: [] }, '2', env);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l).pr_number)).toEqual([1, 2]);
  });

  it('records a null pr_number rather than NaN when the PR is unresolvable', () => {
    const file = eventsFile();
    recordCiEvent({ ...base, failures: [] }, '?', {
      DEVKIT_GATE_EVENTS: file,
      DEVKIT_SHIP_ID: 'ship-1',
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).pr_number).toBeNull();
  });
});
