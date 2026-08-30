/** sc-2261 — the base resolvers in cli/lib/ship/origin-base.sh, sourced and called directly. */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync } from './_helpers.mts';
import { dirs, GIT_ENV, scriptPath } from './_ship-branch-fixture.mts';

const lib = dirname(scriptPath);

/** Call one resolver against a real repo. Empty string means "no answer", which is a real result. */
function resolverOf(fn, repo) {
  return execFileSync(
    '/bin/bash',
    ['-c', `set -euo pipefail\n. "${lib}/origin-base.sh"\n${fn} ${JSON.stringify(repo)}`],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
  ).trim();
}

/** A checkout on `work` with a bare origin. Nothing pushed, no origin/HEAD — the barest real shape. */
function seedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'originbase-'));
  dirs.push(root);
  const bare = join(root, 'origin.git');
  const dir = join(root, 'work');
  const git = (a) =>
    execFileSync('git', ['-C', dir, ...a], {
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    });
  const bareGit = (a) =>
    execFileSync('git', ['-C', bare, ...a], {
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    });
  execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GIT_ENV } });
  execFileSync('git', ['init', '-q', '-b', 'work', dir], { env: { ...process.env, ...GIT_ENV } });
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 'a']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'note.txt'), 'hi\n');
  git(['add', 'note.txt']);
  git(['commit', '-q', '-m', 'base']);
  git(['remote', 'add', 'origin', bare]);
  return { dir, bare, git, bareGit };
}

