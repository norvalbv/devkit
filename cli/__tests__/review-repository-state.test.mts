import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureReviewRepositoryState,
  verifyReviewRepositoryState,
} from '../lib/ship/review/repository/state.mts';
import { rootRegistry } from './_helpers.mts';

const REPOSITORY_STATE_CLI = fileURLToPath(
  new URL('../lib/ship/review/repository/state.mts', import.meta.url),
);
const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

interface RepositoryFixture {
  env: NodeJS.ProcessEnv;
  parent: string;
  root: string;
  manifest: string;
  git: (...args: string[]) => string;
}

function fixture(name = 'devkit-review-repository-state-'): RepositoryFixture {
  const parent = mkTmp(name);
  const root = join(parent, 'target');
  const home = join(parent, 'home');
  mkdirSync(root);
  mkdirSync(home);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Repository State Test');
  git('config', 'user.email', 'repository-state@test.invalid');
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  git('add', 'tracked.txt');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('config', 'branch.main.remote', 'origin');
  git('config', 'branch.main.merge', 'refs/heads/main');
  git('config', 'remote.origin.url', 'https://example.invalid/owner/repository.git');
  return { env, parent, root, manifest: join(parent, 'repository-state.json'), git };
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [REPOSITORY_STATE_CLI, ...args], {
    env,
    encoding: 'utf8',
  });
}

