import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devkitVersion } from '../../gate-engine/devkit-version.mts';
import {
  assertInterruptedGateKeepsWorktree,
  testExecFileSync as execFileSync,
  testSpawnSync as spawnSync,
} from './_helpers.mts';
import {
  addOverlay,
  buildAndRun,
  createPreservedCommit,
  DELETED_BRANCH_RE,
  DETACHED_RE,
  DIR_RE,
  dirs,
  dropWorktree,
  EPHEMERAL_WT_RE,
  EXEC_MODE_RE,
  FLAG_RE,
  GATE_RAN_RE,
  GIT_ENV,
  ghStub,
  hasGh,
  linkGateConfigsScript,
  localBranchExists,
  manifestOf,
  NOTE_RE,
  NOTHING_RE,
  packagedApiSecurityAgent,
  packagedApiSecurityChecklist,
  remoteBranchExists,
  reshipScript,
  resolve,
  reviewerTimeoutEnv,
  scriptPath,
  seedReshipRepo,
  seedShipRepo,
  seedShipRepoLocalRemote,
  WT_RE,
} from './_ship-branch-fixture.mts';

describe('ship-branch.sh — origin → owner/repo resolution (the fork-upstream bug)', () => {
  const urls = [
    ['custom SSH host alias', 'git@github.com-personal:acme/app.git', 'acme/app'],
    ['plain SSH', 'git@github.com:acme/app.git', 'acme/app'],
    ['HTTPS', 'https://github.com/acme/app.git', 'acme/app'],
    ['HTTPS without .git', 'https://github.com/acme/app', 'acme/app'],
  ];
  for (const [label, url, expected] of urls) {
    it(`resolves ${label} → ${expected}`, () => {
      expect(resolve('main', url).repo).toBe(expected);
    });
  }

  it('is not hardcoded — a different owner/repo resolves correctly', () => {
    expect(resolve('main', 'git@github.com:acme/widgets.git').repo).toBe('acme/widgets');
  });
});

describe('ship-branch.sh — PR base = the branch we branched from', () => {
  it('uses the current branch as the base', () => {
    expect(resolve('release', 'git@github.com:acme/app.git').baseRef).toBe('release');
  });
  it('fails fast on a detached HEAD instead of silently targeting main', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', { detached: true });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(DETACHED_RE);
  });

  // --base overrides the target. These run through SHIP_RESOLVE_ONLY, which exits BEFORE the fetch —
  // so they also pin that the seam stayed side-effect-free once --base gave it a network step.
  it('--base overrides the current branch as the PR target', () => {
    expect(
      resolve('main', 'git@github.com:acme/app.git', { extraArgs: ['--base', 'studio'] }).baseRef,
    ).toBe('studio');
  });
  it('--base origin/<b> targets <b> (the PR base is a branch name, not a remote-tracking ref)', () => {
    expect(
      resolve('main', 'git@github.com:acme/app.git', { extraArgs: ['--base', 'origin/studio'] })
        .baseRef,
    ).toBe('studio');
  });
  it('--base makes a detached HEAD shippable (there is no current branch to need)', () => {
    expect(
      resolve('main', 'git@github.com:acme/app.git', {
        detached: true,
        extraArgs: ['--base', 'studio'],
      }).baseRef,
    ).toBe('studio');
  });
});

// DK-1: ship off an arbitrary base. The repro it fixes — work ALREADY COMMITTED on a source branch
// whose PR base is a different branch — staged nothing (the paths matched HEAD), so the ship aborted
// and force-deleted its own branch. The fix is that BASE is no longer pinned to HEAD; `git diff <base>
// -- <paths>` was already base-vs-WORKING-TREE, so staging itself needed no change.
describe('ship-branch.sh — --base <branch>', () => {
  /** A repo with an `origin` bare that has a `studio` branch, and a `finalized` branch (checked out)
   *  whose note.txt change is ALREADY COMMITTED — exactly the DK-1 repro state. */
  function seedBaseRepo({ hookBody } = {}) {
    const seeded = seedShipRepoLocalRemote({ hookBody });
    const { dir, git, bare } = seeded;
    writeFileSync(join(dir, 'note.txt'), 'studio\n');
    git(['add', 'note.txt'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'studio note'], { stdio: 'ignore' });
    git(['push', '-q', 'origin', 'work:studio'], { stdio: 'ignore' }); // the PR base, on origin
    git(['checkout', '-q', '-b', 'finalized'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'finalized\n');
    git(['add', 'note.txt'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'finalize'], { stdio: 'ignore' }); // committed → HEAD-based ship stages nothing
    const studioTip = execFileSync('git', ['-C', bare, 'rev-parse', 'studio'], {
      env: { ...process.env, ...GIT_ENV },
      encoding: 'utf8',
    }).trim();
    return { ...seeded, studioTip };
  }

  // The acceptance criterion, and the proof that `x` and `origin/x` resolve to ONE base.
  for (const spelling of ['studio', 'origin/studio']) {
    it(`--base ${spelling}: ships committed work as a diff vs studio, from the finalized checkout`, () => {
      const { dir, env, git, studioTip } = seedBaseRepo();
      const headBefore = git(['rev-parse', 'HEAD']).trim();

      const r = spawnSync(
        '/bin/bash',
        [scriptPath, 'feat/dk1', 'ship it', '--base', spelling, '--', 'note.txt'],
        { cwd: dir, input: 'b\n', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
      );
      dropWorktree(git, r.stderr);

      expect(r.status, r.stderr).toBe(0); // the repro: this aborted "nothing to commit"
      expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore); // shared HEAD unmoved
      expect(git(['rev-parse', 'feat/dk1^']).trim()).toBe(studioTip); // branched off origin/studio
      // The diff is the FINALIZED content vs studio — i.e. read from the working tree, not from HEAD.
      expect(git(['show', 'feat/dk1:note.txt'])).toBe('finalized\n');
      expect(git(['diff', '--name-only', 'origin/studio', 'feat/dk1']).trim()).toBe('note.txt');
    });
  }

  it('bases on ORIGIN’s tip, not a stale local copy of the base branch', () => {
    const { dir, env, git, bare } = seedBaseRepo();
    // origin/studio advances behind this checkout's back (a parallel agent's merge). This checkout
    // never fetches, so its own origin/studio remote-tracking ref stays STALE — resolving the base
    // from it would cut the worktree at the old tip and gate code GitHub will never merge into. Only
    // ship's own fetch makes the base current, so this test fails if that fetch is ever dropped.
    const clone = mkdtempSync(join(tmpdir(), 'shipadv-'));
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
    const advancedTip = execFileSync('git', ['-C', bare, 'rev-parse', 'studio'], {
      env: { ...process.env, ...GIT_ENV },
      encoding: 'utf8',
    }).trim();

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/fresh', 't', '--base', 'studio', '--', 'note.txt'],
      { cwd: dir, input: 'b\n', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(git(['rev-parse', 'feat/fresh^']).trim()).toBe(advancedTip); // fetched, not the stale local
  });

  it('fails before creating a worktree when the base has a tighter size ceiling than the checkout', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'eslint/baselines'), { recursive: true });
    writeFileSync(
      join(dir, 'guard.config.json'),
      JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 }),
    );
    writeFileSync(join(dir, 'src/hot.ts'), Array(60).fill('const x = 1;').join('\n'));
    writeFileSync(
      join(dir, 'eslint/baselines/size-lines.json'),
      JSON.stringify({ maxLines: 50, files: { 'src/hot.ts': 60 } }),
    );
    git(['add', 'guard.config.json', 'src/hot.ts', 'eslint/baselines/size-lines.json']);
    git(['commit', '-q', '-m', 'size baseline']);
    git(['push', '-q', 'origin', 'work:studio']);
    git(['checkout', '-q', '-b', 'finalized']);

    writeFileSync(join(dir, 'src/hot.ts'), Array(70).fill('const x = 1;').join('\n'));
    writeFileSync(
      join(dir, 'eslint/baselines/size-lines.json'),
      JSON.stringify({ maxLines: 50, files: { 'src/hot.ts': 80 } }),
    );
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/size-preflight', 't', '--base', 'studio', '--', 'src/hot.ts'],
      { cwd: join(dir, 'src'), input: '', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('working-tree baseline would allow 80');
    expect(localBranchExists(git, 'feat/size-preflight')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/size-preflight')).toBe(false);
    expect(r.stderr).not.toMatch(EPHEMERAL_WT_RE);
  });

  it('rejects a --base branch that does not exist on origin', () => {
    const { dir, env } = seedBaseRepo();
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/x', 't', '--base', 'nope', '--', 'note.txt'],
      {
        cwd: dir,
        input: 'b\n',
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no branch origin\/nope/);
  });

  // A PR base must be a BRANCH — `gh pr create --base <tag|sha>` is rejected. Fetching the fully
  // qualified refs/heads/<b> (not a bare ref, which would also match a tag) is what fails it HERE,
  // before the push, instead of after.
  for (const kind of ['tag', 'sha']) {
    it(`rejects a --base ${kind} (a PR base must be a branch), before anything is pushed`, () => {
      const { dir, env, git, bare, studioTip } = seedBaseRepo();
      git(['tag', 'v1', 'origin/studio'], { stdio: 'ignore' });
      git(['push', '-q', 'origin', 'v1'], { stdio: 'ignore' });
      const ref = kind === 'tag' ? 'v1' : studioTip;

      const r = spawnSync(
        '/bin/bash',
        [scriptPath, 'feat/x', 't', '--base', ref, '--', 'note.txt'],
        {
          cwd: dir,
          input: 'b\n',
          encoding: 'utf8',
          env: { ...env, SHIP_DRY_RUN: '1' },
        },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/must be a remote branch/);
      expect(localBranchExists(git, 'feat/x')).toBe(false); // failed before creating anything
      expect(remoteBranchExists(bare, 'feat/x')).toBe(false);
    });
  }

  // The --base empty-commit hint ("already identical on origin/<base>", no checkout advice) is
  // covered in the `empty-commit preflight` describe, beside its default-base twin.

  // DK-5: the worktree is cut from origin's fetched studio tip — in-chain gates (fallow) need that
  // SAME commit exported so they scope their own audit against it instead of their own
  // main-autodetect, which would misreport studio's own pre-existing findings vs main as "new".
  it("exports DEVKIT_SHIP_BASE_SHA = origin's fetched studio tip, not a stale local ref", () => {
    const { dir, env, git, studioTip } = seedBaseRepo({
      hookBody: 'echo "HOOK_BASE=$DEVKIT_SHIP_BASE_SHA"',
    });
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/base-sha-flag', 't', '--base', 'studio', '--', 'note.txt'],
      { cwd: dir, input: 'b\n', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-base-sha-flag.log'), 'utf8');
    expect(log).toContain(`HOOK_BASE=${studioTip}`);
  });
});

