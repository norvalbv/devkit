/** sc-2261 — the base resolvers in cli/lib/ship/origin-base.sh, sourced and called directly. */
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
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

/**
 * The ancestor tier alone. Returns the exit code beside the output: "no answer" is exit 1 with empty
 * stdout, and swallowing the code would let a CRASH pass as that same valid result.
 */
function ancestorOf(repo) {
  const r = spawnSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail\n. "${lib}/origin-base.sh"\nship_origin_ancestor_branch ${JSON.stringify(repo)}`,
    ],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
  );
  return { status: r.status, out: (r.stdout ?? '').trim() };
}

describe('origin-base.sh — ship_origin_ancestor_branch (tier 1 only, with its oid)', () => {
  it('answers the nearest ancestor as "<oid> <name>"', () => {
    const { dir, git } = seedRepo();
    git(['push', '-q', 'origin', 'work:work']);

    expect(ancestorOf(dir)).toEqual({
      status: 0,
      out: `${git(['rev-parse', 'HEAD']).trim()} work`,
    });
  });

  it('answers NOTHING where ship_origin_base_candidate falls through to the default', () => {
    // The candidate's fall-through answers "what could I switch to", not "what is this work built
    // on": that branch has no branch point here, so ancestry against it compares the wrong commit.
    const { dir, git } = seedRepo();
    git(['push', '-q', 'origin', 'work:main']);
    git(['checkout', '-q', '--orphan', 'solo']);
    writeFileSync(join(dir, 'solo.txt'), 'x\n');
    git(['add', 'solo.txt']);
    git(['commit', '-q', '-m', 'unrelated root']);

    // Exit 1 with empty stdout is the documented "no answer"; any other code is a defect wearing
    // the same clothes, which is why the status is asserted rather than discarded.
    expect(ancestorOf(dir)).toEqual({ status: 1, out: '' });
    expect(resolverOf('ship_origin_base_candidate', dir)).toBe('main');
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

/** Push to <branch> from a separate clone, so this checkout never sees the commit. `orphan` puts it
 *  on an unrelated line (a force-push); otherwise it advances the branch. */
function pushFromOtherClone(bare, branch, msg, orphan) {
  const other = mkdtempSync(join(tmpdir(), 'otherclone-'));
  dirs.push(other);
  const og = (a) =>
    execFileSync('git', ['-C', other, '-c', 'user.email=a@b.c', '-c', 'user.name=a', ...a], {
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    });
  execFileSync('git', ['clone', '-q', '-b', branch, bare, other], {
    env: { ...process.env, ...GIT_ENV },
  });
  if (orphan) og(['checkout', '-q', '--orphan', 'x']);
  writeFileSync(join(other, `${msg}.txt`), 'x\n');
  og(['add', `${msg}.txt`]);
  og(['commit', '-q', '-m', msg]);
  og(['push', '-q', '-f', 'origin', `HEAD:${branch}`]);
}

/** A `git` on PATH that runs <caseBody> (sh) first, then execs the real git. Returns its bin dir. */
function shimGit(caseBody) {
  const bin = mkdtempSync(join(tmpdir(), 'shimgit-'));
  dirs.push(bin);
  const real = execFileSync('command', ['-v', 'git'], { shell: true, encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${caseBody}\nexec ${real} "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return bin;
}

/** ship_suggested_base on HEAD with <bin> first on PATH. */
function suggestedWith(repo, bin) {
  const r = spawnSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail\n. "${lib}/origin-base.sh"\nship_suggested_base ${JSON.stringify(repo)} HEAD`,
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` },
    },
  );
  return { status: r.status, out: (r.stdout ?? '').trim() };
}

/** One commit on the current branch, returning its oid. */
function commitOn(dir, git, msg) {
  writeFileSync(join(dir, 'note.txt'), `${msg}\n`);
  git(['add', 'note.txt']);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']).trim();
}

/** The shared suggestion resolver, with its exit code beside the output (see ancestorOf). */
function suggestedOf(repo, head = 'HEAD') {
  const r = spawnSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail\n. "${lib}/origin-base.sh"\nship_suggested_base ${JSON.stringify(repo)} ${JSON.stringify(head)}`,
    ],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
  );
  return { status: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
}

/** sc-3409: old `0.0.8` in main's past, story cut from main, and origin/main advanced past the
 *  fork point — so main is no longer an ancestor and the stale release branch used to win. */
