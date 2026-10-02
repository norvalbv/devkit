/** sc-3883 — ship refuses a missing hook dir BEFORE it creates a branch or worktree, and names a
 *  self-checkout conflict in the same refusal. */
import {
  chmodSync,
  existsSync,
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
import { describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  addOverlay,
  dirs,
  EPHEMERAL_WT_RE,
  ghStub,
  GIT_ENV,
  localBranchExists,
  remoteBranchExists,
  reshipScript,
  scriptPath,
  seedReshipRepo,
  seedShipRepo,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const helperPath = fileURLToPath(new URL('../lib/ship/prepare-gate-worktree.sh', import.meta.url));
const MISSING_RUNNER_RE = /missing \.husky\/_ in /;
const INIT_HINT_RE = /not been initialised with devkit — run `devkit init`/;
const SELF_RE = /story is checked out in THIS worktree/;
const FREED_RE = /git branch -m 'story' "devkit-freed-/;

/** Invoke the real helper under the same `set -euo pipefail` every caller sources it under. The
 *  trailing echo proves a refusal RETURNS non-zero rather than aborting the caller's shell. */
function preflight(root: string, base: string) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      `set -euo pipefail; . "${helperPath}"; if gate_hook_source_preflight "${root}" "${base}" shipping; then echo PASS; else echo REFUSED; fi`,
    ],
    { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
  );
}

/** A `git` on PATH that records any `worktree add`: a later worktree count cannot tell "never
 *  created" from "created, then cleaned up". */
