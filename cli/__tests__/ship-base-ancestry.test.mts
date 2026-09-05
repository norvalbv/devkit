/**
 * sc-2357 — ship refuses a --base that does not contain the commit this work is built on.
 * The predicate is one shell function, called directly; one end-to-end case covers the wiring.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dirs,
  EPHEMERAL_WT_RE,
  GIT_ENV,
  localBranchExists,
  remoteBranchExists,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const lib = dirname(scriptPath);

/** Call the predicate the way ship-branch.sh does: repo, the base's BRANCH NAME, the pinned base OID. */
function relatedness(repo: string, baseRef: string, baseOid: string, extraEnv = {}, head = 'HEAD') {
  const r = spawnSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail\n. "${lib}/origin-base.sh"\nship_base_contains_branch_point "$1" "$2" "$3" "$4"`,
      'bash',
      repo,
      baseRef,
      baseOid,
      head,
    ],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...extraEnv } },
  );
  return { status: r.status, stderr: r.stderr };
}

/** The base hint, called the way ship-branch.sh calls it: a GitHub slug plus the checkout to read. */
function suggestBaseFrom(repo: string, cwd: string = repo, head = '') {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail\n. "${lib}/origin-base.sh"\nship_suggest_base "acme/app" "$1" "$2"`,
      'bash',
      repo,
      head,
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
  ).stdout;
}

/**
 * Two lines that SHARE history: c0 = origin/main + origin/work, c1 = origin/release + HEAD.
 * Unrelated-histories never fires here, so only containment separates a right base from a wrong one.
 */
function seedTwoLines() {
  const root = mkdtempSync(join(tmpdir(), 'baseancestry-'));
  dirs.push(root);
  const bare = join(root, 'origin.git');
  const dir = join(root, 'work');
  const env = { ...process.env, ...GIT_ENV };
  const git = (a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env });
  const bareGit = (a: string[]) =>
    execFileSync('git', ['-C', bare, ...a], { encoding: 'utf8', env });
  execFileSync('git', ['init', '-q', '--bare', bare], { env });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env });
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 'a']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'f.txt'), 'c0\n');
  git(['add', 'f.txt']);
  git(['commit', '-q', '-m', 'c0']);
  git(['remote', 'add', 'origin', bare]);
  git(['push', '-q', 'origin', 'main:main']);
  const c0 = git(['rev-parse', 'HEAD']).trim();

  git(['switch', '-q', '-c', 'feature']);
  writeFileSync(join(dir, 'f.txt'), 'c1\n');
  git(['add', 'f.txt']);
  git(['commit', '-q', '-m', 'c1']);
  git(['push', '-q', 'origin', 'HEAD:release']);
  const c1 = git(['rev-parse', 'HEAD']).trim();

  git(['fetch', '-q', 'origin']);
  return { dir, bare, git, bareGit, c0, c1 };
}

