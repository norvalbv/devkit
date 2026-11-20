import { describe, expect, it } from 'vitest';
import { NO_RUN, type PullState, type WorkflowRun, headRunsPoller } from './head-runs.mts';
import { apiArgs } from './required.mts';
import { type CheckRow, type ChecksExec, verdictLine, waitForChecks } from './wait.mts';

const CODERABBIT: CheckRow = {
  bucket: 'pass',
  name: 'CodeRabbit',
  state: 'SUCCESS',
  link: '',
  workflow: '',
};
const pull = (fields: Partial<PullState> = {}) =>
  JSON.stringify({
    state: 'open',
    mergeable: true,
    head: { sha: 'abc123def4567890' },
    base: { ref: 'main', repo: { default_branch: 'main' } },
    ...fields,
  });
const run = (fields: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1,
  workflow_id: 7,
  name: 'gate',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/o/r/actions/runs/1',
  event: 'pull_request',
  pull_requests: [{ number: 42 }],
  ...fields,
});
/** `gh api --paginate --slurp` output: one element per page. */
const pages = (...p: WorkflowRun[][]) => JSON.stringify(p.map((r) => ({ workflow_runs: r })));
const runs = (...r: WorkflowRun[]) => pages(r);
const STACKED = {
  base: { ref: 'feat/parent', repo: { default_branch: 'main' } },
  stack: { number: 9 },
};
const ghFailure = (stderr: string) => Object.assign(new Error('gh failed'), { status: 1, stderr });

interface GhAnswers {
  pull?: string | Error;
  runs?: string | Error;
  /** Ruleset-required contexts, one per line, as the `--jq` read prints them. */
  required?: string | Error;
}

