import { execFileSync } from 'node:child_process';
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

// sc-4159: sibling sessions share the common .git, so their ref writes must not abort a review whose
// snapshot is already pinned by HEAD and tree IDs.
describe('review repository state ignores shared ref churn (sc-4159)', () => {
  it.each([
    ['a new local branch', ['update-ref', 'refs/heads/sibling', 'HEAD']],
    ['a moved remote-tracking ref', ['commit-tree', '-m', 'fetched']],
    ['a deleted remote-tracking ref', ['update-ref', '-d', 'refs/remotes/origin/main']],
    ['a re-pointed remote symref', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main']],
    ['a created tag', ['tag', 'created-after-capture']],
    ['a notes ref', ['notes', '--ref=review', 'add', '-m', 'review note', 'HEAD']],
    ['packed refs', ['pack-refs', '--all']],
  ])('verifies after %s', (_label, args) => {
    const target = repositoryStateFixture(mkTmp, 'devkit review repository shared-ref-');
    const captured = captureReviewRepositoryState(target.root, target.manifest);

    if (args[0] === 'commit-tree') {
      const fetched = target.git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', ...args.slice(1));
      target.git('update-ref', 'refs/remotes/origin/main', fetched);
    } else {
      target.git(...args);
    }

    expect(verifyReviewRepositoryState(target.root, target.manifest)).toEqual(captured);
  });

  it('verifies a linked worktree while a sibling worktree commits and is removed', () => {
    const { parent, git, env } = repositoryStateFixture(mkTmp, 'devkit review repository sibling-');
    const linked = join(parent, 'reviewed');
    const sibling = join(parent, 'sibling');
    git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'reviewed', linked);
    const manifest = join(parent, 'reviewed.json');
    const captured = captureReviewRepositoryState(linked, manifest);

    git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'sibling', sibling);
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'sibling work'], {
      cwd: sibling,
      env,
    });
    git('-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--force', sibling);
    git('pack-refs', '--all');

    expect(verifyReviewRepositoryState(linked, manifest)).toEqual(captured);
  });

  it('still fails when the reviewed worktree gains a per-worktree ref', () => {
    const { parent, git, env } = repositoryStateFixture(mkTmp, 'devkit review repository bisect-');
    const linked = join(parent, 'reviewed');
    git('-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
    const manifest = join(parent, 'reviewed.json');
    captureReviewRepositoryState(linked, manifest);

    execFileSync('git', ['update-ref', 'refs/bisect/bad', 'HEAD'], { cwd: linked, env });

    expect(() => verifyReviewRepositoryState(linked, manifest)).toThrow(
      /repository metadata changed after capture/,
    );
  });

  it('succeeds when an unrelated branch is created and deleted mid-capture', () => {
    const target = repositoryStateFixture(mkTmp, 'devkit review repository shared-aba-');
    let seamRuns = 0;

    const captured = captureReviewRepositoryState(target.root, target.manifest, {
      afterFirstCapture: () => {
        seamRuns += 1;
        if (seamRuns > 1) return;
        target.git('update-ref', 'refs/heads/capture-aba', 'HEAD');
        target.git('update-ref', '-d', 'refs/heads/capture-aba');
      },
    });

    // A ref delete takes packed-refs.lock in the admin dir; that churn is re-captured, never fatal.
    expect(seamRuns).toBeLessThanOrEqual(2);
    expect(verifyReviewRepositoryState(target.root, target.manifest)).toEqual(captured);
  });
});