describe('ship base relatedness — the refusal (sc-2357)', () => {
  it('refuses a base that does not contain the branch point, and says which branches do', () => {
    const { dir, c0, c1 } = seedTwoLines();

    const r = relatedness(dir, 'main', c0);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`branch point ${c1.slice(0, 9)} (origin/release)`);
    expect(r.stderr).toContain('is not contained in origin/main');
    // The distance is NARRATED. It is never the trigger — base-drift Rejected(b) — so it appears in
    // the message and nowhere in the predicate above it.
    expect(r.stderr).toMatch(/origin\/main is missing 1 commit\(s\)/);
    expect(r.stderr).toContain('contained by: origin/release');
    expect(r.stderr).toContain(
      "the branch this work sits on top of is 'release' — pass --base 'release'",
    );
    expect(r.stderr).toContain('GUARD_SHIP_BASE_OK=1');
  });

  it('never names a candidate origin no longer has', () => {
    // Remote-tracking refs outlive the branches they cache. The refusal stands either way; it just
    // stops short of naming a remedy origin cannot honour.
    const { dir, bareGit, c0 } = seedTwoLines();
    bareGit(['branch', '-D', 'release']);

    const r = relatedness(dir, 'main', c0);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not contained in origin/main');
    expect(r.stderr).not.toContain('pass --base');
  });

  it('drops the remedy when the candidate was FORCE-PUSHED off the history it was chosen on', () => {
    // Sibling worktrees share refs/remotes: a force-push can leave the candidate EXISTING at a commit
    // this work never sat on. Existence alone would pass; the ls-remote proof is oid-pinned.
    const { dir, bareGit, c0 } = seedTwoLines();
    bareGit(['branch', '-f', 'release', c0]); // origin moves; the local tracking ref still says c1

    const r = relatedness(dir, 'main', c0);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not contained in origin/main');
    expect(r.stderr).not.toContain('pass --base');
  });

  it('refuses when the base itself was force-pushed off the branch point, same name and all', () => {
    // Name equality is not proof: the candidate oid is the local tracking ref and the base oid this
    // run's fetch, so a rewind leaves the names equal while the pinned base lost the branch point.
    const { dir, git, bareGit, c0, c1 } = seedTwoLines();
    bareGit(['branch', '-f', 'release', c0]); // origin/release rewound off c1
    const rewound = bareGit(['rev-parse', 'release']).trim();

    expect(git(['rev-parse', 'origin/release']).trim()).toBe(c1); // the local cache still says c1
    const r = relatedness(dir, 'release', rewound);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not contained in origin/release');
    // "pass --base release" would be no remedy at all when release IS what was passed.
    expect(r.stderr).toContain("origin/release moved off this work's branch point");
    expect(r.stderr).not.toContain('pass --base');
  });

  it('judges the PINNED head, not whatever HEAD happens to be by the time it runs', () => {
    // ship pins CALLER_HEAD before staging because a sibling agent can switch or reset the shared
    // checkout mid-run. Re-reading HEAD here would judge a line this ship never touched.
    const { dir, git, c0, c1 } = seedTwoLines();
    git(['switch', '-q', 'main']); // another actor moves the checkout off the work

    expect(relatedness(dir, 'main', c0).status).toBe(0); // a fresh HEAD read sees nothing wrong
    expect(relatedness(dir, 'main', c0, {}, c1).status).toBe(1); // the pinned commit still refuses
  });

  it('fails open when the head it was handed cannot be resolved', () => {
    // The caller's pin is allowed to be unreadable. Judging a live HEAD instead would decide the
    // ship on a commit nobody in this run reasoned about — the failure the pin exists to stop.
    const { dir, c0 } = seedTwoLines();

    const r = relatedness(dir, 'main', c0, {}, 'no-such-ref-here');

    expect(r.status).toBe(0);
  });

  it('GUARD_SHIP_BASE_OK proceeds, and says what the override costs', () => {
    const { dir, c0 } = seedTwoLines();

    const r = relatedness(dir, 'main', c0, { GUARD_SHIP_BASE_OK: '1' });

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('GUARD_SHIP_BASE_OK:');
    // Naming the cost is the point. The incident's agent answered twelve phantom clone findings with
    // twelve permanent allowlist entries; an override that says nothing invites exactly that again.
    expect(r.stderr).toMatch(
      /guard-size, guard-clone and structure results are not about your change/,
    );
  });
});

