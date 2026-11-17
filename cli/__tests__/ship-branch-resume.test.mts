/** Resuming a commit preserved by a post-commit gate timeout, when the BASE MOVED under it. Sibling of
 *  ship-branch.test.mts, which keeps the moved-base-free resume cases and has no maxTestLines headroom. */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  createPreservedCommit,
  dirs,
  GIT_ENV,
  installHook,
  COUNTING_HOOK,
  localBranchExists,
  manifestOf,
  publishEnvFor,
  remoteBranchExists,
  scriptPath,
  seedBaseRepo,
  seedShipRepoLocalRemote,
  installPostCommitHang,
  POST_COMMIT_CEILING_BANNER,
} from './_ship-branch-fixture.mts';

/** createPreservedCommit leaves note.txt UNTRACKED in $ROOT, and git refuses a checkout/merge that
 *  would overwrite it. Every caller here is about to take the branch's own copy anyway. */
function clearUntrackedNote(dir) {
  rmSync(join(dir, 'note.txt'), { force: true });
}

/** Mint the receipt ship would have written, skipping a real ceiling. Valid only where the variable
 *  under test is a PRECONDITION, not the timeout itself (same shortcut ship-branch.test.mts uses). */
function preserveWithReceipt(dir, env, git, branch) {
  const preserved = createPreservedCommit({
    dir,
    env,
    git,
    branch,
    tempPrefix: `ship-resume-${branch.replace(/\W/g, '-')}-`,
  });
  git(['update-ref', `refs/devkit/ship-receipts/${branch}`, preserved]);
  return preserved;
}

/** Move the HEAD a default-base retry will resolve. --no-verify is REQUIRED: core.hooksPath points at
 *  the seeded hook, which would append to an unset TEST_HOOK_COUNT and poison the hook-run ledger. */
function advanceSharedHead(dir, git, file = 'other.txt') {
  writeFileSync(join(dir, file), 'parallel agent\n');
  git(['add', file], { stdio: 'ignore' });
  git(['commit', '-q', '--no-verify', '-m', `parallel agent lands ${file}`], { stdio: 'ignore' });
  return git(['rev-parse', 'HEAD']).trim();
}

/** A parallel agent merges into `studio`. Pushed from a throwaway clone so the bare advances without
 *  touching this checkout (a clone carries no core.hooksPath, so the hooks are inert). */