describe('ship-branch.sh — isolation + arg guards', () => {
  it('rejects a directory path (it would sweep in parallel edits under it)', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      mkdir: 'sub',
      pathArg: 'sub',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(DIR_RE);
  });

  it('rejects an unknown flag before -- (a dash-leading file path must go after --)', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', { pathArg: '--bogus' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(FLAG_RE);
  });
});

// `<branch>` and `<title>` are read positionally before the flag loop, so flags-first bound
// BR="--base" and the run died ~180 lines later inside `git branch` with `unknown option 'base'` —
// an error naming neither the ordering rule nor the two arguments at fault. Five of six recorded
// agent sessions wrote this form, all AFTER reading the help text; reship.sh hit the same class via
// `--pr` (its :18-25). Assert the guard fires EARLY, by its own message.
describe('ship — <branch>/<title> must precede the flags', () => {
  const ORDER_RE = /must come FIRST, before any flag/;
  const GIT_UNKNOWN_OPT_RE = /unknown option/;

  for (const flag of ['--base', '--link', '--body', '--pr']) {
    it(`rejects ${flag} in a positional slot, naming the ordering rule`, () => {
      const r = buildAndRun('main', 'git@github.com:acme/app.git', {
        argv: [flag, 'somevalue', 'feat/x', 'title', '--', 'dummy-path'],
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(ORDER_RE);
      expect(r.stderr).toMatch(new RegExp(`'\\${flag}'`));
      // The whole point: it must NOT reach the internal git call it used to die in.
      expect(r.stderr).not.toMatch(GIT_UNKNOWN_OPT_RE);
    });
  }

  it('rejects a positional-slot flag in reship.sh too (shared guard)', () => {
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      script: reshipScript,
      argv: ['--link', 'somedir', 'feat/x', 'title', '--', 'dummy-path'],
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(ORDER_RE);
  });

  it('still accepts a dash-leading TITLE (guard matches known flags, not every dash)', () => {
    // Matching a blanket `-*` would trade the flags-first footgun for a title one. A title is free
    // text; only the four real flag spellings are rejected.
    const r = buildAndRun('main', 'git@github.com:acme/app.git', {
      argv: ['feat/x', '-- rebuild the parser --', '--', 'dummy-path'],
    });
    expect(r.status, `guard must not reject a dash-leading title (stderr: ${r.stderr})`).toBe(0);
  });
});

describe('ship-branch.sh — empty-commit preflight', () => {
  // Regression: shipping paths already identical to BASE staged nothing, and NOTHING observed the
  // empty index — the tracked-diff patch is empty (so the `[ -s "$PATCH" ] && apply` never fires) and
  // `ls-files -o` lists nothing. Ship therefore created the branch, ran the FULL gate chain, and died
  // on git's cryptic "nothing added to commit but untracked files present" (the untracked files being
  // ship's own gate symlinks), whereupon the cleanup trap force-deleted the branch it had just made —
  // "Deleted branch … (was …)" on STDOUT, unsuppressed by the trap's 2>/dev/null. Minutes of gates for
  // an unexplained failure. reship.sh already guarded this; the new-ship path did not.
  it('fails fast when the paths are identical to base — no gates, no branch churn', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: 'echo GATE_RAN >&2; exit 0' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    git(['add', 'note.txt'], { stdio: 'ignore' });
    git(['commit', '-qm', 'already committed'], { stdio: 'ignore' });

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/empty', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(NOTHING_RE);
    expect(r.stderr).not.toMatch(GATE_RAN_RE); // zero gate work — the chain never ran
    expect(r.stdout).not.toMatch(DELETED_BRANCH_RE); // no create-then-delete churn
    expect(git(['worktree', 'list'])).not.toMatch(EPHEMERAL_WT_RE);
    expect(localBranchExists(git, 'feat/empty')).toBe(false);
  });

  // The remedy must name the base that was ACTUALLY used, or it sends the operator the wrong way.
  // Default (no --base) the base is this checkout's branch, so "check out the branch your work is on"
  // is the fix and --base is worth offering.
  it('default base: names this checkout’s branch and offers --base as the alternative', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    git(['add', 'note.txt'], { stdio: 'ignore' });
    git(['commit', '-qm', 'already committed'], { stdio: 'ignore' });

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/default-base-hint', 'ship it', 'note.txt'],
      {
        cwd: dir,
        input: 'pr body\n',
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      },
    );

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(NOTHING_RE);
    expect(r.stderr).toContain('work'); // the base actually used: this checkout's branch
    expect(r.stderr).toContain('--base'); // the flag exists, so offering it is a real remedy
  });

  // …but under --base the base is origin/<branch>, NOT the checkout. Re-suggesting a checkout there
  // would contradict the flag's whole purpose (ship a diff vs another base WITHOUT checking it out),
  // so the message must name origin/<base> and stay silent about checking out.
  it('--base: names origin/<base>, never re-suggests checking out', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    git(['add', 'note.txt'], { stdio: 'ignore' });
    git(['commit', '-qm', 'content'], { stdio: 'ignore' });
    git(['push', '-q', 'origin', 'work:studio'], { stdio: 'ignore' }); // origin/studio has this exact content

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/base-hint', 'ship it', '--base', 'studio', '--', 'note.txt'],
      { cwd: dir, input: 'pr body\n', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(NOTHING_RE);
    expect(r.stderr).toContain('origin/studio'); // the base actually used
    expect(r.stderr).not.toContain('check out'); // not checking out is the point of --base
    expect(localBranchExists(git, 'feat/base-hint')).toBe(false); // no churn on the --base path either
  });

  // Guards the guard: the empty-commit check must not abort a REAL tracked edit. The worktree-
  // integration test below ships an UNTRACKED file, exercising only the `ls-files -o` half — nothing
  // covered the `diff --quiet` half against a false abort.
  it('still ships a modified tracked file (the guard is not over-eager)', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    git(['add', 'note.txt'], { stdio: 'ignore' });
    git(['commit', '-qm', 'base content'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'changed\n'); // tracked edit → the patch path

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/tracked', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status, r.stderr).toBe(0);
    expect(git(['show', 'feat/tracked:note.txt'])).toContain('changed');
    dropWorktree(git, r.stderr); // dry-run keeps the worktree; don't block afterAll's rm
  });
});

