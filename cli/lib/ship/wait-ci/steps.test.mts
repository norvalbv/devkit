import { describe, expect, it } from 'vitest';
import { failedStepsByJob, withFailedSteps } from './steps.mts';
import type { CheckRow } from './wait.mts';

const JOB_URL = 'https://github.com/acme/app/actions/runs/39102871541/job/117612322793';

const gate = (bucket: CheckRow['bucket'], link = JOB_URL): CheckRow => ({
  bucket,
  name: 'gate',
  state: bucket === 'pending' ? 'IN_PROGRESS' : 'FAILURE',
  link,
  workflow: 'gate',
});

/** `repos/<repo>/actions/runs/<run>/jobs` as GitHub answers it mid-job, trimmed to the read fields. */
const jobsJson = (steps: [string, string, string | null][], id = 117612322793) =>
  JSON.stringify({
    total_count: 1,
    jobs: [
      {
        id,
        name: 'gate',
        status: 'in_progress',
        conclusion: null,
        html_url: JOB_URL,
        steps: steps.map(([name, status, conclusion], i) => ({
          name,
          status,
          conclusion,
          number: i + 1,
        })),
      },
    ],
  });

const STRUCTURE_FAILED = jobsJson([
  ['Lint (Oxlint)', 'completed', 'success'],
  ['Structure governance (folder-structure)', 'completed', 'failure'],
  ['Tests', 'in_progress', null],
]);
const ALL_GREEN = jobsJson([
  ['Lint (Oxlint)', 'completed', 'success'],
  ['Structure governance (folder-structure)', 'completed', 'success'],
  ['Tests', 'in_progress', null],
]);

/** An exec that answers every call through `answer` and records the args it was asked for. */
function stub(answer: () => string) {
  const calls: string[][] = [];
  const exec = (args: string[]) => {
    calls.push(args);
    return answer();
  };
  return { calls, opts: { repo: 'acme/app', cwd: '/tmp', exec } };
}

describe('failedStepsByJob', () => {
  it('names the failed steps of an in-progress job and nothing else', () => {
    expect(failedStepsByJob(STRUCTURE_FAILED)).toEqual(
      new Map([[117612322793, ['Structure governance (folder-structure)']]]),
    );
    expect(failedStepsByJob(ALL_GREEN)).toEqual(new Map([[117612322793, []]]));
  });

  it('rejects an answer it cannot trust rather than reading part of it', () => {
    expect(failedStepsByJob('not json')).toBeNull();
    expect(failedStepsByJob('{}')).toBeNull();
    expect(failedStepsByJob('{"jobs":[{"id":"7","steps":[]}]}')).toBeNull();
    expect(failedStepsByJob('{"jobs":[{"id":7,"steps":[{"conclusion":"failure"}]}]}')).toBeNull();
  });

  it('still reads the run when a sibling job carries no steps field', () => {
    // GitHub's OpenAPI job schema does not require `steps`, e.g. a job still queued behind `needs:`.
    const queued = JSON.parse(STRUCTURE_FAILED);
    queued.jobs.push({ id: 5, name: 'required', status: 'queued', conclusion: null });
    expect(failedStepsByJob(JSON.stringify(queued))).toEqual(
      new Map([
        [117612322793, ['Structure governance (folder-structure)']],
        [5, []],
      ]),
    );
  });

  it('counts only a failure conclusion, never a skipped or cancelled step', () => {
    // gate.yml skips steps by `if:` on every push run; reading them as red would false-block.
    const raw = jobsJson([
      ['Release-only dist', 'completed', 'skipped'],
      ['Tests', 'completed', 'cancelled'],
      ['Upload', 'completed', 'neutral'],
    ]);
    expect(failedStepsByJob(raw)).toEqual(new Map([[117612322793, []]]));
  });
});

describe('withFailedSteps', () => {
  it('turns a pending job with a failed step into a fail row naming check › step', () => {
    const { calls, opts } = stub(() => STRUCTURE_FAILED);
    expect(withFailedSteps([gate('pending')], opts)).toEqual([
      {
        ...gate('pending'),
        bucket: 'fail',
        failedSteps: ['gate › Structure governance (folder-structure)'],
      },
    ]);
    expect(calls).toEqual([['api', 'repos/acme/app/actions/runs/39102871541/jobs?per_page=100']]);
  });

  it('leaves an all-green in-progress job pending', () => {
    const rows = [gate('pending')];
    expect(withFailedSteps(rows, stub(() => ALL_GREEN).opts)).toEqual(rows);
  });

  it.each([
    [
      'gh throws',
      () =>
        stub(() => {
          throw new Error('HTTP 403: rate limit exceeded');
        }),
    ],
    ['gh answers garbage', () => stub(() => '<html>')],
  ])('leaves rows untouched when %s — the read can only add a red', (_label, make) => {
    const rows = [gate('pending')];
    expect(withFailedSteps(rows, make().opts)).toEqual(rows);
  });

  it('never asks gh about a completed, blank-link or non-Actions row', () => {
    const { calls, opts } = stub(() => STRUCTURE_FAILED);
    const rows = [
      gate('fail'),
      gate('pending', ''),
      { ...gate('pending', 'https://coderabbit.ai/x'), name: 'CodeRabbit' },
    ];
    expect(withFailedSteps(rows, opts)).toEqual(rows);
    expect(calls).toEqual([]);
  });

  it('reads a run once however many of its jobs are pending', () => {
    const { calls, opts } = stub(() => STRUCTURE_FAILED);
    const sibling = { ...gate('pending', JOB_URL.replace(/\d+$/, '1')), name: 'lint' };
    const out = withFailedSteps([gate('pending'), sibling], opts);
    expect(calls).toHaveLength(1);
    expect(out.map((r) => r.bucket)).toEqual(['fail', 'pending']);
  });
});
