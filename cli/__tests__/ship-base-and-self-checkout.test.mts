/** sc-2261 — ship's PR-base preflight and its self-checkout remedy. */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dirs,
  dropWorktree,
  EPHEMERAL_WT_RE,
  ghStub,
  GIT_ENV,
  localBranchExists,
  manifestOf,
  publishEnvFor,
  remoteBranchExists,
  reshipScript,
  scriptPath,
  seedReshipRepo,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const REMOVE_FORCE_RE = /git worktree remove --force/;

/** A `git` shim that passes everything through EXCEPT one ls-remote. With `armedBy`, it stays inert
 *  until that file exists, so a test can target a probe that runs after some other step. */
function gitStub(failPattern, exitCode, armedBy) {
  const stubBin = mkdtempSync(join(tmpdir(), 'ship-gitbin-'));
  dirs.push(stubBin);
  const real = execFileSync('command', ['-v', 'git'], { shell: true, encoding: 'utf8' }).trim();
  const guard = armedBy ? `[ -f '${armedBy}' ] || exec ${real} "$@"\n` : '';
  writeFileSync(
    join(stubBin, 'git'),
    `#!/bin/sh\n${guard}for a in "$@"; do\n  [ "$a" = '${failPattern}' ] || continue\n  case " $* " in *' ls-remote '*) exit ${exitCode} ;; esac\ndone\nexec ${real} "$@"\n`,
  );
  chmodSync(join(stubBin, 'git'), 0o755);
  return stubBin;
}

describe('ship-branch.sh — the PR base must be a branch on origin (sc-2261)', () => {
  it('refuses a local-only default base BEFORE the worktree, the commit or the push', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    // The reported shape: a provisioned worktree sitting on a branch that exists only locally.
    git(['switch', '-q', '-c', 'faint-jaguar-e8d9ad'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const headBefore = git(['rev-parse', 'HEAD']).trim();

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/orphan', 't', '--body', 'b', '--', 'note.txt'],
      {
        cwd: dir,
        encoding: 'utf8',
        env,
      },
    );

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/base 'faint-jaguar-e8d9ad' is not on origin; pass --base <branch>/);
    // The whole point: nothing was created, and above all nothing was PUSHED. The original bug left a
    // real branch on origin with no PR, which is the state no path may reach.
    expect(remoteBranchExists(bare, 'feat/orphan')).toBe(false);
    expect(localBranchExists(git, 'feat/orphan')).toBe(false);
    expect(r.stderr).not.toMatch(EPHEMERAL_WT_RE);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });

  it('prints the full refusal (not git’s exit 128) when origin’s default branch cannot be resolved', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    git(['switch', '-q', '-c', 'local-only'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/x', 't', '--body', 'b', '--', 'note.txt'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    });

    expect(r.status).not.toBe(128);
    expect(r.stderr).toMatch(/base 'local-only' is not on origin/);
    expect(r.stderr).toMatch(/choose the base yourself and pass --base <branch>/);
  });

  it('names the suggested base when origin’s default branch IS resolvable', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/work'], {
      env: { ...process.env, ...GIT_ENV },
    });
    git(['switch', '-q', '-c', 'local-only'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/x', 't', '--body', 'b', '--', 'note.txt'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    });

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/origin's default branch is 'work' — pass --base 'work'/);
  });

  it('fails CLOSED when the base probe errors rather than answering "absent"', () => {
    // ls-remote exits 2 for "no matching ref" but non-zero for auth/network failures too. Treating
    // those as absent would refuse a perfectly good base; treating them as present would push against
    // one that may not exist. Same polarity the sibling $BR probe already fails toward.
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const stubBin = gitStub('refs/heads/work', 7);

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/x', 't', '--body', 'b', '--', 'note.txt'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
    });

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(
      /could not verify base 'work' \(ls-remote exit 7\) — refusing to push/,
    );
    expect(git(['rev-parse', 'HEAD'])).toBeTruthy(); // the caller's repo is intact
  });

  it('does not read an unrelated origin/feat/<x> as "branch <x> already exists"', () => {
    // The sibling probe used a BARE ls-remote pattern, which tail-matches on path segments.
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    git(['push', '-q', 'origin', 'work:feat/x'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const stubBin = ghStub('exit 0');

    const r = spawnSync('/bin/bash', [scriptPath, 'x', 't', '--body', 'b', '--', 'note.txt'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
    });

    expect(r.stderr).not.toMatch(/remote branch already exists/);
    expect(r.status, r.stderr).toBe(0);
    expect(remoteBranchExists(bare, 'x')).toBe(true);
  });
});