describe('ship-branch.sh — worktree integration', () => {
  // The load-bearing path: a real SHIP_DRY_RUN that creates the worktree, ships a file, and commits
  // inside it. Asserts the Target's core claims end-to-end — the shared HEAD never moves, the file
  // lands on the new branch, and the hook fires in the worktree via the .husky/_ symlink.
  it('ships a file into an isolated worktree; HEAD stays put; the hook fires in the worktree', () => {
    const { dir, env, git } = seedShipRepo({
      // touch the sentinel unconditionally — proves the hook fired. $SENTINEL is an ABSOLUTE path from
      // the ship env: the hook's cwd is the ephemeral worktree, so a relative `touch` would land there,
      // not in the repo dir we assert against.
      hookBody: 'touch "$SENTINEL"\nexit 0',
    });
    const sentinel = join(dir, 'HOOK_FIRED');
    writeFileSync(join(dir, 'note.txt'), 'hello\n'); // the untracked file we ship
    writeFileSync(join(dir, 'tool.sh'), '#!/bin/sh\necho hi\n'); // an EXECUTABLE untracked file
    chmodSync(join(dir, 'tool.sh'), 0o755);

    const headBefore = git(['rev-parse', 'HEAD']).trim();
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/wt-test', 'ship it', 'note.txt', 'tool.sh'],
      {
        cwd: dir,
        input: 'pr body\n',
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1', SENTINEL: sentinel }, // commit in the worktree, skip push/PR
      },
    );
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore); // shared HEAD unmoved
    expect(git(['show', '--name-only', '--pretty=format:', 'feat/wt-test'])).toMatch(NOTE_RE);
    expect(existsSync(sentinel)).toBe(true); // hook fired in the worktree
    // cp -Pp preserves the +x bit through the worktree commit (git tracks the exec mode).
    expect(git(['ls-tree', 'feat/wt-test', 'tool.sh']).trim()).toMatch(EXEC_MODE_RE);
  });

  // Regression: a FAILED dry-run must not leak its ephemeral worktree/branch. Before the fix cleanup
  // keyed on SHIP_DRY_RUN and only PRINTED "worktree kept" — so a gate failure under dry-run left a
  // devkit-ship-* worktree + empty branch registered, blocking later deletion. Now cleanup keys on
  // "did a commit land beyond BASE": nothing landed ⇒ reclaim both, even under dry-run.
  it('a failed gate under dry-run leaves no worktree or branch behind', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: 'exit 1' }); // gate fails → commit fails → nonzero exit
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/leak-test', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status, r.stderr).not.toBe(0); // the gate failed the ship
    expect(git(['worktree', 'list'])).not.toMatch(/devkit-ship-/); // no ephemeral worktree left registered
    expect(localBranchExists(git, 'feat/leak-test')).toBe(false); // no leftover branch
  });

  // sc-1420: a ship died ten minutes in because a gate could not read a staged object. The log's last
  // line was a git fatal from whichever gate happened to read the staged diff first, so it read as
  // that gate rejecting the commit — sending the operator to re-run a reviewer that was never the
  // problem. The hook here reproduces the shape: it removes a staged object mid-gate, then fails. What
  // must hold is attribution — NOT "the gate blocked", but "the staged content became unreadable".
  it('attributes a mid-gate loss of a staged object to the object database, not to the gate', () => {
    const sink = 'events.jsonl';
    const { dir, env, git } = seedShipRepo({
      hookBody: [
        'oid=$(git rev-parse :note.txt)',
        'objects=$(git rev-parse --path-format=absolute --git-common-dir)/objects',
        'rm -f "$objects/$(printf %s "$oid" | cut -c1-2)/$(printf %s "$oid" | cut -c3-)"',
        'echo "gate read the staged diff and failed" >&2',
        'exit 1',
      ].join('\n'),
    });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/lost-object', 'x', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1', DEVKIT_GATE_EVENTS: join(dir, sink) },
    });

    expect(r.status, r.stderr).not.toBe(0);
    // The banner names the real cause and says plainly that the reporting gate is not the culprit.
    expect(r.stderr).toContain('missing from the object database');
    expect(r.stderr).toContain('NOT a gate rejection');
    // ...and carries the evidence that separates a deletion from an ODB split.
    expect(r.stderr).toContain('GIT_OBJECT_DIRECTORY=');

    // Telemetry agrees with the banner — one evidence-checked verdict, not a second independent grep.
    const events = readFileSync(join(dir, sink), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === 'ship_result').blocked_gate).toBe(
      'staged_objects_missing',
    );

    // Nothing shipped, nothing leaked.
    expect(git(['worktree', 'list'])).not.toMatch(/devkit-ship-/);
    expect(localBranchExists(git, 'feat/lost-object')).toBe(false);
  });

  it('ships a dash-leading filename passed after -- (treated as a path, not a flag)', () => {
    const { dir, env, git } = seedShipRepo();
    const weird = '--looks-like-flag.txt';
    writeFileSync(join(dir, weird), 'x\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/dash', 't', '--', weird], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(git(['show', '--name-only', '--pretty=format:', 'feat/dash'])).toContain(weird);
  });

  it.runIf(hasGh)('on a commit failure, deletes the empty branch so a retry is not blocked', () => {
    const bare = mkdtempSync(join(tmpdir(), 'shipbare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GIT_ENV } });
    const { dir, env, git } = seedShipRepo({ hookBody: 'exit 1', origin: bare }); // hook REJECTS the commit
    writeFileSync(join(dir, 'note.txt'), 'hello\n');

    // NON-dry run exercises the real cleanup; the commit is rejected before any push.
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/wt-fail', 'x', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env,
    });

    expect(r.status).not.toBe(0); // the commit was rejected
    // The empty branch (no commit beyond BASE) must be gone, so a retry is not blocked.
    expect(() =>
      git(['rev-parse', '--verify', '--quiet', 'feat/wt-fail'], { stdio: 'ignore' }),
    ).toThrow();
  });

  // push OK but `gh pr create` fails (the wrong-gh-account bug, frink#28): the branch is live on the
  // remote, so the manifest MUST be recorded the instant the push succeeds — recording on PR-create
  // instead would orphan the pushed branch from `devkit reconcile` forever. pr:null is fine: reconcile
  // self-heals it by resolving merge state via `gh pr view <branch>` once a PR exists + merges.
  it('records the branch (pr:null) the instant push succeeds, even when gh pr create fails', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote(); // REPO resolves to acme/app, offline push
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const stubBin = ghStub('exit 1'); // gh pr create FAILS (preflight `command -v gh` still passes)

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/pr-fail', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
    });

    expect(r.status, r.stderr).not.toBe(0); // PR create failed → ship still surfaces the failure
    expect(r.stderr).toMatch(/pushed AND recorded for reconcile/); // the louder push-OK/PR-fail warning

    // The branch is recorded with pr:null + full fresh-entry metadata (reconcile heals the number later).
    const e = manifestOf(dir).branches['feat/pr-fail'];
    expect(e, 'branch must be recorded the instant the push succeeds').toBeTruthy();
    expect(e.prNumber).toBe(null);
    expect(e.repo).toBe('acme/app');
    expect(e.baseRef).toBe('work');
    expect(e.paths.find((p) => p.path === 'note.txt')).toMatchObject({ op: 'add' });

    // Branch kept locally (recoverable for the manual PR-create) AND live on the bare remote.
    expect(localBranchExists(git, 'feat/pr-fail')).toBe(true);
    expect(remoteBranchExists(bare, 'feat/pr-fail')).toBe(true);
  });

  // The success branch of the same reorder (push OK + PR-create OK): the manifest must carry the REAL
  // PR number and the local branch + worktree must be cleaned up. Previously had no integration coverage.
  it('on push + PR-create success, records the real PR number and cleans up the local branch', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const stubBin = ghStub('echo "https://github.com/acme/app/pull/42"'); // gh pr create SUCCEEDS

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ok', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/pull\/42/); // the PR URL stays the only stdout line (the agent-facing stream)

    const e = manifestOf(dir).branches['feat/ok'];
    expect(e.prNumber).toBe(42); // the parsed PR number, not null
    expect(e.repo).toBe('acme/app');
    expect(e.paths.find((p) => p.path === 'note.txt')).toMatchObject({ op: 'add' });

    // Full success → the redundant local branch is dropped; the work lives on the remote with its PR.
    expect(localBranchExists(git, 'feat/ok')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/ok')).toBe(true);
  });

  // The ship emits a ship_pr telemetry line tying its ship_id to the PR it opened, so the usage
  // tracker links a ship row straight to its PR without a gh-by-branch lookup.
  it('emits a ship_pr telemetry event with the opened PR url + number, correlated to the ship_id', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const stubBin = ghStub('echo "https://github.com/acme/app/pull/42"');
    const sink = join(dir, 'events.jsonl');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ok', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${process.env.PATH}`, DEVKIT_GATE_EVENTS: sink },
    });
    expect(r.status, r.stderr).toBe(0);

    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const attempt = events.find((e) => e.type === 'ship_attempt');
    const resultEvent = events.find((e) => e.type === 'ship_result');
    const prEvent = events.find((e) => e.type === 'ship_pr');
    expect(attempt.devkit_version).toBe(devkitVersion());
    expect(resultEvent.devkit_version).toBe(devkitVersion());
    expect(prEvent).toBeTruthy();
    expect(prEvent.pr_url).toBe('https://github.com/acme/app/pull/42');
    expect(prEvent.pr_number).toBe(42); // a bare JSON number, not a string
    expect(prEvent.ship_id).toBe(attempt.ship_id); // same attempt the gate events correlate under
    expect(prEvent.devkit_version).toBe(devkitVersion());
  });

  // A 0-exit `gh pr create` that prints no parseable URL (e.g. it writes the URL to stderr) must NOT be
  // mistaken for the create-failure path: the ship still succeeds and cleans up, recording pr:null —
  // which reconcile self-heals via its `gh pr view <branch>` lookup. Guards the exit-code vs
  // empty-PR_NUM distinction the reorder introduced.
  it('treats a 0-exit gh with no parseable URL as success: records pr:null and still cleans up', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const stubBin = ghStub('exit 0'); // success, but empty stdout → PR_NUM unparseable

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/empty-url', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
    });

    expect(r.status, r.stderr).toBe(0); // 0-exit gh ≠ failure path
    expect(r.stderr).not.toMatch(/PR create failed/); // no false warning, no exit 1
    expect(manifestOf(dir).branches['feat/empty-url'].prNumber).toBe(null); // unparseable URL → pr:null
    expect(localBranchExists(git, 'feat/empty-url')).toBe(false); // success → cleaned up
    expect(remoteBranchExists(bare, 'feat/empty-url')).toBe(true);
  });

  // commit-with-gate-capture.sh: the worktree commit's hook output is captured to a per-branch log so
  // the shipping agent can read the gate verdicts (git buries them on the commit's stderr), while the
  // PR URL stays the only stdout line and a blocking gate still aborts.
  it('captures the pre-commit gate output to a per-branch log, off stdout', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: 'echo "GATE_MARKER_XYZ"\nexit 0' });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/gate-log', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    const log = join(dir, '.devkit/last-ship-gates-feat-gate-log.log');
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toMatch(/GATE_MARKER_XYZ/); // full gate output captured
    expect(r.stderr).toMatch(/pre-commit gates ran/); // compact status on stderr
    expect(r.stdout).not.toMatch(/GATE_MARKER_XYZ/); // gate output never pollutes stdout (PR-URL stream)
  });

  it('keeps an unwritable telemetry archive best-effort while persisting the gate log', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: 'echo "ARCHIVE_MARKER_XYZ"\nexit 0' });
    const archiveParent = join(dir, 'archive-parent-is-a-file');
    writeFileSync(archiveParent, 'not a directory\n');
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/archive-log', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: {
        ...env,
        SHIP_DRY_RUN: '1',
        DEVKIT_GATE_EVENTS: join(archiveParent, 'gate-events.jsonl'),
      },
    });
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-archive-log.log'), 'utf8')).toMatch(
      /ARCHIVE_MARKER_XYZ/,
    );
    expect(r.stderr).toMatch(/ARCHIVE_MARKER_XYZ/);
    expect(r.stderr).toMatch(/could not archive gate output .* continuing/);
  });

  it('captures the gate output to the log even when a gate blocks the commit', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: 'echo "BLOCK_REASON_XYZ"\nexit 1' });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/gate-block', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status).not.toBe(0); // blocking gate aborts the ship
    const log = join(dir, '.devkit/last-ship-gates-feat-gate-block.log');
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toMatch(/BLOCK_REASON_XYZ/); // blocking gate's reason captured
  });

  // A hung hook with a background pipe-holder must be group-reaped so capture can return 124; a
  // leader-only kill leaves the child holding the pipe. This runs on stock macOS since sc-1199
  // replaced the coreutils timeout dependency with Node + /bin/ps.
  it('bounds a hung gate: the backgrounded pipe-holder is reaped, the ship exits 124 fast (not hung)', () => {
    // sleep 30 & → a grandchild inheriting the commit's stdout (the pipe) that outlives a kill-git-only;
    // sleep 30 → the hook itself hangs so the test timeout fires while it is still running. Fifteen
    // seconds leaves enough startup headroom under load while staying well below either sleep.
    const { dir, env, git } = seedShipRepo({ hookBody: 'sleep 30 &\nsleep 30' });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/hung-gate', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      timeout: 45_000, // belt-and-suspenders: a broken impl would hang ~30s; cap it under the suite timeout
      env: { ...env, SHIP_DRY_RUN: '1', SHIP_COMMIT_TIMEOUT: '15' },
    });
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).not.toBe(0); // bounded — the timed-out commit aborts the ship
    // The make-or-break: the group-kill closes the pipe and the supervisor reports its own expiry.
    // A leader-only signal leaves the background sleep holding the pipe and spawnSync hits its 45s cap.
    expect(r.stderr).toMatch(/gate chain hit the 15s ceiling \(exit 124\)/);
    expect(r.stderr).toMatch(/Re-run the same devkit ship command to converge/); // resume hint
    expect(r.stderr).toMatch(/export SHIP_COMMIT_TIMEOUT/); // the knob, with the exported-env caveat
  });

  it('an identical retry publishes the preserved commit after a post-commit timeout', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote({
      // The hook exits successfully but leaks a pipe-holding child. Git lands the commit; the gate
      // supervisor then returns 124 while reaping that descendant — the reported Story #1550 state.
      hookBody: 'echo run >> "$TEST_HOOK_COUNT"\nsleep 30 &',
    });
    const hookCount = join(dir, 'hook-count');
    const stubBin = ghStub('echo https://github.com/acme/app/pull/42');
    const publishEnv = {
      ...env,
      PATH: `${stubBin}:${env.PATH ?? process.env.PATH ?? ''}`,
      TEST_HOOK_COUNT: hookCount,
    };
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const first = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/post-commit-timeout', 'ship it', '--', './note.txt'],
      {
        cwd: dir,
        input: 'pr body  \n', // Git strips these spaces; the identical retry must normalize likewise.
        encoding: 'utf8',
        timeout: 45_000,
        env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
      },
    );

    expect(first.status, first.stderr).toBe(124);
    expect(first.stderr).toMatch(/Re-run the same devkit ship command to converge/);
    expect(first.stdout).not.toContain('https://github.com/acme/app/pull/42');
    expect(localBranchExists(git, 'feat/post-commit-timeout')).toBe(true);
    expect(remoteBranchExists(bare, 'feat/post-commit-timeout')).toBe(false);
    const preserved = git(['rev-parse', 'feat/post-commit-timeout']).trim();
    expect(git(['rev-parse', 'refs/devkit/ship-receipts/feat/post-commit-timeout']).trim()).toBe(
      preserved,
    );

    const retry = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/post-commit-timeout', 'ship it', '--', './note.txt'],
      { cwd: dir, input: 'pr body  \n', encoding: 'utf8', env: publishEnv },
    );

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('gate receipt verified');
    expect(retry.stdout).toContain('https://github.com/acme/app/pull/42');
    expect(remoteBranchExists(bare, 'feat/post-commit-timeout')).toBe(true);
    expect(
      execFileSync('git', ['--git-dir', bare, 'rev-parse', 'feat/post-commit-timeout'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(preserved);
    expect(localBranchExists(git, 'feat/post-commit-timeout')).toBe(false);
    expect(readFileSync(hookCount, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(manifestOf(dir).branches['feat/post-commit-timeout'].prNumber).toBe(42);
  });

  it('does not treat a matching hand-made commit as proof that ship gates ran', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    const stubBin = ghStub('echo should-not-run; exit 9');
    createPreservedCommit({
      dir,
      env,
      git,
      branch: 'feat/unproved',
      tempPrefix: 'ship-unproved-',
    });

    const retry = spawnSync('/bin/bash', [scriptPath, 'feat/unproved', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${env.PATH ?? process.env.PATH ?? ''}` },
    });

    expect(retry.status, retry.stderr).toBe(1);
    expect(retry.stderr).toContain('no matching prior-ship gate receipt');
    expect(retry.stdout).not.toContain('should-not-run');
    expect(localBranchExists(git, 'feat/unproved')).toBe(true);
  });

  it('does not mint a gate receipt when mandatory gate-log persistence fails', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const stubBin = ghStub('echo should-not-run; exit 9');
    const realTee = execFileSync('/bin/sh', ['-c', 'command -v tee'], {
      env,
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(stubBin, 'tee'), `#!/bin/sh\n"${realTee}" "$@"\nexit 1\n`);
    chmodSync(join(stubBin, 'tee'), 0o755);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const first = spawnSync('/bin/bash', [scriptPath, 'feat/log-failed', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${env.PATH ?? process.env.PATH ?? ''}` },
    });

    expect(first.status, first.stderr).toBe(1);
    expect(first.stderr).toContain('could not persist gate output');
    expect(localBranchExists(git, 'feat/log-failed')).toBe(true);
    expect(localBranchExists(git, 'refs/devkit/ship-receipts/feat/log-failed')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/log-failed')).toBe(false);
    expect(first.stdout).not.toContain('should-not-run');
  });

  it('checkpoints a landed commit before honoring a post-supervisor signal', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const stubBin = ghStub('echo https://github.com/acme/app/pull/44');
    const realTee = execFileSync('/bin/sh', ['-c', 'command -v tee'], {
      env,
      encoding: 'utf8',
    }).trim();
    // tee observes EOF only after the supervisor is reaped. Signalling its parent at that point
    // deterministically exercises the post-commit/reaped drain window from the correctness review.
    writeFileSync(
      join(stubBin, 'tee'),
      `#!/bin/sh\n"${realTee}" "$@"\nkill -TERM "$PPID"\nexit 0\n`,
    );
    chmodSync(join(stubBin, 'tee'), 0o755);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const publishEnv = {
      ...env,
      PATH: `${stubBin}:${env.PATH ?? process.env.PATH ?? ''}`,
    };

    const first = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/post-reap-signal', 'ship it', 'note.txt'],
      {
        cwd: dir,
        input: 'pr body\n',
        encoding: 'utf8',
        env: publishEnv,
      },
    );

    expect(first.status, first.stderr).toBe(143);
    const preserved = git(['rev-parse', 'feat/post-reap-signal']).trim();
    const receiptRef = 'refs/devkit/ship-receipts/feat/post-reap-signal';
    expect(localBranchExists(git, receiptRef), first.stderr).toBe(true);
    expect(git(['rev-parse', receiptRef]).trim()).toBe(preserved);
    expect(remoteBranchExists(bare, 'feat/post-reap-signal')).toBe(false);

    const retry = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/post-reap-signal', 'ship it', 'note.txt'],
      { cwd: dir, input: 'pr body\n', encoding: 'utf8', env: publishEnv },
    );
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('gate receipt verified');
    expect(remoteBranchExists(bare, 'feat/post-reap-signal')).toBe(true);
  });

  it('does not delete a concurrent local branch update after publishing the preserved commit', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    const base = git(['rev-parse', 'work']).trim();
    const preserved = createPreservedCommit({
      dir,
      env,
      git,
      branch: 'feat/concurrent-update',
      tempPrefix: 'ship-concurrent-update-',
    });
    git(['update-ref', 'refs/devkit/ship-receipts/feat/concurrent-update', preserved]);
    const stubBin = ghStub(
      'git update-ref refs/heads/feat/concurrent-update "$TEST_CONCURRENT_TIP"\n' +
        'echo https://github.com/acme/app/pull/43',
    );

    const retry = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/concurrent-update', 'ship it', 'note.txt'],
      {
        cwd: dir,
        input: 'pr body\n',
        encoding: 'utf8',
        env: {
          ...env,
          PATH: `${stubBin}:${env.PATH ?? process.env.PATH ?? ''}`,
          TEST_CONCURRENT_TIP: base,
        },
      },
    );

    expect(retry.status, retry.stderr).toBe(0);
    expect(
      execFileSync('git', ['--git-dir', bare, 'rev-parse', 'feat/concurrent-update'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(preserved);
    expect(git(['rev-parse', 'feat/concurrent-update']).trim()).toBe(base);
  });

  it('still rejects an unrelated existing local branch', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    const stubBin = ghStub('echo should-not-run; exit 9');
    git(['branch', 'feat/unrelated']);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/unrelated', 'ship it', 'note.txt'], {
      cwd: dir,
      input: 'pr body\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${env.PATH ?? process.env.PATH ?? ''}` },
    });

    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('branch already exists: feat/unrelated');
    expect(r.stderr).toContain('cannot safely resume it');
    expect(r.stdout).not.toContain('should-not-run');
    expect(git(['rev-parse', 'feat/unrelated']).trim()).toBe(git(['rev-parse', 'work']).trim());
  });

  it('keeps the new-ship worktree alive until an interrupted gate is fully reaped', async () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    await assertInterruptedGateKeepsWorktree({
      dir,
      env,
      script: scriptPath,
      args: ['feat/signal-handoff', 't', 'note.txt'],
      listWorktrees: () => git(['worktree', 'list']),
    });
  });
  it('a timeout DURING the reviewer gate names the stage and the reviewers with no completion', () => {
    // The deterministic supervisor fixture records the running set + one checkpointed completion to
    // the progress JSON the ship exported (DEVKIT_REVIEW_PROGRESS), then returns timeout status 124.
    // The banner reads THAT file (not stderr prose) to name the unfinished reviewer.
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/review-attrib', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: {
        ...reviewerTimeoutEnv(dir, env),
        SHIP_DRY_RUN: '1',
        SHIP_COMMIT_TIMEOUT: '15',
      },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/DURING: .*Reviewer gate/); // last stage banner, not the last line
    expect(r.stderr).toMatch(/unfinished.*commit-guard/); // running − completed = the unfinished one
    expect(r.stderr).not.toMatch(/unfinished.*api-security-reviewer/); // checkpointed → not named
  });

  it('attribution survives LC_ALL=C (the emoji stage grep + the JSON read under the C locale)', () => {
    // Hooks often run with a minimal C locale (GUI git clients, CI): the stage grep still carries
    // emoji alternations, and the progress read must parse the JSON identically regardless of locale.
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/c-locale', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: {
        ...reviewerTimeoutEnv(dir, env),
        SHIP_DRY_RUN: '1',
        SHIP_COMMIT_TIMEOUT: '15',
        LC_ALL: 'C',
        LANG: 'C',
      },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/DURING: .*Reviewer gate/);
    expect(r.stderr).toMatch(/unfinished.*commit-guard/);
  });

  it('the worktree commit forces ship mode even when the caller exports review mode', () => {
    const { dir, env, git } = seedShipRepo({
      hookBody: 'echo "HOOK_ENV ship=$DEVKIT_SHIP strict=$GUARD_AI_STRICT mode=$DEVKIT_RUN_MODE"',
    });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ship-env', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: {
        ...env,
        SHIP_DRY_RUN: '1',
        DEVKIT_RUN_MODE: 'review',
        DEVKIT_REVIEW_GUARDS: 'size',
      },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-ship-env.log'), 'utf8');
    expect(log).toMatch(/HOOK_ENV ship=1 strict=1 mode=ship/);
  });

  it('--body sets the commit/PR body inline (no stdin / temp file)', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'x\n');
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/body', 't', '--body', 'BODY_INLINE_XYZ', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } }, // empty stdin: --body wins
    );
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(git(['show', '-s', '--format=%b', 'feat/body'])).toMatch(/BODY_INLINE_XYZ/);
  });

  // DK-5: the worktree is cut from $BASE (default: this checkout's HEAD; --base: origin's fetched
  // tip), and in-chain gates (fallow) need that SAME commit to scope their own audit correctly —
  // else a --base ship off a stacked branch misreports that branch's pre-existing findings vs main
  // as "new". Assert the exported var matches the commit the worktree was ACTUALLY cut from, not a
  // stale local ref.
  it("exports DEVKIT_SHIP_BASE_SHA = this checkout's HEAD for a default (no --base) ship", () => {
    const { dir, env, git } = seedShipRepo({
      hookBody: 'echo "HOOK_BASE=$DEVKIT_SHIP_BASE_SHA"',
    });
    const headSha = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/base-sha-default', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(
      join(dir, '.devkit/last-ship-gates-feat-base-sha-default.log'),
      'utf8',
    );
    expect(log).toContain(`HOOK_BASE=${headSha}`);
  });

  // sc-1442: the composed message is handed to the pre-commit gates via a temp file BEFORE
  // `git commit` runs (never .git/COMMIT_EDITMSG), and the file is gone once the commit returns.
  it('exports DEVKIT_COMMIT_MSG_FILE with title+body during gates, and removes it after (sc-1442)', () => {
    const { dir, env, git } = seedShipRepo({
      hookBody: 'echo "MSGFILE=$DEVKIT_COMMIT_MSG_FILE"; cat "$DEVKIT_COMMIT_MSG_FILE"',
    });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/msg-ctx', 'TITLE_MARKER_1442', '--body', 'BODY_MARKER_1442', 'note.txt'],
      { cwd: dir, input: '', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-msg-ctx.log'), 'utf8');
    expect(log).toContain('TITLE_MARKER_1442'); // the hook read the COMPOSED message pre-commit
    expect(log).toContain('BODY_MARKER_1442');
    const msgPath = log.match(/MSGFILE=(\S+)/)?.[1] ?? '';
    expect(msgPath).toContain('devkit-ship-msg');
    expect(existsSync(msgPath)).toBe(false); // cleaned up on the success path
  });
});

