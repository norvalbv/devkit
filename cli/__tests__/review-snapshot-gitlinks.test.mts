import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, mkTmp, runSnapshotTrees, snapshotFixture } from './review-snapshot-fixture.mts';

afterEach(cleanup);

describe('review snapshot gitlinks', () => {
  it('ignores an unstaged submodule checkout but captures a staged gitlink change', () => {
    const { root, env, git } = snapshotFixture();
    const moduleOrigin = mkTmp('devkit snapshot module origin-');
    const modulePath = 'modules/dependency';
    const moduleGit = (args: string[]) =>
      execFileSync('git', args, { cwd: moduleOrigin, env, encoding: 'utf8' });
    moduleGit(['init', '-q', '-b', 'main']);
    moduleGit(['config', 'user.name', 'Snapshot Test']);
    moduleGit(['config', 'user.email', 'snapshot@test.invalid']);
    writeFileSync(join(moduleOrigin, 'module.txt'), 'first\n');
    moduleGit(['add', 'module.txt']);
    moduleGit(['commit', '-q', '-m', 'first']);
    const first = moduleGit(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(moduleOrigin, 'module.txt'), 'second\n');
    moduleGit(['commit', '-q', '-am', 'second']);
    const second = moduleGit(['rev-parse', 'HEAD']).trim();

    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', moduleOrigin, modulePath]);
    execFileSync('git', ['checkout', '-q', first], { cwd: join(root, modulePath), env });
    git(['add', '.gitmodules', modulePath]);
    git(['commit', '-q', '-m', 'add dependency']);
    const targetHead = git(['rev-parse', 'HEAD']).trim();
    execFileSync('git', ['checkout', '-q', second], { cwd: join(root, modulePath), env });

    const unstaged = runSnapshotTrees(root, targetHead, env);

    expect(unstaged.status, unstaged.stderr).toBe(0);
    const [unstagedCanonical, unstagedRaw] = unstaged.stdout.trim().split(' ');
    const indexedEntry = `160000 commit ${first}\t${modulePath}`;
    expect(git(['ls-tree', unstagedCanonical, '--', modulePath]).trim()).toBe(indexedEntry);
    expect(git(['ls-tree', unstagedRaw, '--', modulePath]).trim()).toBe(indexedEntry);

    git(['add', '--', modulePath]);
    const staged = runSnapshotTrees(root, targetHead, env);

    expect(staged.status, staged.stderr).toBe(0);
    const [stagedCanonical, stagedRaw] = staged.stdout.trim().split(' ');
    const stagedEntry = `160000 commit ${second}\t${modulePath}`;
    expect(git(['ls-tree', stagedCanonical, '--', modulePath]).trim()).toBe(stagedEntry);
    expect(git(['ls-tree', stagedRaw, '--', modulePath]).trim()).toBe(stagedEntry);
  });
});
