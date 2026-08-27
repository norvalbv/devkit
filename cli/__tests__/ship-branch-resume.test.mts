/** Resuming a commit preserved by a post-commit gate timeout, when the BASE MOVED under it. Sibling of
 *  ship-branch.test.mts, which keeps the moved-base-free resume cases and has no maxTestLines headroom. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  createPreservedCommit,
  dirs,
  GIT_ENV,
  installHook,
  LEAKING_HOOK,
  localBranchExists,
  manifestOf,
  publishEnvFor,
  remoteBranchExists,
  scriptPath,
  seedBaseRepo,
  seedShipRepoLocalRemote,
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

describe('ship-branch.sh — resume when the base moved', () => {
  // The primary regression. Non-dry on purpose: dry-run keeps the strict new-branch precondition and
  // would refuse before the resume checks are reached.
  it('resumes and publishes when origin/<base> advances between the timeout and the retry', () => {
    const { dir, env, git, bare, studioTip } = seedBaseRepo();
    installHook(dir, LEAKING_HOOK); // only the SHIP's commit may leak, not the seed's
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    const argv = [scriptPath, 'feat/base-advance', 'ship it', '--base', 'studio', '--', 'note.txt'];

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });

    expect(first.status, first.stderr).toBe(124);
    // Pair every 124 with OUR banner: testSpawnSync also returns 124 at its own deadline, so an
    // unpaired status assertion cannot say which supervisor fired.
    expect(first.stderr).toMatch(/gate chain hit the 15s ceiling \(exit 124\)/);
    const preserved = git(['rev-parse', 'feat/base-advance']).trim();
    expect(git(['rev-parse', 'refs/devkit/ship-receipts/feat/base-advance']).trim()).toBe(
      preserved,
    );
    expect(remoteBranchExists(bare, 'feat/base-advance')).toBe(false);

    // A parallel agent merges into the PR base. Push from a throwaway clone so the bare advances
    // without touching this checkout (a clone carries no core.hooksPath, so the leaking hook is inert).
    const clone = mkdtempSync(join(tmpdir(), 'shipbaseadv-'));
    dirs.push(clone);
    const cgit = (a) =>
      execFileSync('git', a, { cwd: clone, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
    cgit(['clone', '-q', '--branch', 'studio', bare, '.']);
    cgit(['config', 'user.email', 'a@b.c']);
    cgit(['config', 'user.name', 'a']);
    writeFileSync(join(clone, 'other.txt'), 'advanced\n');
    cgit(['add', 'other.txt']);
    cgit(['commit', '-q', '-m', 'studio advances']);
    cgit(['push', '-q', 'origin', 'studio']);
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
  });

  // BASE is pinned from HEAD (:144), so a sibling agent's commit between attempts moves it with no
  // --base involved. The commonest form of the defect, and one an earlier draft of the fix missed.
  it('resumes after the shared checkout’s HEAD advances between the timeout and the retry', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote({ hookBody: LEAKING_HOOK });
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const baseBefore = git(['rev-parse', 'HEAD']).trim();
    const argv = [scriptPath, 'feat/head-advance', 'ship it', '--', 'note.txt'];

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });

    expect(first.status, first.stderr).toBe(124);
    expect(first.stderr).toMatch(/gate chain hit the 15s ceiling \(exit 124\)/);
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
  });

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
    expect(r.stderr).toContain('already merged');
    expect(remoteBranchExists(bare, 'feat/already-merged')).toBe(false);
  });

  // The other is-ancestor fail-open: BASE == RECOVERY_COMMIT and BASE_REF == BR. Accepting it pushes
  // first and fails at `gh pr create --base <br> --head <br>`, stranding the branch on origin with no PR.
  it('refuses when the checkout is sitting on the preserved branch (base would equal head)', () => {
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
    expect(r.stderr).toContain('cannot safely resume it');
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
      hookBody: `echo run >> "$TEST_HOOK_COUNT"\nprintf 'formatted\\n' > note.txt\ngit add -f -- note.txt\nsleep 30 &`,
    });
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const argv = [scriptPath, 'feat/formatter-drift', 'ship it', '--', 'note.txt'];

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });

    expect(first.status, first.stderr).toBe(124);
    expect(first.stderr).toMatch(/gate chain hit the 15s ceiling \(exit 124\)/);
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
  });

  // Six paths exercises the cap. Exit 1 rather than 141 is the assertion that matters: the list must be
  // built without a truncating pipe, whose SIGPIPE would abort the ship only once a list got long.
  it('caps the drifted-path list at five and still exits 1, never a SIGPIPE abort', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.txt`);
    const rewrite = files.map((f) => `printf 'formatted\\n' > ${f}\ngit add -f -- ${f}`).join('\n');
    const { dir, env, git } = seedShipRepoLocalRemote({
      hookBody: `echo run >> "$TEST_HOOK_COUNT"\n${rewrite}\nsleep 30 &`,
    });
    const { publishEnv } = publishEnvFor(dir, env);
    for (const f of files) writeFileSync(join(dir, f), 'hi\n');
    const argv = [scriptPath, 'feat/wide-drift', 'ship it', '--', ...files];

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });
    expect(first.status, first.stderr).toBe(124);
    expect(first.stderr).toMatch(/gate chain hit the 15s ceiling \(exit 124\)/);

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
  });

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