// Overlay mode keeps the entire gate chain in a git-ignored .devkit/hooks/pre-commit that never
// materializes in a fresh worktree — so ship must (1) link .devkit in AND force
// core.hooksPath=.devkit/hooks so the chain actually runs, (2) fail CLOSED if the config declares
// overlay but the hook is missing, and (3) never report "gates ran" when the chain produced no
// output (honest banner), while staying version-skew-safe for old pre-sentinel hooks.
describe('ship-branch.sh — overlay-mode gate chain', () => {
  it('runs the overlay hook (via forced core.hooksPath) and captures its output', () => {
    const { dir, env, git } = seedShipRepo(); // .husky/_ hook is a bare `exit 0` (no marker)
    // Overlay hook emits the sentinel + a UNIQUE marker. Its presence in the log proves the OVERLAY
    // hook ran — NOT .husky/_/pre-commit (which has no marker); without the core.hooksPath force git
    // would run .husky/_ and the marker would be absent (the bug this guards).
    addOverlay(dir, `echo 'devkit-gates: chain start' >&2\necho 'GATE_MARKER_OVERLAY'\nexit 0`);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ov-run', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-ov-run.log'), 'utf8');
    expect(log).toMatch(/GATE_MARKER_OVERLAY/); // the overlay chain ran in the worktree
    expect(log).toMatch(/devkit-gates: chain start/); // sentinel captured
    expect(r.stderr).toMatch(/pre-commit gates ran/); // honest success banner
  });

  it('a blocking overlay gate aborts the ship', () => {
    const { dir, env, git } = seedShipRepo();
    addOverlay(dir, `echo 'devkit-gates: chain start' >&2\necho 'OVERLAY_BLOCK_XYZ'\nexit 1`);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ov-block', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status).not.toBe(0); // the overlay gate blocked
    expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-ov-block.log'), 'utf8')).toMatch(
      /OVERLAY_BLOCK_XYZ/,
    );
  });

  it('fails CLOSED when the config declares overlay but the hook is absent', () => {
    const { dir, env, git } = seedShipRepo();
    addOverlay(dir, null); // overlay:true in config, but NO .devkit/hooks/pre-commit
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ov-broken', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status).not.toBe(0); // refuses to ship ungated
    expect(r.stderr).toMatch(/gates must not fail open/);
  });

  it('aborts + reclaims the branch when a sentinel-emitting overlay hook produces NO output', () => {
    // NON-dry: the honest-banner reset+abort only reclaims the branch on the real cleanup path.
    // The hook FILE contains the sentinel line (so the file-grep gate arms) but never emits it at
    // runtime (guarded off) → the chain silently no-op'd → ship must abort, not report success.
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    addOverlay(dir, `[ -n "\${DK_NEVER:-}" ] && echo 'devkit-gates: chain start' >&2\nexit 0`);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const stubBin = ghStub('exit 0'); // clears the `command -v gh` preflight; no PR is reached
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ov-noop', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, PATH: `${stubBin}:${process.env.PATH}` },
    });
    expect(r.status).not.toBe(0); // silence is NOT reportable as success
    expect(r.stderr).toMatch(/NO gate output captured/);
    expect(r.stderr).not.toMatch(/pre-commit gates ran/); // the false success banner must not print
    expect(localBranchExists(git, 'feat/ov-noop')).toBe(false); // reset+cleanup reclaimed it (retry unblocked)
    expect(remoteBranchExists(bare, 'feat/ov-noop')).toBe(false); // aborted before push
  });

  it('does NOT abort an old (pre-sentinel) overlay hook that runs its gates — version skew', () => {
    // devkit update ships the new ship.sh but does NOT regenerate the on-disk hook. An old hook runs
    // every gate correctly yet emits no sentinel; holding it to a sentinel it can't emit would falsely
    // abort a fully-gated ship. The file-grep gate exempts hooks whose FILE lacks the sentinel line.
    const { dir, env, git } = seedShipRepo();
    addOverlay(dir, `echo 'OLD_HOOK_MARKER'\nexit 0`); // runs a gate, no sentinel anywhere
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ov-skew', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0); // ships green — enforcement skipped for a sentinel-less hook
    expect(r.stderr).toMatch(/pre-commit gates ran/);
    expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-ov-skew.log'), 'utf8')).toMatch(
      /OLD_HOOK_MARKER/,
    );
  });
});

