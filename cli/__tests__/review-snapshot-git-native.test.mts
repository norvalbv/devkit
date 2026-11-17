import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  GIT_ENV,
  initializeSnapshotRepo,
  mkTmp,
  readTree,
  runSnapshotTrees,
  runWorktreeHelper,
  snapshotFixture,
} from './review-snapshot-fixture.mts';

afterEach(cleanup);

type Trees = { staged: string; raw: string };

function capture(root: string, env: NodeJS.ProcessEnv): Trees {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' });
  const result = runSnapshotTrees(root, head.trim(), env);
  expect(result.status, result.stderr).toBe(0);
  const [staged, raw] = result.stdout.trim().split(' ');
  return { staged, raw };
}

function createWorktree(root: string, env: NodeJS.ProcessEnv) {
  const destination = join(mkTmp('devkit review git-native worktree-'), 'snapshot');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' });
  const created = runWorktreeHelper(
    'review_create_worktree',
    [root, destination, head.trim()],
    env,
  );
  expect(created.status, created.stderr).toBe(0);
  return destination;
}

function materialize(root: string, env: NodeJS.ProcessEnv, trees: Trees) {
  const destination = createWorktree(root, env);
  const result = runWorktreeHelper(
    'review_materialize_tree',
    [destination, trees.staged, trees.raw],
    env,
  );
  expect(result.status, result.stderr).toBe(0);
  return destination;
}