function pushToStudio(bare, file, body) {
  const clone = mkdtempSync(join(tmpdir(), 'shipbaseadv-'));
  dirs.push(clone);
  const cgit = (a) =>
    execFileSync('git', a, { cwd: clone, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
  cgit(['clone', '-q', '--branch', 'studio', bare, '.']);
  cgit(['config', 'user.email', 'a@b.c']);
  cgit(['config', 'user.name', 'a']);
  writeFileSync(join(clone, file), body);
  cgit(['add', file]);
  cgit(['commit', '-q', '-m', `studio advances ${file}`]);
  cgit(['push', '-q', 'origin', 'studio']);
}

/** Lands a gated commit for note.txt on studio and ends the attempt at the post-commit ceiling. */
function preserveOnStudio(dir, env, git, branch) {
  installHook(dir, COUNTING_HOOK); // only the SHIP's commit may count, not the seed's
  const { hookCount, publishEnv } = publishEnvFor(dir, env);
  const argv = [scriptPath, branch, 'ship it', '--base', 'studio', '--', 'note.txt'];
  installPostCommitHang(dir);
  const first = spawnSync('/bin/bash', argv, {
    cwd: dir,
    input: 'pr body\n',
    encoding: 'utf8',
    env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
  });
  expect(first.status, first.stderr).toBe(124);
  expect(first.stderr).toMatch(POST_COMMIT_CEILING_BANNER);
  expect(git(['rev-parse', `refs/devkit/ship-receipts/${branch}`]).trim()).toBe(
    git(['rev-parse', branch]).trim(),
  );
  // The retry is the exact command the operator is told to run, replayed from the recorded intent.
  const run = () =>
    spawnSync('/bin/bash', [scriptPath, '--resume', branch], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: publishEnv,
    });
  return { hookCount, run };
}

/** The refusal every conflicting resume must print: before any push, gates untouched. */
function expectConflictRefusal(retry, bare, hookCount, branch) {
  expect(retry.status, retry.stderr).toBe(1);
  expect(retry.stderr).toContain('no longer merges cleanly into studio');
  expect(retry.stderr).toContain('conflicting paths (1): note.txt');
  expect(retry.stderr).toContain(`git branch -D ${branch} && devkit ship --resume ${branch}`);
  expect(retry.stderr).not.toContain('choose a new branch name');
  expect(retry.stderr).not.toContain('three-way merged'); // no staging runs on this path
  expect(retry.stderr).not.toContain('gate receipt verified');
  expect(remoteBranchExists(bare, branch)).toBe(false);
  expect(readFileSync(hookCount, 'utf8').trim().split('\n')).toHaveLength(1);
}

describe('ship-branch.sh — resume when the base moved', () => {
  // The primary regression. Non-dry on purpose: dry-run keeps the strict new-branch precondition and
  // would refuse before the resume checks are reached.
  it('resumes and publishes when origin/<base> advances between the timeout and the retry', () => {
    const { dir, env, git, bare, studioTip } = seedBaseRepo();
    installHook(dir, COUNTING_HOOK); // only the SHIP's commit may count, not the seed's
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    const argv = [scriptPath, 'feat/base-advance', 'ship it', '--base', 'studio', '--', 'note.txt'];

    installPostCommitHang(dir);

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });

    expect(first.status, first.stderr).toBe(124);
    // Pair every 124 with OUR banner: testSpawnSync's linger reap also returns 124, so an
    // unpaired status assertion cannot say which supervisor fired.
    expect(first.stderr).toMatch(POST_COMMIT_CEILING_BANNER);
    const preserved = git(['rev-parse', 'feat/base-advance']).trim();
    expect(git(['rev-parse', 'refs/devkit/ship-receipts/feat/base-advance']).trim()).toBe(
      preserved,
    );
    expect(remoteBranchExists(bare, 'feat/base-advance')).toBe(false);

    // A parallel agent merges into the PR base.
    pushToStudio(bare, 'other.txt', 'advanced\n');
    expect(
      execFileSync('git', ['-C', bare, 'rev-parse', 'studio'], {
        env: { ...process.env, ...GIT_ENV },
        encoding: 'utf8',
      }).trim(),
    ).not.toBe(studioTip); // the precondition this test exists for

    const retry = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('gate receipt verified');
    // The advanced base carries other.txt, so a scope check still anchored on $BASE would see it as an
    // out-of-scope path. Assert the absence explicitly — this is what pins the parent-anchored diff.
    expect(retry.stderr).not.toContain('outside the requested scope');
    expect(retry.stdout).toContain('https://github.com/acme/app/pull/42');
    expect(remoteBranchExists(bare, 'feat/base-advance')).toBe(true);
    expect(
      execFileSync('git', ['-C', bare, 'rev-parse', 'feat/base-advance'], {
        env: { ...process.env, ...GIT_ENV },
        encoding: 'utf8',
      }).trim(),
    ).toBe(preserved); // the EXACT gated OID is published — never rebased onto the new tip
    expect(git(['rev-parse', `${preserved}^`]).trim()).toBe(studioTip);
    expect(readFileSync(hookCount, 'utf8').trim().split('\n')).toHaveLength(1); // gates never re-ran
    expect(localBranchExists(git, 'feat/base-advance')).toBe(false);

    // The only direct coverage of the manifest anchor: classify() reads add-vs-modify and a deletion's
    // pre-deletion blob from this sha, so recording the ADVANCED base misclassifies both, silently.
    const entry = manifestOf(dir).branches['feat/base-advance'];
    expect(entry.prNumber).toBe(42);
    expect(entry.baseSha).toBe(studioTip);
  }, 240_000);

  // The resume used to publish this commit unchanged, open a PR GitHub marked CONFLICTING, and exit 0.
  it('refuses a preserved commit the moved base now conflicts with, and its remedy re-stages it', () => {
    const { dir, env, git, bare } = seedBaseRepo();
    const { hookCount, run } = preserveOnStudio(dir, env, git, 'feat/base-conflict');
    pushToStudio(bare, 'note.txt', 'parallel agent\n');

    expectConflictRefusal(run(), bare, hookCount, 'feat/base-conflict');

    // Following the printed remedy reaches staging's own three-way verdict, before any gate runs.
    git(['branch', '-D', 'feat/base-conflict'], { stdio: 'ignore' });
    const restaged = run();
    expect(restaged.status, restaged.stderr).toBe(1);
    expect(restaged.stderr).toContain('blocked before creating a branch or worktree');
    expect(restaged.stderr).toContain('note.txt');
    expect(restaged.stderr).toContain('three-way merged'); // a fresh ship still announces its merge
    expect(readFileSync(hookCount, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 240_000);

  // GitHub ignores merge drivers, so a locally union-merged path still opens CONFLICTING there.
  it('refuses a conflict that a merge=union attribute would hide locally', () => {
    const { dir, env, git, bare } = seedBaseRepo();
    writeFileSync(join(dir, '.gitattributes'), 'note.txt merge=union\n');
    git(['add', '.gitattributes'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'union notes'], { stdio: 'ignore' });
    pushToStudio(bare, '.gitattributes', 'note.txt merge=union\n');
    const { hookCount, run } = preserveOnStudio(dir, env, git, 'feat/union-conflict');
    pushToStudio(bare, 'note.txt', 'parallel agent\n');

    expectConflictRefusal(run(), bare, hookCount, 'feat/union-conflict');
  }, 240_000);

  // Unverified is not clean: publishing it would reopen the CONFLICTING-PR exit 0 on an older git.
  it('refuses, with the re-stage remedy, when git cannot run the merge check', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserveWithReceipt(dir, env, git, 'feat/old-git');
    advanceSharedHead(dir, git); // disjoint: a git that could check would publish this

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/old-git', 'ship it', '--', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...publishEnv, PATH: oldGitPath(publishEnv.PATH) },
    });

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('could not verify it still merges cleanly into');
    expect(r.stderr).toContain('git branch -D feat/old-git && devkit ship --resume feat/old-git');
    expect(remoteBranchExists(bare, 'feat/old-git')).toBe(false);
  });

  // BASE is pinned from HEAD (:144), so a sibling agent's commit between attempts moves it with no
  // --base involved. The commonest form of the defect, and one an earlier draft of the fix missed.
  it('resumes after the shared checkout’s HEAD advances between the timeout and the retry', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote({ hookBody: COUNTING_HOOK });
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const baseBefore = git(['rev-parse', 'HEAD']).trim();
    const argv = [scriptPath, 'feat/head-advance', 'ship it', '--', 'note.txt'];

    installPostCommitHang(dir);

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });

    expect(first.status, first.stderr).toBe(124);
    expect(first.stderr).toMatch(POST_COMMIT_CEILING_BANNER);
    const preserved = git(['rev-parse', 'feat/head-advance']).trim();
    expect(git(['rev-parse', 'refs/devkit/ship-receipts/feat/head-advance']).trim()).toBe(
      preserved,
    );

    const advancedHead = advanceSharedHead(dir, git);
    expect(advancedHead).not.toBe(baseBefore);

    const retry = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('gate receipt verified');
    expect(remoteBranchExists(bare, 'feat/head-advance')).toBe(true);
    expect(git(['rev-parse', `${preserved}^`]).trim()).toBe(baseBefore); // published exactly as gated
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(advancedHead); // the shared HEAD never moved
    expect(readFileSync(hookCount, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(manifestOf(dir).branches['feat/head-advance'].baseSha).toBe(baseBefore);
  }, 240_000);

  // The fail-closed half of the predicate. Nothing else in the suite reaches the parent check — the
  // "unrelated existing local branch" test's branch sits at HEAD, so it exits on the message check.
  it('refuses when the base moved BACKWARDS, naming the divergence rather than the branch shape', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    // Two commits of headroom, so the base can be rewound below the preserved commit's parent.
    advanceSharedHead(dir, git, 'first.txt');
    const rewindTarget = git(['rev-parse', 'HEAD~1']).trim();
    const preserved = preserveWithReceipt(dir, env, git, 'feat/base-rewound');
    git(['reset', '-q', '--hard', rewindTarget]); // force-push-backwards, as seen from this checkout

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/base-rewound', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('cannot safely resume it: its parent');
    expect(r.stderr).toContain('diverges from it');
    expect(r.stderr).not.toContain('is not a single commit'); // the OTHER half of the split reason
    expect(r.stdout).not.toContain('https://github.com/acme/app/pull/42');
    expect(remoteBranchExists(bare, 'feat/base-rewound')).toBe(false);
    expect(localBranchExists(git, 'feat/base-rewound')).toBe(true); // kept for the operator
    expect(git(['rev-parse', 'feat/base-rewound']).trim()).toBe(preserved); // untouched
  });

  // A fail-open `merge-base --is-ancestor <parent> $BASE` would introduce: the parent stays reachable,
  // so is-ancestor accepts and ship re-pushes merged work. merge-base($BASE, C) is C here, so it refuses.
  it('refuses when the base has already ABSORBED the preserved commit', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    const preserved = preserveWithReceipt(dir, env, git, 'feat/already-merged');
    // The operator gave up on converging and merged the preserved commit by hand.
    clearUntrackedNote(dir);
    git(['merge', '-q', '--no-ff', '-m', 'merge the preserved work', preserved], {
      stdio: 'ignore',
    });
    // `--is-ancestor` exits 0 here — i.e. the predicate this test guards against would ACCEPT.
    expect(git(['merge-base', '--is-ancestor', `${preserved}^`, 'HEAD'])).toBe('');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/already-merged', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('carries no commit of its own over');
    expect(remoteBranchExists(bare, 'feat/already-merged')).toBe(false);
  });

  it('reclaims an unheld branch whose ROOT-commit tip the base contains, naming the old tip', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const root = git(['rev-list', '--max-parents=0', 'HEAD']).trim();
    advanceSharedHead(dir, git, 'first.txt'); // so the base is genuinely AHEAD of the root
    git(['branch', 'feat/root-tip', root], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const { publishEnv } = publishEnvFor(dir, env);

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/root-tip', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(
      `ship: feat/root-tip held no commit of its own over origin/work (tip ${root.slice(0, 7)})`,
    );
    expect(r.stderr).toContain(`restore: git branch 'feat/root-tip' ${root.slice(0, 7)}`);
    expect(r.stderr).not.toContain('cannot safely resume');
    expect(remoteBranchExists(bare, 'feat/root-tip')).toBe(true);
  });

  // The other is-ancestor fail-open: BASE == RECOVERY_COMMIT and BASE_REF == BR. Accepting it pushes
  // first and fails at `gh pr create --base <br> --head <br>`, stranding the branch on origin with no PR.
  it('refuses when the checkout is sitting on the preserved branch (it cannot be the PR base)', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserveWithReceipt(dir, env, git, 'feat/self-base');
    clearUntrackedNote(dir);
    git(['checkout', '-q', 'feat/self-base'], { stdio: 'ignore' });

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/self-base', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("base 'feat/self-base' is not on origin");
    expect(r.stderr).toContain('is checked out in THIS worktree');
    expect(remoteBranchExists(bare, 'feat/self-base')).toBe(false); // nothing left stranded on origin
  });

  // Why the merge-base call carries `|| true`: a command substitution does NOT suppress -e, so
  // unrelated histories would abort with a raw git error instead of printing the refusal.
  it('refuses, rather than aborting, when the base shares no history with the preserved commit', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserveWithReceipt(dir, env, git, 'feat/unrelated-base');
    git(['checkout', '-q', '--orphan', 'detached-root'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'root.txt'), 'orphan\n');
    git(['add', 'root.txt'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'unrelated root'], { stdio: 'ignore' });
    // On origin so the PR-base preflight (sc-2261) passes: this test's subject is the RESUME refusal
    // on unrelated history, and a base that cannot be one would refuse first, several screens earlier.
    git(['push', '-q', 'origin', 'detached-root:detached-root'], { stdio: 'ignore' });

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/unrelated-base', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(r.status, r.stderr).toBe(1); // a refusal, never a raw abort
    expect(r.stderr).toContain('branch already exists: feat/unrelated-base');
    expect(r.stderr).toContain('cannot safely resume it');
    expect(r.stderr).toContain('choose a new branch name'); // the closing advice still printed
  });

  // The split reason's other half: a merge tip needs a new branch name, a wrong base needs the original
  // --base. Conflating them sent operators to inspect a branch shape that was fine.
  it('names the branch SHAPE, not the base, when the tip is a merge commit', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    const preserved = preserveWithReceipt(dir, env, git, 'feat/merge-tip');
    advanceSharedHead(dir, git, 'sibling.txt');
    // Turn the branch tip into a merge, keeping the receipt pointed at the new tip so the shape check
    // is provably what refuses — not the receipt check further down.
    clearUntrackedNote(dir);
    git(['checkout', '-q', 'feat/merge-tip'], { stdio: 'ignore' });
    git(['merge', '-q', '--no-ff', '-m', 'merge sibling', 'work'], { stdio: 'ignore' });
    const mergeTip = git(['rev-parse', 'feat/merge-tip']).trim();
    expect(mergeTip).not.toBe(preserved);
    git(['update-ref', 'refs/devkit/ship-receipts/feat/merge-tip', mergeTip]);
    git(['checkout', '-q', 'work'], { stdio: 'ignore' });

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/merge-tip', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('its tip is not a single commit');
    expect(r.stderr).not.toContain('diverges from it');
  });
});

