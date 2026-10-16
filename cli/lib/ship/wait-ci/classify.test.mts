import { describe, expect, it } from 'vitest';
import { classifyChecksFailure } from './classify.mts';

describe('classifyChecksFailure', () => {
  it('reads the --required empty set as no checks, not as the exit-1 error it shares', () => {
    expect(
      classifyChecksFailure({ status: 1, stderr: "no required checks reported on the 'x' branch" }),
    ).toEqual({ kind: 'rows', rows: [] });
  });

  it.each([
    'Post "https://api.github.com/graphql": dial tcp 20.250.119.72:443: i/o timeout',
    'read tcp 10.0.0.5:54321->140.82.121.6:443: read: connection reset by peer',
    'HTTP 502: Bad Gateway (https://api.github.com/graphql)',
    'GraphQL: API rate limit exceeded for user ID 1',
    'GraphQL: Something went wrong while executing your query. This may be the result of a timeout',
    // gh's own wording for a DNS failure: printError never prints "no such host" without --debug.
    'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com',
  ])('names a network or GitHub-side fault unreachable: %s', (stderr) => {
    expect(classifyChecksFailure({ status: 1, stderr })).toMatchObject({
      kind: 'unavailable',
      reason: 'gh-unreachable',
    });
  });

  it('names the per-poll exec cap firing unreachable', () => {
    expect(classifyChecksFailure({ killed: true })).toMatchObject({ reason: 'gh-unreachable' });
  });

  it.each([
    'unknown flag: --required',
    'Unknown JSON field: "nonsense"',
    'expected the "[HOST/]OWNER/REPO" format, got "bad"',
    "GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)",
    'HTTP 401: Bad credentials (https://api.github.com/graphql)',
  ])('keeps a failure waiting cannot fix as gh-failed: %s', (stderr) => {
    expect(classifyChecksFailure({ status: 1, stderr })).toMatchObject({ reason: 'gh-failed' });
  });
});