describe('ship-branch.sh — the branch is checked out in THIS worktree (sc-2261)', () => {
  /** Main tree stays on `work`; a linked worktree holds `story` — the Frink-provisioned shape. */
  function seedSelfCheckout() {
    const seeded = seedShipRepoLocalRemote();
    const wt = join(mkdtempSync(join(tmpdir(), 'shipself-')), 'wt');
    dirs.push(wt);
    seeded.git(['worktree', 'add', '-q', '-b', 'story', wt], { stdio: 'ignore' });
    writeFileSync(join(wt, 'note.txt'), 'hello\n');
    return { ...seeded, wt };
  }

  it('never tells the caller to force-remove the worktree it is running inside', () => {
    const { env, wt } = seedSelfCheckout();

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'story', 't', '--base', 'work', '--body', 'b', '--', 'note.txt'],
      {
        cwd: wt,
        encoding: 'utf8',
        env,
      },
    );

    expect(r.status, r.stderr).not.toBe(0);
    // The harm, asserted as an ABSENCE: the old advice named this very worktree.
    expect(r.stderr).not.toMatch(REMOVE_FORCE_RE);
    expect(r.stderr).toMatch(/story is checked out in THIS worktree/);
    expect(r.stderr).toMatch(/git branch -m 'story' "devkit-freed-[0-9a-f]+-\$\$"/);
    // No delete of any shape: a rename cannot lose a commit under any interleaving.
    expect(r.stderr).not.toMatch(/branch -[dD] |update-ref -d /);
  });

  it('closes on the same remedy the preflight opened with, not "choose a new branch name"', () => {
    const { env, wt } = seedSelfCheckout();

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'story', 't', '--base', 'work', '--body', 'b', '--', 'note.txt'],
      {
        cwd: wt,
        encoding: 'utf8',
        env,
      },
    );

    // The closing advice is the line an agent acts on. It used to contradict the preflight.
    expect(r.stderr).not.toMatch(/choose a new branch name/);
    const lines = r.stderr.trimEnd().split('\n');
    expect(lines.at(-1)).toMatch(/renaming keeps every commit/);
  });

  it('offers the same rename for a branch that DOES carry a commit of its own', () => {
    const { env, git, wt } = seedSelfCheckout();
    const wtGit = (a) =>
      execFileSync('git', a, { cwd: wt, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
    writeFileSync(join(wt, 'own.txt'), 'x\n');
    wtGit(['add', 'own.txt']);
    wtGit(['commit', '-q', '-m', 'a commit only story has']);
    const tip = wtGit(['rev-parse', 'story']).trim();

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'story', 't', '--base', 'work', '--body', 'b', '--', 'note.txt'],
      { cwd: wt, encoding: 'utf8', env },
    );

    expect(r.stderr).toMatch(/git branch -m 'story' "devkit-freed-[0-9a-f]+-\$\$"/);
    expect(r.stderr).not.toMatch(/branch -[dD] |update-ref -d /);
    expect(localBranchExists(git, 'story')).toBe(true); // ship itself touched nothing
    expect(wtGit(['rev-parse', 'story']).trim()).toBe(tip);
  });

  it('states plainly that a self-checked-out branch carries no commit of its own', () => {
    const { env, git, wt } = seedSelfCheckout();

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'story', 't', '--base', 'work', '--body', 'b', '--', 'note.txt'],
      { cwd: wt, encoding: 'utf8', env },
    );

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain('carries no commit of its own over');
    expect(r.stderr).not.toContain('is not a single commit');
    expect(r.stderr).not.toContain('diverges from it');
    // The two halves must still agree: the reason explains, the closing advice acts, and neither may
    // reach for the worktree this run is executing inside.
    expect(r.stderr).toMatch(/story is checked out in THIS worktree/);
    expect(r.stderr).toMatch(/git branch -m 'story' "devkit-freed-[0-9a-f]+-\$\$"/);
    expect(r.stderr).not.toMatch(REMOVE_FORCE_RE);
    expect(localBranchExists(git, 'story')).toBe(true);
  });

  it('the printed remedy actually works: run it verbatim, then the same ship succeeds', () => {
    const { env, wt, bare } = seedSelfCheckout();
    const stubBin = ghStub('exit 0');

    const refused = spawnSync(
      '/bin/bash',
      [scriptPath, 'story', 't', '--base', 'work', '--body', 'b', '--', 'note.txt'],
      {
        cwd: wt,
        encoding: 'utf8',
        env,
      },
    );
    // Never a `git switch`: this worktree holds the uncommitted work being shipped, and a switch can
    // legitimately refuse when those edits collide with the base. Run exactly what it printed.
    expect(refused.stderr).not.toMatch(/^ {4}git switch /m);
    const ren = refused.stderr.match(/^ {4}(git branch -m .*)$/m);
    expect(ren, refused.stderr).toBeTruthy();
    // Through a shell: the destination is deliberately expanded at execution time, not here.
    execFileSync('/bin/bash', ['-c', ren[1]], { cwd: wt, env: { ...process.env, ...GIT_ENV } });

    const retry = spawnSync(
      '/bin/bash',
      [scriptPath, 'story', 't', '--base', 'work', '--body', 'b', '--', 'note.txt'],
      {
        cwd: wt,
        encoding: 'utf8',
        env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
      },
    );

    expect(retry.stderr).not.toMatch(/detached HEAD/);
    expect(retry.stderr).not.toMatch(/is checked out in THIS worktree/);
    expect(retry.status, retry.stderr).toBe(0);
    expect(remoteBranchExists(bare, 'story')).toBe(true);
  });
});

