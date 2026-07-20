import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from './_helpers.mts';

const WORKTREE_SCRIPT = fileURLToPath(new URL('../lib/ship/review/worktrees.sh', import.meta.url));
const { mkTmp, cleanup } = rootRegistry();
const REAL_GIT = execFileSync('/bin/bash', ['-c', 'command -v git'], {
  encoding: 'utf8',
}).trim();
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Review Worktree Test',
  GIT_AUTHOR_EMAIL: 'review-worktree@test.invalid',
  GIT_COMMITTER_NAME: 'Review Worktree Test',
  GIT_COMMITTER_EMAIL: 'review-worktree@test.invalid',
};

afterEach(cleanup);

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' });
}

function stageRawBlob(root: string, path: string, content: string | Buffer, mode = '100644') {
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root,
    env: GIT_ENV,
    input: content,
    encoding: 'utf8',
  }).trim();
  git(root, 'update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`);
}

function runHelper(name: string, args: string[], env: NodeJS.ProcessEnv = GIT_ENV) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'set -euo pipefail; source "$1"; shift; helper=$1; shift; "$helper" "$@"',
      'review-worktree-test',
      WORKTREE_SCRIPT,
      name,
      ...args,
    ],
    { env, encoding: 'utf8' },
  );
}

function fixture(name = 'devkit review worktrees-') {
  const parent = mkTmp(name);
  const root = join(parent, 'repo');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Review Worktree Test');
  git(root, 'config', 'user.email', 'review-worktree@test.invalid');
  writeFileSync(join(root, '.gitignore'), 'ignored/\n');
  writeFileSync(join(root, 'kept.txt'), 'base\n');
  writeFileSync(join(root, 'deleted.txt'), 'delete later\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return { parent, root, base: git(root, 'rev-parse', 'HEAD').trim() };
}

function nulManifest(path: string, roots: string[]) {
  writeFileSync(path, Buffer.from(`${roots.join('\0')}\0`));
}

function sabotageGit(parent: string, body: string) {
  const bin = join(parent, 'bin');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh\n${body}\n`);
  chmodSync(wrapper, 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, REAL_GIT };
}

describe('review worktree lifecycle', () => {
  it('creates a literal-safe detached checkout without running target hooks or inheriting Git env', () => {
    const parent = mkTmp('devkit review newline lifecycle-');
    const root = join(parent, 'repo\n');
    const destination = join(parent, 'detached\n');
    const marker = join(parent, 'post-checkout-ran');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Review Worktree Test');
    git(root, 'config', 'user.email', 'review-worktree@test.invalid');
    writeFileSync(join(root, 'file.txt'), 'base\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    mkdirSync(join(root, 'hooks'));
    writeFileSync(
      join(root, 'hooks/post-checkout'),
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`,
    );
    chmodSync(join(root, 'hooks/post-checkout'), 0o755);
    git(root, 'config', 'core.hooksPath', 'hooks');
    const base = git(root, 'rev-parse', 'HEAD').trim();

    const created = runHelper('review_create_worktree', [root, destination, base], {
      ...GIT_ENV,
      GIT_DIR: join(parent, 'poison-git-dir'),
      GIT_WORK_TREE: join(parent, 'poison-work-tree'),
      GIT_INDEX_FILE: join(parent, 'poison-index'),
    });

    expect(created.status, created.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(git(destination, 'rev-parse', 'HEAD').trim()).toBe(base);
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: destination }).status).toBe(1);

    expect(runHelper('review_remove_worktree', [root, destination]).status).toBe(0);
    expect(existsSync(destination)).toBe(false);
    expect(runHelper('review_remove_worktree', [root, destination]).status).toBe(0);
  });

  it('rejects nested, relative, pre-existing, and unregistered removal destinations', () => {
    const { parent, root, base } = fixture();
    const nested = join(root, 'nested');
    expect(runHelper('review_create_worktree', [root, nested, base]).status).toBe(1);
    expect(existsSync(nested)).toBe(false);

    const existing = join(parent, 'existing');
    mkdirSync(existing);
    writeFileSync(join(existing, 'owned.txt'), 'caller owned\n');
    expect(runHelper('review_create_worktree', [root, existing, base]).status).toBe(1);
    expect(runHelper('review_create_worktree', [root, 'relative', base]).status).toBe(1);
    expect(runHelper('review_remove_worktree', [root, existing]).status).toBe(1);
    expect(readFileSync(join(existing, 'owned.txt'), 'utf8')).toBe('caller owned\n');
  });

  it('cleans a checkout and registration when worktree creation fails after partial success', () => {
    const { parent, root, base } = fixture();
    const destination = join(parent, 'partial');
    const count = join(parent, 'add-count');
    const wrapper = sabotageGit(
      parent,
      'is_add=\nfor arg in "$@"; do\n  [ "$arg" = add ] && is_add=1\ndone\nif [ -n "$is_add" ] && [ ! -e "$ADD_COUNT" ]; then\n  : > "$ADD_COUNT"\n  "$REAL_GIT" "$@" || exit $?\n  exit 73\nfi\nexec "$REAL_GIT" "$@"',
    );

    const result = runHelper('review_create_worktree', [root, destination, base], {
      ...GIT_ENV,
      ...wrapper,
      ADD_COUNT: count,
    });

    expect(result.status).toBe(1);
    expect(existsSync(destination), result.stderr).toBe(false);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(destination);
  });
});

