/**
 * `devkit sync-hook-runner` — stage (`git add -f`) whatever husky-generated runner files this repo
 * needs that are currently untracked AND gitignored, so a fresh `git worktree add` can actually
 * reach them.
 *
 * Husky pins a RELATIVE `core.hooksPath` (`.husky/_`) and gitignores the runner it points at
 * (`.husky/_/.gitignore` = `*`). A linked worktree checks out with hooksPath resolving to a MISSING
 * directory — git treats "no runner" as "no hooks", so every commit made there is silently ungated.
 * Tracking the runner (force-adding past husky's own ignore) fixes it permanently: a tracked file
 * checks out into every worktree, so the relative path resolves everywhere.
 *
 * `devkit init` chains this into a fresh package-mode install's `prepare` script, so no NEW repo
 * ever needs a manual `git add -f` — every `bun install` re-stages it if husky's install regenerated
 * an untracked runner (it never will once tracked, but the chain is idempotent either way).
 *
 * A dedicated, explicitly-invoked command rather than folded into `devkit doctor --fix`: --fix only
 * ever regenerates FILE content from the recorded selection, never mutates the git INDEX — staging
 * is something the caller (a human, or their own prepare script) must ask for.
 *
 *   devkit sync-hook-runner [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { detectGitRoot } from "../../lib/detect-git-root.mjs";
import { unreachableRunnerFiles } from "../../lib/doctor/hook-checks.mjs";
export const meta = {
    name: 'sync-hook-runner',
    summary: 'Stage the husky hook runner so it survives `git worktree add` (git add -f).',
    help: `devkit sync-hook-runner — force-add whatever husky-generated runner files this repo needs
that are untracked AND gitignored, so a fresh \`git worktree add\` can reach them.

Usage:
  devkit sync-hook-runner [--dry-run]

A no-op (exit 0) when the runner is already fully tracked, or when core.hooksPath is unset/absolute
(nothing in-repo to stage in either case). Chained into a fresh \`devkit init\`'s package.json
"prepare" script — every \`bun install\` self-heals, so this rarely needs a manual run.`,
};
export default function run(args, cwd) {
    const { gitRoot } = detectGitRoot(cwd);
    const files = unreachableRunnerFiles(gitRoot);
    if (!files.length) {
        console.log('devkit sync-hook-runner: hook runner already reachable — nothing to stage');
        return 0;
    }
    if (args.includes('--dry-run')) {
        console.log(`devkit sync-hook-runner: [dry-run] would git add -f ${files.join(' ')}`);
        return 0;
    }
    execFileSync('git', ['-C', gitRoot, 'add', '-f', ...files], { stdio: 'inherit' });
    console.log(`devkit sync-hook-runner: staged ${files.join(', ')}`);
    return 0;
}
