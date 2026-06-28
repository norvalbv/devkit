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
// grammar, and the real worktree-commit path (HEAD never moves, the hook fires, markers carried).
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
  // lands on the new branch, and the hook fires in the worktree via the .husky/_ symlink with the
  // carried review marker present.
  it('ships a file into an isolated worktree; HEAD stays put; the hook fires with the carried marker', () => {
    const { dir, env, git } = seedShipRepo({
      // touch the sentinel ONLY if the carried marker is present — proves "hook fired" AND "marker
      // carried". $SENTINEL is an ABSOLUTE path from the ship env: the hook's cwd is the ephemeral
      // worktree, so a relative `touch` would land there, not in the repo dir we assert against.
      hookBody: '[ -f .claude/.commit-guard-passed ] && touch "$SENTINEL"\nexit 0',
    });
    const sentinel = join(dir, 'HOOK_FIRED');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude/.commit-guard-passed'), 'ok\n');
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
    expect(existsSync(sentinel)).toBe(true); // hook fired in the worktree + marker carried
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
