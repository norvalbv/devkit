/** `devkit ci-verdict`: ship's --wait-ci verdict for an already-open PR, with gh injected. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ciVerdict, { repoOfPrUrl, resolvePr } from '../commands/baseline/ci-verdict.mts';
import type { CheckRow, ChecksExec } from '../lib/ship/wait-ci/wait.mts';

const PR_JSON = JSON.stringify({ number: 985, url: 'https://github.com/norvalbv/devkit/pull/985' });
const RUN_LINK = 'https://github.com/norvalbv/devkit/actions/runs/38387941840/job/1';
const failing: CheckRow = {
  bucket: 'fail',
  name: 'gate',
  state: 'FAILURE',
  link: RUN_LINK,
  workflow: 'gate',
};

/** gh stand-in: `pr view` answers PR_JSON, `pr checks` answers `checks`; every call is logged. */
function ghStub(checks: CheckRow[], calls: string[][] = []): ChecksExec {
  return (args) => {
    calls.push(args);
    return args[1] === 'view' ? PR_JSON : JSON.stringify(checks);
  };
}

/** A gh failure shaped as execFileSync throws it. */
const ghThrows =
  (stderr: string, code?: string): ChecksExec =>
  () => {
    throw Object.assign(new Error('gh failed'), { stderr, code });
  };

/** Instant polls with no settle grace; each clock read advances `step` ms. */
const fastWait = (step = 1) => {
  let t = 0;
  return { sleep: async () => {}, settleGraceMs: 0, now: () => (t += step), emit: () => {} };
};

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void err.push(line));
});
afterEach(() => vi.restoreAllMocks());

describe('repoOfPrUrl', () => {
  it('reads owner/repo from a github.com PR url and keeps a GHES host', () => {
    expect(repoOfPrUrl('https://github.com/o/r/pull/7')).toBe('o/r');
    expect(repoOfPrUrl('https://ghe.example.com/o/r/pull/7')).toBe('ghe.example.com/o/r');
    expect(repoOfPrUrl('https://github.com/o/r/issues/7')).toBeNull();
  });
});

describe('resolvePr', () => {
  it('resolves a number or a branch through one gh pr view from cwd', () => {
    const calls: string[][] = [];
    expect(resolvePr('my-branch', '/repo', ghStub([], calls))).toEqual({
      pr: '985',
      repo: 'norvalbv/devkit',
    });
    expect(calls).toEqual([['pr', 'view', 'my-branch', '--json', 'number,url']]);
  });

  it('names why a PR could not be resolved', () => {
    expect(resolvePr('x', '/r', ghThrows('no pull requests found for branch "x"'))).toEqual({
      reason: 'pr-not-found',
    });
    expect(resolvePr('x', '/r', ghThrows('', 'ENOENT'))).toEqual({ reason: 'gh-missing' });
    // gh echoes the branch, so its name must not be read as an auth failure.
    const echoed = ghThrows('no pull requests found for branch "fix-authentication"');
    expect(resolvePr('fix-authentication', '/r', echoed)).toEqual({ reason: 'pr-not-found' });
    expect(resolvePr('x', '/r', () => 'not json')).toEqual({ reason: 'gh-json-unparseable' });
    for (const body of ['{"number":1,"url":"nope"}', '{"url":"https://github.com/o/r/pull/1"}'])
      expect(resolvePr('x', '/r', () => body)).toEqual({ reason: 'gh-json-unparseable' });
  });
});

describe('devkit ci-verdict', () => {
  it.each([
    [[], 'exactly one'],
    [['1', '2'], 'exactly one'],
    [['1', '--bogus'], 'unknown option --bogus'],
    [['1', '--timeout', '10'], '--timeout must be'],
  ])('refuses %j with exit 1', async (args, message) => {
    expect(await ciVerdict(args, '/r', { exec: ghStub([]) })).toBe(1);
    expect(err.join('\n')).toContain(message);
    expect(out).toEqual([]);
  });

  it('exits 2 with an unavailable verdict on stdout when the PR cannot be resolved', async () => {
    const code = await ciVerdict(['gone'], '/r', { exec: ghThrows('no pull requests found') });
    expect(code).toBe(2);
    expect(out).toEqual(['ship: ci-outcome=unavailable pr=gone reason=pr-not-found']);
  });

  it('exits 2, not 0, when gh disappears after the PR resolved', async () => {
    const exec: ChecksExec = (args) => {
      if (args[1] === 'view') return PR_JSON;
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    };
    expect(await ciVerdict(['985'], '/r', { exec, wait: fastWait() })).toBe(2);
    expect(out).toEqual(['ship: ci-outcome=unavailable pr=985 reason=gh-missing']);
  });

  it('prints the attributed failed verdict on stdout and exits 0', async () => {
    const seen: { pr: string; failures: CheckRow[] }[] = [];
    const code = await ciVerdict(['my-branch'], '/r', {
      exec: ghStub([failing]),
      wait: fastWait(),
      attribute: ({ pr, failures }) => {
        seen.push({ pr, failures });
        return {
          token: 'inherited-only',
          inherited: 2,
          fresh: 0,
          line: 'attribution=inherited-only inherited=2 new=0 base-run=38335385331 base-ci=red',
        };
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([{ pr: '985', failures: [failing] }]);
    expect(out).toEqual([
      `ship: ci-outcome=failed pr=985 failing=gate:${RUN_LINK} ` +
        'attribution=inherited-only inherited=2 new=0 base-run=38335385331 base-ci=red',
    ]);
  });

  it('reports an attribution that throws as unknown rather than losing the verdict', async () => {
    await ciVerdict(['985'], '/r', {
      exec: ghStub([failing]),
      wait: fastWait(),
      attribute: () => {
        throw new Error('boom');
      },
    });
    expect(out[0]).toMatch(/ci-outcome=failed .* attribution=unknown reason=attribution-error$/);
  });

  it('exits 0 on a timed-out verdict and passes --required to gh pr checks', async () => {
    const calls: string[][] = [];
    const pending = { ...failing, bucket: 'pending' as const, state: 'IN_PROGRESS' };
    const code = await ciVerdict(['985', '--timeout', '60', '--required'], '/r', {
      exec: ghStub([pending], calls),
      wait: fastWait(61_000),
    });
    expect(code).toBe(0);
    expect(out).toEqual([
      expect.stringMatching(/^ship: ci-outcome=timed-out pr=985 scope=required pending=gate/),
    ]);
    expect(calls.filter((c) => c[1] === 'checks').every((c) => c.includes('--required'))).toBe(
      true,
    );
  });
});
