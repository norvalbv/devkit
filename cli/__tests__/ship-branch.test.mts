import { execFileSync, spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Coverage for ship-branch.sh: the pure resolution seam (the fork-upstream bug — gh's default repo
// can resolve to a fork's UPSTREAM remote instead of origin, opening the PR against the wrong repo;
// the fix derives owner/repo from `git remote get-url origin`), the isolation guards, the flag/path arg
// grammar, and the real worktree-commit path (HEAD never moves, the hook fires in the worktree).
// Hermetic — throwaway repos, SHIP_DRY_RUN / SHIP_RESOLVE_ONLY seams, no gh, no network.

vi.setConfig({ testTimeout: 30_000 }); // bash + many git subprocesses; generous under parallel load

const scriptPath = fileURLToPath(new URL('../lib/ship/ship-branch.sh', import.meta.url));
const reshipScript = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const REPO_RE = /REPO=(.*)/;
const BASE_REF_RE = /BASE_REF=(.*)/;
const DETACHED_RE = /detached HEAD/;
const DIR_RE = /directory path not allowed/;
const FLAG_RE = /unknown flag/;
const NOTHING_RE = /nothing to commit: no changes in/;
const GATE_RAN_RE = /GATE_RAN/;
const DELETED_BRANCH_RE = /Deleted branch/;
const EPHEMERAL_WT_RE = /devkit-ship-/;
// Matches the dry-run "worktree kept" line of BOTH scripts: ship-branch prints "… (branch <br>)",
// reship prints "… . Remove with:" — so dropWorktree cleans either (reship worktrees leaked before).
const WT_RE = /worktree kept at (.+?)(?: \(branch|\. Remove)/;
const NOTE_RE = /note\.txt/;
const EXEC_MODE_RE = /^100755/; // git mode for an executable blob
const dirs = [];

// The commit-failure cleanup test runs the REAL non-dry path, which needs `gh` on PATH
// for the preflight (it never calls gh — the commit fails first). Skip where gh is absent.
const hasGh = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v gh'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// R2's gate-hang timeout needs coreutils `timeout`/`gtimeout`; stock macOS has neither (R2 degrades to
// bare there). Gate the hang test on its presence — the bare-degrade path is covered by the other tests.
const hasTimeoutBin = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v timeout || command -v gtimeout'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A throwaway repo on `branch` with `origin` set; returns the script's resolved {repo, baseRef}. */
function buildAndRun(
  branch,
  origin,
  { detached = false, mkdir, pathArg = 'dummy-path', extraArgs = [] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'shipres-'));
  dirs.push(dir);
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
  git(['init', '-q', '-b', branch]);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 'a']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  git(['remote', 'add', 'origin', origin]);
  if (mkdir) mkdirSync(join(dir, mkdir), { recursive: true });
  if (detached) git(['checkout', '-q', '--detach']);

  return spawnSync(
    '/bin/bash',
    [scriptPath, 'feat/__resolve_test__', 'title', ...extraArgs, pathArg],
    {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, SHIP_DRY_RUN: '1', SHIP_RESOLVE_ONLY: '1' },
    },
  );
}

function resolve(branch, origin, opts) {
  const r = buildAndRun(branch, origin, opts);
  expect(r.status, `script must exit 0 (stderr: ${r.stderr})`).toBe(0);
  return {
    repo: REPO_RE.exec(r.stdout)?.[1],
    baseRef: BASE_REF_RE.exec(r.stdout)?.[1],
  };
}

/**
 * A repo with a husky stub (the gitignored _ runner is untracked, mirroring the real repo) so the
 * worktree commit actually fires a hook. `hookBody` is the pre-commit script; `origin` defaults to a
 * GitHub URL but a bare local path drives the non-dry push path with no network.
 */
function seedShipRepo({ hookBody = 'exit 0', origin = 'git@github.com:acme/app.git' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shipwt-'));
  dirs.push(dir);
  const env = { ...process.env, ...GIT_ENV };
  const git = (args, opts = {}) =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', ...opts });
  mkdirSync(join(dir, '.husky'), { recursive: true });
  writeFileSync(join(dir, '.husky/.keep'), '');
  for (const a of [
    ['init', '-q', '-b', 'work'],
    ['config', 'user.email', 'a@b.c'],
    ['config', 'user.name', 'a'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '.husky/.keep'],
    ['commit', '-q', '-m', 'base'],
    ['config', 'core.hooksPath', '.husky/_'],
    ['remote', 'add', 'origin', origin],
  ])
    git(a, { stdio: 'ignore' });
  mkdirSync(join(dir, '.husky/_'), { recursive: true });
  writeFileSync(join(dir, '.husky/_/pre-commit'), `#!/bin/sh\n${hookBody}\n`);
  chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
  return { dir, env, git };
}

/** dry-run keeps the worktree — remove it so afterAll's rm of the repo dir isn't blocked. */
function dropWorktree(git, stderr) {
  const wt = WT_RE.exec(stderr)?.[1];
  if (wt) {
    try {
      git(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * A ship repo whose `origin` is a LOCAL bare repo at an ABSOLUTE `…/github.com/acme/app.git` path: the
 * `…github.com/` prefix makes ship-branch's origin→owner/repo sed resolve REPO to `acme/app` (a plain
 * bare path fails its shape check), while the absolute path stays reachable from BOTH ROOT (ls-remote)
 * and the ephemeral $WT (push) with no network. Drives the real non-dry push + manifest path offline.
 */
function seedShipRepoLocalRemote({ hookBody } = {}) {
  const ghRoot = mkdtempSync(join(tmpdir(), 'shipgh-'));
  dirs.push(ghRoot);
  const bare = join(ghRoot, 'github.com', 'acme', 'app.git');
  mkdirSync(join(ghRoot, 'github.com', 'acme'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GIT_ENV } });
  return { ...seedShipRepo({ origin: bare, ...(hookBody ? { hookBody } : {}) }), bare };
}

/**
 * Turn a seeded ship repo `dir` into an OVERLAY install: a git-ignored `.devkit/config.json`
 * (`overlay:true`) + an executable `.devkit/hooks/pre-commit`. `overlayHook === null` writes NO hook
 * (models a broken/absent overlay hook → ship must fail closed). The overlay hook is git-ignored in a
 * real repo; here it just stays untracked. The seed keeps `.husky/_` (the fail-closed husky guard),
 * but ship forces core.hooksPath=.devkit/hooks so the OVERLAY hook is the one that runs.
 */
function addOverlay(dir, overlayHook) {
  mkdirSync(join(dir, '.devkit/hooks'), { recursive: true });
  writeFileSync(
    join(dir, '.devkit/config.json'),
    `${JSON.stringify({ overlay: true }, null, 2)}\n`,
  );
  if (overlayHook !== null) {
    const pre = join(dir, '.devkit/hooks/pre-commit');
    writeFileSync(pre, `#!/bin/sh\n${overlayHook}\n`);
    chmodSync(pre, 0o755);
  }
}

/** A ship repo whose `origin` is a local bare remote that ALREADY has the PR branch `pr-open` (the
 *  existing-branch precondition `ship --pr` requires). Returns {dir, env, git, bare}. */
function seedReshipRepo() {
  const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
  dirs.push(bare);
  execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GIT_ENV } });
  const seeded = seedShipRepo({ origin: bare });
  seeded.git(['push', '-q', 'origin', 'work:pr-open'], { stdio: 'ignore' }); // the open PR's head branch
  return { ...seeded, bare };
}

/** A `gh` stub on a fresh PATH dir: runs `prBody` for `gh pr …`, exits 0 for anything else (clears the
 * `command -v gh` preflight). Returns the dir to prepend to PATH. */
function ghStub(prBody) {
  const stubBin = mkdtempSync(join(tmpdir(), 'ship-bin-'));
  dirs.push(stubBin);
  writeFileSync(
    join(stubBin, 'gh'),
    `#!/bin/sh\ncase "$1" in\n  pr) ${prBody} ;;\n  *) exit 0 ;;\nesac\n`,
  );
  chmodSync(join(stubBin, 'gh'), 0o755);
  return stubBin;
}

/** True iff branch `br` exists locally in repo dir (via the seedShipRepo `git` helper). */
function localBranchExists(git, br) {
  try {
    return Boolean(git(['rev-parse', '--verify', '--quiet', br], { stdio: 'pipe' }).trim());
  } catch {
    return false; // rev-parse --verify exits non-zero when the ref is absent
  }
}

/** The parsed reconcile manifest written into repo `dir`. */
function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, '.devkit/reconcile-manifest.json'), 'utf8'));
}

