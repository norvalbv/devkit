import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectRequired, readRequiredContexts, requiredSetPoller } from './required.mts';
import { recordCiEvent } from './telemetry.mts';
import {
  type CheckRow,
  type ChecksExec,
  type PollResult,
  ghChecksPoller,
  verdictLine,
  waitForChecks,
} from './wait.mts';

const REQUIRED_EMPTY = "no required checks reported on the 'feat/x' branch";
const pass = (name: string): CheckRow => ({
  bucket: 'pass',
  name,
  state: 'SUCCESS',
  link: '',
  workflow: name,
});

/** What execFileSync throws for a gh exit 1, as the classifier reads it. */
const ghError = (stderr: string): Error =>
  Object.assign(new Error('gh failed'), { status: 1, stdout: '', stderr });

/** gh as a protected repo answers: `base` for the PR, then the ruleset and classic context lists. */
function fakeGh(answers: { ruleset?: string[]; classic?: string[]; checks?: () => string }) {
  const calls: string[][] = [];
  const exec: ChecksExec = (args) => {
    calls.push(args);
    if (args[1] === 'view') return 'main\n';
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (path.includes('/rules/branches/')) return (answers.ruleset ?? []).join('\n');
    if (path.includes('/branches/')) return (answers.classic ?? []).join('\n');
    if (answers.checks) return answers.checks();
    throw ghError(REQUIRED_EMPTY);
  };
  return { calls, exec };
}

const OPTS = { pr: '514', repo: 'acme/app', cwd: '/tmp' };

/** The narrowed poller exactly as wait.mts main() builds it, over a clock the sleep advances. */
function narrowedWait(exec: ChecksExec, timeoutMs = 60_000) {
  const checks = ghChecksPoller({ ...OPTS, required: true, exec });
  const narrowed = requiredSetPoller(checks, { ...OPTS, exec });
  let clock = 0;
  const run = waitForChecks({
    poll: narrowed.poll,
    timeoutMs,
    intervalMs: 1_000,
    settleGraceMs: 0,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    emit: () => {},
  }).then((r) => ({ ...r, required: true, requiredContexts: narrowed.contexts()?.length }));
  return { run, narrowed };
}

describe('readRequiredContexts', () => {
  it('unions ruleset and classic contexts, paginating the rules read', () => {
    const { calls, exec } = fakeGh({ ruleset: ['required', 'lint'], classic: ['lint', 'build'] });
    expect(readRequiredContexts({ ...OPTS, exec })).toEqual(['required', 'lint', 'build']);
    const rules = calls.find((c) => c.some((a) => a.includes('/rules/branches/')));
    expect(rules?.slice(0, 3)).toEqual(['api', '--paginate', 'repos/acme/app/rules/branches/main']);
  });

  it('reads a private free-plan repo, where GitHub refuses rulesets, as requiring only its classic set', () => {
    // Live shape on a private repo owned by a free-plan user; protection there is not enforced either.
    const refused =
      'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)';
    const { exec: base } = fakeGh({ classic: ['lint'], checks: () => '[]' });
    const exec: ChecksExec = (args, cwd) => {
      if (args.some((a) => a.includes('/rules/branches/'))) throw ghError(refused);
      return base(args, cwd);
    };
    expect(readRequiredContexts({ ...OPTS, exec })).toEqual(['lint']);
  });

  it('encodes a base branch carrying a slash into one path segment', () => {
    const calls: string[][] = [];
    const exec: ChecksExec = (args) => {
      calls.push(args);
      return args[1] === 'view' ? 'release/1.x' : '';
    };
    expect(readRequiredContexts({ ...OPTS, exec })).toEqual([]);
    expect(calls.map((c) => c.find((a) => a.startsWith('repos/')))).toContain(
      'repos/acme/app/branches/release%2F1.x',
    );
  });
});

describe('expectRequired', () => {
  it('adds a pending EXPECTED row only for a context nothing has reported', () => {
    // `codeql` stands for a row gh marks required that the set missed (a code_scanning rule).
    const reported = [
      pass('build (ubuntu-latest)'),
      { ...pass('codeql'), bucket: 'fail' as const },
    ];
    const rows = expectRequired(reported, ['build (ubuntu-latest)', 'e2e']);
    expect(rows.map((r) => [r.name, r.bucket, r.state])).toEqual([
      ['build (ubuntu-latest)', 'pass', 'SUCCESS'],
      ['codeql', 'fail', 'SUCCESS'],
      ['e2e', 'pending', 'EXPECTED'],
    ]);
  });
});

