import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureReviewRepositoryState,
  verifyReviewRepositoryState,
} from '../lib/ship/review/repository/state.mts';
import { rootRegistry } from './_helpers.mts';
import { repositoryStateFixture } from './_review-repository-state-fixture.mts';

const { mkTmp, cleanup } = rootRegistry();

afterEach(cleanup);

// sc-4171: sibling sessions write their own `branch.<name>.*` upstreams into the shared config;
// only the reviewed checkout's branch and non-branch keys shape the review.
describe('review repository state ignores sibling branch config (sc-4171)', () => {
  it.each([
    ['push -u style upstream', ['config', 'branch.sibling.remote', 'origin']],
    ['dotted branch name', ['config', 'branch.feat.sub.merge', 'refs/heads/feat.sub']],
    ['a removed sibling section', ['config', 'branch.gone.remote', 'origin']],
  ])('verifies after a sibling writes %s', (label, args) => {
    const target = repositoryStateFixture(mkTmp, 'devkit review repository sibling-config-');
    if (label === 'a removed sibling section') target.git(...args);
    const captured = captureReviewRepositoryState(target.root, target.manifest);

    if (label === 'a removed sibling section') {
      target.git('config', '--remove-section', 'branch.gone');
    } else {
      target.git(...args);
    }

    expect(verifyReviewRepositoryState(target.root, target.manifest)).toEqual(captured);
  });

  it('verifies a linked worktree while a sibling worktree tracks and pushes its own branch', () => {
    const { parent, git, env } = repositoryStateFixture(mkTmp, 'devkit review repository track-');
    git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    const linked = join(parent, 'reviewed');
    git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'reviewed', linked);
    const manifest = join(parent, 'reviewed.json');
    const captured = captureReviewRepositoryState(linked, manifest);

    const sibling = join(parent, 'sibling');
    git(
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '-q',
      '--track',
      '-b',
      'sibling',
      sibling,
      'origin/main',
    );
    execFileSync('git', ['config', 'branch.sibling.pushRemote', 'origin'], { cwd: sibling, env });

    expect(verifyReviewRepositoryState(linked, manifest)).toEqual(captured);
  });

  it('ignores a comment-only edit to the shared config file', () => {
    const target = repositoryStateFixture(mkTmp, 'devkit review repository config-comment-');
    const captured = captureReviewRepositoryState(target.root, target.manifest);
    appendFileSync(join(target.root, '.git', 'config'), '# sibling session comment\n');
    expect(verifyReviewRepositoryState(target.root, target.manifest)).toEqual(captured);
  });

  it('still fails when the reviewed branch or a non-branch key changes', () => {
    const own = repositoryStateFixture(mkTmp, 'devkit review repository own-branch-config-');
    captureReviewRepositoryState(own.root, own.manifest);
    own.git('config', 'branch.main.pushRemote', 'review-push');
    expect(() => verifyReviewRepositoryState(own.root, own.manifest)).toThrow(
      /repository metadata changed after capture/,
    );

    const core = repositoryStateFixture(mkTmp, 'devkit review repository core-config-');
    captureReviewRepositoryState(core.root, core.manifest);
    core.git('config', 'core.hooksPath', '.hooks');
    expect(() => verifyReviewRepositoryState(core.root, core.manifest)).toThrow(
      /repository metadata changed after capture/,
    );
  });

  it('ignores every branch section while HEAD is detached', () => {
    const target = repositoryStateFixture(mkTmp, 'devkit review repository detached-config-');
    target.git('-c', 'core.hooksPath=/dev/null', 'switch', '--detach', '-q');
    const captured = captureReviewRepositoryState(target.root, target.manifest);

    target.git('config', 'branch.main.pushRemote', 'review-push');

    expect(verifyReviewRepositoryState(target.root, target.manifest)).toEqual(captured);
  });

  it('still fails when an included file adds an entry for the reviewed branch', () => {
    const target = repositoryStateFixture(mkTmp, 'devkit review repository include-branch-');
    const includePath = join(target.parent, 'branch-include.config');
    writeFileSync(includePath, '');
    target.git('config', 'include.path', includePath);
    captureReviewRepositoryState(target.root, target.manifest);

    writeFileSync(includePath, '[branch "main"]\n\trebase = true\n');

    expect(() => verifyReviewRepositoryState(target.root, target.manifest)).toThrow(
      /repository metadata changed after capture/,
    );
  });
});