/** True iff branch `br` exists on the bare remote at `bare`. */
function remoteBranchExists(bare, br) {
  try {
    return Boolean(
      execFileSync('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', br], {
        env: { ...process.env, ...GIT_ENV },
        encoding: 'utf8',
      }).trim(),
    );
  } catch {
    return false;
  }
}

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
    const prEvent = events.find((e) => e.type === 'ship_pr');
    expect(prEvent).toBeTruthy();
    expect(prEvent.pr_url).toBe('https://github.com/acme/app/pull/42');
    expect(prEvent.pr_number).toBe(42); // a bare JSON number, not a string
    expect(prEvent.ship_id).toBe(attempt.ship_id); // same attempt the gate events correlate under
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

  // R2 (commit-with-gate-capture.sh): a HUNG gate that backgrounds a pipe-holding grandchild must NOT
  // wedge the ship forever. coreutils `timeout`'s default process-group kill reaps the hook AND its child
  // so `tee` unblocks; the ship exits 124 fast. The backgrounded `sleep &` is the whole point — a hook that
  // is merely the sleeper would unblock even under the broken `--foreground` form, so it tests nothing.
  // Gated on a timeout bin (absent on stock macOS, where R2 degrades to bare — the other tests cover that).
  it.runIf(hasTimeoutBin)(
    'bounds a hung gate: the backgrounded pipe-holder is reaped, the ship exits 124 fast (not hung)',
    () => {
      // sleep 30 & → a grandchild inheriting the commit's stdout (the pipe) that outlives a kill-git-only;
      // sleep 30 → the hook itself hangs so the 2s timeout fires while it's still running. Correct
      // group-kill reaps BOTH at ~2s; the broken --foreground form leaves the `&` child holding the pipe.
      const { dir, env, git } = seedShipRepo({ hookBody: 'sleep 30 &\nsleep 30' });
      writeFileSync(join(dir, 'note.txt'), 'hi\n');
      const t0 = Date.now();
      const r = spawnSync('/bin/bash', [scriptPath, 'feat/hung-gate', 't', 'note.txt'], {
        cwd: dir,
        input: 'b\n',
        encoding: 'utf8',
        timeout: 18_000, // belt-and-suspenders: a broken impl would hang ~30s; cap it under the suite timeout
        env: { ...env, SHIP_DRY_RUN: '1', SHIP_COMMIT_TIMEOUT: '2' },
      });
      const elapsed = Date.now() - t0;
      dropWorktree(git, r.stderr);

      expect(r.status, r.stderr).not.toBe(0); // bounded — the timed-out commit aborts the ship
      // The make-or-break: the group-kill closes the pipe so `tee` returns near the 2s timeout. The broken
      // `--foreground` form would leave the `sleep 30 &` holding the pipe → ~30s hang (elapsed ≥ 15s).
      expect(elapsed).toBeLessThan(15_000);
      expect(r.stderr).toMatch(/gate chain hit the 2s ceiling \(exit 12[47]\)/); // the rc==124/137 branch
      expect(r.stderr).toMatch(/Re-run the same devkit ship command to converge/); // resume hint
      expect(r.stderr).toMatch(/export SHIP_COMMIT_TIMEOUT/); // the knob, with the exported-env caveat
    },
  );

  it.runIf(hasTimeoutBin)(
    'a timeout DURING the reviewer gate names the stage and the reviewers with no completion',
    () => {
      // Emulate guard-review under a ship: it records the running set + one checkpointed completion to
      // the progress JSON the ship exported (DEVKIT_REVIEW_PROGRESS), then the gate hangs → 2s timeout.
      // The banner reads THAT file (not stderr prose) to name the unfinished reviewer.
      const hookBody = [
        'echo "🔍 Reviewer gate (headless domain judges)..."',
        `printf '%s' '{"running":["api-security-reviewer","commit-guard"],"completed":["api-security-reviewer"]}' > "$DEVKIT_REVIEW_PROGRESS"`,
        'sleep 30',
      ].join('\n');
      const { dir, env, git } = seedShipRepo({ hookBody });
      writeFileSync(join(dir, 'note.txt'), 'hi\n');
      const r = spawnSync('/bin/bash', [scriptPath, 'feat/review-attrib', 't', 'note.txt'], {
        cwd: dir,
        input: 'b\n',
        encoding: 'utf8',
        timeout: 18_000,
        env: { ...env, SHIP_DRY_RUN: '1', SHIP_COMMIT_TIMEOUT: '2' },
      });
      dropWorktree(git, r.stderr);
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toMatch(/DURING: .*Reviewer gate/); // last stage banner, not the last line
      expect(r.stderr).toMatch(/unfinished.*commit-guard/); // running − completed = the unfinished one
      expect(r.stderr).not.toMatch(/unfinished.*api-security-reviewer/); // checkpointed → not named
    },
  );

  it.runIf(hasTimeoutBin)(
    'attribution survives LC_ALL=C (the emoji stage grep + the JSON read under the C locale)',
    () => {
      // Hooks often run with a minimal C locale (GUI git clients, CI): the stage grep still carries
      // emoji alternations, and the progress read must parse the JSON identically regardless of locale.
      const hookBody = [
        'echo "🔍 Reviewer gate (headless domain judges)..."',
        `printf '%s' '{"running":["api-security-reviewer","commit-guard"],"completed":["api-security-reviewer"]}' > "$DEVKIT_REVIEW_PROGRESS"`,
        'sleep 30',
      ].join('\n');
      const { dir, env, git } = seedShipRepo({ hookBody });
      writeFileSync(join(dir, 'note.txt'), 'hi\n');
      const r = spawnSync('/bin/bash', [scriptPath, 'feat/c-locale', 't', 'note.txt'], {
        cwd: dir,
        input: 'b\n',
        encoding: 'utf8',
        timeout: 18_000,
        env: { ...env, SHIP_DRY_RUN: '1', SHIP_COMMIT_TIMEOUT: '2', LC_ALL: 'C', LANG: 'C' },
      });
      dropWorktree(git, r.stderr);
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toMatch(/DURING: .*Reviewer gate/);
      expect(r.stderr).toMatch(/unfinished.*commit-guard/);
    },
  );

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

