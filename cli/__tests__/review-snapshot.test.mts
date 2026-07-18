import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from './_helpers.mts';

const SNAPSHOT_SCRIPT = fileURLToPath(new URL('../lib/ship/review/snapshot.sh', import.meta.url));
const { mkTmp, cleanup } = rootRegistry();

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Snapshot Test',
  GIT_AUTHOR_EMAIL: 'snapshot@test.invalid',
  GIT_COMMITTER_NAME: 'Snapshot Test',
  GIT_COMMITTER_EMAIL: 'snapshot@test.invalid',
};

afterEach(cleanup);

function snapshotFixture() {
  const root = mkTmp('devkit review snapshot-');
  const home = join(root, '.home');
  mkdirSync(home);
  const env = { ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  const git = initializeSnapshotRepo(root, env);
  return { root, env, git };
}

function initializeSnapshotRepo(root: string, env: NodeJS.ProcessEnv) {
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Snapshot Test']);
  git(['config', 'user.email', 'snapshot@test.invalid']);
  writeFileSync(join(root, 'tracked.txt'), 'tracked base\n');
  writeFileSync(join(root, 'partial.txt'), 'partial base\n');
  writeFileSync(join(root, 'delete-staged.txt'), 'delete staged\n');
  writeFileSync(join(root, 'delete-unstaged.txt'), 'delete unstaged\n');
  writeFileSync(join(root, 'replace.txt'), 'replace me\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  return git;
}

function runSnapshot(root: string, targetHead: string, env: NodeJS.ProcessEnv, cwd = root) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; shift; review_snapshot_capture_tree "$@"',
      'snapshot-test',
      SNAPSHOT_SCRIPT,
      root,
      targetHead,
    ],
    { cwd, env, encoding: 'utf8' },
  );
}

function snapshotMatches(root: string, targetHead: string, tree: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; shift; review_snapshot_tree_matches "$@"',
      'snapshot-test',
      SNAPSHOT_SCRIPT,
      root,
      targetHead,
      tree,
    ],
    { env, encoding: 'utf8' },
  );
}

type TreeEntry = { mode: string; oid: string; content: Buffer };

function readTree(root: string, tree: string, env: NodeJS.ProcessEnv) {
  const raw = execFileSync('git', ['ls-tree', '-rz', '-r', tree], { cwd: root, env });
  const entries = new Map<string, TreeEntry>();
  for (const record of raw.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, , oid] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    const content = execFileSync('git', ['cat-file', 'blob', oid], { cwd: root, env });
    entries.set(path, { mode, oid, content });
  }
  return entries;
}

function indexBytes(root: string, git: (args: string[]) => string) {
  const path = git(['rev-parse', '--git-path', 'index']).trim();
  return readFileSync(isAbsolute(path) ? path : resolve(root, path));
}

function postFirstCaptureMutation(root: string) {
  const bin = join(root, 'capture-mutation-bin');
  const state = mkTmp('devkit capture input mutation-');
  const realGit = execFileSync('/bin/bash', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim();
  const mutator = join(state, 'mutate.mjs');
  mkdirSync(bin);
  writeFileSync(
    mutator,
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.MUTATION_PATH, process.env.MUTATION_CONTENT);\n",
  );
  writeFileSync(
    join(bin, 'git'),
    '#!/bin/sh\nis_write=\nfor arg in "$@"; do [ "$arg" = write-tree ] && is_write=1; done\nif [ -n "$is_write" ] && [ -n "$GIT_INDEX_FILE" ]; then\n  output=$("$REAL_GIT" "$@") || exit $?\n  n=$(cat "$WRITE_TREE_COUNT" 2>/dev/null || printf 0)\n  n=$((n + 1))\n  printf "%s\\n" "$n" > "$WRITE_TREE_COUNT"\n  [ "$n" -eq 2 ] && "$REAL_NODE" "$MUTATOR_SCRIPT"\n  printf "%s\\n" "$output"\n  exit 0\nfi\nexec "$REAL_GIT" "$@"\n',
  );
  chmodSync(join(bin, 'git'), 0o755);
  return {
    PATH: `${bin}:${process.env.PATH}`,
    REAL_GIT: realGit,
    REAL_NODE: process.execPath,
    MUTATOR_SCRIPT: mutator,
    WRITE_TREE_COUNT: join(state, 'write-tree-count'),
  };
}