describe('requiredSetPoller', () => {
  it('holds the wait open until an unreported required check reports, then passes', async () => {
    let checksCalls = 0;
    const green =
      '[{"bucket":"pass","name":"required","state":"SUCCESS","link":"","workflow":"ci"}]';
    const { exec } = fakeGh({
      ruleset: ['required'],
      checks: () => {
        if (++checksCalls < 5) throw ghError(REQUIRED_EMPTY);
        return green;
      },
    });
    const result = await narrowedWait(exec).run;
    expect(result.outcome).toBe('passed');
    expect(checksCalls).toBeGreaterThanOrEqual(5);
    expect(verdictLine(result, '514')).toBe(
      'ship: ci-outcome=passed pr=514 scope=required required-contexts=1 checks=1',
    );
  });

  it('never passes on a partially reported set: the missing context times out as pending', async () => {
    const onlyA = '[{"bucket":"pass","name":"a","state":"SUCCESS","link":"","workflow":"ci"}]';
    const { exec } = fakeGh({ ruleset: ['a', 'b'], checks: () => onlyA });
    const result = await narrowedWait(exec).run;
    expect(result.outcome).toBe('timed-out');
    expect(verdictLine(result, '514')).toMatch(/^ship: ci-outcome=timed-out .* pending=b waited=/);
  });

  it('ends failed, not timed-out, when a reported required check fails beside an unreported one', async () => {
    const red = '[{"bucket":"fail","name":"a","state":"FAILURE","link":"","workflow":"ci"}]';
    const { exec } = fakeGh({ ruleset: ['a', 'b'], checks: () => red });
    const result = await narrowedWait(exec).run;
    expect(result.outcome).toBe('failed');
    expect(result.pending.map((r) => r.name)).toEqual(['b']);
  });

  it('reads a base that requires nothing as no-checks with zero required contexts', async () => {
    const { exec } = fakeGh({});
    const result = await narrowedWait(exec).run;
    expect(verdictLine(result, '514')).toBe(
      'ship: ci-outcome=no-checks pr=514 scope=required required-contexts=0 checks=0',
    );
  });

  it('retries a transient set-read failure instead of ending the wait', async () => {
    let views = 0;
    const { exec: base } = fakeGh({ ruleset: ['gate'], checks: () => '[]' });
    const exec: ChecksExec = (args, cwd) => {
      if (args[1] === 'view' && ++views === 1) throw ghError('HTTP 502: Bad Gateway');
      return base(args, cwd);
    };
    const { run, narrowed } = narrowedWait(exec, 5_000);
    const result = await run;
    expect(views).toBe(2);
    expect(narrowed.contexts()).toEqual(['gate']);
    expect(result).toMatchObject({ outcome: 'timed-out', requiredContexts: 1 });
  });

  // The second stderr is the checks call's "empty set" text: on a set read it is still no answer.
  it.each([
    ['a 404', 'gh: Not Found (HTTP 404)'],
    ['an empty-set message', 'no checks reported'],
  ])(
    'ends unavailable, never no-checks, when the set read fails with %s',
    async (_label, stderr) => {
      const exec: ChecksExec = (args) => {
        if (args[0] === 'api') throw ghError(stderr);
        return 'main';
      };
      const result = await narrowedWait(exec).run;
      expect(result).toMatchObject({ outcome: 'unavailable', unavailableReason: 'gh-failed' });
      expect(result.unavailableMessage).toMatch(/^required-set read: /);
      expect(result.requiredContexts).toBeUndefined();
    },
  );

  it('passes a gh failure on the checks call through untouched', async () => {
    const { exec } = fakeGh({ ruleset: ['gate'], checks: () => 'not json' });
    const poll = requiredSetPoller(ghChecksPoller({ ...OPTS, required: true, exec }), {
      ...OPTS,
      exec,
    }).poll;
    expect(await poll(1)).toMatchObject<Partial<PollResult>>({ kind: 'unavailable' });
  });
});

describe('ship_ci required_contexts', () => {
  it('records the count when the set was read, and null otherwise', async () => {
    const { exec } = fakeGh({ ruleset: ['gate'], checks: () => '[]' });
    const read = await narrowedWait(exec, 2_000).run;
    const file = join(mkdtempSync(join(tmpdir(), 'ci-events-')), 'events.jsonl');
    const env = { DEVKIT_GATE_EVENTS: file, DEVKIT_SHIP_ID: 'ship-1' };
    recordCiEvent(read, '1', env);
    recordCiEvent({ ...read, requiredContexts: undefined }, '2', env);
    const written = readFileSync(file, 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(written.map((r) => r.required_contexts)).toEqual([1, null]);
  });
});
