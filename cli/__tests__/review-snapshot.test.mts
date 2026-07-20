import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  failNullEmitterEnvironment,
  failUpdateIndexEnvironment,
  GIT_ENV,
  indexBytes,
  initializeSnapshotRepo,
  mkTmp,
  postFirstCaptureMutation,
  readTree,
  runSnapshot,
  runSnapshotTrees,
  signalBeforeTempEnvironment,
  snapshotFixture,
  snapshotMatches,
} from './review-snapshot-fixture.mts';

afterEach(cleanup);

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
    symlinkSync('tracked.txt\n\n', join(root, 'replace.txt'));
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
    expect(entries.get('replace.txt')?.content.toString()).toBe('tracked.txt\n\n');
    expect(entries.get('run.sh')).toMatchObject({ mode: '100755' });
    expect(entries.get('line\nbreak.txt')?.content.toString()).toBe('newline path\n');
    expect(entries.has('secret.txt')).toBe(false);
    expect(entries.get('forced.txt')?.content.toString()).toBe('final force-staged bytes\n');
    expect(git(['rev-parse', 'HEAD'])).toBe(before.head);
    expect(indexBytes(root, git)).toEqual(before.index);
    expect(git(['show-ref'])).toBe(before.refs);
    expect(git(['status', '--porcelain=v1'])).toBe(before.status);
  });

  it('captures a 0644 to 0755 change when core.fileMode=false hides it from Git', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    git(['config', 'core.fileMode', 'false']);
    chmodSync(join(root, 'tracked.txt'), 0o755);
    expect(git(['status', '--porcelain=v1', '--', 'tracked.txt'])).toBe('');

    const result = runSnapshotTrees(root, targetHead, env);

    expect(result.status, result.stderr).toBe(0);
    const [stagedTree, rawTree] = result.stdout.trim().split(' ');
    expect(readTree(root, stagedTree, env).get('tracked.txt')?.mode).toBe('100755');
    expect(readTree(root, rawTree, env).get('tracked.txt')?.mode).toBe('100755');
  });

  it('captures a 0755 to 0644 change when core.fileMode=false hides it from Git', () => {
    const { root, env, git } = snapshotFixture();
    chmodSync(join(root, 'tracked.txt'), 0o755);
    git(['add', 'tracked.txt']);
    git(['commit', '-q', '-m', 'make tracked executable']);
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    git(['config', 'core.fileMode', 'false']);
    chmodSync(join(root, 'tracked.txt'), 0o644);
    expect(git(['status', '--porcelain=v1', '--', 'tracked.txt'])).toBe('');

    const result = runSnapshotTrees(root, targetHead, env);

    expect(result.status, result.stderr).toBe(0);
    const [stagedTree, rawTree] = result.stdout.trim().split(' ');
    expect(readTree(root, stagedTree, env).get('tracked.txt')?.mode).toBe('100644');
    expect(readTree(root, rawTree, env).get('tracked.txt')?.mode).toBe('100644');
  });

  it('hashes working-tree bytes without configured clean filters', () => {
    const { root, env, git } = snapshotFixture();
    writeFileSync(join(root, '.gitattributes'), 'filtered.txt filter=snapshot-rewrite\n');
    writeFileSync(join(root, 'filtered.txt'), 'committed bytes\n');
    git(['add', '.gitattributes', 'filtered.txt']);
    git(['commit', '-q', '-m', 'add filtered file']);
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    git(['config', 'filter.snapshot-rewrite.clean', "sed 's/^/cleaned: /'"]);
    git(['config', 'filter.snapshot-rewrite.smudge', 'cat']);
    git(['config', 'filter.snapshot-rewrite.required', 'true']);
    writeFileSync(join(root, 'filtered.txt'), 'raw final bytes\n');
    expect(git(['hash-object', '--', 'filtered.txt']).trim()).not.toBe(
      git(['hash-object', '--no-filters', '--', 'filtered.txt']).trim(),
    );
    const beforeIndex = indexBytes(root, git);

    const result = runSnapshotTrees(root, targetHead, env);

    expect(result.status, result.stderr).toBe(0);
    const [stagedTree, rawTree] = result.stdout.trim().split(' ');
    expect(readTree(root, stagedTree, env).get('filtered.txt')?.content.toString()).toBe(
      'cleaned: raw final bytes\n',
    );
    expect(readTree(root, rawTree, env).get('filtered.txt')?.content.toString()).toBe(
      'raw final bytes\n',
    );
    expect(indexBytes(root, git)).toEqual(beforeIndex);
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

  it('captures a nested consumer as a whole-repository snapshot with target-scoped exclusions', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    const target = join(root, 'packages', 'consumer');
    const sibling = join(root, 'packages', 'sibling');
    const projection = mkTmp('devkit nested snapshot projection-');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(sibling, '.devkit/review-runs'), { recursive: true });
    mkdirSync(join(root, '.husky'));
    mkdirSync(join(target, '.devkit/review-runs'), { recursive: true });
    mkdirSync(join(target, 'cache'));
    mkdirSync(join(projection, 'hook-runner'));
    writeFileSync(join(root, '.husky/team.txt'), 'root husky neighbor\n');
    writeFileSync(join(projection, 'hook-runner/pre-commit'), 'generated runner\n');
    symlinkSync(join(projection, 'hook-runner'), join(root, '.husky/_'));
    writeFileSync(join(target, '.devkit/review-runs/run.log'), 'generated review log\n');
    writeFileSync(join(target, 'target.txt'), 'nested consumer change\n');
    writeFileSync(join(sibling, 'sibling.txt'), 'sibling repository change\n');
    writeFileSync(
      join(sibling, '.devkit/review-runs/keep.log'),
      'different consumer review state\n',
    );
    writeFileSync(join(root, 'guard.config.json'), '{"scanRoots":["packages"]}\n');
    writeFileSync(join(projection, 'guard.json'), '{"indexPath":"cache/index.db"}\n');
    writeFileSync(join(projection, 'index.db'), 'generated target index\n');
    symlinkSync(join(projection, 'guard.json'), join(target, 'guard.config.json'));
    symlinkSync(join(projection, 'index.db'), join(target, 'cache/index.db'));
    writeFileSync(
      join(root, '.gitignore'),
      '!/.husky/_\n!/packages/consumer/.devkit/review-runs/**\n',
    );
    const before = {
      index: indexBytes(root, git),
      status: git(['status', '--porcelain=v1']),
    };

    const result = runSnapshot(target, targetHead, env);

    expect(result.status, result.stderr).toBe(0);
    const tree = result.stdout.trim();
    const entries = readTree(root, tree, env);
    expect(entries.has('.husky/_')).toBe(false);
    expect(entries.has('packages/consumer/.devkit/review-runs/run.log')).toBe(false);
    expect(entries.has('packages/consumer/guard.config.json')).toBe(false);
    expect(entries.has('packages/consumer/cache/index.db')).toBe(false);
    expect(entries.get('.husky/team.txt')?.content.toString()).toBe('root husky neighbor\n');
    expect(entries.get('guard.config.json')?.content.toString()).toBe(
      '{"scanRoots":["packages"]}\n',
    );
    expect(entries.get('packages/consumer/target.txt')?.content.toString()).toBe(
      'nested consumer change\n',
    );
    expect(entries.get('packages/sibling/sibling.txt')?.content.toString()).toBe(
      'sibling repository change\n',
    );
    expect(entries.get('packages/sibling/.devkit/review-runs/keep.log')?.content.toString()).toBe(
      'different consumer review state\n',
    );
    expect(snapshotMatches(target, targetHead, tree, env).status).toBe(0);
    expect(indexBytes(root, git)).toEqual(before.index);
    expect(git(['status', '--porcelain=v1'])).toBe(before.status);
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
    writeFileSync(join(root, 'tracked.txt'), 'first bytes\n');
    const mutationEnv = postFirstCaptureMutation(root);

    const result = runSnapshot(root, targetHead, {
      ...env,
      ...mutationEnv,
      MUTATION_PATH: join(root, 'tracked.txt'),
      MUTATION_CONTENT: 'other bytes\n',
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

    const failure = runSnapshot(root, targetHead, {
      ...env,
      TMPDIR: temp,
      ...failUpdateIndexEnvironment(root, env.PATH),
    });
    expect(failure.status).toBe(1);
    expect(readdirSync(temp)).toEqual([]);

    const emitterFailure = runSnapshot(root, targetHead, {
      ...env,
      TMPDIR: temp,
      ...failNullEmitterEnvironment(root, env.PATH),
    });
    expect(emitterFailure.status).toBe(1);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('preserves the promised signal status before temporary state is allocated', () => {
    const { root, env, git } = snapshotFixture();
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    const result = runSnapshot(root, targetHead, {
      ...env,
      ...signalBeforeTempEnvironment(root, env.PATH),
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