describe('review repository state', () => {
  it('captures and verifies both symbolic and detached HEAD state', () => {
    const { parent, root, manifest, git } = fixture('devkit review repository branch-');

    const attached = captureReviewRepositoryState(root, manifest);

    expect(attached.targetRoot).toBe(realpathSync(root));
    expect(attached.gitRoot).toBe(realpathSync(root));
    expect(attached.gitCommonDir).toBe(realpathSync(join(root, '.git')));
    expect(attached.gitDir).toBe(attached.gitCommonDir);
    expect(attached.state.headOid).toBe(git('rev-parse', 'HEAD'));
    expect(Buffer.from(attached.state.headSymrefBase64 as string, 'base64').toString()).toBe(
      'refs/heads/main',
    );
    expect(verifyReviewRepositoryState(root, manifest)).toEqual(attached);

    git('-c', 'core.hooksPath=/dev/null', 'switch', '--detach', '-q');
    const detachedManifest = join(parent, 'detached-state.json');
    const detached = captureReviewRepositoryState(root, detachedManifest);

    expect(detached.state.headOid).toBe(attached.state.headOid);
    expect(detached.state.headSymrefBase64).toBeNull();
    expect(verifyReviewRepositoryState(root, detachedManifest)).toEqual(detached);
  });

  it('fails when a local branch, remote-tracking ref, or remote symref changes', () => {
    const local = fixture('devkit review repository local-ref-');
    captureReviewRepositoryState(local.root, local.manifest);
    local.git('update-ref', 'refs/heads/new-local-branch', 'HEAD');
    expect(() => verifyReviewRepositoryState(local.root, local.manifest)).toThrow(
      /repository metadata changed after capture/,
    );

    const remote = fixture('devkit review repository remote-ref-');
    remote.git('update-ref', 'refs/remotes/origin/other', 'HEAD');
    captureReviewRepositoryState(remote.root, remote.manifest);
    remote.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/other');
    expect(() => verifyReviewRepositoryState(remote.root, remote.manifest)).toThrow(
      /repository metadata changed after capture/,
    );

    const tracking = fixture('devkit review repository tracking-ref-');
    captureReviewRepositoryState(tracking.root, tracking.manifest);
    tracking.git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(() => verifyReviewRepositoryState(tracking.root, tracking.manifest)).toThrow(
      /repository metadata changed after capture/,
    );
  });

  it('freezes tag and non-branch ref namespaces', () => {
    const createdTag = fixture('devkit review repository created-tag-');
    captureReviewRepositoryState(createdTag.root, createdTag.manifest);
    createdTag.git('tag', 'created-after-capture');
    expect(() => verifyReviewRepositoryState(createdTag.root, createdTag.manifest)).toThrow(
      /repository metadata changed after capture/,
    );

    const movedTag = fixture('devkit review repository moved-tag-');
    movedTag.git('tag', 'release', 'HEAD');
    const replacement = movedTag.git(
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      'HEAD',
      '-m',
      'replacement',
    );
    captureReviewRepositoryState(movedTag.root, movedTag.manifest);
    movedTag.git('update-ref', 'refs/tags/release', replacement);
    expect(() => verifyReviewRepositoryState(movedTag.root, movedTag.manifest)).toThrow(
      /repository metadata changed after capture/,
    );

    const deletedTag = fixture('devkit review repository deleted-tag-');
    deletedTag.git('tag', 'removed-after-capture');
    captureReviewRepositoryState(deletedTag.root, deletedTag.manifest);
    deletedTag.git('tag', '--delete', 'removed-after-capture');
    expect(() => verifyReviewRepositoryState(deletedTag.root, deletedTag.manifest)).toThrow(
      /repository metadata changed after capture/,
    );

    const notes = fixture('devkit review repository notes-ref-');
    captureReviewRepositoryState(notes.root, notes.manifest);
    notes.git('notes', '--ref=review', 'add', '-m', 'review note', 'HEAD');
    expect(() => verifyReviewRepositoryState(notes.root, notes.manifest)).toThrow(
      /repository metadata changed after capture/,
    );
  });

  it('freezes remote URLs and branch/remote configuration', () => {
    const remote = fixture('devkit review repository remote-config-');
    captureReviewRepositoryState(remote.root, remote.manifest);
    remote.git('remote', 'set-url', 'origin', 'https://changed.invalid/repository.git');
    expect(() => verifyReviewRepositoryState(remote.root, remote.manifest)).toThrow(
      /repository metadata changed after capture/,
    );

    const branch = fixture('devkit review repository branch-config-');
    captureReviewRepositoryState(branch.root, branch.manifest);
    branch.git('config', 'branch.main.pushRemote', 'review-push');
    expect(() => verifyReviewRepositoryState(branch.root, branch.manifest)).toThrow(
      /repository metadata changed after capture/,
    );
  });

  it.each([
    ['user identity', 'user.email', 'changed@test.invalid'],
    ['core behavior', 'core.abbrev', '12'],
    ['repository extensions', 'extensions.worktreeConfig', 'true'],
  ])('freezes complete shared local config when %s changes', (_label, key, value) => {
    const target = fixture(`devkit review repository local-${key.replace('.', '-')}-`);
    captureReviewRepositoryState(target.root, target.manifest);

    target.git('config', key, value);

    expect(() => verifyReviewRepositoryState(target.root, target.manifest)).toThrow(
      /repository metadata changed after capture/,
    );
  });

  it('freezes exact shared config bytes and active local include contents', () => {
    const bytes = fixture('devkit review repository config-bytes-');
    captureReviewRepositoryState(bytes.root, bytes.manifest);
    appendFileSync(join(bytes.root, '.git', 'config'), '# byte-only mutation\n');
    expect(() => verifyReviewRepositoryState(bytes.root, bytes.manifest)).toThrow(
      /repository metadata changed after capture/,
    );

    const included = fixture('devkit review repository config-include-');
    const includePath = join(included.parent, 'review-include.config');
    writeFileSync(includePath, '[review]\n\tmarker = before\n');
    included.git('config', 'include.path', includePath);
    captureReviewRepositoryState(included.root, included.manifest);
    writeFileSync(includePath, '[review]\n\tmarker = after\n');
    expect(() => verifyReviewRepositoryState(included.root, included.manifest)).toThrow(
      /repository metadata changed after capture/,
    );
  });

  it('freezes the selected linked worktree config without coupling sibling worktrees', () => {
    const target = fixture('devkit review repository worktree-config-');
    const linked = join(target.parent, 'linked-config-target');
    target.git('config', 'extensions.worktreeConfig', 'true');
    target.git(
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '-q',
      '--detach',
      linked,
      'HEAD',
    );
    execFileSync('git', ['config', '--worktree', 'user.email', 'linked@test.invalid'], {
      cwd: linked,
      env: target.env,
    });
    const linkedManifest = join(target.parent, 'linked-config-state.json');
    const captured = captureReviewRepositoryState(linked, linkedManifest);
    const linkedGitDirectory = realpathSync(
      execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
        cwd: linked,
        env: target.env,
        encoding: 'utf8',
      }).trim(),
    );

    expect(captured.gitCommonDir).toBe(realpathSync(join(target.root, '.git')));
    expect(captured.gitDir).toBe(linkedGitDirectory);

    target.git('config', '--worktree', 'core.abbrev', '9');
    expect(verifyReviewRepositoryState(linked, linkedManifest)).toEqual(captured);

    execFileSync('git', ['config', '--worktree', 'user.email', 'changed@test.invalid'], {
      cwd: linked,
      env: target.env,
    });
    expect(() => verifyReviewRepositoryState(linked, linkedManifest)).toThrow(
      /repository metadata changed after capture/,
    );
  });

  it('ignores global config mutations that are not included by repository config', () => {
    const target = fixture('devkit review repository global-config-');
    const manifest = join(target.parent, 'global-noise-state.json');
    const captured = runCli(['capture', target.root, manifest], target.env);
    expect(captured.status, captured.stderr).toBe(0);

    target.git('config', '--global', 'user.email', 'global-change@test.invalid');

    const verified = runCli(['verify', target.root, manifest], target.env);
    expect(verified.status, verified.stderr).toBe(0);
  });

  it('ignores hostile inherited Git repository selectors in the API and CLI', () => {
    const target = fixture('devkit review repository target-');
    const poison = fixture('devkit review repository poison-');
    poison.git('commit', '--allow-empty', '-q', '-m', 'poison');
    const hostileEnv = {
      ...process.env,
      GIT_DIR: join(poison.root, '.git'),
      GIT_WORK_TREE: poison.root,
      GIT_INDEX_FILE: join(poison.root, '.git', 'index'),
      GIT_CONFIG: join(poison.root, '.git', 'config'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'remote.injected.url',
      GIT_CONFIG_VALUE_0: 'https://poison.invalid/repository.git',
      GIT_TRACE: join(poison.parent, 'must-not-be-written.trace'),
    };
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(hostileEnv)) {
      if (!key.startsWith('GIT_')) continue;
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const captured = captureReviewRepositoryState(target.root, target.manifest);
      expect(captured.state.headOid).toBe(target.git('rev-parse', 'HEAD'));
      expect(verifyReviewRepositoryState(target.root, target.manifest)).toEqual(captured);
      expect(existsSync(hostileEnv.GIT_TRACE)).toBe(false);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const cliManifest = join(target.parent, 'repository-state-cli.json');
    const captured = runCli(['capture', target.root, cliManifest], hostileEnv);
    expect(captured.status, captured.stderr).toBe(0);
    const verified = runCli(['verify', target.root, cliManifest], hostileEnv);
    expect(verified.status, verified.stderr).toBe(0);
    expect(existsSync(hostileEnv.GIT_TRACE)).toBe(false);
  });

  it('rejects a tampered manifest, a wrong target, and a manifest inside the Git root', () => {
    const first = fixture('devkit review repository manifest-first-');
    const second = fixture('devkit review repository manifest-second-');
    captureReviewRepositoryState(first.root, first.manifest);

    expect(() => verifyReviewRepositoryState(second.root, first.manifest)).toThrow(
      /belongs to a different target checkout/,
    );

    const tampered = JSON.parse(readFileSync(first.manifest, 'utf8')) as {
      state: { refsSha256: string };
    };
    tampered.state.refsSha256 = '0'.repeat(64);
    writeFileSync(first.manifest, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => verifyReviewRepositoryState(first.root, first.manifest)).toThrow(
      /manifest authentication failed/,
    );

    captureReviewRepositoryState(first.root, first.manifest);
    const tamperedAdmin = JSON.parse(readFileSync(first.manifest, 'utf8')) as { gitDir: string };
    tamperedAdmin.gitDir = realpathSync(join(second.root, '.git'));
    writeFileSync(first.manifest, `${JSON.stringify(tamperedAdmin, null, 2)}\n`);
    expect(() => verifyReviewRepositoryState(first.root, first.manifest)).toThrow(
      /manifest authentication failed/,
    );

    expect(() =>
      captureReviewRepositoryState(first.root, join(first.root, '.devkit-review-state.json')),
    ).toThrow(/manifest must live outside the target Git root/);
  });

  it('never writes a linked-worktree manifest into either Git admin tree', () => {
    const target = fixture('devkit review repository linked-admin-destination-');
    const linked = join(target.parent, 'linked-admin-target');
    target.git(
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '-q',
      '--detach',
      linked,
      'HEAD',
    );
    const adminDirectory = (flag: '--git-common-dir' | '--git-dir') =>
      realpathSync(
        execFileSync('git', ['rev-parse', '--path-format=absolute', flag], {
          cwd: linked,
          env: target.env,
          encoding: 'utf8',
        }).trim(),
      );
    const commonDir = adminDirectory('--git-common-dir');
    const gitDir = adminDirectory('--git-dir');
    const commonEntries = readdirSync(commonDir).sort();
    const worktreeEntries = readdirSync(gitDir).sort();
    const commonManifest = join(commonDir, 'must-not-write-common.json');
    const worktreeManifest = join(gitDir, 'must-not-write-worktree.json');

    expect(gitDir).not.toBe(commonDir);
    expect(() => captureReviewRepositoryState(linked, commonManifest)).toThrow(/Git admin trees/);
    expect(() => captureReviewRepositoryState(linked, worktreeManifest)).toThrow(/Git admin trees/);
    expect(existsSync(commonManifest)).toBe(false);
    expect(existsSync(worktreeManifest)).toBe(false);
    expect(readdirSync(commonDir).sort()).toEqual(commonEntries);
    expect(readdirSync(gitDir).sort()).toEqual(worktreeEntries);
  });

  it('rejects repository metadata that changes between stable capture passes', () => {
    const target = fixture('devkit review repository unstable-');

    expect(() =>
      captureReviewRepositoryState(target.root, target.manifest, {
        afterFirstCapture: () => target.git('update-ref', 'refs/heads/raced', 'HEAD'),
      }),
    ).toThrow(/repository metadata changed during capture/);

    const config = fixture('devkit review repository unstable-config-');
    expect(() =>
      captureReviewRepositoryState(config.root, config.manifest, {
        afterFirstCapture: () => config.git('config', 'core.abbrev', '11'),
      }),
    ).toThrow(/repository metadata changed during capture/);
  });

  it('detects shared and worktree config round trips during capture without writing a manifest', () => {
    const shared = fixture('devkit review repository shared-config-aba-');
    const sharedConfig = join(shared.root, '.git', 'config');
    const sharedBytes = readFileSync(sharedConfig);
    expect(() =>
      captureReviewRepositoryState(shared.root, shared.manifest, {
        afterFirstCapture: () => {
          writeFileSync(sharedConfig, Buffer.concat([sharedBytes, Buffer.from('# raced\n')]));
          writeFileSync(sharedConfig, sharedBytes);
        },
      }),
    ).toThrow(/repository metadata changed during capture/);
    expect(readFileSync(sharedConfig)).toEqual(sharedBytes);
    expect(existsSync(shared.manifest)).toBe(false);

    const selected = fixture('devkit review repository worktree-config-aba-');
    const linked = join(selected.parent, 'linked-config-aba-target');
    selected.git('config', 'extensions.worktreeConfig', 'true');
    selected.git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', linked, 'HEAD');
    execFileSync('git', ['config', '--worktree', 'review.marker', 'before'], {
      cwd: linked,
      env: selected.env,
    });
    const gitDir = realpathSync(
      execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
        cwd: linked,
        env: selected.env,
        encoding: 'utf8',
      }).trim(),
    );
    const worktreeConfig = join(gitDir, 'config.worktree');
    const worktreeBytes = readFileSync(worktreeConfig);
    const manifest = join(selected.parent, 'worktree-config-aba.json');
    expect(() =>
      captureReviewRepositoryState(linked, manifest, {
        afterFirstCapture: () => {
          writeFileSync(worktreeConfig, Buffer.concat([worktreeBytes, Buffer.from('# raced\n')]));
          writeFileSync(worktreeConfig, worktreeBytes);
        },
      }),
    ).toThrow(/repository metadata changed during capture/);
    expect(readFileSync(worktreeConfig)).toEqual(worktreeBytes);
    expect(existsSync(manifest)).toBe(false);
  });

  it('detects a create/delete ref ABA during capture and succeeds once stable', () => {
    const target = fixture('devkit review repository ref-aba-');
    let seamRuns = 0;

    expect(() =>
      captureReviewRepositoryState(target.root, target.manifest, {
        afterFirstCapture: () => {
          seamRuns += 1;
          target.git('update-ref', 'refs/heads/capture-aba', 'HEAD');
          target.git('update-ref', '-d', 'refs/heads/capture-aba');
        },
      }),
    ).toThrow(/repository metadata changed during capture/);
    expect(seamRuns).toBe(1);
    expect(target.git('for-each-ref', '--format=%(refname)', 'refs/heads/capture-aba')).toBe('');
    expect(existsSync(target.manifest)).toBe(false);

    const captured = captureReviewRepositoryState(target.root, target.manifest);
    expect(verifyReviewRepositoryState(target.root, target.manifest)).toEqual(captured);
  });

  it('allows linked-worktree administrative metadata churn', () => {
    const { parent, git } = fixture('devkit review repository linked-');
    const linked = join(parent, 'linked-target');
    git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
    const manifest = join(parent, 'linked-repository-state.json');
    const captured = captureReviewRepositoryState(linked, manifest);

    git('worktree', 'lock', '--reason', 'test metadata churn', linked);
    expect(verifyReviewRepositoryState(linked, manifest)).toEqual(captured);
    git('worktree', 'unlock', linked);
    expect(verifyReviewRepositoryState(linked, manifest)).toEqual(captured);

    const ephemeral = join(parent, 'ephemeral-review-worktree');
    git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '--detach', ephemeral, 'HEAD');
    expect(verifyReviewRepositoryState(linked, manifest)).toEqual(captured);
    git('-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--force', ephemeral);
    expect(verifyReviewRepositoryState(linked, manifest)).toEqual(captured);
  });
});
