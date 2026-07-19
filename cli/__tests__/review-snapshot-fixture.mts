import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootRegistry } from './_helpers.mts';

const SNAPSHOT_SCRIPT = fileURLToPath(new URL('../lib/ship/review/snapshot.sh', import.meta.url));
const registry = rootRegistry();

export const { mkTmp, cleanup } = registry;

export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Snapshot Test',
  GIT_AUTHOR_EMAIL: 'snapshot@test.invalid',
  GIT_COMMITTER_NAME: 'Snapshot Test',
  GIT_COMMITTER_EMAIL: 'snapshot@test.invalid',
};

export function snapshotFixture() {
  const root = mkTmp('devkit review snapshot-');
  const home = join(root, '.home');
  mkdirSync(home);
  const env = { ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  const git = initializeSnapshotRepo(root, env);
  return { root, env, git };
}

export function initializeSnapshotRepo(root: string, env: NodeJS.ProcessEnv) {
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

export function runSnapshot(root: string, targetHead: string, env: NodeJS.ProcessEnv, cwd = root) {
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

export function runSnapshotTrees(root: string, targetHead: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; shift; review_snapshot_capture_trees "$@"',
      'snapshot-test',
      SNAPSHOT_SCRIPT,
      root,
      targetHead,
    ],
    { env, encoding: 'utf8' },
  );
}

export function snapshotMatches(
  root: string,
  targetHead: string,
  tree: string,
  env: NodeJS.ProcessEnv,
) {
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

export function readTree(root: string, tree: string, env: NodeJS.ProcessEnv) {
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

export function indexBytes(root: string, git: (args: string[]) => string) {
  const path = git(['rev-parse', '--git-path', 'index']).trim();
  return readFileSync(isAbsolute(path) ? path : resolve(root, path));
}

export function postFirstCaptureMutation(root: string) {
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

export function failUpdateIndexEnvironment(root: string, path: string | undefined) {
  const bin = join(root, 'fake-bin');
  mkdirSync(bin);
  const realGit = execFileSync('/bin/bash', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim();
  writeFileSync(
    join(bin, 'git'),
    '#!/bin/sh\nfor arg in "$@"; do [ "$arg" = update-index ] && exit 9; done\nexec "$REAL_GIT" "$@"\n',
  );
  chmodSync(join(bin, 'git'), 0o755);
  return { PATH: `${bin}:${path}`, REAL_GIT: realGit };
}

export function failNullEmitterEnvironment(root: string, path: string | undefined) {
  const bin = join(root, 'fake-node-bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'node'),
    '#!/bin/sh\nfor arg in "$@"; do [ "$arg" = --null ] && exit 9; done\nexec "$REAL_NODE" "$@"\n',
  );
  chmodSync(join(bin, 'node'), 0o755);
  return { PATH: `${bin}:${path}`, REAL_NODE: process.execPath };
}

export function signalBeforeTempEnvironment(root: string, path: string | undefined) {
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
  return { PATH: `${bin}:${path}`, REAL_GIT: realGit };
}
