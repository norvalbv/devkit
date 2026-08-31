import { describe, expect, it } from 'vitest';
import type { GitResult, GitRun } from './git-run.mts';
import { normalizeBaseName, resolveBase } from './resolve-base.mts';

/** The canned answers a fake git replies with, keyed by its joined argv. */
type GitTable = Record<string, GitResult>;

const okResult = (stdout = ''): GitResult => ({ status: 0, stdout, stderr: '' });
const failResult = (status = 1): GitResult => ({ status, stdout: '', stderr: '' });

/** A git that answers from a table keyed on the joined argv; anything unlisted fails. */
function fakeGit(table: GitTable) {
  const calls: string[][] = [];
  const run: GitRun = (args) => {
    calls.push(args);
    return table[args.join(' ')] ?? failResult();
  };
  // Object.assign infers the intersection, so the recorder needs no assertion to exist.
  return Object.assign(run, { calls });
}

const wellFormed = (base: string) => ({ [`check-ref-format refs/heads/${base}`]: okResult() });
const tracking = (base: string, sha: string) => ({
  [`show-ref --verify --quiet refs/remotes/origin/${base}`]: okResult(),
  [`rev-parse --verify --quiet refs/remotes/origin/${base}^{commit}`]: okResult(`${sha}\n`),
});

describe('normalizeBaseName', () => {
  it('strips a leading origin/ so --base origin/main and --base main are one thing', () => {
    expect(normalizeBaseName('origin/main')).toBe('main');
    expect(normalizeBaseName('  main  ')).toBe('main');
    // Only the LEADING segment: a branch legitimately named `origin/x` under a different remote
    // prefix must not be truncated twice.
    expect(normalizeBaseName('origin/origin/x')).toBe('origin/x');
  });
});

describe('resolveBase — explicit tier', () => {
  it('resolves an explicit base that verifies', () => {
    const run = fakeGit({ ...wellFormed('studio'), ...tracking('studio', 'aaa111') });
    expect(resolveBase(run, { explicit: 'studio', env: {} })).toEqual({
      kind: 'resolved',
      base: 'studio',
      ref: 'refs/remotes/origin/studio',
      source: 'explicit',
      sha: 'aaa111',
    });
  });

  it('reads $DEVKIT_BASE_REF when no --base is given', () => {
    const run = fakeGit({ ...wellFormed('release'), ...tracking('release', 'bbb222') });
    const resolved = resolveBase(run, { env: { DEVKIT_BASE_REF: 'origin/release' } });
    expect(resolved).toMatchObject({ kind: 'resolved', base: 'release', source: 'explicit' });
  });

  it('NEVER falls through to origin/HEAD when an explicit base is missing', () => {
    // The whole point of the explicit tier: ship has already decided what the PR targets, so
    // reporting against a different base is worse than reporting nothing.
    const run = fakeGit({
      ...wellFormed('gone'),
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': okResult('origin/main\n'),
      ...tracking('main', 'ccc333'),
    });
    expect(resolveBase(run, { explicit: 'gone', env: {} })).toEqual({
      kind: 'unresolvable',
      reason: 'explicit-missing',
    });
  });

  it('rejects a base git would not accept as a ref name, without probing for it', () => {
    const run = fakeGit({});
    expect(resolveBase(run, { explicit: '../../etc/passwd', env: {} })).toEqual({
      kind: 'unresolvable',
      reason: 'explicit-missing',
    });
  });

  it('retries once through the caller fetch when the tracking ref is merely absent', () => {
    // A freshly provisioned worktree can lack a tracking ref for a base that does exist on origin.
    const answers = { ...wellFormed('studio') };
    const run = fakeGit(answers);
    let fetched = 0;
    const resolved = resolveBase(run, {
      explicit: 'studio',
      env: {},
      refetch: () => {
        fetched += 1;
        Object.assign(answers, tracking('studio', 'ddd444'));
      },
    });
    expect(fetched).toBe(1);
    expect(resolved).toMatchObject({ kind: 'resolved', base: 'studio', sha: 'ddd444' });
  });
});

describe('resolveBase — origin/HEAD tier', () => {
  it('uses origin/HEAD when it names a real origin branch', () => {
    const run = fakeGit({
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': okResult('origin/trunk\n'),
      ...tracking('trunk', 'eee555'),
    });
    expect(resolveBase(run, { env: {} })).toMatchObject({
      kind: 'resolved',
      base: 'trunk',
      source: 'origin-head',
    });
  });

  it('rejects an origin/HEAD pointing at ANOTHER remote (the fork case)', () => {
    const run = fakeGit({
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': okResult('upstream/main\n'),
      ...tracking('main', 'fff666'),
    });
    // Falls through to the conventional tier rather than trusting upstream/main.
    expect(resolveBase(run, { env: {} })).toMatchObject({ source: 'main' });
  });

  it('rejects an origin/HEAD naming a branch origin no longer has', () => {
    const run = fakeGit({
      // The symref survives locally after origin renames or deletes the branch.
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': okResult('origin/old-default\n'),
      ...tracking('master', 'ggg777'),
    });
    expect(resolveBase(run, { env: {} })).toMatchObject({ source: 'master' });
  });
});

describe('resolveBase — conventional tier and giving up', () => {
  it('prefers main over master', () => {
    const run = fakeGit({ ...tracking('main', 'h1'), ...tracking('master', 'h2') });
    expect(resolveBase(run, { env: {} })).toMatchObject({ base: 'main', source: 'main' });
  });

  it('reports no-origin when the remote itself is absent', () => {
    expect(resolveBase(fakeGit({}), { env: {} })).toEqual({
      kind: 'unresolvable',
      reason: 'no-origin',
    });
  });

  it('reports no-candidate when origin exists but offers nothing verifiable', () => {
    const run = fakeGit({ remote: okResult('origin\n') });
    expect(resolveBase(run, { env: {} })).toEqual({ kind: 'unresolvable', reason: 'no-candidate' });
  });
});