describe('ship-branch.sh — resume refusals that name their own cause', () => {
  // The gate chain's own formatter re-stages inside the ship worktree, so the COMMIT is formatted and
  // $ROOT is not — the old reason blamed the operator for a rewrite the gates performed.
  it('names the drifted path when a gate formatter rewrote and re-staged a shipped file', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote({
      hookBody: `echo run >> "$TEST_HOOK_COUNT"\nprintf 'formatted\\n' > note.txt\ngit add -f -- note.txt`,
    });
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const argv = [scriptPath, 'feat/formatter-drift', 'ship it', '--', 'note.txt'];

    installPostCommitHang(dir);

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });

    expect(first.status, first.stderr).toBe(124);
    expect(first.stderr).toMatch(POST_COMMIT_CEILING_BANNER);
    const preserved = git(['rev-parse', 'feat/formatter-drift']).trim();
    expect(git(['show', `${preserved}:note.txt`])).toBe('formatted\n'); // the hook's bytes were committed
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('hi\n'); // $ROOT was never formatted

    const refused = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain(
      'cannot safely resume it: the current scoped files no longer match its commit',
    );
    expect(refused.stderr).toContain('differing paths (1): note.txt');
    expect(refused.stderr).toContain('pre-commit formatter');
    expect(refused.stderr).toContain('git diff feat/formatter-drift -- <path>');
    expect(refused.stderr).toContain('choose a new branch name'); // hints did not displace the advice
    expect(remoteBranchExists(bare, 'feat/formatter-drift')).toBe(false);

    // The diagnosis is actionable, not decorative: adopt the commit's bytes and the same command converges.
    writeFileSync(join(dir, 'note.txt'), 'formatted\n');
    const retry = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('gate receipt verified');
    expect(readFileSync(hookCount, 'utf8').trim().split('\n')).toHaveLength(1); // gates never re-ran
  }, 360_000);

  // Six paths exercises the cap. Exit 1 rather than 141 is the assertion that matters: the list must be
  // built without a truncating pipe, whose SIGPIPE would abort the ship only once a list got long.
  it('caps the drifted-path list at five and still exits 1, never a SIGPIPE abort', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.txt`);
    const rewrite = files.map((f) => `printf 'formatted\\n' > ${f}\ngit add -f -- ${f}`).join('\n');
    const { dir, env, git } = seedShipRepoLocalRemote({
      hookBody: `echo run >> "$TEST_HOOK_COUNT"\n${rewrite}`,
    });
    const { publishEnv } = publishEnvFor(dir, env);
    for (const f of files) writeFileSync(join(dir, f), 'hi\n');
    const argv = [scriptPath, 'feat/wide-drift', 'ship it', '--', ...files];

    installPostCommitHang(dir);

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });
    expect(first.status, first.stderr).toBe(124);
    expect(first.stderr).toMatch(POST_COMMIT_CEILING_BANNER);

    const refused = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(refused.status, refused.stderr).toBe(1); // 141 here would mean the diagnostic killed the ship
    expect(refused.stderr).toMatch(/differing paths \(6\): /);
    expect(refused.stderr).toContain('(+1 more)');
    expect(refused.stderr).toContain('choose a new branch name');
    expect(localBranchExists(git, 'feat/wide-drift')).toBe(true);
  }, 240_000);

  // A here-doc does not survive a re-run through a wrapper: a TTY and a closed stdin both yield an
  // empty BODY silently, so the message diverges and the old reason pointed at an unchanged title.
  it('blames the missing PR body, not the message, when a retry’s stdin is empty', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserveWithReceipt(dir, env, git, 'feat/no-body-retry');

    const refused = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/no-body-retry', 'ship it', 'note.txt'],
      {
        cwd: dir,
        input: '', // the wrapper case: no here-doc this time
        encoding: 'utf8',
        env: publishEnv,
      },
    );

    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain(
      'cannot safely resume it: this run supplied no PR body, but its commit has one',
    );
    expect(refused.stderr).toContain('re-supply it with --body');
    expect(refused.stderr).not.toContain('differs from this ship title/body'); // no longer the generic reason
    expect(remoteBranchExists(bare, 'feat/no-body-retry')).toBe(false);

    // The named fix is the real fix: --body re-supplies what the pipe used to.
    const retry = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/no-body-retry', 'ship it', '--body', 'pr body', '--', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env: publishEnv },
    );
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('gate receipt verified');
    expect(remoteBranchExists(bare, 'feat/no-body-retry')).toBe(true);
  });

  it.each([
    ['--body', ''],
    ['--body-file', 'empty.md'],
  ])(
    'keeps the generic message reason for an explicit empty %s, never blaming stdin',
    (flag, value) => {
      const { dir, env, git } = seedShipRepoLocalRemote();
      const { publishEnv } = publishEnvFor(dir, env);
      preserveWithReceipt(dir, env, git, 'feat/explicit-empty');
      writeFileSync(join(dir, 'empty.md'), '');

      const r = spawnSync(
        '/bin/bash',
        [scriptPath, 'feat/explicit-empty', 'ship it', flag, value, '--', 'note.txt'],
        { cwd: dir, input: '', encoding: 'utf8', env: publishEnv },
      );

      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain('its commit message differs from this ship title/body');
      expect(r.stderr).not.toContain('re-supply it with --body');
    },
  );

  // An empty body plus a bodied commit ALSO describes a changed title, where --body would be the same
  // misdiagnosis inverted. The title must match before the body can be called the sole cause.
  it('keeps the generic message reason when the TITLE also changed', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserveWithReceipt(dir, env, git, 'feat/title-changed');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/title-changed', 'a different title', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env: publishEnv },
    );

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(
      'cannot safely resume it: its commit message differs from this ship title/body',
    );
    expect(r.stderr).not.toContain('supplied no PR body');
    expect(r.stderr).not.toContain('re-supply it with --body');
  });

  // RECOVERY_HINTS=() expanded under `set -u` on bash 3.2 (macOS /bin/bash) is the unbound-variable
  // trap; a hintless refusal must still print exactly three lines — no blank line, no crash.
  it('keeps the bare three-line refusal shape when no hint applies', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    const { publishEnv } = publishEnvFor(dir, env);
    preserveWithReceipt(dir, env, git, 'feat/no-hint');
    // Drop the receipt: that refusal carries no hint, and it is the last check before the tree rebuild.
    git(['update-ref', '-d', 'refs/devkit/ship-receipts/feat/no-hint']);

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/no-hint', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(r.status, r.stderr).toBe(1);
    const refusalLines = r.stderr
      .split('\n')
      .filter((l) => l.startsWith('branch already exists') || l.startsWith('  '));
    expect(refusalLines).toEqual([
      'branch already exists: feat/no-hint',
      '  cannot safely resume it: it has no matching prior-ship gate receipt',
      '  choose a new branch name, or inspect and remove the local branch yourself',
    ]);
  });
});

const lib = (name) => fileURLToPath(new URL(`../lib/ship/${name}`, import.meta.url));

/** main and side both edit every one of `files`; disjoint only adds o.txt. */
function mergeRepo({ files = ['n.txt'], objectFormat = 'sha1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-merge-check-'));
  dirs.push(dir);
  const git = (a) =>
    execFileSync('git', a, { cwd: dir, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
  const commit = (paths, body) => {
    for (const f of paths) writeFileSync(join(dir, f), body);
    git(['add', ...paths]);
    git(['commit', '-q', '-m', body.trim()]);
  };
  git(['init', '-q', '-b', 'main', `--object-format=${objectFormat}`]);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 'a']);
  commit(files, 'a\n');
  git(['branch', 'side']);
  git(['branch', 'disjoint']);
  commit(files, 'main\n');
  git(['checkout', '-q', 'side']);
  commit(files, 'side\n');
  git(['checkout', '-q', 'disjoint']);
  commit(['o.txt'], 'o\n');
  return dir;
}

/** A PATH whose git rejects merge-tree's options the way git before 2.38 does (exit 129). */
function oldGitPath(path = process.env.PATH) {
  const bin = mkdtempSync(join(tmpdir(), 'ship-old-git-'));
  dirs.push(bin);
  const real = execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = merge-tree ] && exit 129; done\nexec '${real}' "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  return `${bin}:${path}`;
}

function runLib(dir, script, vars = {}) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail; . "${lib('origin-base.sh')}"; . "${lib('ship-branch/staging-and-record.sh')}"; ${script}`,
    ],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...vars } },
  );
}