/** Puts a `git` on PATH that runs `prelude` (a shell snippet) before handing off to the real one. */
function wrapGit(env: NodeJS.ProcessEnv, prelude: string) {
  const bin = mkTmp('devkit review git wrapper-');
  const realGit = execFileSync('/bin/bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${prelude}\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return { ...env, PATH: `${bin}:${env.PATH}` };
}

function verify(destination: string, env: NodeJS.ProcessEnv, trees: Trees) {
  return runWorktreeHelper(
    'review_worktree_matches_tree',
    [destination, trees.raw, trees.staged],
    env,
  );
}

describe('git-native review snapshot plumbing', () => {
  it('keeps raw bytes when conversions are declared only in .git/info/attributes', () => {
    const { root, env, git } = snapshotFixture();
    const marker = join(mkTmp('devkit review smudge marker-'), 'smudged');
    git(['config', 'filter.rewrite.clean', "sed 's/^/cleaned: /'"]);
    git(['config', 'filter.rewrite.smudge', `touch '${marker}'; cat`]);
    git(['config', 'filter.rewrite.required', 'true']);
    git(['config', 'core.eol', 'crlf']);
    writeFileSync(
      join(root, '.git/info/attributes'),
      'filtered.txt filter=rewrite\ncrlf.txt text eol=crlf\nlegacy.txt crlf\n',
    );
    writeFileSync(join(root, 'filtered.txt'), 'raw bytes\n');
    writeFileSync(join(root, 'crlf.txt'), 'one\r\ntwo\r\n');
    writeFileSync(join(root, 'legacy.txt'), 'legacy lf\n');

    const trees = capture(root, env);
    const raw = readTree(root, trees.raw, env);
    expect(raw.get('filtered.txt')?.content.toString()).toBe('raw bytes\n');
    expect(raw.get('crlf.txt')?.content.toString()).toBe('one\r\ntwo\r\n');
    expect(readTree(root, trees.staged, env).get('filtered.txt')?.content.toString()).toBe(
      'cleaned: raw bytes\n',
    );

    const destination = materialize(root, env, trees);
    expect(readFileSync(join(destination, 'filtered.txt'), 'utf8')).toBe('raw bytes\n');
    expect(readFileSync(join(destination, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    expect(readFileSync(join(destination, 'legacy.txt'), 'utf8')).toBe('legacy lf\n');
    expect(existsSync(marker)).toBe(false);
    const matched = verify(destination, env, trees);
    expect(matched.status, matched.stderr).toBe(0);
    expect(matched.stderr).toBe('');
  });

  it('ignores untracked gate output and names each tracked entry that changed', () => {
    const { root, env } = snapshotFixture();
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(root, 'run.sh'), 0o755);
    const trees = capture(root, env);
    const destination = materialize(root, env, trees);

    writeFileSync(join(destination, 'gate-cache.json'), '{}\n');
    expect(verify(destination, env, trees).status).toBe(0);

    chmodSync(join(destination, 'run.sh'), 0o654);
    const modeChanged = verify(destination, env, trees);
    expect(modeChanged.status).toBe(1);
    expect(modeChanged.stderr).toContain('tracked snapshot entry changed: run.sh');

    chmodSync(join(destination, 'run.sh'), 0o755);
    writeFileSync(join(destination, 'tracked.txt'), 'gate rewrote this\n');
    const bytesChanged = verify(destination, env, trees);
    expect(bytesChanged.status).toBe(1);
    expect(bytesChanged.stderr).toContain('tracked snapshot entry changed: tracked.txt');
    expect(bytesChanged.stderr).not.toContain('run.sh');

    writeFileSync(join(destination, 'tracked.txt'), 'tracked base\n');
    rmSync(join(destination, 'partial.txt'));
    const deleted = verify(destination, env, trees);
    expect(deleted.status).toBe(1);
    expect(deleted.stderr).toContain('tracked snapshot entry changed: partial.txt');
  });

  it('detects a mode change even when the repository sets core.fileMode=false', () => {
    const { root, env, git } = snapshotFixture();
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(root, 'run.sh'), 0o755);
    const trees = capture(root, env);
    const destination = materialize(root, env, trees);
    git(['config', 'core.fileMode', 'false']);

    chmodSync(join(destination, 'run.sh'), 0o644);

    const result = verify(destination, env, trees);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tracked snapshot entry changed: run.sh');
  });

  it('keeps each mode paired with its own bytes across the 256-path hash batch boundary', () => {
    const { root, env } = snapshotFixture();
    mkdirSync(join(root, 'many'));
    for (let i = 0; i < 300; i += 1) {
      const name = join(root, 'many', `f${String(i).padStart(3, '0')}`);
      writeFileSync(name, `file ${i}\n`);
      if (i % 7 === 0) chmodSync(name, 0o755);
    }

    const trees = capture(root, env);
    const raw = readTree(root, trees.raw, env);
    for (let i = 0; i < 300; i += 1) {
      const entry = raw.get(`many/f${String(i).padStart(3, '0')}`);
      expect(entry?.content.toString()).toBe(`file ${i}\n`);
      expect(entry?.mode).toBe(i % 7 === 0 ? '100755' : '100644');
    }
    const destination = materialize(root, env, trees);
    expect(verify(destination, env, trees).status).toBe(0);
  });

  it('rejects only real .git path components, in any letter case', () => {
    const check = (path: string) =>
      runWorktreeHelper('_review_tree_safe_path', [path], GIT_ENV).status;

    for (const path of ['.git/config', 'a/.GiT/b', 'a/.git']) expect(check(path), path).toBe(1);
    for (const path of ['.github/workflows/ci.yml', '.gitignore', 'a.git/b', 'x/.gitkeep']) {
      expect(check(path), path).toBe(0);
    }
  });

  it('records an executable bit only when the owner can execute, in both trees', () => {
    const { root, env } = snapshotFixture();
    writeFileSync(join(root, 'group-only.sh'), '#!/bin/sh\n');
    chmodSync(join(root, 'group-only.sh'), 0o654);

    const trees = capture(root, env);

    expect(readTree(root, trees.staged, env).get('group-only.sh')?.mode).toBe('100644');
    expect(readTree(root, trees.raw, env).get('group-only.sh')?.mode).toBe('100644');
  });

  it('gives an untracked embedded repository the same gitlink in both trees', () => {
    const { root, env } = snapshotFixture();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const nestedGit = (args: string[]) =>
      execFileSync('git', args, { cwd: nested, env, encoding: 'utf8' });
    nestedGit(['init', '-q', '-b', 'main']);
    writeFileSync(join(nested, 'inner.txt'), 'inner\n');
    nestedGit(['add', 'inner.txt']);
    nestedGit([
      '-c',
      'user.name=Nested',
      '-c',
      'user.email=nested@test.invalid',
      'commit',
      '-qm',
      'n',
    ]);
    const nestedHead = nestedGit(['rev-parse', 'HEAD']).trim();

    const trees = capture(root, env);

    for (const tree of [trees.staged, trees.raw]) {
      const entry = execFileSync('git', ['ls-tree', tree, '--', 'nested'], {
        cwd: root,
        env,
        encoding: 'utf8',
      });
      expect(entry).toBe(`160000 commit ${nestedHead}\tnested\n`);
    }
  });

  it('captures, materializes, and verifies a SHA-256 repository', () => {
    const root = mkTmp('devkit review sha256-');
    const env = { ...GIT_ENV, HOME: root, GIT_DEFAULT_HASH: 'sha256' };
    initializeSnapshotRepo(root, env);
    writeFileSync(join(root, 'tracked.txt'), 'sha256 change\n');

    const trees = capture(root, env);
    expect(trees.raw).toMatch(/^[0-9a-f]{64}$/);
    const destination = materialize(root, env, trees);

    expect(readFileSync(join(destination, 'tracked.txt'), 'utf8')).toBe('sha256 change\n');
    const matched = verify(destination, env, trees);
    expect(matched.status, matched.stderr).toBe(0);
  });

  it('writes raw bytes and stable modes under a converting global config', () => {
    const { root, env } = snapshotFixture();
    const globalConfig = join(mkTmp('devkit review global config-'), 'gitconfig');
    const marker = join(mkTmp('devkit review filter marker-'), 'ran');
    writeFileSync(
      globalConfig,
      `[core]\n\tautocrlf = true\n\teol = crlf\n[filter "lfs"]\n\tprocess = touch '${marker}'\n\trequired = true\n`,
    );
    const hostile = { ...env, GIT_CONFIG_GLOBAL: globalConfig, REVIEW_HELPER_UMASK: '077' };
    mkdirSync(join(root, 'deep/nested'), { recursive: true });
    writeFileSync(join(root, 'deep/nested/run.sh'), 'mixed\r\nlines\n');
    chmodSync(join(root, 'deep/nested/run.sh'), 0o755);
    writeFileSync(join(root, 'plain.txt'), 'plain\n');

    const trees = capture(root, hostile);
    const destination = materialize(root, hostile, trees);

    expect(readFileSync(join(destination, 'deep/nested/run.sh'), 'utf8')).toBe('mixed\r\nlines\n');
    expect(readFileSync(join(destination, 'plain.txt'), 'utf8')).toBe('plain\n');
    expect(statSync(join(destination, 'deep/nested/run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(destination, 'plain.txt')).mode & 0o777).toBe(0o644);
    expect(existsSync(marker)).toBe(false);
    expect(verify(destination, hostile, trees).status).toBe(0);
  });

  it('removes its scratch files when the bulk checkout fails', () => {
    const { root, env } = snapshotFixture();
    writeFileSync(join(root, 'plain.txt'), 'plain\n');
    const trees = capture(root, env);
    const destination = createWorktree(root, env);
    const temp = mkTmp('devkit review materialize temp-');
    const failing = wrapGit(
      { ...env, TMPDIR: temp },
      'for arg in "$@"; do [ "$arg" = checkout-index ] && exit 9; done',
    );

    const result = runWorktreeHelper(
      'review_materialize_tree',
      [destination, trees.staged, trees.raw],
      failing,
    );

    expect(result.status).toBe(1);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('bulk-checks out text and text=auto paths byte-exact under a CRLF repo config', () => {
    const { root, env, git } = snapshotFixture();
    git(['config', 'core.autocrlf', 'true']);
    git(['config', 'core.eol', 'crlf']);
    writeFileSync(join(root, '.gitattributes'), '* text=auto\n*.k text\n*.lf eol=lf\n');
    writeFileSync(join(root, 'auto.txt'), 'mixed\r\nendings\n');
    writeFileSync(join(root, 'set.k'), 'text set\n');
    writeFileSync(join(root, 'pinned.lf'), 'eol lf\n');
    const trees = capture(root, env);
    const destination = createWorktree(root, env);
    const perFileReads = join(mkTmp('devkit review cat-file log-'), 'reads');

    const result = runWorktreeHelper(
      'review_materialize_tree',
      [destination, trees.staged, trees.raw],
      wrapGit(env, `case " $* " in *" cat-file "*) echo "$*" >> '${perFileReads}' ;; esac`),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(destination, 'auto.txt'), 'utf8')).toBe('mixed\r\nendings\n');
    expect(readFileSync(join(destination, 'set.k'), 'utf8')).toBe('text set\n');
    expect(readFileSync(join(destination, 'pinned.lf'), 'utf8')).toBe('eol lf\n');
    expect(existsSync(perFileReads) ? readFileSync(perFileReads, 'utf8') : '').toBe('');
    expect(verify(destination, env, trees).status).toBe(0);
  });
});
