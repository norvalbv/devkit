import { spawn as spawnChild } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { relIntentPath, writeIntent } from '../lib/ship/ship-intent.mts';
import { testSpawnSync as spawnSync } from './_helpers.mts';
import {
  dropWorktree,
  installHook,
  localBranchExists,
  publishEnvFor,
  remoteBranchExists,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

function commit(git, paths: string[], message: string): void {
  git(['--literal-pathspecs', 'add', '--', ...paths], { stdio: 'ignore' });
  git(['commit', '-q', '-m', message], { stdio: 'ignore' });
}

function runFromBranch(dir, env, branch: string, extraArgs: string[] = []) {
  return spawnSync(
    '/bin/bash',
    [
      scriptPath,
      branch,
      'ship committed branch scope',
      '--base',
      'work',
      '--from-branch',
      ...extraArgs,
    ],
    {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    },
  );
}

function spawnFromBranch(dir, env, branch: string, title: string) {
  const child = spawnChild(
    '/bin/bash',
    [scriptPath, branch, title, '--base', 'work', '--from-branch'],
    { cwd: dir, env: { ...env, SHIP_DRY_RUN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stdin.end();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    },
  );
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe('ship-branch.sh — --from-branch committed scope (sc-2352)', () => {
  it('requires an explicit remote base and rejects a mixed explicit path list', () => {
    const { dir, env } = seedShipRepoLocalRemote();
    const noBase = spawnSync('/bin/bash', [scriptPath, 'feat/no-base', 't', '--from-branch'], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    expect(noBase.status).not.toBe(0);
    expect(noBase.stderr).toContain('--from-branch requires --base');

    const mixed = runFromBranch(dir, env, 'feat/mixed', ['--', 'note.txt']);
    expect(mixed.status).not.toBe(0);
    expect(mixed.stderr).toContain('cannot be combined with explicit paths');
  });

  it('bounds a stalled remote-base advertisement before creating the ship branch', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'committed\n');
    commit(git, ['note.txt'], 'committed source snapshot');
    const bin = join(dir, 'timeout-bin');
    mkdirSync(bin);
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    }).stdout.trim();
    const wrapper = join(bin, 'git');
    writeFileSync(
      wrapper,
      [
        '#!/bin/bash',
        'for arg in "$@"; do [ "$arg" != refs/heads/work ] || sleep 30; done',
        'exec "$REAL_GIT" "$@"',
      ].join('\n'),
    );
    chmodSync(wrapper, 0o755);
    const started = Date.now();
    const result = runFromBranch(
      dir,
      {
        ...env,
        DEVKIT_REMOTE_TIMEOUT_SECONDS: '0.1',
        PATH: `${bin}:${env.PATH ?? process.env.PATH ?? ''}`,
        REAL_GIT: realGit,
      },
      'feat/bounded-remote',
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ls-remote exit 124');
    expect(localBranchExists(git, 'feat/bounded-remote')).toBe(false);
  });

  it('derives every committed BASE-to-HEAD path and ignores unrelated working-tree dirt', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'one.txt'), 'one\n');
    writeFileSync(join(dir, 'two.txt'), 'two\n');
    commit(git, ['one.txt', 'two.txt'], 'committed source snapshot');
    writeFileSync(join(dir, 'parallel.txt'), 'another agent owns this\n');
    const headBefore = git(['rev-parse', 'HEAD']).trim();
    const baseOid = git(['rev-parse', 'origin/work']).trim();
    const fetchHead = join(dir, '.git/FETCH_HEAD');
    writeFileSync(fetchHead, 'peer-owned sentinel\n');
    git(['update-ref', '-d', 'refs/remotes/origin/work']);

    const r = runFromBranch(dir, env, 'feat/from-branch');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('--from-branch: 2 committed path(s)');
    expect(r.stderr).toContain('  one.txt');
    expect(r.stderr).toContain('  two.txt');
    expect(readFileSync(fetchHead, 'utf8')).toBe('peer-owned sentinel\n');
    expect(localBranchExists(git, 'refs/remotes/origin/work')).toBe(false);
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/devkit/ship-base/']).trim()).toBe('');
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(
      git(['diff', '--name-only', baseOid, 'feat/from-branch']).trim().split('\n').sort(),
    ).toEqual(['one.txt', 'two.txt']);
    expect(git(['show', 'feat/from-branch:one.txt'])).toBe('one\n');
    expect(git(['show', 'feat/from-branch:two.txt'])).toBe('two\n');
    expect(readFileSync(join(dir, 'parallel.txt'), 'utf8')).toBe('another agent owns this\n');
    dropWorktree(git, r.stderr);
  });

  it('lets only the atomic branch-creation winner record a fresh branch-source attempt', async () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, '.git/info/exclude'), '.devkit/\n');
    writeFileSync(join(dir, 'note.txt'), 'committed\n');
    commit(git, ['note.txt'], 'committed source snapshot');
    const raceDir = join(dir, '.git', 'intent-race');
    const bin = join(dir, 'race-bin');
    const branch = 'feat/concurrent-source-owner';
    mkdirSync(raceDir);
    mkdirSync(bin);
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    }).stdout.trim();
    const gitWrapper = join(bin, 'git');
    writeFileSync(
      gitWrapper,
      [
        '#!/bin/bash',
        'if [ "${1:-}" = worktree ] && [ "${2:-}" = add ] && [ "${5:-}" = "$TEST_RACE_BRANCH" ]; then',
        '  : > "$TEST_RACE_DIR/$TEST_RACE_ROLE.arrived"',
        '  if [ "$TEST_RACE_ROLE" = A ]; then',
        '    n=0; while [ ! -e "$TEST_RACE_DIR/B.arrived" ]; do n=$((n + 1)); [ "$n" -lt 500 ] || exit 98; sleep 0.02; done',
        '    "$REAL_GIT" "$@"',
        '    status=$?',
        '    [ "$status" -ne 0 ] || : > "$TEST_RACE_DIR/winner"',
        '    : > "$TEST_RACE_DIR/A.done"',
        '    exit "$status"',
        '  fi',
        '  n=0; while [ ! -e "$TEST_RACE_DIR/A.done" ]; do n=$((n + 1)); [ "$n" -lt 500 ] || exit 98; sleep 0.02; done',
        '  [ -e "$TEST_RACE_DIR/winner" ] || exit 97',
        'fi',
        'exec "$REAL_GIT" "$@"',
      ].join('\n'),
    );
    chmodSync(gitWrapper, 0o755);
    const raceEnv = {
      ...env,
      PATH: `${bin}:${env.PATH ?? process.env.PATH ?? ''}`,
      REAL_GIT: realGit,
      TEST_RACE_BRANCH: branch,
      TEST_RACE_DIR: raceDir,
    };
    const attemptA = spawnFromBranch(dir, { ...raceEnv, TEST_RACE_ROLE: 'A' }, branch, 'attempt A');
    await waitForFile(join(raceDir, 'A.arrived'));
    const attemptB = spawnFromBranch(dir, { ...raceEnv, TEST_RACE_ROLE: 'B' }, branch, 'attempt B');
    const [a, b] = await Promise.all([attemptA, attemptB]);

    expect(a.status, a.stderr).toBe(0);
    expect(b.status).not.toBe(0);
    expect(git(['log', '-1', '--format=%s', branch]).trim()).toBe('attempt A');
    expect(JSON.parse(readFileSync(join(dir, relIntentPath(branch)), 'utf8')).title).toBe(
      'attempt A',
    );
    dropWorktree(git, a.stderr);
  });

  it('ships a committed file-to-directory transition without dropping the deleted file identity', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'shape'), 'old file\n');
    commit(git, ['shape'], 'base file');
    git(['push', '-q', 'origin', 'HEAD:work']);
    git(['update-ref', 'refs/remotes/origin/work', 'HEAD']);
    rmSync(join(dir, 'shape'));
    mkdirSync(join(dir, 'shape'));
    writeFileSync(join(dir, 'shape/child.txt'), 'new child\n');
    commit(git, ['shape', 'shape/child.txt'], 'replace file with directory');
    writeFileSync(join(dir, 'shape/unrelated.txt'), 'another agent owns this\n');

    const r = runFromBranch(dir, env, 'feat/df-transition');
    expect(r.status, r.stderr).toBe(0);
    expect(git(['show', 'feat/df-transition:shape/child.txt'])).toBe('new child\n');
    expect(git(['cat-file', '-t', 'feat/df-transition:shape']).trim()).toBe('tree');
    expect(
      git(['diff', '--name-only', 'origin/work', 'feat/df-transition']).trim().split('\n'),
    ).toEqual(['shape', 'shape/child.txt']);
    expect(readFileSync(join(dir, 'shape/unrelated.txt'), 'utf8')).toBe(
      'another agent owns this\n',
    );
    dropWorktree(git, r.stderr);
  });

  it('treats derived filenames as literal Git paths, including pathspec-magic bytes', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    const magic = ':(exclude)*';
    writeFileSync(join(dir, magic), 'literal magic name\n');
    writeFileSync(join(dir, 'ordinary.txt'), 'ordinary\n');
    commit(git, [magic, 'ordinary.txt'], 'pathspec edge names');

    const r = runFromBranch(dir, { ...env, GIT_LITERAL_PATHSPECS: '1' }, 'feat/literal-scope');
    expect(r.status, r.stderr).toBe(0);
    expect(git(['show', `feat/literal-scope:${magic}`])).toBe('literal magic name\n');
    expect(git(['show', 'feat/literal-scope:ordinary.txt'])).toBe('ordinary\n');
    dropWorktree(git, r.stderr);
  });

  it('refuses an uncommitted overlay on a derived path before creating the ship branch', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'committed\n');
    commit(git, ['note.txt'], 'committed source snapshot');
    writeFileSync(join(dir, 'note.txt'), 'uncommitted overlay\n');

    const r = runFromBranch(dir, env, 'feat/refuse-overlay');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('uncommitted overlays on --from-branch paths');
    expect(r.stderr).toContain('note.txt');
    expect(localBranchExists(git, 'feat/refuse-overlay')).toBe(false);
  });

  it('refuses a changed gitlink with a submodule-specific diagnostic', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    const gitlinkCommit = git(['rev-parse', 'HEAD']).trim();
    git(['update-index', '--add', '--cacheinfo', `160000,${gitlinkCommit},vendor/sub`]);
    git(['commit', '-q', '-m', 'add gitlink'], { stdio: 'ignore' });

    const r = runFromBranch(dir, env, 'feat/refuse-gitlink');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/gitlink|submodule/i);
    expect(r.stderr).toContain('vendor/sub');
    expect(localBranchExists(git, 'feat/refuse-gitlink')).toBe(false);
  });

  it('resume preserves branch-source semantics and frozen membership while refreshing committed bytes', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, '.git/info/exclude'), '.devkit/\n');
    writeFileSync(join(dir, 'note.txt'), 'committed\n');
    commit(git, ['note.txt'], 'committed source snapshot');
    installHook(dir, 'exit 1');

    const blocked = runFromBranch(dir, env, 'feat/resume-branch');
    expect(blocked.status).not.toBe(0);
    const intent = JSON.parse(readFileSync(join(dir, relIntentPath('feat/resume-branch')), 'utf8'));
    expect(intent).toMatchObject({ version: 3, sourceMode: 'branch', paths: ['note.txt'] });
    const firstSourceAttemptId = intent.sourceAttemptId;

    const widened = spawnSync(
      '/bin/bash',
      [scriptPath, '--resume', 'feat/resume-branch', '--', 'later.txt'],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      },
    );
    expect(widened.status).not.toBe(0);
    expect(widened.stderr).toContain('frozen path membership');

    installHook(dir, 'exit 0');
    writeFileSync(join(dir, 'unrecorded.txt'), 'later committed but not in the frozen brief\n');
    commit(git, ['unrecorded.txt'], 'later unrelated commit');
    const resumed = spawnSync('/bin/bash', [scriptPath, '--resume', 'feat/resume-branch'], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(resumed.status, resumed.stderr).toBe(0);
    expect(
      git(['diff', '--name-only', 'origin/work', 'feat/resume-branch']).trim().split('\n'),
    ).toEqual(['note.txt']);
    const refreshedIntent = JSON.parse(
      readFileSync(join(dir, relIntentPath('feat/resume-branch')), 'utf8'),
    );
    expect(refreshedIntent.sourceAttemptId).not.toBe(firstSourceAttemptId);
    dropWorktree(git, resumed.stderr);
  });

  it('refuses a pre-commit resume when a frozen file identity became a directory prefix', () => {
    const { dir, env, git } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, '.git/info/exclude'), '.devkit/\n');
    writeFileSync(join(dir, 'shape'), 'recorded file\n');
    commit(git, ['shape'], 'record frozen file');
    installHook(dir, 'exit 1');
    const blocked = runFromBranch(dir, env, 'feat/frozen-df');
    expect(blocked.status).not.toBe(0);
    expect(
      JSON.parse(readFileSync(join(dir, relIntentPath('feat/frozen-df')), 'utf8')).paths,
    ).toEqual(['shape']);

    rmSync(join(dir, 'shape'));
    mkdirSync(join(dir, 'shape'));
    writeFileSync(join(dir, 'shape/child.txt'), 'later descendant\n');
    installHook(dir, 'exit 0');
    commit(git, ['shape', 'shape/child.txt'], 'replace frozen file with directory');
    const resumed = spawnSync('/bin/bash', [scriptPath, '--resume', 'feat/frozen-df'], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });

    expect(resumed.status).not.toBe(0);
    expect(resumed.stderr).toContain('frozen path membership would expand');
    expect(resumed.stderr).toContain('shape/child.txt');
    expect(localBranchExists(git, 'feat/frozen-df')).toBe(false);
  });

  it('receipt resume publishes the already-gated branch snapshot when a gate formatted a frozen path', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, '.git/info/exclude'), '.devkit/\n');
    writeFileSync(join(dir, 'note.txt'), 'committed source bytes\n');
    commit(git, ['note.txt'], 'committed source snapshot');
    installHook(
      dir,
      `echo run >> "$TEST_HOOK_COUNT"\nprintf 'gate-formatted\\n' > note.txt\ngit add -f -- note.txt\nsleep 30 &`,
    );
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    const argv = [
      scriptPath,
      'feat/from-branch-formatter',
      'ship committed branch scope',
      '--base',
      'work',
      '--from-branch',
    ];

    const first = spawnSync('/bin/bash', argv, {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...publishEnv, SHIP_COMMIT_TIMEOUT: '15' },
    });

    expect(first.status, first.stderr).toBe(124);
    expect(first.stderr).toMatch(/gate chain hit the 15s ceiling \(exit 124\)/);
    const preserved = git(['rev-parse', 'feat/from-branch-formatter']).trim();
    expect(git(['show', `${preserved}:note.txt`])).toBe('gate-formatted\n');
    expect(git(['show', 'HEAD:note.txt'])).toBe('committed source bytes\n');
    const oldBase = git(['--git-dir', bare, 'rev-parse', 'work']).trim();
    const advancedBase = git([
      'commit-tree',
      `${oldBase}^{tree}`,
      '-p',
      oldBase,
      '-m',
      'base advances between attempts',
    ]).trim();
    git(['push', '-q', 'origin', `${advancedBase}:work`]);

    const resumed = spawnSync('/bin/bash', [scriptPath, '--resume', 'feat/from-branch-formatter'], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stderr).toContain('gate receipt verified');
    expect(remoteBranchExists(bare, 'feat/from-branch-formatter')).toBe(true);
    expect(git(['--git-dir', bare, 'rev-parse', 'feat/from-branch-formatter']).trim()).toBe(
      preserved,
    );
    expect(readFileSync(hookCount, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(
      git(['for-each-ref', '--format=%(refname)', 'refs/devkit/ship-source-memberships']).trim(),
    ).toBe('');
  });

  it('a fresh branch-source invocation cannot adopt a receipt created by explicit-path mode', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, 'note.txt'), 'committed branch-source bytes\n');
    commit(git, ['note.txt'], 'committed source snapshot');

    const priorWorktree = join(dir, '..', `prior-explicit-${process.pid}-${Date.now()}`);
    git(['worktree', 'add', '-q', '-b', 'feat/cross-mode-receipt', priorWorktree, 'origin/work']);
    writeFileSync(join(priorWorktree, 'note.txt'), 'prior explicit working-tree bytes\n');
    git(['-C', priorWorktree, 'add', '--', 'note.txt']);
    git(['-C', priorWorktree, 'commit', '-q', '-m', 'ship committed branch scope']);
    const priorCommit = git(['rev-parse', 'feat/cross-mode-receipt']).trim();
    git(['worktree', 'remove', '--force', priorWorktree]);
    git(['update-ref', 'refs/devkit/ship-receipts/feat/cross-mode-receipt', priorCommit]);
    const { publishEnv } = publishEnvFor(dir, env);

    const refused = spawnSync(
      '/bin/bash',
      [
        scriptPath,
        'feat/cross-mode-receipt',
        'ship committed branch scope',
        '--base',
        'work',
        '--from-branch',
      ],
      { cwd: dir, input: '', encoding: 'utf8', env: publishEnv },
    );

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('fresh --from-branch invocation cannot adopt a prior receipt');
    expect(remoteBranchExists(bare, 'feat/cross-mode-receipt')).toBe(false);
    expect(git(['show', `${priorCommit}:note.txt`])).toBe('prior explicit working-tree bytes\n');
  });

  it('refuses a branch receipt owned by a different full source attempt', () => {
    const { dir, env, git, bare } = seedShipRepoLocalRemote();
    writeFileSync(join(dir, '.git/info/exclude'), '.devkit/\n');
    writeFileSync(join(dir, 'note.txt'), 'attempt A bytes\n');
    commit(git, ['note.txt'], 'committed source snapshot');
    const base = git(['rev-parse', 'origin/work']).trim();
    const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
    const preserved = git([
      'commit-tree',
      tree,
      '-p',
      base,
      '-m',
      'ship committed branch scope',
    ]).trim();
    git(['update-ref', 'refs/heads/feat/receipt-owner-race', preserved]);
    git(['update-ref', 'refs/devkit/ship-receipts/feat/receipt-owner-race', preserved]);
    const binding = git(['hash-object', '-w', '--stdin'], { input: 'attempt-a' }).trim();
    git(['update-ref', 'refs/devkit/ship-receipt-intents/feat/receipt-owner-race', binding]);
    expect(
      writeIntent(
        {
          root: dir,
          branch: 'feat/receipt-owner-race',
          mode: 'ship',
          sourceMode: 'branch',
          sourceAttemptId: 'attempt-b',
          title: 'ship committed branch scope',
          base: 'work',
          links: [],
          noQavisPublish: false,
          updatePrBody: false,
          draft: false,
          resumed: false,
          mergePaths: false,
          body: Buffer.alloc(0),
        },
        ['note.txt'],
      ),
    ).toBe(0);
    const { publishEnv } = publishEnvFor(dir, env);

    const refused = spawnSync('/bin/bash', [scriptPath, '--resume', 'feat/receipt-owner-race'], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: publishEnv,
    });

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(
      'gate receipt belongs to a different recorded branch-source attempt',
    );
    expect(remoteBranchExists(bare, 'feat/receipt-owner-race')).toBe(false);
  });
});