describe('reship.sh (ship --pr) — overlay-mode gate chain', () => {
  it('runs the base-aware size preflight before creating a reship worktree', () => {
    const { dir, env, git } = seedReshipRepo();
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'eslint/baselines'), { recursive: true });
    writeFileSync(
      join(dir, 'guard.config.json'),
      JSON.stringify({ scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 }),
    );
    writeFileSync(join(dir, 'src/hot.ts'), Array(60).fill('const x = 1;').join('\n'));
    writeFileSync(
      join(dir, 'eslint/baselines/size-lines.json'),
      JSON.stringify({ maxLines: 50, files: { 'src/hot.ts': 60 } }),
    );
    git(['add', 'guard.config.json', 'src/hot.ts', 'eslint/baselines/size-lines.json']);
    git(['commit', '-q', '-m', 'size baseline']);
    git(['push', '-q', 'origin', 'work:pr-open']);
    writeFileSync(join(dir, 'src/hot.ts'), Array(70).fill('const x = 1;').join('\n'));
    writeFileSync(
      join(dir, 'eslint/baselines/size-lines.json'),
      JSON.stringify({ maxLines: 50, files: { 'src/hot.ts': 80 } }),
    );

    const r = spawnSync('/bin/bash', [reshipScript, 'pr-open', 't', 'src/hot.ts'], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('working-tree baseline would allow 80');
    expect(r.stderr).not.toMatch(EPHEMERAL_WT_RE);
  });

  it('forces ship mode when the caller inherits review mode', () => {
    const { dir, env, git } = seedReshipRepo();
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\necho "RESHIP_ENV mode=$DEVKIT_RUN_MODE"\n',
    );
    writeFileSync(join(dir, 'note.txt'), 'delta\n');
    const r = spawnSync('/bin/bash', [reshipScript, 'pr-open', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: {
        ...env,
        SHIP_DRY_RUN: '1',
        DEVKIT_RUN_MODE: 'review',
        DEVKIT_REVIEW_GUARDS: 'size',
      },
    });
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, '.devkit/last-ship-gates-pr-open.log'), 'utf8')).toMatch(
      /RESHIP_ENV mode=ship/,
    );
  });

  it('links + forces the overlay hook so it runs in the detached re-ship worktree', () => {
    const { dir, env, git } = seedReshipRepo();
    addOverlay(dir, `echo 'devkit-gates: chain start' >&2\necho 'RESHIP_OVERLAY_MARKER'\nexit 0`);
    writeFileSync(join(dir, 'note.txt'), 'delta\n'); // a delta vs origin/pr-open so the commit isn't empty
    const r = spawnSync('/bin/bash', [reshipScript, 'pr-open', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, '.devkit/last-ship-gates-pr-open.log'), 'utf8')).toMatch(
      /RESHIP_OVERLAY_MARKER/,
    );
  });

  it('fails CLOSED when the config declares overlay but the hook is absent', () => {
    const { dir, env, git } = seedReshipRepo();
    addOverlay(dir, null);
    writeFileSync(join(dir, 'note.txt'), 'delta\n');
    const r = spawnSync('/bin/bash', [reshipScript, 'pr-open', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/gates must not fail open/);
  });
});