describe('ship-branch.sh — PR-create failure must not re-propose the failed base (sc-2261)', () => {
  it('suggests a base that exists on origin, and names the recorded one as the rejected one', () => {
    const { dir, env, bare } = seedShipRepoLocalRemote();
    execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/work'], {
      env: { ...process.env, ...GIT_ENV },
    });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const stubBin = ghStub('exit 1'); // push lands, `gh pr create` then fails

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/pr-hint', 't', '--body', 'b', '--', 'note.txt'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
      },
    );

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/pushed AND recorded for reconcile/);
    // gh failed for a reason that is NOT the base — the base was proven on origin before the push and
    // is still there. Substituting origin's default here would send the operator to open the PR
    // against a branch they never chose, which is a quieter error than the one being fixed.
    expect(r.stderr).toMatch(
      /gh pr create --repo 'acme\/app' --base 'work' --head 'feat\/pr-hint'/,
    );
    expect(r.stderr).toMatch(/'work' is on origin, so the base is not the cause/);
    expect(manifestOf(dir).branches['feat/pr-hint'].baseRef).toBe('work');
    expect(remoteBranchExists(bare, 'feat/pr-hint')).toBe(true);
  });

  it('does not announce the base as deleted when the re-verify itself fails', () => {
    // ls-remote is non-zero for auth and network trouble as well as absence. Reading those as
    // deletion would swap a valid base for a different one on the strength of a failed lookup.
    const { dir, env, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    // gh arms the git shim as it fails, so the broken probe CANNOT be the pre-push one: by
    // construction the only ls-remote it can reach is the re-verify in the recovery hint.
    const armed = join(mkdtempSync(join(tmpdir(), 'ship-armed-')), 'armed');
    dirs.push(armed);
    const ghBin = ghStub(`touch '${armed}'; exit 1`);
    const gitBin = gitStub('refs/heads/work', 7, armed);

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/pr-hint3', 't', '--base', 'work', '--body', 'b', '--', 'note.txt'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { ...env, PATH: `${ghBin}:${gitBin}:${process.env.PATH}` },
      },
    );

    // Assert the run REACHED the post-push hint before asserting what the hint says: a stub that also
    // broke the pre-push preflight would satisfy the message checks from an early refusal instead.
    expect(r.stderr).toMatch(/pushed AND recorded for reconcile/);
    expect(remoteBranchExists(bare, 'feat/pr-hint3')).toBe(true);
    expect(r.stderr).not.toMatch(/no longer on origin/);
    expect(r.stderr).toMatch(/--base 'work'/);
    expect(r.stderr).toMatch(/could not re-verify 'work' on origin \(ls-remote exit 7\)/);
  });

  it('diverges only when the base has genuinely left origin since the preflight', () => {
    // The stub deletes the base from the bare as it fails, reproducing the one race in which the
    // recorded base really is unusable: proven on origin before the push, gone by the time the hint
    // is composed. Only here may the hint name a different branch — and it must say why.
    const { dir, env, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const stubBin = ghStub(`git -C '${bare}' branch -D work >/dev/null 2>&1; exit 1`);

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/pr-hint2', 't', '--body', 'b', '--', 'note.txt'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
      },
    );

    expect(r.stderr).toMatch(/'work' is no longer on origin/);
    expect(r.stderr).not.toMatch(/--base 'work'/);
    expect(r.stderr).toMatch(/--base '<branch-on-origin>'/); // unborn bare HEAD → nothing to suggest
  });
});