// .claude/{agents,skills} are devkit sync artifacts — git-ignored in an overlay consumer, so a fresh
// worktree lacks them and guard-review can't load reviewer briefs / run the judge checklist (every
// reviewer INCONCLUSIVEs → strict ship fails closed). ship must symlink the two SUBDIRS in, leave
// .claude itself a real worktree dir (per-run checklist state stays local, not leaked to the shared
// tree), and NOT clobber a .claude a repo TRACKS (already checked out → a symlink onto it nests
// .../agents/agents).
describe('ship — links .claude/{agents,skills} into the worktree', () => {
  /** Seed git-ignored (untracked) devkit-synced .claude artifacts in `dir`. */
  function seedClaudeArtifacts(dir, git) {
    writeFileSync(join(dir, '.gitignore'), '.claude/\n');
    git(['add', '.gitignore'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'ignore .claude'], { stdio: 'ignore' });
    mkdirSync(join(dir, '.claude/agents'), { recursive: true });
    writeFileSync(join(dir, '.claude/agents/api-security-reviewer.md'), '# brief\n');
    mkdirSync(join(dir, '.claude/skills/api-security/scripts'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/api-security/scripts/checklist.mjs'), '// noop\n');
  }

  it('symlinks the two subdirs (agents + skills), keeps .claude itself a real dir', () => {
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
      expect(lstatSync(join(wt, '.claude/agents')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(wt, '.claude/skills')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(wt, '.claude')).isSymbolicLink()).toBe(false); // real dir → per-run state stays local
      // resolves back into ROOT, so the brief is actually readable from the worktree cwd
      expect(readFileSync(join(wt, '.claude/agents/api-security-reviewer.md'), 'utf8')).toMatch(
        /# brief/,
      );
      expect(realpathSync(join(wt, '.claude/agents'))).toBe(
        realpathSync(join(dir, '.claude/agents')),
      );
    } finally {
      dropWorktree(git, r.stderr);
    }
  });

  it('does NOT clobber a TRACKED .claude already checked out (no nested .claude/agents/agents)', () => {
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
      expect(lstatSync(join(wt, '.claude/agents')).isSymbolicLink()).toBe(false); // real git checkout
      expect(existsSync(join(wt, '.claude/agents/agents'))).toBe(false); // no bogus nested symlink
    } finally {
      dropWorktree(git, r.stderr);
    }
  });

  it('reship.sh links the subdirs into the detached re-ship worktree too', () => {
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
      expect(lstatSync(join(wt, '.claude/agents')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(wt, '.claude/skills')).isSymbolicLink()).toBe(true);
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
    const src = readFileSync(
      fileURLToPath(new URL('../lib/ship/link-gate-configs.sh', import.meta.url)),
      'utf8',
    );
    const line = /^\s*local candidates=\((.*)\)\s*$/m.exec(src);
    expect(line, 'candidates array not found — did the helper get restructured?').toBeTruthy();
    expect((line as RegExpExecArray)[1].split(/\s+/)).toEqual([
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
