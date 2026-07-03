import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const REPO_RE = /REPO=(.*)/;
const BASE_REF_RE = /BASE_REF=(.*)/;
const DETACHED_RE = /detached HEAD/;
const DIR_RE = /directory path not allowed/;
const FLAG_RE = /unknown flag/;
const WT_RE = /worktree kept at (.+) \(branch/;
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
function buildAndRun(branch, origin, { detached = false, mkdir, pathArg = 'dummy-path' } = {}) {
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

  return spawnSync('/bin/bash', [scriptPath, 'feat/__resolve_test__', 'title', pathArg], {
    cwd: dir,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, SHIP_DRY_RUN: '1', SHIP_RESOLVE_ONLY: '1' },
  });
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
function seedShipRepoLocalRemote() {
  const ghRoot = mkdtempSync(join(tmpdir(), 'shipgh-'));
  dirs.push(ghRoot);
  const bare = join(ghRoot, 'github.com', 'acme', 'app.git');
  mkdirSync(join(ghRoot, 'github.com', 'acme'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GIT_ENV } });
  return { ...seedShipRepo({ origin: bare }), bare };
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
  // self-heals it by resolving merge state via `gh pr view --head <branch>` once a PR exists + merges.
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

  // A 0-exit `gh pr create` that prints no parseable URL (e.g. it writes the URL to stderr) must NOT be
  // mistaken for the create-failure path: the ship still succeeds and cleans up, recording pr:null —
  // which reconcile self-heals via its `gh pr view --head <branch>` lookup. Guards the exit-code vs
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
    'a timeout DURING the reviewer gate names the stage and the reviewers with no heartbeat',
    () => {
      const hookBody = [
        'echo "🔍 Reviewer gate (headless domain judges)..."',
        'echo "guard-review: running api-security-reviewer, commit-guard (parallel, sonnet → opus on FAIL)…"',
        'echo "guard-review: api-security-reviewer — PASS in 3s (checkpointed)"',
        // a mid-retry line uses a COLON, not " — ": it must NOT count as a completion
        'echo "guard-review: commit-guard: judge run failed, retrying once…"',
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
      expect(r.stderr).toMatch(/unfinished.*commit-guard/); // the one with no completion heartbeat
      expect(r.stderr).not.toMatch(/unfinished.*api-security-reviewer/); // checkpointed → not named
    },
  );

  it.runIf(hasTimeoutBin)(
    'attribution survives LC_ALL=C (emoji banner grep + em-dash awk under the C locale)',
    () => {
      // Hooks often run with a minimal C locale (GUI git clients, CI): the banner grep carries
      // emoji alternations and the awk completion pattern carries an em-dash — both multibyte.
      const hookBody = [
        'echo "🔍 Reviewer gate (headless domain judges)..."',
        'echo "guard-review: running api-security-reviewer, commit-guard (parallel, sonnet → opus on FAIL)…"',
        'echo "guard-review: api-security-reviewer — PASS in 3s (checkpointed)"',
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

  it('the worktree commit runs with ship-mode gate env (DEVKIT_SHIP + GUARD_AI_STRICT)', () => {
    const { dir, env, git } = seedShipRepo({
      hookBody: 'echo "HOOK_ENV ship=$DEVKIT_SHIP strict=$GUARD_AI_STRICT"',
    });
    writeFileSync(join(dir, 'note.txt'), 'hi\n');
    const r = spawnSync('/bin/bash', [scriptPath, 'feat/ship-env', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-ship-env.log'), 'utf8');
    expect(log).toMatch(/HOOK_ENV ship=1 strict=1/);
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
});