describe('ship-branch.sh — edge cases around the base preflight (sc-2261)', () => {
  it('does NOT probe origin under SHIP_DRY_RUN, however unusable the base is', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    git(['remote', 'set-url', 'origin', 'git@github.com:acme/app.git'], { stdio: 'ignore' });
    git(['switch', '-q', '-c', 'local-only'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dry', 't', '--body', 'b', '--', 'note.txt'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      },
    );
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/is not on origin/);
  });

  it('does not fire at all when --base is given from a local-only checkout', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    git(['switch', '-q', '-c', 'scratch-only'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const stubBin = ghStub('exit 0');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/with-base', 't', '--base', 'work', '--body', 'b', '--', 'note.txt'],
      { cwd: dir, encoding: 'utf8', env: { ...env, PATH: `${stubBin}:${process.env.PATH}` } },
    );

    expect(r.stderr).not.toMatch(/is not on origin/);
    expect(r.status, r.stderr).toBe(0);
    expect(remoteBranchExists(bare, 'feat/with-base')).toBe(true);
  });

  it('refuses when origin carries only a TAG of the base’s name, never a branch', () => {
    // `--heads` plus the refs/heads/ prefix is what makes this a BRANCH test rather than a ref test.
    // A tag would satisfy a looser probe and then be rejected by `gh pr create` after the push —
    // the exact ordering sc-2261 exists to stop.
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    git(['switch', '-q', '-c', 'tagged-only'], { stdio: 'ignore' });
    // A TAG of that name on origin and NO branch. Pushed branch→tag directly so no LOCAL tag exists:
    // a local tag sharing the branch name makes `symbolic-ref --short HEAD` disambiguate to
    // `heads/tagged-only`, which would test git's ref parsing rather than ship's probe.
    git(['push', '-q', 'origin', 'tagged-only:refs/tags/tagged-only'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/tagbase', 't', '--body', 'b', '--', 'note.txt'],
      {
        cwd: dir,
        encoding: 'utf8',
        env,
      },
    );

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/base 'tagged-only' is not on origin/);
    expect(remoteBranchExists(bare, 'feat/tagbase')).toBe(false);
  });

  it('carries a SLASHED default branch through the ls-remote --symref parse intact', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    git(['push', '-q', 'origin', 'work:release/1.0'], { stdio: 'ignore' });
    execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/release/1.0'], {
      env: { ...process.env, ...GIT_ENV },
    });
    git(['switch', '-q', '-c', 'local-only'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/x', 't', '--body', 'b', '--', 'note.txt'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    });

    expect(r.stderr).toMatch(
      /origin's default branch is 'release\/1\.0' — pass --base 'release\/1\.0'/,
    );
  });
});

