import { describe, expect, it } from 'vitest';
import { meta } from '../commands/ship.mts';

// An agent that ran `git switch -c <branch>` must learn from --help alone that ship refuses that
// branch and prints a rename, or it guesses and ships under a different name.
describe('devkit ship --help — branch checked out in this worktree', () => {
  it('names the refusal and the rename-then-rerun remedy', () => {
    expect(meta.help).toMatch(/<branch> checked out in this worktree/);
    expect(meta.help).toMatch(/`git branch -m` that frees the name[\s\S]*re-run with --base/);
  });
});