// .claude/{agents,skills} are devkit sync projections and can lag the running package whether they
// are tracked or ignored (sc-1300). A strict ship that trusts those stale bytes can fail closed with
// "checklist artifact missing" until someone mutates the shared checkout by hand. Ship/reship must
// refresh only the throwaway worktree from the running package, while keeping .claude itself real so
// per-run checklist state stays local and the refreshed assets never enter the commit.
describe('ship — refreshes .claude reviewer assets inside the worktree', () => {
  /** Seed deliberately stale, git-ignored devkit-synced .claude artifacts in `dir`. */
  function seedClaudeArtifacts(dir, git) {
    writeFileSync(join(dir, '.gitignore'), '.claude/\n');
    git(['add', '.gitignore'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'ignore .claude'], { stdio: 'ignore' });
    mkdirSync(join(dir, '.claude/agents'), { recursive: true });
    writeFileSync(join(dir, '.claude/agents/api-security-reviewer.md'), '# brief\n');
    mkdirSync(join(dir, '.claude/skills/api-security/scripts'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/api-security/scripts/checklist.mjs'), '// noop\n');
  }

  it('replaces ignored stale assets from the running package and keeps .claude worktree-local', () => {
    const { dir, env, git } = seedShipRepo();
    seedClaudeArtifacts(dir, git);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/claude-link', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    const wt = WT_RE.exec(r.stderr)?.[1];
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(wt, r.stderr).toBeTruthy();
      expect(lstatSync(join(wt, '.claude/agents')).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(wt, '.claude/skills')).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(wt, '.claude')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(wt, '.claude/agents/api-security-reviewer.md'), 'utf8')).toBe(
        readFileSync(packagedApiSecurityAgent, 'utf8'),
      );
      expect(
        readFileSync(join(wt, '.claude/skills/api-security/scripts/checklist.mjs'), 'utf8'),
      ).toBe(readFileSync(packagedApiSecurityChecklist, 'utf8'));
      expect(realpathSync(join(wt, '.claude/agents'))).not.toBe(
        realpathSync(join(dir, '.claude/agents')),
      );
    } finally {
      dropWorktree(git, r.stderr);
    }
  });

  it('replaces tracked stale assets for the gate run without adding them to the commit', () => {
    const { dir, env, git } = seedShipRepo();
    mkdirSync(join(dir, '.claude/agents'), { recursive: true });
    writeFileSync(join(dir, '.claude/agents/api-security-reviewer.md'), '# tracked\n');
    git(['add', '.claude/agents/api-security-reviewer.md'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'track .claude'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/claude-tracked', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    const wt = WT_RE.exec(r.stderr)?.[1];
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(lstatSync(join(wt, '.claude/agents')).isSymbolicLink()).toBe(false);
      expect(existsSync(join(wt, '.claude/agents/agents'))).toBe(false);
      expect(readFileSync(join(wt, '.claude/agents/api-security-reviewer.md'), 'utf8')).toBe(
        readFileSync(packagedApiSecurityAgent, 'utf8'),
      );
      expect(
        execFileSync('git', ['show', 'HEAD:.claude/agents/api-security-reviewer.md'], {
          cwd: wt,
          encoding: 'utf8',
          env: { ...process.env, ...GIT_ENV },
        }),
      ).toBe('# tracked\n');
    } finally {
      dropWorktree(git, r.stderr);
    }
  });

  it('reship.sh refreshes the detached re-ship worktree too', () => {
    const { dir, env, git } = seedReshipRepo();
    seedClaudeArtifacts(dir, git);
    writeFileSync(join(dir, 'note.txt'), 'delta\n'); // a delta vs origin/pr-open so the commit isn't empty
    const r = spawnSync('/bin/bash', [reshipScript, 'pr-open', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    const wt = WT_RE.exec(r.stderr)?.[1];
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(wt, r.stderr).toBeTruthy();
      expect(lstatSync(join(wt, '.claude/agents')).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(wt, '.claude/skills')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(wt, '.claude/agents/api-security-reviewer.md'), 'utf8')).toBe(
        readFileSync(packagedApiSecurityAgent, 'utf8'),
      );
    } finally {
      dropWorktree(git, r.stderr);
    }
  });
});