/** gh as the guard reads it, keyed by REST path; a thrown answer is a gh failure. */
function gh(answers: GhAnswers, calls: string[][] = []) {
  const exec: ChecksExec = (args) => {
    calls.push(args);
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    const answer = path.includes('/pulls/')
      ? (answers.pull ?? pull())
      : path.includes('/actions/runs')
        ? (answers.runs ?? runs())
        : path.includes('/rules/branches/')
          ? (answers.required ?? '')
          : '';
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return exec;
}

/** The whole wait over a fixed check set, on a clock the injected sleep advances. */
function verdict(exec: ChecksExec, checks: CheckRow[] = [CODERABBIT], repo = 'o/r') {
  let clock = 0;
  return waitForChecks({
    poll: headRunsPoller(() => ({ kind: 'rows', rows: checks }), {
      pr: '42',
      repo,
      cwd: '/repo',
      exec,
    }),
    timeoutMs: 60_000,
    intervalMs: 1_000,
    settleGraceMs: 0,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    emit: () => {},
  });
}

describe('headRunsPoller — a review bot alone is never a CI verdict', () => {
  it('holds the wait while the head has a queued run gh pr checks does not list yet', async () => {
    const result = await verdict(gh({ runs: runs(run({ status: 'queued', conclusion: null })) }));
    expect(result.outcome).toBe('timed-out');
    expect(result.pending.map((r) => r.name)).toEqual(['gate']);
  });

  it('turns an empty set into a wait, not no-checks, while a run is queued', async () => {
    const result = await verdict(
      gh({ runs: runs(run({ status: 'queued', conclusion: null })) }),
      [],
    );
    expect(result.outcome).toBe('timed-out');
  });

  it('reads a run that failed before reporting any check as red', async () => {
    const result = await verdict(gh({ runs: runs(run({ conclusion: 'startup_failure' })) }));
    expect(result.outcome).toBe('failed');
    expect(result.failures).toMatchObject([
      { name: 'gate', state: 'STARTUP_FAILURE', link: 'https://github.com/o/r/actions/runs/1' },
    ]);
  });

  it('reads a cancelled run as cancelled', async () => {
    const result = await verdict(gh({ runs: runs(run({ conclusion: 'cancelled' })) }));
    expect(result.outcome).toBe('cancelled');
  });

  it('holds a completed run GitHub has not given a conclusion yet', async () => {
    const result = await verdict(gh({ runs: runs(run({ conclusion: null })) }));
    expect(result.outcome).toBe('timed-out');
  });

  it('holds a fork run awaiting approval', async () => {
    const result = await verdict(gh({ runs: runs(run({ conclusion: 'action_required' })) }));
    expect(result.outcome).toBe('timed-out');
  });

  it('judges each workflow by its newest run on the head', async () => {
    const cancelledThenQueued = runs(
      run({ id: 1, conclusion: 'cancelled' }),
      run({ id: 2, status: 'queued', conclusion: null }),
    );
    expect((await verdict(gh({ runs: cancelledThenQueued }))).outcome).toBe('timed-out');
    const failedThenRerunGreen = runs(run({ id: 2 }), run({ id: 1, conclusion: 'failure' }));
    expect((await verdict(gh({ runs: failedThenRerunGreen }))).outcome).toBe('passed');
  });

  it('never lets a newer fully skipped run hide an older red one of the same workflow', async () => {
    // A `labeled` re-trigger whose jobs all skip says nothing about the code the older run tested.
    const failedThenSkipped = runs(
      run({ id: 1, conclusion: 'failure' }),
      run({ id: 2, conclusion: 'skipped' }),
    );
    expect((await verdict(gh({ runs: failedThenSkipped }))).outcome).toBe('failed');
  });

  it('keeps the verdict of a run made before the PR came to conflict', async () => {
    const conflicting = pull({ mergeable: false });
    expect((await verdict(gh({ pull: conflicting, runs: runs(run()) }))).outcome).toBe('passed');
  });

  it('judges a push run and a pull_request run of one workflow apart', async () => {
    const prFailedPushGreen = runs(
      run({ id: 1, conclusion: 'startup_failure' }),
      run({ id: 2, event: 'push' }),
    );
    expect((await verdict(gh({ runs: prFailedPushGreen }))).outcome).toBe('failed');
  });

  it('ends a conflicting PR whose head has only a push run as merge-conflict', async () => {
    const pushOnly = runs(run({ event: 'push' }));
    const result = await verdict(gh({ pull: pull({ mergeable: false }), runs: pushOnly }));
    expect(result).toMatchObject({ outcome: 'unavailable', unavailableReason: 'merge-conflict' });
  });

  it('never lets a push run stand in for the pull_request run a PR still needs', async () => {
    const pushOnly = runs(run({ name: 'CI', event: 'push' }));
    const pushCheck: CheckRow = { ...CODERABBIT, name: 'CI', workflow: 'CI' };
    const result = await verdict(gh({ runs: pushOnly, required: 'CI' }), [CODERABBIT, pushCheck]);
    expect(result.outcome).toBe('timed-out');
  });

  it('never counts a fully skipped pull_request run as the PR having run', async () => {
    const skipped = runs(run({ conclusion: 'skipped' }));
    const result = await verdict(gh({ pull: pull(STACKED), runs: skipped }));
    expect(result.outcome).toBe('timed-out');
    expect(result.pending.map((r) => r.name)).toEqual([NO_RUN]);
  });

  it('holds a check the base requires even when another workflow ran green', async () => {
    const lintOnly = runs(run({ name: 'lint' }));
    const result = await verdict(gh({ runs: lintOnly, required: 'gate' }));
    expect(result.outcome).toBe('timed-out');
    expect(result.pending.map((r) => r.name)).toEqual(['gate']);
    const skippedOnly = runs(run({ name: 'labeler', conclusion: 'skipped' }));
    expect((await verdict(gh({ runs: skippedOnly, required: 'gate' }))).outcome).toBe('timed-out');
  });

  it('passes once every workflow run on the head succeeded', async () => {
    const result = await verdict(
      gh({ runs: runs(run(), run({ id: 3, workflow_id: 8, conclusion: 'skipped' })) }),
    );
    expect(result.outcome).toBe('passed');
    expect(result.counts.pass).toBe(1);
  });
});

describe('headRunsPoller — a head with no workflow run', () => {
  it('ends at once on a conflicting PR, since GitHub starts no run until it is resolved', async () => {
    const result = await verdict(gh({ pull: pull({ mergeable: false }) }));
    expect(result).toMatchObject({
      outcome: 'unavailable',
      unavailableReason: 'merge-conflict',
      polls: 1,
    });
    expect(verdictLine(result, '42')).toBe(
      'ship: ci-outcome=unavailable pr=42 reason=merge-conflict detail=the PR has a merge conflict, so GitHub starts no pull_request run on abc123def456',
    );
  });

  it('waits while GitHub has not computed mergeability', async () => {
    const result = await verdict(gh({ pull: pull({ mergeable: null }) }));
    expect(result.outcome).toBe('timed-out');
    expect(result.pending.map((r) => r.name)).toEqual([NO_RUN]);
  });

  it('waits on a native stack member, whose runs GitHub keys to the stack base', async () => {
    expect((await verdict(gh({ pull: pull(STACKED) }))).outcome).toBe('timed-out');
  });

  it('treats a non-default base outside a native stack like the default branch', async () => {
    // A --no-stack PR onto another open PR's branch is an ordinary PR: GitHub runs its own CI.
    const parentBranch = pull({ base: { ref: 'feat/parent', repo: { default_branch: 'main' } } });
    expect((await verdict(gh({ pull: parentBranch }))).outcome).toBe('passed');
  });

  it('passes a mergeable PR whose base requires no check and that no workflow runs on', async () => {
    expect((await verdict(gh({}))).outcome).toBe('passed');
  });

  it('holds a review-bot-only set open while a check the base requires has not reported', async () => {
    const result = await verdict(gh({ required: 'required' }));
    expect(result.outcome).toBe('timed-out');
    expect(result.pending.map((r) => r.name)).toEqual(['required']);
    const reported: CheckRow = { ...CODERABBIT, name: 'required', workflow: 'gate' };
    const calls: string[][] = [];
    const settled = await verdict(gh({ required: 'required' }, calls), [CODERABBIT, reported]);
    expect(settled.outcome).toBe('passed');
    // Protection does not move during a wait, so the set is read once however many polls settle.
    expect(calls.filter((c) => c.some((a) => a.includes('/rules/branches/')))).toHaveLength(1);
  });

  it('reads Actions that are disabled or invisible (404) as no runs', async () => {
    const result = await verdict(gh({ runs: ghFailure('gh: Not Found (HTTP 404)') }));
    expect(result.outcome).toBe('passed');
  });
});

describe('headRunsPoller — what it never does', () => {
  it('never passes when GitHub cannot be read', async () => {
    const outage = await verdict(gh({ runs: ghFailure('gh: Bad Gateway (HTTP 502)') }));
    expect(outage).toMatchObject({ outcome: 'unavailable', unavailableReason: 'gh-unreachable' });
    const garbled = await verdict(gh({ pull: 'not json' }));
    expect(garbled).toMatchObject({
      outcome: 'unavailable',
      unavailableReason: 'gh-json-unparseable',
    });
    const protection = await verdict(gh({ required: ghFailure('gh: Bad Gateway (HTTP 502)') }));
    expect(protection).toMatchObject({
      outcome: 'unavailable',
      unavailableReason: 'gh-unreachable',
    });
    const missing = await verdict(gh({ pull: ghFailure('gh: Not Found (HTTP 404)') }));
    expect(missing).toMatchObject({ outcome: 'unavailable', unavailableReason: 'gh-failed' });
  });

  it("never lets another PR's run on the same head SHA decide this PR", async () => {
    const theirsGreen = run({ id: 2, pull_requests: [{ number: 99 }] });
    const oursFailed = run({ id: 1, conclusion: 'startup_failure' });
    expect((await verdict(gh({ runs: runs(oursFailed, theirsGreen) }))).outcome).toBe('failed');
  });

  it('reads every page of runs before deciding the PR has none', async () => {
    const pushPage = [run({ id: 3, event: 'push' })];
    const prPage = [run({ id: 2 })];
    expect((await verdict(gh({ runs: pages(pushPage, prPage) }))).outcome).toBe('passed');
  });

  it('keeps a known red when the protection read fails', async () => {
    const failedRun = runs(run({ conclusion: 'startup_failure' }));
    const result = await verdict(gh({ runs: failedRun, required: ghFailure('gh: HTTP 403') }));
    expect(result.outcome).toBe('failed');
  });

  it("addresses a GHES base's protection reads by host", async () => {
    const calls: string[][] = [];
    await verdict(gh({}, calls), [CODERABBIT], 'ghe.example.com/o/r');
    const rules = calls.find((c) => c.some((a) => a.includes('/rules/branches/')));
    expect(rules?.slice(0, 5)).toEqual([
      'api',
      '--paginate',
      '--hostname',
      'ghe.example.com',
      'repos/o/r/rules/branches/main',
    ]);
  });

  it('makes no extra gh call on a red or pending poll', async () => {
    const calls: string[][] = [];
    const red: CheckRow = { ...CODERABBIT, bucket: 'fail', name: 'gate' };
    expect((await verdict(gh({}, calls), [red])).outcome).toBe('failed');
    expect(calls).toEqual([]);
  });

  it('leaves a closed or merged PR to its rollup, reading no runs', async () => {
    const calls: string[][] = [];
    const result = await verdict(gh({ pull: pull({ state: 'closed', mergeable: null }) }, calls));
    expect(result.outcome).toBe('passed');
    expect(calls.every((args) => args.at(-1)?.endsWith('/pulls/42'))).toBe(true);
  });

  it('reads the PR, then the runs on its head SHA', async () => {
    const calls: string[][] = [];
    await verdict(gh({}, calls));
    expect(calls.slice(0, 2)).toEqual([
      ['api', 'repos/o/r/pulls/42'],
      [
        'api',
        '--paginate',
        '--slurp',
        'repos/o/r/actions/runs?head_sha=abc123def4567890&per_page=100',
      ],
    ]);
  });
});

describe('apiArgs', () => {
  it('addresses github.com by owner/repo and a GHES PR by its host', () => {
    expect(apiArgs('o/r', 'pulls/1')).toEqual(['api', 'repos/o/r/pulls/1']);
    expect(apiArgs('o/r', 'rules/branches/main', ['--paginate'])).toEqual([
      'api',
      '--paginate',
      'repos/o/r/rules/branches/main',
    ]);
    expect(apiArgs('ghe.example.com/o/r', 'pulls/1')).toEqual([
      'api',
      '--hostname',
      'ghe.example.com',
      'repos/o/r/pulls/1',
    ]);
  });
});