describe('review tree materialization', () => {
  it('stages the exact target tree while keeping detached HEAD at the merge base', () => {
    const { parent, root, base } = fixture();
    writeFileSync(join(root, 'kept.txt'), 'target\n');
    rmSync(join(root, 'deleted.txt'));
    writeFileSync(join(root, 'executable.sh'), '#!/bin/sh\n');
    chmodSync(join(root, 'executable.sh'), 0o755);
    symlinkSync('kept.txt', join(root, 'link'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'target');
    const targetTree = git(root, 'rev-parse', 'HEAD^{tree}').trim();
    const destination = join(parent, 'materialized');
    expect(runHelper('review_create_worktree', [root, destination, base]).status).toBe(0);

    const result = runHelper('review_materialize_tree', [destination, targetTree]);

    expect(result.status, result.stderr).toBe(0);
    expect(git(destination, 'rev-parse', 'HEAD').trim()).toBe(base);
    expect(runHelper('review_staged_tree', [destination]).stdout.trim()).toBe(targetTree);
    expect(readFileSync(join(destination, 'kept.txt'), 'utf8')).toBe('target\n');
    expect(existsSync(join(destination, 'deleted.txt'))).toBe(false);
    expect(readFileSync(join(destination, 'link'), 'utf8')).toBe('target\n');
    expect(statSync(join(destination, 'executable.sh')).mode & 0o777).toBe(0o755);
    expect(spawnSync('git', ['diff', '--quiet'], { cwd: destination }).status).toBe(0);
    expect(spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: destination }).status).toBe(1);
  });

  it('materializes raw blobs, modes, links, gitlinks, and literal paths without conversions', () => {
    const { parent, root, base } = fixture();
    git(root, 'config', 'core.autocrlf', 'true');
    git(root, 'config', 'filter.snapshot-rewrite.clean', "sed 's/^/cleaned: /'");
    git(root, 'config', 'filter.snapshot-rewrite.smudge', "sed 's/^/smudged: /'");
    git(root, 'config', 'filter.snapshot-rewrite.required', 'true');
    stageRawBlob(
      root,
      '.gitattributes',
      'filtered.txt filter=snapshot-rewrite\ncrlf.txt text eol=crlf\n',
    );
    stageRawBlob(root, 'filtered.txt', 'raw filtered bytes\n');
    stageRawBlob(root, 'crlf.txt', 'raw lf bytes\n');
    stageRawBlob(root, 'binary.bin', Buffer.from([0, 255, 1, 254]));
    stageRawBlob(root, 'executable.sh', '#!/bin/sh\nexit 0\n', '100755');
    stageRawBlob(root, 'link', 'target\n\n', '120000');
    stageRawBlob(root, 'line\nbreak.txt', 'literal path\n');
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${base},module`);
    const rawTree = git(root, 'write-tree').trim();
    stageRawBlob(root, 'filtered.txt', 'cleaned: raw filtered bytes\n');
    const stagedTree = git(root, 'write-tree').trim();
    const destination = join(parent, 'raw-materialized');
    expect(runHelper('review_create_worktree', [root, destination, base]).status).toBe(0);

    const result = runHelper('review_materialize_tree', [destination, stagedTree, rawTree]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(destination, 'filtered.txt'), 'utf8')).toBe('raw filtered bytes\n');
    expect(readFileSync(join(destination, 'crlf.txt'))).toEqual(Buffer.from('raw lf bytes\n'));
    expect(readFileSync(join(destination, 'binary.bin'))).toEqual(Buffer.from([0, 255, 1, 254]));
    expect(statSync(join(destination, 'executable.sh')).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(destination, 'link'))).toBe('target\n\n');
    expect(readFileSync(join(destination, 'line\nbreak.txt'), 'utf8')).toBe('literal path\n');
    expect(statSync(join(destination, 'module')).isDirectory()).toBe(true);
    expect(runHelper('review_staged_tree', [destination]).stdout.trim()).toBe(stagedTree);
    expect(git(destination, 'rev-parse', 'HEAD').trim()).toBe(base);
    expect(spawnSync('git', ['diff', '--quiet'], { cwd: destination, env: GIT_ENV }).status).toBe(
      0,
    );
    const matched = runHelper('review_worktree_matches_tree', [destination, rawTree, stagedTree]);
    expect(matched.status, matched.stderr).toBe(0);
    chmodSync(join(destination, 'executable.sh'), 0o654);
    expect(
      runHelper('review_worktree_matches_tree', [destination, rawTree, stagedTree]).status,
    ).toBe(0);

    writeFileSync(join(destination, 'filtered.txt'), 'hook-mutated bytes\n');
    expect(
      runHelper('review_worktree_matches_tree', [destination, rawTree, stagedTree]).status,
    ).toBe(1);
    writeFileSync(join(destination, 'filtered.txt'), 'raw filtered bytes\n');
    chmodSync(join(destination, 'executable.sh'), 0o644);
    expect(
      runHelper('review_worktree_matches_tree', [destination, rawTree, stagedTree]).status,
    ).toBe(1);
  });

  it('refuses to overwrite any dirty temporary worktree state', () => {
    const { parent, root, base } = fixture();
    const destination = join(parent, 'dirty');
    expect(runHelper('review_create_worktree', [root, destination, base]).status).toBe(0);
    writeFileSync(join(destination, 'untracked.txt'), 'do not overwrite\n');

    const result = runHelper('review_materialize_tree', [destination, `${base}^{tree}`]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to materialize over a dirty');
    expect(readFileSync(join(destination, 'untracked.txt'), 'utf8')).toBe('do not overwrite\n');
  });
});

describe('review untracked integrity manifests', () => {
  it('authenticates literal names, bytes, complete modes, types, and exact symlink targets', () => {
    const { parent, root, base } = fixture();
    const destination = join(parent, 'untracked');
    const manifest = join(parent, 'untracked.manifest');
    expect(runHelper('review_create_worktree', [root, destination, base]).status).toBe(0);
    writeFileSync(join(destination, 'line\nbreak.txt'), 'original\n');
    writeFileSync(join(destination, 'mode.txt'), 'mode\n');
    chmodSync(join(destination, 'mode.txt'), 0o640);
    symlinkSync('target\n\n', join(destination, 'link'));
    mkdirSync(join(destination, 'ignored'));
    writeFileSync(join(destination, 'ignored/cache'), 'ignored original\n');

    const captured = runHelper('review_capture_untracked', [destination, manifest]);
    expect(captured.status, captured.stderr).toBe(0);
    writeFileSync(join(destination, 'ignored/cache'), 'ignored changed\n');
    expect(runHelper('review_assert_untracked_unchanged', [destination, manifest]).status).toBe(0);

    writeFileSync(join(destination, 'line\nbreak.txt'), 'changed\n');
    expect(runHelper('review_assert_untracked_unchanged', [destination, manifest]).status).toBe(1);
    writeFileSync(join(destination, 'line\nbreak.txt'), 'original\n');
    chmodSync(join(destination, 'mode.txt'), 0o600);
    expect(runHelper('review_assert_untracked_unchanged', [destination, manifest]).status).toBe(1);
    chmodSync(join(destination, 'mode.txt'), 0o640);
    rmSync(join(destination, 'link'));
    symlinkSync('target\nchanged', join(destination, 'link'));
    expect(runHelper('review_assert_untracked_unchanged', [destination, manifest]).status).toBe(1);
  });

  it('allows only exact mutable projection roots from a validated NUL manifest', () => {
    const { parent, root, base } = fixture();
    const destination = join(parent, 'excluded');
    const manifest = join(parent, 'excluded.manifest');
    const exclusions = join(parent, 'exclusions.manifest');
    expect(runHelper('review_create_worktree', [root, destination, base]).status).toBe(0);
    mkdirSync(join(destination, '.fallow/cache'), { recursive: true });
    writeFileSync(join(destination, '.fallow/cache/state'), 'mutable\n');
    writeFileSync(join(destination, 'mutable-file'), 'mutable\n');
    writeFileSync(join(destination, '.fallowish'), 'authenticated\n');
    nulManifest(exclusions, ['.fallow', 'mutable-file']);

    expect(runHelper('review_capture_untracked', [destination, manifest, exclusions]).status).toBe(
      0,
    );
    writeFileSync(join(destination, '.fallow/cache/state'), 'changed\n');
    writeFileSync(join(destination, '.fallow/new'), 'new projection\n');
    writeFileSync(join(destination, 'mutable-file'), 'changed\n');
    expect(
      runHelper('review_assert_untracked_unchanged', [destination, manifest, exclusions]).status,
    ).toBe(0);
    nulManifest(exclusions, ['.fallow', 'mutable-file', 'newly-hidden']);
    writeFileSync(join(destination, 'newly-hidden'), 'must not be hidden after capture\n');
    expect(
      runHelper('review_assert_untracked_unchanged', [destination, manifest, exclusions]).status,
    ).toBe(1);
    nulManifest(exclusions, ['.fallow', 'mutable-file']);
    rmSync(join(destination, 'newly-hidden'));
    writeFileSync(join(destination, '.fallowish'), 'changed\n');
    expect(
      runHelper('review_assert_untracked_unchanged', [destination, manifest, exclusions]).status,
    ).toBe(1);
  });

  it('rejects unsafe or malformed exclusion roots', () => {
    const { parent, root, base } = fixture();
    const destination = join(parent, 'invalid exclusions');
    expect(runHelper('review_create_worktree', [root, destination, base]).status).toBe(0);
    writeFileSync(join(destination, 'entry'), 'bytes\n');
    const invalid = ['/absolute', '../escape', '.', 'dir//child', 'dir/../child'];
    for (const [index, rootName] of invalid.entries()) {
      const exclusions = join(parent, `invalid-${index}`);
      const manifest = join(parent, `manifest-${index}`);
      nulManifest(exclusions, [rootName]);
      expect(
        runHelper('review_capture_untracked', [destination, manifest, exclusions]).status,
      ).toBe(1);
    }
    const unterminated = join(parent, 'unterminated');
    writeFileSync(unterminated, 'entry');
    expect(
      runHelper('review_capture_untracked', [
        destination,
        join(parent, 'unterminated-out'),
        unterminated,
      ]).status,
    ).toBe(1);
  });

  it('fails capture when bytes change between its two complete passes', () => {
    const { parent, root, base } = fixture();
    const destination = join(parent, 'unstable');
    const manifest = join(parent, 'unstable.manifest');
    const counter = join(parent, 'hash-count');
    expect(runHelper('review_create_worktree', [root, destination, base]).status).toBe(0);
    const entry = join(destination, 'entry.txt');
    writeFileSync(entry, 'before\n');
    const wrapper = sabotageGit(
      parent,
      'is_target_hash=\nfor arg in "$@"; do\n  [ "$arg" = entry.txt ] && is_target_hash=1\ndone\nif [ -n "$is_target_hash" ]; then\n  "$REAL_GIT" "$@" || exit $?\n  n=$(cat "$HASH_COUNT" 2>/dev/null || printf 0)\n  n=$((n + 1))\n  printf "%s\\n" "$n" > "$HASH_COUNT"\n  [ "$n" -eq 1 ] && printf changed > "$MUTATE_PATH"\n  exit 0\nfi\nexec "$REAL_GIT" "$@"',
    );

    const result = runHelper('review_capture_untracked', [destination, manifest], {
      ...GIT_ENV,
      ...wrapper,
      HASH_COUNT: counter,
      MUTATE_PATH: entry,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changed during integrity capture');
    expect(existsSync(manifest)).toBe(false);
  });
});
