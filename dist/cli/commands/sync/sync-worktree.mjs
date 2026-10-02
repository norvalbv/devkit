/** `devkit sync-worktree`: the overlay pre-commit's projector for a linked worktree, the same repair
 * `devkit doctor --fix` runs. Rationale: docs/decisions/overlay-self-heal.md. */
import { parseArgs } from 'node:util';
import { projectBorrowedOverlay } from '../../lib/husky/overlay/projection-report.mjs';
export const meta = {
    name: 'sync-worktree',
    agentFacing: false,
    notRoutedBecause: 'Run by the overlay pre-commit hook in a linked worktree before any gate; the command a ' +
        'person or agent runs for the same repair is devkit doctor --fix.',
    summary: "Project the overlay's gate inputs into this linked worktree (run by the overlay hook).",
    help: `devkit sync-worktree — project the overlay's gate inputs into this linked worktree.

Usage:
  devkit sync-worktree --home <overlay home> [--pkg <package dir>]

The overlay pre-commit hook runs this from a linked worktree whose projection has a gap, passing the
checkout that holds its own hook. It links the shared gate inputs and copies the branch-local ones
(lint overlay, ratchet baselines), exactly as devkit doctor --fix does. It exits 1 when a gap stays
open, which blocks the commit. The home itself, and a checkout with its own overlay, are left as they
are.`,
};
export default function run(args, cwd) {
    const { values } = parseArgs({
        args,
        options: { home: { type: 'string' }, pkg: { type: 'string', default: '' } },
    });
    if (!values.home)
        throw new Error('sync-worktree: --home <overlay home> is required');
    if (projectBorrowedOverlay(cwd, values.home, values.pkg))
        return 0;
    console.error("devkit: this worktree lacks the overlay's gate inputs listed above, so the commit is blocked — fix what they name, then commit again (devkit doctor --fix re-checks)");
    return 1;
}