describe('origin-base.sh — ship_origin_default_branch (local, no network)', () => {
  it('prefers refs/remotes/origin/HEAD, stripped of its origin/ prefix', () => {
    const { dir, git } = seedRepo();
    git(['push', '-q', 'origin', 'work:trunk']);
    git(['push', '-q', 'origin', 'work:main']); // present, and must LOSE to the explicit symref
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);

    expect(resolverOf('ship_origin_default_branch', dir)).toBe('trunk');
  });

  it('falls back to origin/main, then origin/master, when no symref exists', () => {
    // The middle rung of the ladder. Untested, it would silently never fire and every repo without
    // an origin/HEAD would drop straight to the ancestor scan — a different, weaker answer.
    const withMain = seedRepo();
    withMain.git(['push', '-q', 'origin', 'work:main']);
    withMain.git(['push', '-q', 'origin', 'work:master']); // main must win the tie
    expect(resolverOf('ship_origin_default_branch', withMain.dir)).toBe('main');

    const withMaster = seedRepo();
    withMaster.git(['push', '-q', 'origin', 'work:master']);
    expect(resolverOf('ship_origin_default_branch', withMaster.dir)).toBe('master');
  });

  it('ignores a stale origin/HEAD that still names a deleted remote branch', () => {
    // Nothing prunes refs/remotes/origin/HEAD: after the remote's default is renamed or deleted, the
    // local symref keeps resolving to a name that no longer exists. Trusting it prints
    // `git switch <deleted-branch>` as the remedy, which fails and leaves the caller stuck.
    const { dir, git } = seedRepo();
    git(['push', '-q', 'origin', 'work:gone']);
    git(['push', '-q', 'origin', 'work:main']);
    git(['fetch', '-q', 'origin']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone']);
    git(['update-ref', '-d', 'refs/remotes/origin/gone']); // the branch is gone; the symref is not

    expect(resolverOf('ship_origin_default_branch', dir)).toBe('main'); // falls through, never 'gone'
  });

  it('rejects an origin/HEAD that points into ANOTHER remote’s namespace', () => {
    // A fork's origin/HEAD may legally target refs/remotes/upstream/main. That is not an origin
    // branch, so `--base upstream/main` and `git switch upstream/main` are both wrong.
    const { dir, git } = seedRepo();
    git(['push', '-q', 'origin', 'work:main']);
    git(['remote', 'add', 'upstream', '/dev/null']);
    git(['update-ref', 'refs/remotes/upstream/other', 'HEAD']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/upstream/other']);

    expect(resolverOf('ship_origin_default_branch', dir)).toBe('main'); // never 'upstream/other'
  });

  it('answers nothing — and exits 0 — when origin has no default to infer', () => {
    // `symbolic-ref` on an absent refs/remotes/origin/HEAD exits 128. Under the callers' `set -euo
    // pipefail` an unguarded substitution would abort the script here, killing the very refusal this
    // value is being resolved for. Asserting the exit status is the whole point of this case.
    const { dir } = seedRepo();
    expect(resolverOf('ship_origin_default_branch', dir)).toBe('');
  });
});

describe('origin-base.sh — ship_origin_base_candidate (default, else an ancestor on origin)', () => {
  it('falls back to a remote branch this HEAD already sits on top of', () => {
    const { dir, git } = seedRepo();
    git(['push', '-q', 'origin', 'work:work']);

    expect(resolverOf('ship_origin_base_candidate', dir)).toBe('work');
  });

  it('ignores a remote branch that HEAD is NOT on top of', () => {
    // An unrelated branch on origin is not a base for this work: a PR against it would either fail
    // or show a diff nobody asked for. Answering nothing is the honest result.
    const { dir, git, bare } = seedRepo();
    git(['checkout', '-q', '--orphan', 'unrelated']);
    writeFileSync(join(dir, 'other.txt'), 'x\n');
    git(['add', 'other.txt']);
    git(['commit', '-q', '-m', 'unrelated root']);
    git(['push', '-q', 'origin', 'unrelated:unrelated']);
    git(['checkout', '-q', 'work']);
    expect(
      execFileSync('git', ['-C', bare, 'rev-parse', '--verify', 'unrelated'], {
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV },
      }).trim(),
    ).toBeTruthy(); // precondition: it really is on origin

    expect(resolverOf('ship_origin_base_candidate', dir)).toBe('');
  });

  it('never answers "HEAD" from refs/remotes/origin/HEAD itself', () => {
    // for-each-ref over refs/remotes/origin lists the symref alongside real branches. Left in, the
    // scan can answer the literal string "HEAD" — a name `git switch` and `--base` both reject.
    const { dir, git } = seedRepo();
    git(['push', '-q', 'origin', 'work:work']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/work']);

    expect(resolverOf('ship_origin_base_candidate', dir)).not.toBe('HEAD');
  });
});

describe('origin-base.sh — a candidate is only offered if origin still has it', () => {
  it('prefers the branch HEAD sits on top of over origin’s unrelated nominal default', () => {
    const { dir, git } = seedRepo();
    git(['push', '-q', 'origin', 'work:release']); // the branch this work is cut from
    git(['checkout', '-q', '--orphan', 'main']); // origin's default, sharing no history with it
    writeFileSync(join(dir, 'main.txt'), 'x\n');
    git(['add', 'main.txt']);
    git(['commit', '-q', '-m', 'unrelated default']);
    git(['push', '-q', 'origin', 'main:main']);
    git(['checkout', '-q', 'work']);
    git(['fetch', '-q', 'origin']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    expect(resolverOf('ship_origin_default_branch', dir)).toBe('main'); // the default really is main
    expect(resolverOf('ship_origin_base_candidate', dir)).toBe('release'); // …but the work sits here
  });

  it('does not offer a branch whose remote-tracking ref outlived the branch on origin', () => {
    // Remote-tracking refs are a local cache: origin deletes a branch and refs/remotes/origin/<it>
    // survives until someone prunes. A remedy built on that prints a switch that fails, and a
    // --base that the preflight then refuses on the retry.
    const { dir, git, bareGit } = seedRepo();
    git(['push', '-q', 'origin', 'work:doomed']);
    git(['fetch', '-q', 'origin']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/doomed']);
    bareGit(['branch', '-D', 'doomed']); // gone from origin; the local tracking ref remains
    expect(
      execFileSync('git', ['-C', dir, 'show-ref', '--verify', '-q', 'refs/remotes/origin/doomed'], {
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV },
      }),
    ).toBe(''); // precondition: the stale ref really is still here

    expect(resolverOf('ship_origin_base_candidate', dir)).toBe('');
  });
});

describe('origin-base.sh — ship_origin_head_branch (origin’s own HEAD, over the network)', () => {
  it('reads a slashed default branch out of ls-remote --symref intact', () => {
    // Release-train repos (devkit's origin among them) use `0.0.11` / `release/1.0`. A parse that
    // stopped at a path segment would suggest a base that does not exist.
    const { dir, git, bareGit } = seedRepo();
    git(['push', '-q', 'origin', 'work:release/1.0']);
    bareGit(['symbolic-ref', 'HEAD', 'refs/heads/release/1.0']);

    expect(resolverOf('ship_origin_head_branch', dir)).toBe('release/1.0');
  });

  it('answers nothing when origin’s HEAD is unborn, without tripping pipefail', () => {
    // `git init --bare` points HEAD at a branch that does not exist yet, so --symref prints nothing.
    // The resolver is a PIPELINE, so `set -o pipefail` makes any stage's failure the caller's — this
    // pins the guard that keeps that from aborting the refusal being composed around it.
    const { dir } = seedRepo();
    expect(resolverOf('ship_origin_head_branch', dir)).toBe('');
  });
});

describe('origin-base.sh — ship_shell_quote (ref names are not safe shell literals)', () => {
  // Via the environment, never interpolated into the script: a double-quoted bash literal would
  // expand `$(…)` before ship_shell_quote ever saw it, and the test would grade its own harness.
  const quote = (v) =>
    execFileSync(
      '/bin/bash',
      ['-c', `set -euo pipefail\n. "${lib}/origin-base.sh"\nship_shell_quote "$RAW"`],
      { encoding: 'utf8', env: { ...process.env, ...GIT_ENV, RAW: v } },
    ).trim();

  /** Round-trip through a real shell: the quoted form must evaluate back to the original bytes. */
  const evalBack = (quoted) =>
    execFileSync('/bin/bash', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });

  for (const name of [
    'plain',
    'release/1.0',
    "release/o'neil", // git allows an apostrophe; a naive wrapper emits an unmatched quote
    'feat/$(id)', // git allows these too; bare, they would execute as the operator
    'feat/`id`',
    'feat/a"b',
  ]) {
    it(`survives a round-trip through the shell: ${name}`, () => {
      expect(evalBack(quote(name))).toBe(name);
    });
  }

  it('leaves no substitution unevaluated — the quoted form is inert', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'quote-')), 'pwned');
    dirs.push(marker);
    const hostile = `release/$(touch ${marker})`;
    expect(evalBack(quote(hostile))).toBe(hostile);
    expect(existsSync(marker)).toBe(false);
  });
});