// The silent-defaults gap: the ship worktree is a clean checkout at $BASE (tracked files only), so an
// untracked config / gitignored index never reaches it and the worktree gates run on DEFAULTS while the
// ship LOOKS fully gated. link-gate-configs.sh symlinks such inputs in (restoring plain-commit parity)
// and prints a loud notice. The hook body runs with cwd = the worktree, so it can assert a config arrived.
describe('ship-branch.sh — untracked/gitignored gate configs are linked into the worktree', () => {
  const cfgHook = '[ -e guard.config.json ] && echo CONFIG_SEEN || echo CONFIG_MISSING\nexit 0';

  it('links an untracked guard.config.json in + nudges to commit it (gate sees it, not defaults)', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: cfgHook });
    writeFileSync(join(dir, 'guard.config.json'), '{"scanRoots":["src"]}\n'); // untracked
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/gate-cfg', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/absent from the committed tree/); // the loud notice printed
    expect(r.stderr).toMatch(/guard\.config\.json .*commit it/); // untracked → hygiene nudge
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-gate-cfg.log'), 'utf8');
    expect(log).toMatch(/CONFIG_SEEN/); // reached the worktree = parity restored
    expect(log).not.toMatch(/CONFIG_MISSING/);
  });

  it('is a silent no-op for a TRACKED config (it already rides the checkout)', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: cfgHook });
    writeFileSync(join(dir, 'guard.config.json'), '{"scanRoots":["src"]}\n');
    git(['add', 'guard.config.json'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'track config'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/cfg-tracked', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/absent from the committed tree/); // nothing to link → no notice
    expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-cfg-tracked.log'), 'utf8')).toMatch(
      /CONFIG_SEEN/,
    );
  });

  // The ratchet freezes live in eslint/baselines. OVERLAY hides the dir via .git/info/exclude while
  // init still freezes into it → untracked → absent from the checkout. It must be linked back, or the
  // fanout gate enforces an EMPTY freeze (it can't fail open: guard.config.json IS linked) and every
  // grandfathered folder reads as new growth.
  const freezeHook =
    '[ -e eslint/baselines/fanout.json ] && echo FREEZE_SEEN || echo FREEZE_MISSING\nexit 0';

  it('links an untracked ratchet freeze in (fanout gate sees the grandfathering, not an empty one)', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: freezeHook });
    mkdirSync(join(dir, 'eslint/baselines'), { recursive: true });
    // untracked exactly as an overlay repo leaves it (excluded via .git/info/exclude, never committed)
    writeFileSync(
      join(dir, 'eslint/baselines/fanout.json'),
      '{"cap":12,"dirs":{"src/icons":65}}\n',
    );
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/freeze', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-freeze.log'), 'utf8');
    expect(log).toMatch(/FREEZE_SEEN/); // reached the worktree = no false fanout failure
    expect(log).not.toMatch(/FREEZE_MISSING/);
  });

  it('is a silent no-op for TRACKED baselines (devkit/frink package mode ride the checkout)', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: freezeHook });
    mkdirSync(join(dir, 'eslint/baselines'), { recursive: true });
    writeFileSync(join(dir, 'eslint/baselines/fanout.json'), '{"cap":12,"dirs":{}}\n');
    git(['add', 'eslint/baselines/fanout.json'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'track freeze'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/freeze-tracked', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/absent from the committed tree/); // nothing to link → no notice
    expect(
      readFileSync(join(dir, '.devkit/last-ship-gates-feat-freeze-tracked.log'), 'utf8'),
    ).toMatch(/FREEZE_SEEN/);
  });

  // The qavis pass-receipt is the untracked, gitignored cache `qavis qa` writes on a pass. The ship-time
  // qavis-advisory gate shells `qavis route --repo $WT` which reads it to clear the block — but it never
  // reached $WT (untracked, not in the pathspec), so a genuine pass blocked the ship. Link it in, and
  // label it a cache (never "commit it" — committing a content-addressed receipt makes it stale at once).
  const receiptHook =
    '[ -e .qavis/receipt.json ] && echo RECEIPT_SEEN || echo RECEIPT_MISSING\nexit 0';

  it('links an untracked qavis receipt in + labels it a cache (ship gate can clear on a real pass)', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: receiptHook });
    // A qavis repo tracks .qavis/recipe.json, so $WT/.qavis pre-exists after checkout; the receipt is the
    // untracked cache alongside it. Seed the ignore so the notice labels it a cache, not a commit-it nudge.
    mkdirSync(join(dir, '.qavis'), { recursive: true });
    writeFileSync(join(dir, '.qavis/recipe.json'), '{"from":"acme/qavis"}\n');
    writeFileSync(join(dir, '.gitignore'), '.qavis/receipt.json\n');
    git(['add', '.qavis/recipe.json', '.gitignore'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'track recipe + ignore receipt'], {
      stdio: 'ignore',
    });
    writeFileSync(join(dir, '.qavis/receipt.json'), '{"sha":"deadbeef"}\n'); // untracked cache
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/qavis-receipt', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/\.qavis\/receipt\.json .*gitignored cache/); // cache, not a nudge
    expect(r.stderr).not.toMatch(/\.qavis\/receipt\.json .*commit it/);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-qavis-receipt.log'), 'utf8');
    expect(log).toMatch(/RECEIPT_SEEN/); // reached the worktree = `qavis route` can read + clear
    expect(log).not.toMatch(/RECEIPT_MISSING/);
  });

  // The candidates array is the whole gate-parity contract, and dropping an entry breaks it SILENTLY
  // (the gate falls to defaults and still reports a pass). Pin the set so a deletion fails loudly.
  it('pins the fixed gate-artifact candidate set (a dropped entry silently weakens every ship)', () => {
    const src = readFileSync(linkGateConfigsScript, 'utf8');
    const block = /GATE_PROJECTION_FIXED_CANDIDATES=\(\n([\s\S]*?)\n\)/.exec(src);
    expect(block, 'candidate registry not found — did the helper get restructured?').toBeTruthy();
    expect(
      (block as RegExpExecArray)[1]
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ).toEqual([
      'guard.config.json',
      '.fallowrc.jsonc',
      '.fallowrc.json',
      'fallow.toml',
      '.fallow.toml',
      '.fallow',
      'fallow-baselines',
      '.decisions',
      'eslint/baselines',
      'eslint.config.devkit.mjs',
      'biome.devkit.jsonc',
      '.qavis/receipt.json',
    ]);
  });

  it('labels a config-resolved, gitignored index path as a cache — not a "commit it" nudge', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, '.gitignore'), '.search-code/\n');
    writeFileSync(join(dir, 'guard.config.json'), '{"indexPath":".search-code/index.db"}\n');
    mkdirSync(join(dir, '.search-code'), { recursive: true });
    writeFileSync(join(dir, '.search-code/index.db'), 'idx');
    git(['add', '.gitignore', 'guard.config.json'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'config + ignore'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/idx', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    // gate-config-paths.mts resolved the config's indexPath; check-ignore labels it a cache, not a nudge.
    expect(r.stderr).toMatch(/\.search-code\/index\.db .*gitignored cache/);
    expect(r.stderr).not.toMatch(/\.search-code\/index\.db .*commit it/);
  });

  it('uses main-worktree gate inputs and classifies a symlinked cache without a fatal pathspec', () => {
    const hookBody = [
      '[ -e guard.config.json ] && echo CONFIG_SEEN || echo CONFIG_MISSING',
      '[ -e .search-code/index.db ] && echo INDEX_SEEN || echo INDEX_MISSING',
      'grep -q main .decisions/source && echo EMPTY_DIR_FELL_BACK',
      'grep -q linked .fallow/source && echo LOCAL_POPULATED_WON',
      'exit 0',
    ].join('\n');
    const { dir, env, git } = seedShipRepo({ hookBody });
    writeFileSync(join(dir, '.gitignore'), '.search-code/\n.decisions/\n.fallow/\n');
    git(['add', '.gitignore'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'ignore gate caches'], { stdio: 'ignore' });

    // These untracked/ignored inputs live only in the main checkout.
    writeFileSync(join(dir, 'guard.config.json'), '{"indexPath":".search-code/index.db"}\n');
    mkdirSync(join(dir, '.search-code'), { recursive: true });
    writeFileSync(join(dir, '.search-code/index.db'), 'index');
    mkdirSync(join(dir, '.decisions'), { recursive: true });
    writeFileSync(join(dir, '.decisions/source'), 'main');
    mkdirSync(join(dir, '.fallow'), { recursive: true });
    writeFileSync(join(dir, '.fallow/source'), 'main');

    const linkedParent = mkdtempSync(join(tmpdir(), 'ship-linked-root-'));
    dirs.push(linkedParent);
    const linked = join(linkedParent, 'checkout');
    git(['worktree', 'add', '-q', '-b', 'linked-task', linked], { stdio: 'ignore' });
    execFileSync('ln', ['-s', join(dir, '.search-code'), join(linked, '.search-code')]);
    mkdirSync(join(linked, '.decisions')); // empty local projection must not hide populated main data
    mkdirSync(join(linked, '.fallow'));
    writeFileSync(join(linked, '.fallow/source'), 'linked'); // populated local override still wins
    writeFileSync(join(linked, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/linked-gate-inputs', 't', 'note.txt'], {
      cwd: linked,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/\.search-code\/index\.db .*gitignored cache/);
    expect(r.stderr).not.toMatch(/fatal: pathspec/);
    const log = readFileSync(
      join(linked, '.devkit/last-ship-gates-feat-linked-gate-inputs.log'),
      'utf8',
    );
    expect(log).toMatch(/CONFIG_SEEN/);
    expect(log).toMatch(/INDEX_SEEN/);
    expect(log).toMatch(/EMPTY_DIR_FELL_BACK/);
    expect(log).toMatch(/LOCAL_POPULATED_WON/);
    expect(log).not.toMatch(/CONFIG_MISSING|INDEX_MISSING/);
  });

  it('does not double-link a config already passed via --link (no ln clobber under set -e)', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: cfgHook });
    writeFileSync(join(dir, 'guard.config.json'), '{"scanRoots":["src"]}\n'); // untracked
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/dbl', 't', '--link', 'guard.config.json', 'note.txt'],
      { cwd: dir, input: 'b\n', encoding: 'utf8', env: { ...env, SHIP_DRY_RUN: '1' } },
    );
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0); // no "File exists" abort
    expect(r.stderr).not.toMatch(/guard\.config\.json .*commit it/); // already present → not re-listed
    expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-dbl.log'), 'utf8')).toMatch(
      /CONFIG_SEEN/,
    );
  });

  it('ships a gate config passed as a PATH as a real blob, not a symlink (helper runs after copy)', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'guard.config.json'), '{"scanRoots":["src"]}\n'); // untracked AND shipped
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ship-cfg', 't', 'guard.config.json'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    // Copied into $WT first → the helper sees it present and skips → a real 100644 blob, not a 120000 symlink.
    expect(git(['ls-tree', 'feat/ship-cfg', 'guard.config.json']).trim()).toMatch(/^100644/);
  });

  // Edge: the real install path has spaces ("…/Personal and learning/devkit") but every test tmpdir is
  // space-free. Exercise link-gate-configs.sh + the emitter with a $ROOT that contains spaces — a single
  // unquoted expansion (ln/mkdir/git -C/node) would break linking. Seeded inline (seedShipRepo can't
  // take a spaced dir).
  it('links a config when $ROOT contains spaces (real-world install path)', () => {
    const base = mkdtempSync(join(tmpdir(), 'ship gap-')); // NB: the space in the prefix → a spaced $ROOT
    dirs.push(base);
    const dir = join(base, 'a b'); // a second space, in a nested segment
    mkdirSync(join(dir, '.husky/_'), { recursive: true });
    const env = { ...process.env, ...GIT_ENV };
    const git = (a, o = {}) =>
      execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o });
    writeFileSync(join(dir, '.husky/.keep'), '');
    for (const a of [
      ['init', '-q', '-b', 'work'],
      ['config', 'user.email', 'a@b.c'],
      ['config', 'user.name', 'a'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.husky/.keep'],
      ['commit', '-q', '-m', 'base'],
      ['config', 'core.hooksPath', '.husky/_'],
      ['remote', 'add', 'origin', 'git@github.com:acme/app.git'],
    ])
      git(a, { stdio: 'ignore' });
    writeFileSync(
      join(dir, '.husky/_/pre-commit'),
      '#!/bin/sh\n[ -e guard.config.json ] && echo CONFIG_SEEN\nexit 0\n',
    );
    chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
    writeFileSync(join(dir, 'guard.config.json'), '{"scanRoots":["src"]}\n'); // untracked
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/spaced', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/guard\.config\.json .*commit it/); // linked + noticed despite the spaces
    expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-spaced.log'), 'utf8')).toMatch(
      /CONFIG_SEEN/,
    );
  });

  // Edge/error path: an unparseable guard.config.json makes resolveGuardConfig throw → the emitter exits
  // non-zero → the shell must WARN and fall back to the fixed artifact list (still linking the bad config
  // in, so the worktree gate fails loud on it) rather than crashing the ship.
  it('warns and falls back to fixed artifacts when guard.config.json is unparseable', () => {
    const { dir, env, git } = seedShipRepo({
      hookBody: '[ -e guard.config.json ] && echo CONFIG_SEEN\nexit 0',
    });
    writeFileSync(join(dir, 'guard.config.json'), '{ this is not: valid json'); // untracked + unparseable
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/badcfg', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0); // the linker degrades gracefully; the real gate fails loud, not this
    expect(r.stderr).toMatch(/could not resolve config gate paths/); // the resolver-failure warning
    // Fixed-artifact fallback still links guard.config.json itself → the worktree gate sees the bad config.
    expect(readFileSync(join(dir, '.devkit/last-ship-gates-feat-badcfg.log'), 'utf8')).toMatch(
      /CONFIG_SEEN/,
    );
  });

  // Boundary: every other test links exactly one config. With N present, the notice must report the plural
  // count and list each linked path.
  it('links multiple untracked configs and lists each in the notice (plural count)', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'guard.config.json'), '{"scanRoots":["src"]}\n'); // untracked fixed artifact
    writeFileSync(join(dir, '.fallowrc.jsonc'), '{}\n'); // a second untracked fixed artifact
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/multi', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/2 gate config\(s\) present/); // plural count
    expect(r.stderr).toMatch(/guard\.config\.json .*commit it/);
    expect(r.stderr).toMatch(/\.fallowrc\.jsonc .*commit it/); // both listed
  });
});