function worktreeAddSpy(env: NodeJS.ProcessEnv) {
  const bin = mkdtempSync(join(tmpdir(), 'hookpre-gitbin-'));
  dirs.push(bin);
  const marker = join(bin, 'worktree-add-called');
  const real = execFileSync('command', ['-v', 'git'], { shell: true, encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\ncase " $* " in *' worktree add '*) : > '${marker}' ;; esac\nexec ${real} "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  return { marker, env: { ...env, PATH: `${bin}:${env.PATH ?? process.env.PATH ?? ''}` } };
}

const worktreeCount = (git: (a: string[]) => string) =>
  git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;

describe('gate_hook_source_preflight — read-only, before any worktree exists', () => {
  it('refuses when no checkout has the husky runner, and names `devkit init` for an uninitialised repo', () => {
    const { dir } = seedShipRepo();
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });

    const r = preflight(dir, 'HEAD');

    expect(r.stdout.trim()).toBe('REFUSED');
    expect(r.stderr).toMatch(MISSING_RUNNER_RE);
    expect(r.stderr).toMatch(INIT_HINT_RE);
  });

  it('keeps the dependency-setup remedy alone when the repo IS initialised', () => {
    const { dir } = seedShipRepo();
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });
    mkdirSync(join(dir, '.devkit'), { recursive: true });
    writeFileSync(join(dir, '.devkit/config.json'), '{}\n');

    const r = preflight(dir, 'HEAD');

    expect(r.stdout.trim()).toBe('REFUSED');
    expect(r.stderr).toMatch(/run dependency setup before shipping/);
    expect(r.stderr).not.toMatch(INIT_HINT_RE);
  });

  it('does not take a leftover .devkit/ directory (ship-intent files) as proof of initialisation', () => {
    const { dir } = seedShipRepo();
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });
    mkdirSync(join(dir, '.devkit'), { recursive: true });
    writeFileSync(join(dir, '.devkit/ship-intent-x.json'), '{}\n');

    expect(preflight(dir, 'HEAD').stderr).toMatch(INIT_HINT_RE);
  });

  it('passes a linked worktree that lacks the runner when the MAIN checkout has it', () => {
    const { git } = seedShipRepo();
    const linked = join(realpathSync(mkdtempSync(join(tmpdir(), 'hookpre-'))), 'wt');
    dirs.push(linked);
    git(['worktree', 'add', '-q', '-b', 'task', linked], { stdio: 'ignore' });

    const r = preflight(linked, 'HEAD');

    expect(r.stdout.trim(), r.stderr).toBe('PASS');
  });

  it('passes a standalone hook dir committed at BASE even when the caller deleted it locally', () => {
    const { dir, git } = seedShipRepo();
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });
    writeFileSync(join(dir, '.husky/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(['add', '.husky/pre-commit'], { stdio: 'ignore' });
    git(['commit', '-qm', 'standalone hook'], { stdio: 'ignore' });
    git(['config', 'core.hooksPath', '.husky'], { stdio: 'ignore' });
    rmSync(join(dir, '.husky'), { recursive: true, force: true });

    expect(preflight(dir, 'HEAD').stdout.trim()).toBe('PASS');
    // Without a base to consult the same repo is refused: BASE is what the worktree will check out.
    expect(preflight(dir, '').stdout.trim()).toBe('REFUSED');
  });

  it('does not judge an absolute hooksPath (a global hooks dir is never projected)', () => {
    const { dir, git } = seedShipRepo();
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });
    git(['config', 'core.hooksPath', join(dir, 'nowhere')], { stdio: 'ignore' });

    expect(preflight(dir, 'HEAD').stdout.trim()).toBe('PASS');
  });

  it("judges the hooksPath a NEW worktree inherits, not the caller's per-worktree override", () => {
    const { dir, git } = seedShipRepo();
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });
    const linked = join(realpathSync(mkdtempSync(join(tmpdir(), 'hookpre-'))), 'wt');
    dirs.push(linked);
    git(['worktree', 'add', '-q', '-b', 'task', linked], { stdio: 'ignore' });
    git(['config', 'extensions.worktreeConfig', 'true'], { stdio: 'ignore' });
    git(['-C', linked, 'config', '--worktree', 'core.hooksPath', join(linked, 'global-hooks')], {
      stdio: 'ignore',
    });

    const r = preflight(linked, 'HEAD');

    expect(r.stdout.trim()).toBe('REFUSED');
    expect(r.stderr).toMatch(MISSING_RUNNER_RE);
  });

  it('refuses overlay mode without an executable .devkit/hooks/pre-commit', () => {
    const { dir } = seedShipRepo();
    addOverlay(dir, null);

    const r = preflight(dir, 'HEAD');

    expect(r.stdout.trim()).toBe('REFUSED');
    expect(r.stderr).toMatch(/run 'devkit init --overlay'/);
  });

  it('refuses an overlay config that does not parse instead of gating as package mode', () => {
    const { dir } = seedShipRepo();
    addOverlay(dir, 'exit 0');
    writeFileSync(join(dir, '.devkit/config.json'), '{"overlay": true,');

    const r = preflight(dir, 'HEAD');

    expect(r.stdout.trim()).toBe('REFUSED');
    expect(r.stderr).toMatch(/could not resolve the overlay home/);
  });

  it('finds the overlay home past a bare first worktree entry, and refuses its missing hook', () => {
    const { dir } = seedShipRepo();
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'hookpre-bare-')));
    dirs.push(base);
    const bare = join(base, 'repo.git');
    const bareGit = (...args: string[]) =>
      execFileSync('git', ['-C', bare, ...args], { env: { ...process.env, ...GIT_ENV } });
    execFileSync('git', ['clone', '-q', '--bare', dir, bare], {
      env: { ...process.env, ...GIT_ENV },
    });
    bareGit('worktree', 'add', '-q', '--detach', join(base, 'home'));
    bareGit('worktree', 'add', '-q', '--detach', join(base, 'task'));
    addOverlay(join(base, 'home'), null);
    bareGit('config', 'core.hooksPath', join(base, 'home', '.devkit', 'hooks'));

    const r = preflight(join(base, 'task'), 'HEAD');

    expect(r.stdout.trim()).toBe('REFUSED');
    expect(r.stderr).toMatch(/run 'devkit init --overlay'/);
  });
});