function seedAdvancedDefault() {
  const seeded = seedRepo();
  const { dir, git, bareGit } = seeded;
  git(['push', '-q', 'origin', 'work:0.0.8']); // the old release line
  const fork = commitOn(dir, git, 'main moves on');
  git(['push', '-q', 'origin', 'work:main']);
  bareGit(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['switch', '-q', '-c', 'advance']);
  const advanced = commitOn(dir, git, 'main advances past the fork point');
  git(['push', '-q', 'origin', 'advance:main']);
  git(['switch', '-q', '-c', 'story', fork]);
  commitOn(dir, git, 'the story');
  git(['fetch', '-q', 'origin']);
  return { ...seeded, fork, advanced };
}

describe('origin-base.sh — ship_suggested_base prefers a default that contains the candidate (sc-3409)', () => {
  it('answers the default, not a stale release branch, once origin/main has advanced', () => {
    const { dir } = seedAdvancedDefault();
    expect(suggestedOf(dir)).toMatchObject({ status: 0, out: 'default main' });
    // The rename remedy's resolver must give the same answer — the two lines the story caught disagreeing.
    expect(resolverOf('ship_origin_base_candidate', dir)).toBe('main');
  });

  it('answers the default on an exact tie, not the lexicographically-first name', () => {
    const { dir, git, bareGit } = seedRepo();
    git(['push', '-q', 'origin', 'work:0.0.8']);
    git(['push', '-q', 'origin', 'work:main']);
    bareGit(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(['fetch', '-q', 'origin']);

    expect(suggestedOf(dir)).toMatchObject({ status: 0, out: 'default main' });
    expect(resolverOf('ship_origin_base_candidate', dir)).toBe('main');
  });

  it('keeps a release line with its own commits (sc-2357), even when main is its ancestor', () => {
    const { dir, git, bareGit } = seedRepo();
    git(['push', '-q', 'origin', 'work:main']);
    bareGit(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    commitOn(dir, git, 'release-only commit');
    git(['push', '-q', 'origin', 'work:release/1.0']);
    commitOn(dir, git, 'the story');
    git(['fetch', '-q', 'origin']);

    expect(suggestedOf(dir)).toMatchObject({ status: 0, out: 'ancestor release/1.0' });
    expect(resolverOf('ship_origin_base_candidate', dir)).toBe('release/1.0');
  });

  it('still judges containment with no tracking ref, when origin’s commit is known locally', () => {
    // A narrow refspec never mirrors origin/main, but the commit can reach this checkout another way.
    const { dir, git } = seedAdvancedDefault();
    git(['update-ref', '-d', 'refs/remotes/origin/main']);
    expect(suggestedOf(dir)).toMatchObject({ status: 0, out: 'default main' });
  });

  it('fetches an unseen default commit to judge it, without writing any ref', () => {
    const { dir, git, bare } = seedAdvancedDefault();
    git(['update-ref', '-d', 'refs/remotes/origin/main']);
    pushFromOtherClone(bare, 'main', 'unseen', false);

    expect(suggestedOf(dir)).toMatchObject({ status: 0, out: 'default main' });
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/main']).trim()).toBe(
      '',
    );
  });

  it('refuses a default force-pushed from ANOTHER clone onto an unseen unrelated line (stale cache)', () => {
    // The tracking ref still contains 0.0.8; origin's main no longer does, and this checkout has
    // never seen the commit it now points at.
    const { dir, bare } = seedAdvancedDefault();
    pushFromOtherClone(bare, 'main', 'unrelated', true);

    expect(suggestedOf(dir)).toMatchObject({ status: 0, out: 'ancestor 0.0.8' });
  });

  it('names nothing when the ancestor IS the default and it was moved off this line', () => {
    const { dir, git, bare } = seedRepo();
    git(['push', '-q', 'origin', 'work:main']);
    execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], {
      env: { ...process.env, ...GIT_ENV },
    });
    git(['fetch', '-q', 'origin']);
    pushFromOtherClone(bare, 'main', 'unrelated', true);

    expect(suggestedOf(dir)).toMatchObject({ status: 1, out: '' });
  });

  it('judges containment against origin’s CURRENT default, not a stale tracking ref', () => {
    // origin/main was force-pushed onto an unrelated line after the last fetch. The local cache still
    // contains 0.0.8; origin's main does not, so suggesting it would fail ship's own base check.
    const { dir, git, bareGit } = seedAdvancedDefault();
    git(['checkout', '-q', '--orphan', 'elsewhere']);
    commitOn(dir, git, 'unrelated root');
    git(['push', '-q', '-f', 'origin', 'elsewhere:main']);
    git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'advance']).trim()]);
    git(['switch', '-q', 'story']);
    expect(bareGit(['rev-parse', 'main']).trim()).toBe(git(['rev-parse', 'elsewhere']).trim());

    expect(suggestedOf(dir)).toMatchObject({ status: 0, out: 'ancestor 0.0.8' });
  });

  it('never suggests a default origin no longer has, even when the local cache contains the candidate', () => {
    const { dir, bareGit } = seedAdvancedDefault();
    // Origin's HEAD now dangles; the local ladder still answers "main" from the unpruned cache.
    bareGit(['update-ref', '-d', 'refs/heads/main']);

    expect(suggestedOf(dir)).toMatchObject({ status: 0, out: 'ancestor 0.0.8' });
  });

  it('judges the PINNED head, not live HEAD', () => {
    const { dir, git } = seedAdvancedDefault();
    const story = git(['rev-parse', 'story']).trim();
    git(['checkout', '-q', '--orphan', 'unrelated']);
    commitOn(dir, git, 'another actor moved the checkout');

    expect(suggestedOf(dir, story)).toMatchObject({ status: 0, out: 'default main' });
  });

  it('an EMPTY pin skips the ancestor tier instead of reading live HEAD, in both resolvers', () => {
    // HEAD sits on release/1.0 (which main does not contain), so a live read would answer release.
    const { dir, git, bareGit } = seedRepo();
    git(['push', '-q', 'origin', 'work:main']);
    bareGit(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    commitOn(dir, git, 'release-only commit');
    git(['push', '-q', 'origin', 'work:release/1.0']);
    git(['fetch', '-q', 'origin']);

    expect(suggestedOf(dir, '')).toMatchObject({ status: 0, out: 'default main' });
    const candidate = execFileSync(
      '/bin/bash',
      [
        '-c',
        `set -euo pipefail\n. "${lib}/origin-base.sh"\nship_origin_base_candidate ${JSON.stringify(dir)} ''`,
      ],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
    ).trim();
    expect(candidate).toBe('main');
  });

  it('never suggests a default force-pushed between the containment check and its pinned re-proof', () => {
    // A git shim answers the SECOND `ls-remote refs/heads/main` with a different oid: the race window.
    const { dir, bareGit } = seedAdvancedDefault();
    bareGit(['branch', '-D', '0.0.8']); // the ancestor cannot answer either, so no tier may fall back
    const bin = mkdtempSync(join(tmpdir(), 'racegit-'));
    dirs.push(bin);
    const real = execFileSync('command', ['-v', 'git'], { shell: true, encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\ncase " $* " in *' ls-remote '*' refs/heads/main '*)\n  n=$(cat "${bin}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${bin}/n"\n  [ "$n" -ge 2 ] && { printf '%040d\\trefs/heads/main\\n' 0; exit 0; } ;;\nesac\nexec ${real} "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const r = spawnSync(
      '/bin/bash',
      [
        '-c',
        `set -euo pipefail\n. "${lib}/origin-base.sh"\nship_suggested_base ${JSON.stringify(dir)} HEAD`,
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    expect({ status: r.status, out: r.stdout.trim() }).toEqual({ status: 1, out: '' });
  });

  it('never names a default whose origin HEAD was repointed between the check and the re-proof', () => {
    // main keeps the SAME oid, so an oid-only re-proof would pass; origin's HEAD now names trunk.
    const { dir, git } = seedAdvancedDefault();
    const mainOid = git(['rev-parse', 'refs/remotes/origin/main']).trim();
    const bin = shimGit(
      `case " $* " in *' --symref '*' refs/heads/main '*) printf 'ref: refs/heads/trunk\\tHEAD\\n${mainOid}\\tHEAD\\n${mainOid}\\trefs/heads/main\\n'; exit 0 ;; esac`,
    );

    expect(suggestedWith(dir, bin)).toEqual({ status: 0, out: 'ancestor 0.0.8' });
  });

  it('lets only a default ORIGIN named outrank the ancestor, never the local cache', () => {
    // origin's HEAD cannot be read, so "main" would come from refs/remotes/origin/main alone.
    const { dir } = seedAdvancedDefault();
    const bin = shimGit(`case " $* " in *' --symref origin HEAD ') exit 2 ;; esac`);

    expect(suggestedWith(dir, bin)).toEqual({ status: 0, out: 'ancestor 0.0.8' });
  });

  it('names nothing when the ancestor IS the default, it was force-pushed, and the new tip cannot be fetched', () => {
    const { dir, git, bare } = seedRepo();
    git(['push', '-q', 'origin', 'work:main']);
    execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], {
      env: { ...process.env, ...GIT_ENV },
    });
    git(['fetch', '-q', 'origin']);
    pushFromOtherClone(bare, 'main', 'unrelated', true);
    const bin = shimGit(`case " $* " in *' fetch '*) exit 1 ;; esac`); // containment: cannot tell

    expect(suggestedWith(dir, bin)).toEqual({ status: 1, out: '' });
  });

  it('names nothing when origin’s HEAD is unreadable and the cached default moved off the work', () => {
    const { dir, git, bare } = seedRepo();
    git(['push', '-q', 'origin', 'work:main']);
    git(['fetch', '-q', 'origin']);
    pushFromOtherClone(bare, 'main', 'unrelated', true);
    const bin = shimGit(`case " $* " in *' --symref '*) exit 2 ;; esac`);

    expect(suggestedWith(dir, bin)).toEqual({ status: 1, out: '' });
  });

  it('falls back to a re-proven default when the ancestor is gone from origin (sc-2261)', () => {
    const { dir, git, bareGit } = seedRepo();
    git(['push', '-q', 'origin', 'work:main']);
    bareGit(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    commitOn(dir, git, 'release-only commit');
    git(['push', '-q', 'origin', 'work:release/1.0']);
    git(['fetch', '-q', 'origin']);
    bareGit(['branch', '-D', 'release/1.0']);

    expect(suggestedOf(dir)).toMatchObject({ status: 0, out: 'default main' });
  });

  it('does not fall back to a default force-pushed between its judgment and its re-proof', () => {
    const { dir, git, bareGit } = seedRepo();
    git(['push', '-q', 'origin', 'work:main']);
    bareGit(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    commitOn(dir, git, 'release-only commit');
    git(['push', '-q', 'origin', 'work:release/1.0']);
    git(['fetch', '-q', 'origin']);
    bareGit(['branch', '-D', 'release/1.0']); // the ancestor cannot answer, so the fallback is tried
    const moved = '0'.repeat(40);
    const bin = shimGit(
      `case " $* " in *' --symref '*' refs/heads/main '*) printf 'ref: refs/heads/main\\tHEAD\\n${moved}\\tHEAD\\n${moved}\\trefs/heads/main\\n'; exit 0 ;; esac`,
    );

    expect(suggestedWith(dir, bin)).toEqual({ status: 1, out: '' });
  });

  it('reuses one proven base across a refusal, re-proving it before every print', () => {
    const { dir, git, bare } = seedAdvancedDefault();
    const head = git(['rev-parse', 'HEAD']).trim();
    const run = (mutate) =>
      spawnSync(
        '/bin/bash',
        [
          '-c',
          [
            'set -euo pipefail',
            `. "${lib}/origin-base.sh"`,
            `ship_suggested_base_memo ${JSON.stringify(dir)} ${head}`,
            'echo "remedy=$SHIP_SUGGESTED_ANSWER"',
            mutate,
            `ship_suggest_base acme/app ${JSON.stringify(dir)} ${head}`,
          ].join('\n'),
        ],
        { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
      );

    // Origin unchanged: the advisory repeats the remedy's base.
    const same = run(':');
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toContain('remedy=default main');
    expect(same.stdout).toContain("origin's default branch is 'main' — pass --base 'main'");

    // origin's HEAD repointed in between: the re-proof fails, so the advisory WITHDRAWS rather than
    // naming a second base ('0.0.8') or the stale one ('main').
    const moved = run(`git -C ${JSON.stringify(bare)} symbolic-ref HEAD refs/heads/0.0.8`);
    expect(moved.status, moved.stderr).toBe(0);
    expect(moved.stdout).toContain('remedy=default main');
    expect(moved.stdout).not.toMatch(/--base '/);
    expect(moved.stdout).toContain('choose the base yourself');
  });

  it('withdraws a reused local-ladder guess once origin’s HEAD names a different default', () => {
    // origin's HEAD is unborn (unreadable), nothing on origin is an ancestor: the ladder guesses main.
    const { dir, git, bare } = seedRepo();
    git(['push', '-q', 'origin', 'work:main']);
    git(['push', '-q', 'origin', 'work:develop']);
    git(['fetch', '-q', 'origin']);
    git(['checkout', '-q', '--orphan', 'unrelated']);
    commitOn(dir, git, 'unrelated root');
    const head = git(['rev-parse', 'HEAD']).trim();
    const r = spawnSync(
      '/bin/bash',
      [
        '-c',
        [
          'set -euo pipefail',
          `. "${lib}/origin-base.sh"`,
          `ship_suggested_base_memo ${JSON.stringify(dir)} ${head}`,
          'echo "remedy=$SHIP_SUGGESTED_ANSWER"',
          `git -C ${JSON.stringify(bare)} symbolic-ref HEAD refs/heads/develop`,
          `ship_suggest_base acme/app ${JSON.stringify(dir)} ${head}`,
        ].join('\n'),
      ],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('remedy=default main');
    expect(r.stdout).not.toMatch(/--base '/);
    expect(r.stdout).toContain('choose the base yourself');
  });

  it('answers nothing — exit 1, no crash — when origin has no branches at all', () => {
    const { dir } = seedRepo();
    expect(suggestedOf(dir)).toMatchObject({ status: 1, out: '' });
  });
});