describe('ship base relatedness — what must NOT refuse', () => {
  it('ships when the base IS the branch the work sits on, however far it has advanced', () => {
    // The ordinary case, and the reason the --from-branch predicate could not be reused here: a base
    // that has moved ahead of the fork point is normal, shippable, and already handled at staging.
    const { dir, git } = seedTwoLines();
    git(['switch', '-q', '-c', 'advance']);
    writeFileSync(join(dir, 'f.txt'), 'c2\n');
    git(['add', 'f.txt']);
    git(['commit', '-q', '-m', 'the base advances past the fork point']);
    git(['push', '-q', 'origin', 'HEAD:release']);
    const advanced = git(['rev-parse', 'HEAD']).trim();
    git(['switch', '-q', 'feature']);

    expect(relatedness(dir, 'release', advanced).status).toBe(0);
  });

  it('ships when the nearest ancestor differs from the base but the base CONTAINS it', () => {
    // `release` is nearer to HEAD than `next`, so a name-equality test would refuse — but `next`
    // carries the branch point, so the base is correct.
    const { dir, git } = seedTwoLines();
    git(['switch', '-q', '-c', 'nextline']);
    writeFileSync(join(dir, 'g.txt'), 'c2\n');
    git(['add', 'g.txt']);
    git(['commit', '-q', '-m', 'c2']);
    git(['push', '-q', 'origin', 'HEAD:next']);
    const next = git(['rev-parse', 'HEAD']).trim();
    git(['switch', '-q', 'feature']);
    git(['fetch', '-q', 'origin']);

    const r = relatedness(dir, 'next', next);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('says nothing when no branch on origin is an ancestor of HEAD', () => {
    // ship_origin_base_candidate falls through to origin's DEFAULT here; a check built on that value
    // would print a commit this work was never built on as "the branch point".
    const { dir, git, c0 } = seedTwoLines();
    git(['checkout', '-q', '--orphan', 'solo']);
    writeFileSync(join(dir, 'solo.txt'), 'x\n');
    git(['add', 'solo.txt']);
    git(['commit', '-q', '-m', 'unrelated root']);

    const r = relatedness(dir, 'main', c0);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('refuses a base that shares NO history with the work', () => {
    // The strongest possible answer of "does not contain the branch point", so it refuses like any
    // other rather than being waved through — a gate tree from an unrelated line judges nothing real.
    const { dir, git } = seedTwoLines();
    git(['checkout', '-q', '--orphan', 'detached-line']);
    writeFileSync(join(dir, 'only-here.txt'), 'orphan\n');
    git(['add', 'only-here.txt']);
    git(['commit', '-q', '-m', 'unrelated root']);
    git(['push', '-q', 'origin', 'HEAD:orphan-base']);
    const orphanBase = git(['rev-parse', 'HEAD']).trim();
    git(['switch', '-q', 'feature']);

    const r = relatedness(dir, 'orphan-base', orphanBase);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not contained in origin/orphan-base');
  });

  it('skips the check entirely in a shallow clone', () => {
    // Truncated history answers "not an ancestor" for genuine ancestors. Refusing there would break
    // every depth-limited CI checkout on a question the repository cannot answer.
    const { dir, c0 } = seedTwoLines();
    expect(relatedness(dir, 'main', c0).status).toBe(1); // precondition: this repo DOES refuse
    writeFileSync(join(dir, '.git', 'shallow'), `${c0}\n`);

    const r = relatedness(dir, 'main', c0);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('reports and continues when git cannot answer the ancestry question at all', () => {
    // Fail-open on a diagnostic, ship_size_preflight's polarity: an exit that is neither 0 nor 1 is
    // not a verdict of "unrelated".
    const { dir } = seedTwoLines();

    const r = relatedness(dir, 'main', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('base relatedness could not be verified');
  });

  it('ships when the base and the nearest ancestor are two NAMES for one commit', () => {
    // Both names sit on one commit and a commit contains itself, so either base is correct. A name
    // comparison would refuse on the resolver's tie-break, i.e. on a coin toss.
    const { dir, git, c1 } = seedTwoLines();
    git(['push', '-q', 'origin', 'HEAD:mirror']);
    git(['fetch', '-q', 'origin']);

    const r = relatedness(dir, 'mirror', c1);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});

describe('ship base relatedness — the override is a devkit GUARD_* flag, not any non-empty value', () => {
  // envFlag (gate-engine/config.mts) reads "0"/"false"/"no" as OFF. A non-emptiness test would let
  // GUARD_SHIP_BASE_OK=0 — "off" everywhere else in devkit — disarm this gate instead.
  for (const off of ['0', 'false', 'no', '', 'FALSE']) {
    it(`still refuses when GUARD_SHIP_BASE_OK=${JSON.stringify(off)}`, () => {
      const { dir, c0 } = seedTwoLines();

      const r = relatedness(dir, 'main', c0, { GUARD_SHIP_BASE_OK: off });

      expect(r.status).toBe(1);
      expect(r.stderr).toContain('is not contained in origin/main');
    });
  }

  for (const on of ['1', 'true', 'yes']) {
    it(`proceeds when GUARD_SHIP_BASE_OK=${JSON.stringify(on)}`, () => {
      const { dir, c0 } = seedTwoLines();

      expect(relatedness(dir, 'main', c0, { GUARD_SHIP_BASE_OK: on }).status).toBe(0);
    });
  }
});

describe('ship base relatedness — message shapes the fixtures do not otherwise produce', () => {
  it('carries SLASHED branch names through the refusal and its copyable remedy', () => {
    // `line/1.0`, not `release/1.0`: git stores refs as paths, so a `release` branch makes the latter
    // uncreatable. It sorts before `release`, winning the distance-0 tie. Ref names are not literals.
    const { dir, git } = seedTwoLines();
    git(['push', '-q', 'origin', 'HEAD:line/1.0']);
    git(['push', '-q', 'origin', 'main:hotfix/2.0']);
    git(['fetch', '-q', 'origin']);
    const hotfix = git(['rev-parse', 'origin/hotfix/2.0']).trim();

    const r = relatedness(dir, 'hotfix/2.0', hotfix);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('(origin/line/1.0) is not contained in origin/hotfix/2.0');
    expect(r.stderr).toContain("pass --base 'line/1.0'");
  });

  it('caps the contained-by list at four and counts the rest, never listing origin/HEAD', () => {
    // A release line can be mirrored across dozens of refs. Uncapped, the names push the one-line
    // remedy off the screen — and the remedy is the only part of this message that ends the incident.
    const { dir, git, bareGit, c0 } = seedTwoLines();
    for (const name of ['m1', 'm2', 'm3', 'm4', 'm5']) bareGit(['branch', name, 'release']);
    git(['fetch', '-q', 'origin']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release']);

    const r = relatedness(dir, 'main', c0);
    const line = /contained by: (.+)/.exec(r.stderr)?.[1] ?? '';

    expect(r.status).toBe(1);
    expect(line).toContain('(+2 more)'); // 6 carry the branch point; 4 are named
    expect(line.replace(' (+2 more)', '').split(', ')).toHaveLength(4);
    expect(r.stderr).not.toContain('origin/HEAD');
  });
});

describe('ship_suggest_base — the ancestor tier may not silence the default tier', () => {
  it('reads the repo it was handed, not the cwd it happens to run in', () => {
    // ship-branch.sh passes $ROOT. A cwd-bound fallback answers about a DIFFERENT repository, and
    // recommends that one's default branch as this one's base.
    const here = seedTwoLines();
    const elsewhere = seedTwoLines();
    execFileSync('git', ['-C', here.bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], {
      env: { ...process.env, ...GIT_ENV },
    });
    execFileSync('git', ['-C', elsewhere.bare, 'branch', 'foreign-default', 'main'], {
      env: { ...process.env, ...GIT_ENV },
    });
    execFileSync(
      'git',
      ['-C', elsewhere.bare, 'symbolic-ref', 'HEAD', 'refs/heads/foreign-default'],
      {
        env: { ...process.env, ...GIT_ENV },
      },
    );
    here.bareGit(['branch', '-D', 'release']); // force the default tier, which is the one that erred

    const out = suggestBaseFrom(here.dir, elsewhere.dir, here.c1);

    expect(out).toContain("'main'");
    expect(out).not.toContain('foreign-default');
  });

  it('reasons about the PINNED head, so a sibling moving HEAD cannot change the hint', () => {
    // Same race as the blocking check: this hint is printed to a shared checkout, and a sibling
    // reset between the base probe and this line would otherwise retarget the caller's PR.
    const { dir, git, c0, c1 } = seedTwoLines();
    git(['switch', '-q', 'main']);

    expect(suggestBaseFrom(dir, dir, c1)).toContain("sits on top of is 'release'");
    expect(suggestBaseFrom(dir, dir, c0)).not.toContain("sits on top of is 'release'");
    // An EMPTY pin is cannot-tell: the ancestor tier is skipped, never re-read from live HEAD.
    expect(suggestBaseFrom(dir)).not.toContain('sits on top of');
  });

  it('falls through to origin’s default when the ancestor is gone from origin', () => {
    // sc-2261's rule, inherited by the new tier: never name a branch origin lacks, and never go
    // silent while another tier can still answer.
    const { dir, bare, bareGit, c1 } = seedTwoLines();
    execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], {
      env: { ...process.env, ...GIT_ENV },
    });
    bareGit(['branch', '-D', 'release']); // the nearest ancestor, now only a local tracking ref

    const out = suggestBaseFrom(dir, dir, c1);

    expect(out).toContain("origin's default branch is 'main' — pass --base 'main'");
    expect(out).not.toContain('release');
  });
});

describe('ship --base refuses an unrelated base before anything exists (sc-2357)', () => {
  it('exits before the gate worktree, the branch and the push', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'c1\n');
    git(['add', 'note.txt'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'work the base has never seen'], { stdio: 'ignore' });
    git(['push', '-q', 'origin', 'HEAD:release'], { stdio: 'ignore' });
    git(['fetch', '-q', 'origin'], { stdio: 'ignore' });
    const headBefore = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(dir, 'note.txt'), 'c1 edited\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/wrongbase', 'ship it', '--base', 'work', '--', 'note.txt'],
      { cwd: dir, input: 'b\n', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain('is not contained in origin/work');
    expect(r.stderr).toContain("pass --base 'release'");
    // Nothing was created, which is the whole point: the cost of a wrong base becomes one message
    // instead of a gate chain plus up to six reviewers.
    expect(r.stderr).not.toMatch(EPHEMERAL_WT_RE);
    expect(localBranchExists(git, 'feat/wrongbase')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/wrongbase')).toBe(false);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });

  it('fires from a DETACHED checkout, which is the shape the incident was reported from', () => {
    // --base is the one arm that accepts a detached HEAD, so every provisioned worktree reaches this
    // check and the resolvers behind it must not depend on HEAD being a branch.
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'c1\n');
    git(['add', 'note.txt'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'work the base has never seen'], { stdio: 'ignore' });
    git(['push', '-q', 'origin', 'HEAD:release'], { stdio: 'ignore' });
    git(['fetch', '-q', 'origin'], { stdio: 'ignore' });
    git(['checkout', '-q', '--detach'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'c1 edited\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/detached', 'ship it', '--base', 'work', '--', 'note.txt'],
      { cwd: dir, input: 'b\n', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain('is not contained in origin/work');
    expect(r.stderr).toContain("pass --base 'release'");
    expect(r.stderr).not.toMatch(EPHEMERAL_WT_RE);
    expect(localBranchExists(git, 'feat/detached')).toBe(false);
  });

  it('leaves --from-branch to its own, stricter ancestry predicate', () => {
    // --from-branch requires the opposite — the base CONTAINED IN HEAD. Moving this check earlier
    // would put both predicates on one path, where they disagree by construction.
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'c1\n');
    git(['add', 'note.txt'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'work the base has never seen'], { stdio: 'ignore' });
    git(['push', '-q', 'origin', 'HEAD:release'], { stdio: 'ignore' });
    git(['fetch', '-q', 'origin'], { stdio: 'ignore' });

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/fb', 'ship it', '--base', 'release', '--from-branch'],
      { cwd: dir, input: 'b\n', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );

    expect(r.stderr).not.toContain('is not contained in origin/');
  });
});