describe('review snapshot capture', () => {
  it('preserves a target root whose final pathname byte is a newline', () => {
    const parent = mkTmp('devkit snapshot newline root-');
    const home = join(parent, '.home');
    const plainRoot = join(parent, 'checkout');
    const newlineRoot = `${plainRoot}\n`;
    mkdirSync(home);
    mkdirSync(plainRoot);
    const env = { ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
    const plainGit = initializeSnapshotRepo(plainRoot, env);
    execFileSync('git', ['clone', '-q', plainRoot, newlineRoot], { env });
    writeFileSync(join(plainRoot, 'tracked.txt'), 'wrong sibling\n');
    writeFileSync(join(newlineRoot, 'tracked.txt'), 'newline-root target\n');

    const result = runSnapshot(newlineRoot, plainGit(['rev-parse', 'HEAD']).trim(), env);

    expect(result.status, result.stderr).toBe(0);
    expect(
      readTree(newlineRoot, result.stdout.trim(), env).get('tracked.txt')?.content.toString(),
    ).toBe('newline-root target\n');
  });

  it('collapses committed, staged, unstaged, deleted, binary, link, mode, and untracked state', () => {
    const { root, env, git } = snapshotFixture();
    git(['switch', '-q', '-c', 'feature']);
    writeFileSync(join(root, 'committed.txt'), 'committed branch\n');
    git(['add', 'committed.txt']);
    git(['commit', '-q', '-m', 'feature']);
    const targetHead = git(['rev-parse', 'HEAD']).trim();

    writeFileSync(join(root, 'staged.txt'), 'staged only\n');
    git(['add', 'staged.txt']);
    writeFileSync(join(root, 'partial.txt'), 'staged bytes\n');
    git(['add', 'partial.txt']);
    writeFileSync(join(root, 'partial.txt'), 'final working bytes\n');
    writeFileSync(join(root, 'tracked.txt'), 'unstaged tracked\n');
    rmSync(join(root, 'delete-staged.txt'));
    git(['add', '-u', 'delete-staged.txt']);
    rmSync(join(root, 'delete-unstaged.txt'));
    rmSync(join(root, 'replace.txt'));
    symlinkSync('tracked.txt', join(root, 'replace.txt'));
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 255, 1, 254]));
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'run.sh'), 0o755);
    writeFileSync(join(root, 'line\nbreak.txt'), 'newline path\n');
    writeFileSync(join(root, '.gitignore'), 'secret.txt\nforced.txt\n');
    writeFileSync(join(root, 'secret.txt'), 'ignored\n');
    writeFileSync(join(root, 'forced.txt'), 'force-staged bytes\n');
    git(['add', '-f', 'forced.txt']);
    writeFileSync(join(root, 'forced.txt'), 'final force-staged bytes\n');

    const before = {
      head: git(['rev-parse', 'HEAD']),
      index: indexBytes(root, git),
      refs: git(['show-ref']),
      status: git(['status', '--porcelain=v1']),
    };
    const result = runSnapshot(root, targetHead, env);

    expect(result.status, result.stderr).toBe(0);
    const entries = readTree(root, result.stdout.trim(), env);
    expect(entries.get('committed.txt')?.content.toString()).toBe('committed branch\n');
    expect(entries.get('staged.txt')?.content.toString()).toBe('staged only\n');
    expect(entries.get('partial.txt')?.content.toString()).toBe('final working bytes\n');
    expect(entries.get('tracked.txt')?.content.toString()).toBe('unstaged tracked\n');
    expect(entries.has('delete-staged.txt')).toBe(false);
    expect(entries.has('delete-unstaged.txt')).toBe(false);
    expect(entries.get('binary.bin')?.content).toEqual(Buffer.from([0, 255, 1, 254]));
    expect(entries.get('replace.txt')).toMatchObject({ mode: '120000' });
    expect(entries.get('replace.txt')?.content.toString()).toBe('tracked.txt');
    expect(entries.get('run.sh')).toMatchObject({ mode: '100755' });
    expect(entries.get('line\nbreak.txt')?.content.toString()).toBe('newline path\n');
    expect(entries.has('secret.txt')).toBe(false);
    expect(entries.get('forced.txt')?.content.toString()).toBe('final force-staged bytes\n');
    expect(git(['rev-parse', 'HEAD'])).toBe(before.head);
    expect(indexBytes(root, git)).toEqual(before.index);
    expect(git(['show-ref'])).toBe(before.refs);
    expect(git(['status', '--porcelain=v1'])).toBe(before.status);
  });

  it('preserves repository, info, and target-relative global ignore semantics', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, '.gitignore'), 'repo-secret.txt\n');
    writeFileSync(join(root, '.git/info/exclude'), 'info-secret.txt\n');
    writeFileSync(join(root, 'review-ignore'), 'global-secret.txt\n');
    git(['config', 'core.excludesFile', 'review-ignore']);
    writeFileSync(join(root, 'repo-secret.txt'), 'repo ignored\n');
    writeFileSync(join(root, 'info-secret.txt'), 'info ignored\n');
    writeFileSync(join(root, 'global-secret.txt'), 'global ignored\n');
    writeFileSync(join(root, 'tracked.txt'), 'tracked despite ignore\n');
    writeFileSync(join(root, 'review-ignore'), 'global-secret.txt\ntracked.txt\n');
    const caller = mkTmp('devkit snapshot caller-');

    const result = runSnapshot(root, targetHead, env, caller);

    expect(result.status, result.stderr).toBe(0);
    const entries = readTree(root, result.stdout.trim(), env);
    expect(entries.has('repo-secret.txt')).toBe(false);
    expect(entries.has('info-secret.txt')).toBe(false);
    expect(entries.has('global-secret.txt')).toBe(false);
    expect(entries.get('tracked.txt')?.content.toString()).toBe('tracked despite ignore\n');
  });

  it('distinguishes an explicitly empty excludes file and preserves newline-bearing paths', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    const fallbackDir = join(env.XDG_CONFIG_HOME as string, 'git');
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(join(fallbackDir, 'ignore'), 'fallback-secret.txt\n');
    writeFileSync(join(root, 'fallback-secret.txt'), 'must remain visible\n');
    git(['config', 'core.excludesFile', '']);

    const explicitEmpty = runSnapshot(root, targetHead, env);

    expect(explicitEmpty.status, explicitEmpty.stderr).toBe(0);
    expect(readTree(root, explicitEmpty.stdout.trim(), env).has('fallback-secret.txt')).toBe(true);

    const newlineIgnore = 'review-ignore\n';
    writeFileSync(join(root, newlineIgnore), 'newline-secret.txt\n');
    writeFileSync(join(root, 'newline-secret.txt'), 'must be ignored\n');
    git(['config', 'core.excludesFile', newlineIgnore]);
    const newlinePath = runSnapshot(root, targetHead, env);

    expect(newlinePath.status, newlinePath.stderr).toBe(0);
    expect(readTree(root, newlinePath.stdout.trim(), env).has('newline-secret.txt')).toBe(false);
  });

  it('removes projected runtime inputs even when ignore negations try to stage them', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    mkdirSync(join(root, '.husky'));
    mkdirSync(join(root, '.devkit'));
    mkdirSync(join(root, 'cache'));
    writeFileSync(join(root, '.husky/team.txt'), 'surrounding husky\n');
    writeFileSync(join(root, '.devkit/keep.txt'), 'surrounding devkit\n');
    writeFileSync(join(root, 'cache/neighbor.txt'), 'surrounding cache\n');
    const projection = mkTmp('devkit snapshot projection-');
    writeFileSync(
      join(projection, 'guard.json'),
      `${JSON.stringify({ indexPath: 'cache/[x]', allowlistPath: 'cache/index\n.db' })}\n`,
    );
    writeFileSync(join(projection, 'hook-runner'), 'runtime hook\n');
    writeFileSync(join(projection, 'index.db'), 'runtime index\n');
    symlinkSync(join(projection, 'guard.json'), join(root, 'guard.config.json'));
    symlinkSync(join(projection, 'hook-runner'), join(root, '.husky/_'));
    symlinkSync(join(projection, 'index.db'), join(root, 'cache/[x]'));
    symlinkSync(join(projection, 'index.db'), join(root, 'cache/index\n.db'));
    writeFileSync(join(root, 'cache/x'), 'glob lookalike must remain\n');
    mkdirSync(join(root, '.devkit/review-runs'));
    writeFileSync(join(root, '.devkit/review-runs/run.log'), 'generated\n');
    writeFileSync(
      join(root, '.gitignore'),
      '!guard.config.json\n!.husky/_\n!.devkit/review-runs/\n!.devkit/review-runs/**\n',
    );

    const result = runSnapshot(root, targetHead, env);

    expect(result.status, result.stderr).toBe(0);
    const entries = readTree(root, result.stdout.trim(), env);
    expect(entries.has('guard.config.json')).toBe(false);
    expect(entries.has('.husky/_')).toBe(false);
    expect(entries.has('.devkit/review-runs/run.log')).toBe(false);
    expect(entries.has('cache/[x]')).toBe(false);
    expect(entries.has('cache/index\n.db')).toBe(false);
    expect(entries.get('cache/x')?.content.toString()).toBe('glob lookalike must remain\n');
    expect(entries.get('.husky/team.txt')?.content.toString()).toBe('surrounding husky\n');
    expect(entries.get('.devkit/keep.txt')?.content.toString()).toBe('surrounding devkit\n');
    expect(entries.get('cache/neighbor.txt')?.content.toString()).toBe('surrounding cache\n');
  });

  it('matches only the same target HEAD and final tree', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'tracked.txt'), 'snapshot state\n');
    const captured = runSnapshot(root, targetHead, env);
    expect(captured.status, captured.stderr).toBe(0);
    const tree = captured.stdout.trim();
    expect(snapshotMatches(root, targetHead, tree, env).status).toBe(0);

    writeFileSync(join(root, 'tracked.txt'), 'mutated\n');
    expect(snapshotMatches(root, targetHead, tree, env).status).toBe(1);
    writeFileSync(join(root, 'tracked.txt'), 'snapshot state\n');
    writeFileSync(join(root, 'head-move.txt'), 'move head\n');
    git(['add', 'head-move.txt']);
    git(['commit', '-q', '-m', 'move head']);
    expect(snapshotMatches(root, targetHead, tree, env).status).toBe(1);
  });

  it('fails closed when the real index contains skip-worktree entries', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    git(['update-index', '--skip-worktree', 'tracked.txt']);
    rmSync(join(root, 'tracked.txt'));

    const result = runSnapshot(root, targetHead, env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('skip-worktree checkouts are not supported');
  });

  it('clears assume-unchanged and stat-cache state before reading final bytes', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    git(['update-index', '--assume-unchanged', 'tracked.txt']);
    writeFileSync(join(root, 'tracked.txt'), 'assume-unchanged final bytes\n');

    const result = runSnapshot(root, targetHead, env);

    expect(result.status, result.stderr).toBe(0);
    expect(readTree(root, result.stdout.trim(), env).get('tracked.txt')?.content.toString()).toBe(
      'assume-unchanged final bytes\n',
    );
  });

  it('rejects files that mutate between its two filesystem captures', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    const bin = join(root, 'mutation-bin');
    const state = mkTmp('devkit snapshot mutation state-');
    const realGit = execFileSync('/bin/bash', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    mkdirSync(bin);
    git(['config', 'core.trustctime', 'false']);
    writeFileSync(join(root, 'tracked.txt'), 'first bytes\n');
    const timestamp = statSync(join(root, 'tracked.txt'));
    const reference = join(state, 'timestamp-reference');
    writeFileSync(reference, 'reference\n');
    utimesSync(reference, timestamp.atime, timestamp.mtime);
    writeFileSync(
      join(bin, 'git'),
      '#!/bin/sh\nis_add=\nfor arg in "$@"; do [ "$arg" = add ] && is_add=1; done\nif [ -n "$is_add" ]; then\n  "$REAL_GIT" "$@" || exit $?\n  if [ ! -e "$MUTATION_MARKER" ]; then\n    : > "$MUTATION_MARKER"\n    printf "other bytes\\n" > "$MUTATION_TARGET"\n    touch -r "$MUTATION_REFERENCE" "$MUTATION_TARGET"\n  fi\n  exit 0\nfi\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(join(bin, 'git'), 0o755);

    const result = runSnapshot(root, targetHead, {
      ...env,
      PATH: `${bin}:${env.PATH}`,
      REAL_GIT: realGit,
      MUTATION_MARKER: join(state, 'mutated'),
      MUTATION_TARGET: join(root, 'tracked.txt'),
      MUTATION_REFERENCE: reference,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'target files or review inputs changed during snapshot capture',
    );
  });

  it('rejects effective global-ignore changes between independent captures', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    const excludes = join(mkTmp('devkit external excludes-'), 'review-ignore');
    writeFileSync(excludes, 'unmatched-before\n');
    git(['config', 'core.excludesFile', excludes]);
    const mutationEnv = postFirstCaptureMutation(root);

    const result = runSnapshot(root, targetHead, {
      ...env,
      ...mutationEnv,
      MUTATION_PATH: excludes,
      MUTATION_CONTENT: 'unmatched-after\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'target files or review inputs changed during snapshot capture',
    );
  });

  it('rejects projection-candidate changes between independent captures', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    const projectedConfig = mkTmp('devkit projected config-');
    const config = join(projectedConfig, 'guard.json');
    writeFileSync(config, '{"indexPath":"cache/a.db"}\n');
    symlinkSync(config, join(root, 'guard.config.json'));
    const mutationEnv = postFirstCaptureMutation(root);

    const result = runSnapshot(root, targetHead, {
      ...env,
      ...mutationEnv,
      MUTATION_PATH: config,
      MUTATION_CONTENT: '{"indexPath":"cache/b.db"}\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'target files or review inputs changed during snapshot capture',
    );
  });

  it('cleans alternate-index state on success and injected failure without touching caller index', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    const temp = mkTmp('devkit snapshot temp-');
    const callerIndex = join(root, 'caller-index');
    execFileSync('git', ['read-tree', 'HEAD'], {
      cwd: root,
      env: { ...env, GIT_INDEX_FILE: callerIndex },
    });
    const beforeIndex = readFileSync(callerIndex);
    const success = runSnapshot(root, targetHead, {
      ...env,
      TMPDIR: temp,
      GIT_INDEX_FILE: callerIndex,
      GIT_DIR: join(root, 'wrong-git-dir'),
    });
    expect(success.status, success.stderr).toBe(0);
    expect(readFileSync(callerIndex)).toEqual(beforeIndex);
    expect(readdirSync(temp)).toEqual([]);

    const bin = join(root, 'fake-bin');
    mkdirSync(bin);
    const realGit = execFileSync('/bin/bash', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(bin, 'git'),
      '#!/bin/sh\nfor arg in "$@"; do [ "$arg" = add ] && exit 9; done\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(join(bin, 'git'), 0o755);
    const failure = runSnapshot(root, targetHead, {
      ...env,
      TMPDIR: temp,
      PATH: `${bin}:${env.PATH}`,
      REAL_GIT: realGit,
    });
    expect(failure.status).toBe(1);
    expect(readdirSync(temp)).toEqual([]);

    const nodeBin = join(root, 'fake-node-bin');
    mkdirSync(nodeBin);
    writeFileSync(
      join(nodeBin, 'node'),
      '#!/bin/sh\nfor arg in "$@"; do [ "$arg" = --null ] && exit 9; done\nexec "$REAL_NODE" "$@"\n',
    );
    chmodSync(join(nodeBin, 'node'), 0o755);
    const emitterFailure = runSnapshot(root, targetHead, {
      ...env,
      TMPDIR: temp,
      PATH: `${nodeBin}:${env.PATH}`,
      REAL_NODE: process.execPath,
    });
    expect(emitterFailure.status).toBe(1);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('preserves the promised signal status before temporary state is allocated', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    const bin = join(root, 'signal-bin');
    mkdirSync(bin);
    const realGit = execFileSync('/bin/bash', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(bin, 'git'),
      '#!/bin/sh\ncase "$*" in *"rev-parse HEAD"*) ps -o ppid= -p "$PPID" | xargs kill -TERM; sleep 0.1; exit 0;; esac\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(join(bin, 'git'), 0o755);

    const result = runSnapshot(root, targetHead, {
      ...env,
      PATH: `${bin}:${env.PATH}`,
      REAL_GIT: realGit,
    });

    expect(result.status, result.stderr).toBe(143);
  });

  it('never creates capture state inside the target when TMPDIR points there', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    const targetTemp = join(root, 'target-tmp');
    mkdirSync(targetTemp);

    const result = runSnapshot(root, targetHead, { ...env, TMPDIR: targetTemp });

    expect(result.status, result.stderr).toBe(0);
    const entries = readTree(root, result.stdout.trim(), env);
    expect([...entries.keys()].some((path) => path.startsWith('target-tmp/'))).toBe(false);
    expect(readdirSync(targetTemp)).toEqual([]);
  });
});