describe('ship-branch.sh — the preserved-commit merge check and its remedy', () => {
  const CHECK = `rc=0; ship_preserved_merge_check "$PWD" "$B" "$C" || rc=$?; echo "rc=$rc $RECOVERY_CONFLICT_HINT"`;
  const files = (n) => Array.from({ length: n }, (_, i) => `f${i + 1}.txt`);

  it.each([
    ['a clean merge', {}, 'disjoint', 'rc=0'],
    ['a same-line conflict, naming the path', {}, 'side', 'rc=1 conflicting paths (1): n.txt'],
    // A 40-hex-only OID check would read every SHA-256 repository as cannot-tell and publish.
    [
      'a conflict in a SHA-256 repository',
      { objectFormat: 'sha256' },
      'side',
      'rc=1 conflicting paths (1): n.txt',
    ],
    [
      'five conflicting paths in full',
      { files: files(5) },
      'side',
      'rc=1 conflicting paths (5): f1.txt f2.txt f3.txt f4.txt f5.txt',
    ],
    [
      'only the first five of six paths',
      { files: files(6) },
      'side',
      'rc=1 conflicting paths (6): f1.txt f2.txt f3.txt f4.txt f5.txt (+1 more)',
    ],
  ])('reports %s', (_label, repo, commit, expected) => {
    const r = runLib(mergeRepo(repo), CHECK, { B: 'main', C: commit });
    expect(r.stdout.trim(), r.stderr).toBe(expected);
  });

  // A user-level attributes file is as invisible to GitHub as a committed one.
  it('ignores merge drivers declared in the global attributes file', () => {
    const dir = mergeRepo();
    writeFileSync(join(dir, 'union.attr'), 'n.txt merge=union\n');
    writeFileSync(
      join(dir, 'global.cfg'),
      `[core]\n\tattributesFile = ${join(dir, 'union.attr')}\n`,
    );
    const r = runLib(dir, CHECK, {
      B: 'main',
      C: 'side',
      GIT_CONFIG_GLOBAL: join(dir, 'global.cfg'),
    });
    expect(r.stdout.trim(), r.stderr).toBe('rc=1 conflicting paths (1): n.txt');
  });

  // merge-tree exits 1 for an unresolvable rev too; reading that as a conflict would fail closed.
  it.each([
    ['an unresolvable rev', { B: 'deadbeef', C: 'side' }],
    ['a git older than 2.38', { B: 'main', C: 'side', PATH: oldGitPath() }],
  ])('reports cannot-tell, not a conflict, for %s', (_label, vars) => {
    const r = runLib(mergeRepo(), CHECK, vars);
    expect(r.stdout.trim(), r.stderr).toBe('rc=2');
  });

  const ARMS = {
    BR: 'feat/x',
    BASE_REF: 'main',
    TITLE: "it's done",
    FROM_BRANCH: '0',
    REMOTE_HOLDS_PRESERVED: '',
    PR_SEEN_STATE: '',
    PR_SEEN_NUM: '',
  };
  const REMEDY =
    'RECOVERY_PARENT=$(git rev-parse side~1) RECOVERY_COMMIT=$(git rev-parse side) ship_preserved_conflict_remedy';

  it.each([
    [
      'an explicit-path ship',
      {},
      ['re-stage it on main: git branch -D feat/x && devkit ship --resume feat/x'],
    ],
    [
      'a branch-source ship, which must rebase first',
      { FROM_BRANCH: '1' },
      [
        'first rebase this checkout: git fetch origin main && git rebase origin/main',
        're-stage it on main: git branch -D feat/x && devkit ship --resume feat/x',
      ],
    ],
    [
      'a commit origin already holds with no PR',
      { REMOTE_HOLDS_PRESERVED: '1', PR_SEEN_STATE: 'NONE' },
      ['git push origin --delete feat/x && git branch -D feat/x && devkit ship --resume feat/x'],
    ],
    [
      'a commit an open PR already shows, as a rewrite with the PR paths',
      { REMOTE_HOLDS_PRESERVED: '1', PR_SEEN_STATE: 'OPEN', PR_SEEN_NUM: '7' },
      [
        'PR #7 already shows this commit',
        `devkit ship --pr feat/x 'it'\\''s done' --base main -- n.txt`,
      ],
    ],
  ])('prints the remedy for %s', (_label, vars, expected) => {
    const r = runLib(mergeRepo(), REMEDY, { ...ARMS, ...vars });
    expect(r.status, r.stderr).toBe(0);
    for (const line of expected) expect(r.stderr).toContain(line);
    if (!vars.FROM_BRANCH) expect(r.stderr).not.toContain('rebase this checkout');
  });
});