describe('ship-branch.sh — edge cases around the self-checkout remedy (sc-2261)', () => {
  it('recognises the caller’s own worktree when ship is run from a SUBDIRECTORY of it', () => {
    const seeded = seedShipRepoLocalRemote();
    const wt = join(mkdtempSync(join(tmpdir(), 'shipsub-')), 'wt');
    dirs.push(wt);
    seeded.git(['worktree', 'add', '-q', '-b', 'story', wt], { stdio: 'ignore' });
    mkdirSync(join(wt, 'pkg'), { recursive: true });
    writeFileSync(join(wt, 'pkg/note.txt'), 'hello\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'story', 't', '--base', 'work', '--body', 'b', '--', 'pkg/note.txt'],
      { cwd: join(wt, 'pkg'), encoding: 'utf8', env: seeded.env },
    );

    expect(r.stderr).toMatch(/story is checked out in THIS worktree/);
    expect(r.stderr).not.toMatch(REMOVE_FORCE_RE);
  });

  it('picks a --base whose local branch does not exist, and that ship then accepts', () => {
    const seeded = seedShipRepoLocalRemote();
    seeded.git(['push', '-q', 'origin', 'work:trunk'], { stdio: 'ignore' });
    execFileSync('git', ['-C', seeded.bare, 'symbolic-ref', 'HEAD', 'refs/heads/trunk'], {
      env: { ...process.env, ...GIT_ENV },
    });
    seeded.git(['fetch', '-q', 'origin'], { stdio: 'ignore' });
    expect(localBranchExists(seeded.git, 'refs/heads/trunk')).toBe(false); // precondition
    const wt = join(mkdtempSync(join(tmpdir(), 'shipdwim-')), 'wt');
    dirs.push(wt);
    seeded.git(['worktree', 'add', '-q', '-b', 'story', wt], { stdio: 'ignore' });
    writeFileSync(join(wt, 'note.txt'), 'hello\n');
    const stubBin = ghStub('exit 0');

    const refused = spawnSync(
      '/bin/bash',
      [scriptPath, 'story', 't', '--base', 'trunk', '--body', 'b', '--', 'note.txt'],
      { cwd: wt, encoding: 'utf8', env: seeded.env },
    );

    const base = refused.stderr.match(/--base '(\S+)' --/);
    expect(base, refused.stderr).toBeTruthy();
    expect(base[1]).toBe('trunk'); // a name with no refs/heads/ counterpart is still a valid base
    const ren = refused.stderr.match(/^ {4}(git branch -m .*)$/m);
    execFileSync('/bin/bash', ['-c', ren[1]], { cwd: wt, env: { ...process.env, ...GIT_ENV } });

    // The suggested base survives contact with ship's own preflight, which is the claim.
    const retry = spawnSync(
      '/bin/bash',
      [scriptPath, 'story', 't', '--base', base[1], '--body', 'b', '--', 'note.txt'],
      { cwd: wt, encoding: 'utf8', env: { ...seeded.env, PATH: `${stubBin}:${process.env.PATH}` } },
    );
    expect(retry.status, retry.stderr).toBe(0);
    expect(remoteBranchExists(seeded.bare, 'story')).toBe(true);
  });

  it('does not tell a re-push (--pr) to delete the branch it is re-pushing', () => {
    const { dir, env, git } = seedReshipRepo();
    git(['switch', '-q', 'pr-open'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    // Since sc-2414 an explicit `--pr` re-ship resolves the open PR and rewrites its body, so the
    // run needs a `gh` on PATH; without one it exits 1 before reaching the remediation advice
    // this test is about.
    const { publishEnv } = publishEnvFor(dir, env);

    const r = spawnSync(
      '/bin/bash',
      [reshipScript, 'pr-open', 't', '--pr', '--body', 'b', '--', 'note.txt'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: publishEnv,
      },
    );

    // Anchor the run to the path under test BEFORE asserting absences: three `not.toMatch`es are
    // satisfied by any earlier refusal, so without this the test would pass while proving nothing.
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/ship must create it/);
    expect(r.stderr).not.toMatch(/git branch -m 'pr-open'/);
    expect(r.stderr).not.toMatch(REMOVE_FORCE_RE);
  });
});