// The index-clobber incident: git EXPORTS an absolute GIT_INDEX_FILE into a hook it runs in a LINKED
// worktree — which is exactly how ship commits — so everything the gate chain spawns inherits a
// writable handle on the ship worktree's index. A tool that ran git against ANOTHER repository wrote
// that repo's index over the staged diff; the pending commit silently became a whole-repo deletion,
// and only a reviewer's judgement stopped it from being pushed. assert-staged-set.sh is the invariant
// that turns that into an abort. The hooks below clobber the index the way the real leak did.
describe('ship-branch.sh — staged-set invariants (index clobber)', () => {
  // A foreign index whose objects the ship repo does NOT have makes `git commit` itself fail at
  // "Error building trees" — loud, and nothing is pushed. The dangerous variant is the one git can
  // still build: an index that no longer holds the briefed work, so the commit is a bulk DELETION of
  // everything the base had. That is the ~5,976-file deletion the incident produced, and it is what
  // these hooks reproduce. `read-tree --empty` is the leak's effect on the index, minus the objects
  // git would refuse to write.
  const emptyIndexHook = 'git read-tree --empty\nexit 0';

  it('allows a formatter to normalize a briefed path back to its base content', () => {
    const { dir, env, git } = seedShipRepo({
      hookBody: "printf 'base\\n' > format-me.txt\ngit add -- format-me.txt\nexit 0",
    });
    writeFileSync(join(dir, 'format-me.txt'), 'base\n');
    git(['add', 'format-me.txt'], { stdio: 'ignore' });
    git(['commit', '-qm', 'formatted base'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'format-me.txt'), 'needs formatting\n');
    writeFileSync(join(dir, 'note.txt'), 'real change\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/format-noop', 't', 'format-me.txt', 'note.txt'],
      {
        cwd: dir,
        input: 'b\n',
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      },
    );

    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/format-me\.txt.*normalized to its base content/);
    expect(r.stderr).toMatch(/DRY: committed locally/);
  });

  it('aborts before the push when the gate chain empties the staged index', () => {
    const { dir, env, git } = seedShipRepo({ hookBody: emptyIndexHook });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/clobber', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/ABORTED/);
    expect(r.stderr).toMatch(/missing work that was staged/);
    expect(r.stderr).toMatch(/note\.txt/); // names the path that vanished
    expect(r.stderr).not.toMatch(/DRY: committed locally/); // never reported as a success
    // The clobbered worktree is the only evidence of what happened — it must survive the abort.
    expect(r.stderr).toMatch(/Worktree KEPT for diagnosis/);
    const kept = /Worktree KEPT for diagnosis: (.+?) \(branch/.exec(r.stderr)?.[1];
    expect(kept && existsSync(kept)).toBe(true);
    git(['worktree', 'remove', '--force', kept], { stdio: 'ignore' });
    git(['branch', '-D', 'feat/clobber'], { stdio: 'ignore' });
  });

  it('aborts on a bulk deletion of paths the ship was never asked to touch', () => {
    // Briefed work survives (invariant 1 passes), but the commit now deletes five files nobody
    // briefed. A ratchet gate heal-deleting its own baseline is one file; this is the other shape.
    const { dir, env, git } = seedShipRepo();
    const extras = Array.from({ length: 5 }, (_, i) => `extra-${i}.txt`);
    for (const f of extras) writeFileSync(join(dir, f), 'x\n');
    git(['add', ...extras], { stdio: 'ignore' });
    git(['commit', '-qm', 'extras'], { stdio: 'ignore' });
    // Only NOW arm the clobber — seeding the extras must not fire it (the seed commits run the hook).
    const hook = join(dir, '.husky/_/pre-commit');
    writeFileSync(hook, '#!/bin/sh\ngit rm -q --cached -- extra-*.txt\nexit 0\n');
    chmodSync(hook, 0o755);
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/bulkdel', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/deletes 5 path\(s\) it was never asked to touch/);
    expect(r.stderr).not.toMatch(/DRY: committed locally/);
    const kept = /Worktree KEPT for diagnosis: (.+?) \(branch/.exec(r.stderr)?.[1];
    git(['worktree', 'remove', '--force', kept], { stdio: 'ignore' });
    git(['branch', '-D', 'feat/bulkdel'], { stdio: 'ignore' });
  });

  it('an honest ship passes the preflight — the invariant must never flap', () => {
    // The regression this guards is a FALSE abort. The preflight compares the index against the tree
    // staging produced, and prepare-gate-worktree/link-gate-configs run in that window: if either
    // ever starts staging something, every ship in every repo breaks here first.
    const { dir, env, git } = seedShipRepo({ hookBody: 'echo GATE_RAN >&2\nexit 0' });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    writeFileSync(join(dir, 'guard.config.json'), '{"scanRoots":["src"]}\n'); // linked, untracked

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/preflight', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(GATE_RAN_RE); // the chain ran — the preflight let it through
    expect(r.stderr).not.toMatch(/ABORTED/);
  });

  it('a legitimate deletion-only ship still passes both invariants', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'doomed.txt'), 'bye\n');
    git(['add', 'doomed.txt'], { stdio: 'ignore' });
    git(['commit', '-qm', 'add doomed'], { stdio: 'ignore' });
    rmSync(join(dir, 'doomed.txt'));

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/del', 't', 'doomed.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/ABORTED/);
    expect(git(['diff', '--name-only', 'HEAD', 'feat/del']).trim()).toBe('doomed.txt');
  });

  it('a gate that stages an EXTRA file (a lowered ratchet baseline) is not an abort', () => {
    // gate-engine/ratchets/git-index.mts stages a baseline it auto-lowered so the change rides the
    // same commit. The invariant must tolerate additions — it only forbids briefed work vanishing.
    const { dir, env, git } = seedShipRepo({
      hookBody: 'printf "lowered\\n" > .baseline.json\ngit add .baseline.json\nexit 0',
    });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ratchet', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/ABORTED/);
    expect(git(['diff', '--name-only', 'HEAD', 'feat/ratchet']).trim().split('\n').sort()).toEqual([
      '.baseline.json',
      'note.txt',
    ]);
  });
});

// Regression (sc-1199 fallout): devkit's own `dist/` is gitignored with its contents force-tracked.
// A NEW file there fell through BOTH staging passes — the tracked-diff skips it (absent from BASE)
// and `ls-files -o --exclude-standard` omits it (ignored) — so ship pushed a PR silently missing it.
// That published a devkit whose gate supervisor could not resolve its own import at runtime.
describe('ship-branch.sh — a NEW file under a gitignored tree', () => {
  it('stages and commits a briefed untracked-but-ignored path', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, '.gitignore'), 'dist/\n');
    git(['add', '.gitignore'], { stdio: 'ignore' });
    git(['commit', '-qm', 'ignore dist'], { stdio: 'ignore' });
    // Brand new, untracked, and ignored — the exact shape that vanished.
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist/new-out.mjs'), 'export const x = 1;\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/distnew', 't', 'dist/new-out.mjs'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);

    expect(r.status, r.stderr).toBe(0);
    // The file must be IN the commit, not merely copied into the worktree.
    expect(git(['show', 'feat/distnew:dist/new-out.mjs'])).toBe('export const x = 1;\n');
    expect(git(['diff', '--name-only', 'HEAD', 'feat/distnew']).trim()).toBe('dist/new-out.mjs');
  });

  it('still ships an ordinary untracked path unchanged', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/plain', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(git(['diff', '--name-only', 'HEAD', 'feat/plain']).trim()).toBe('note.txt');
  });
});