describe('ship-branch.sh — the hook dir is checked before any branch work (sc-3883)', () => {
  it('reports the missing runner AND the self-checkout conflict in one refusal, creating nothing', () => {
    const seeded = seedShipRepoLocalRemote();
    const { dir, env, git } = seeded;
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });
    const wt = join(mkdtempSync(join(tmpdir(), 'hookself-')), 'wt');
    dirs.push(wt);
    git(['worktree', 'add', '-q', '-b', 'story', wt], { stdio: 'ignore' });
    writeFileSync(join(wt, 'note.txt'), 'hello\n');
    const before = worktreeCount(git);

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'story', 't', '--base', 'work', '--body', 'b', '--', 'note.txt'],
      { cwd: wt, encoding: 'utf8', env },
    );

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(MISSING_RUNNER_RE);
    expect(r.stderr).toMatch(INIT_HINT_RE);
    expect(r.stderr).toMatch(SELF_RE);
    expect(r.stderr).toMatch(FREED_RE);
    expect(r.stderr).not.toMatch(EPHEMERAL_WT_RE);
    expect(worktreeCount(git)).toBe(before);
    expect(localBranchExists(git, 'story')).toBe(true);
  });

  it('refuses a free branch before `git worktree add -b` — no branch is created, then deleted', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const before = worktreeCount(git);
    const spy = worktreeAddSpy({
      ...env,
      PATH: `${ghStub('exit 0')}:${env.PATH ?? process.env.PATH ?? ''}`,
    });

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/no-hooks', 't', '--body', 'b', '--', 'note.txt'],
      { cwd: dir, encoding: 'utf8', env: spy.env },
    );

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(MISSING_RUNNER_RE);
    expect(r.stderr).not.toMatch(SELF_RE);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Deleted branch/);
    expect(existsSync(spy.marker)).toBe(false);
    expect(localBranchExists(git, 'feat/no-hooks')).toBe(false);
    expect(remoteBranchExists(bare, 'feat/no-hooks')).toBe(false);
    expect(worktreeCount(git)).toBe(before);
  });

  it('passes BASE through: a hook dir committed at the base is not refused early', () => {
    const { dir, env, git } = seedShipRepo();
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });
    writeFileSync(join(dir, '.husky/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(['add', '.husky/pre-commit'], { stdio: 'ignore' });
    git(['commit', '-qm', 'standalone hook'], { stdio: 'ignore' });
    git(['config', 'core.hooksPath', '.husky'], { stdio: 'ignore' });
    rmSync(join(dir, '.husky'), { recursive: true, force: true });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/std', 't', '--', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(r.stderr).not.toMatch(/missing \.husky/);
    expect(r.status, r.stderr).toBe(0);
  });
});

describe('reship.sh — the same early check (sc-3883)', () => {
  it('refuses before adding its detached worktree', () => {
    const { dir, env, git } = seedReshipRepo();
    rmSync(join(dir, '.husky/_'), { recursive: true, force: true });
    writeFileSync(join(dir, 'note.txt'), 'delta\n');
    const before = worktreeCount(git);
    const spy = worktreeAddSpy({ ...env, SHIP_DRY_RUN: '1' });

    const r = spawnSync('/bin/bash', [reshipScript, 'pr-open', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: spy.env,
    });

    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(MISSING_RUNNER_RE);
    expect(existsSync(spy.marker)).toBe(false);
    expect(worktreeCount(git)).toBe(before);
  });
});

describe('reship.sh — an overlay borrowed by a linked worktree (sc-4157)', () => {
  /** An overlay home plus a linked worktree on the PR branch whose own .devkit holds only ship
   *  records — the state ship leaves in any caller before the overlay is projected into it. */
  function seedLinkedOverlay(hook: string) {
    const { dir, env, git } = seedReshipRepo();
    addOverlay(dir, hook);
    writeFileSync(join(dir, '.git/info/exclude'), '.devkit/\n');
    git(['config', 'core.hooksPath', join(dir, '.devkit/hooks')], { stdio: 'ignore' });
    const linked = join(realpathSync(mkdtempSync(join(tmpdir(), 'reship-overlay-'))), 'wt');
    dirs.push(linked);
    git(['worktree', 'add', '-q', '-b', 'task', linked, 'origin/pr-open'], { stdio: 'ignore' });
    writeFileSync(join(linked, 'note.txt'), 'delta\n');
    const reship = (...args: string[]) =>
      spawnSync('/bin/bash', [reshipScript, ...args], {
        cwd: linked,
        input: 'b\n',
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      });
    return { dir, linked, reship };
  }

  it("runs the home's overlay chain, not the caller's partial .devkit", () => {
    const { linked, reship } = seedLinkedOverlay(
      `echo 'devkit-gates: chain start' >&2\necho 'LINKED_OVERLAY_MARKER'`,
    );

    const r = reship('pr-open', 't', 'note.txt');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/no executable pre-commit hook/);
    expect(readFileSync(join(linked, '.devkit/last-ship-gates-pr-open.log'), 'utf8')).toMatch(
      /LINKED_OVERLAY_MARKER/,
    );
  });

  it('--resume after a blocked attempt resolves the same overlay', () => {
    const { dir, linked, reship } = seedLinkedOverlay(
      `echo 'devkit-gates: chain start' >&2\nexit 1`,
    );
    expect(reship('pr-open', 't', 'note.txt').status).not.toBe(0);
    writeFileSync(
      join(dir, '.devkit/hooks/pre-commit'),
      `#!/bin/sh\necho 'devkit-gates: chain start' >&2\necho 'RESUMED_OVERLAY_MARKER'\n`,
    );

    const r = reship('--resume', 'pr-open');

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(linked, '.devkit/last-ship-gates-pr-open.log'), 'utf8')).toMatch(
      /RESUMED_OVERLAY_MARKER/,
    );
  });
});
