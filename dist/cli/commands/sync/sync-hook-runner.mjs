/**
 * `devkit sync-hook-runner` — make THIS checkout gate itself with its own hooks.
 *
 * Two halves of one guarantee, both about a hook runner that a checkout cannot reach:
 *
 * 1. Stage (`git add -f`) whatever husky-generated runner files this repo needs that are currently
 *    untracked AND gitignored. Husky pins a RELATIVE `core.hooksPath` (`.husky/_`) and gitignores the
 *    runner it points at (`.husky/_/.gitignore` = `*`), so a linked worktree checks out with
 *    hooksPath resolving to a MISSING directory — git treats "no runner" as "no hooks", and every
 *    commit made there is silently ungated. Tracking the runner fixes it permanently: a tracked file
 *    checks out into every worktree, so the relative path resolves everywhere.
 *
 * 2. Replace a per-checkout `core.hooksPath` left pinned at ANOTHER checkout's runner. That pin is the
 *    older workaround for exactly the same problem — when a fresh worktree had no runner of its own,
 *    borrowing the main checkout's beat having none. Once (1) holds it stops being a workaround and
 *    becomes a bug: commits made here run the OTHER checkout's version of the hook, off the OTHER
 *    checkout's branch, with no error. Order matters — staging first can be what makes this checkout
 *    self-gated, and the pin is only replaced with the validated shared relative path once it is.
 *
 * `devkit init` chains this into a fresh package-mode install's `prepare` script, so no NEW repo ever
 * needs a manual `git add -f` — every `bun install` re-stages the runner and re-checks the pin.
 *
 * A dedicated, explicitly-invoked command rather than folded into `devkit doctor --fix`: --fix only
 * ever regenerates FILE content from the recorded selection, never mutates the git INDEX or git
 * CONFIG — both are things the caller (a human, or their own prepare script) must ask for.
 *
 *   devkit sync-hook-runner [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { detectGitRoot } from '../../lib/detect-git-root.mjs';
import { checkHookRunner, replaceableHooksPathPin, unreachableRunnerFiles, } from '../../lib/doctor/hook-checks.mjs';
import { sharedHooksPath, worktreeHooksPathState } from '../../lib/doctor/hooks-path.mjs';
export const meta = {
    name: 'sync-hook-runner',
    summary: 'Make this checkout run its OWN hooks (stage the runner; replace a sibling hooksPath pin).',
    help: `devkit sync-hook-runner — make this checkout gate itself with its own hooks.

Usage:
  devkit sync-hook-runner [--dry-run]

Force-adds whatever husky-generated runner files this repo needs that are untracked AND gitignored,
so a fresh \`git worktree add\` can reach them. Then, if this checkout pins core.hooksPath at ANOTHER
checkout's runner — the older workaround for that same gap — replaces that exact value with the
validated shared relative path, but only once this checkout provably gates itself.

Exits 0 when there is nothing to do. Only ever touches a PER-CHECKOUT pin; a repo-wide
core.hooksPath is reported by \`devkit doctor\` and left alone. External central paths are never
replaced. Chained into a fresh \`devkit init\`'s
package.json "prepare" script — every \`bun install\` self-heals, so this rarely needs a manual run.`,
};
/** Restore the exact pre-write config only when nobody has changed our candidate since the failed
 * verification. Re-acquiring Git's lock and comparing bytes makes rollback another CAS operation,
 * rather than overwriting a writer that raced with the verifier. */
function restoreConfig(file, original, candidate) {
    const lockPath = `${file}.lock`;
    let ownsLock = false;
    try {
        const lock = openSync(lockPath, 'wx');
        ownsLock = true;
        closeSync(lock);
        if (!readFileSync(file).equals(candidate))
            throw new Error('the replacement changed again before rollback');
        writeFileSync(lockPath, original);
        renameSync(lockPath, file);
        ownsLock = false;
        return true;
    }
    catch {
        if (ownsLock)
            rmSync(lockPath, { force: true });
        return false;
    }
}
/** Replace the exact sibling value while holding Git's own config.worktree lock. Git's
 * `--fixed-value --replace-all` APPENDS when the old value no longer matches, so invoking it against
 * the live file is not compare-and-swap. Instead we acquire the lock, revalidate the live value,
 * transform a private copy through Git's parser, and atomically rename that copy into place. */
export function replacePin(cwd, gitRoot, pin) {
    let lockPath = '';
    let ownsLock = false;
    let replacedFile = '';
    let original = null;
    let candidateContents = null;
    try {
        const before = worktreeHooksPathState(gitRoot);
        if (before.status !== 'single' || before.value !== pin.from)
            throw new Error('the worktree value changed before replacement');
        lockPath = `${before.file}.lock`;
        const lock = openSync(lockPath, 'wx');
        ownsLock = true;
        closeSync(lock);
        // A writer may have won immediately before our lock. Re-read the LIVE file only after every
        // cooperating Git writer is excluded, then abort unless the captured repair plan is still exact.
        const locked = worktreeHooksPathState(gitRoot);
        if (locked.status !== 'single' || locked.file !== before.file || locked.value !== pin.from)
            throw new Error('the worktree value changed while acquiring the config lock');
        const revalidated = replaceableHooksPathPin(cwd);
        if (!revalidated || revalidated.from !== pin.from || revalidated.to !== pin.to)
            throw new Error('this checkout stopped being a safe replacement target');
        original = readFileSync(locked.file);
        copyFileSync(locked.file, lockPath);
        execFileSync('git', [
            '-C',
            gitRoot,
            'config',
            '--file',
            lockPath,
            '--fixed-value',
            '--replace-all',
            'core.hooksPath',
            pin.to,
            pin.from,
        ], { stdio: ['ignore', 'ignore', 'ignore'] });
        const candidate = execFileSync('git', ['-C', gitRoot, 'config', '--file', lockPath, '--null', '--get-all', 'core.hooksPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\0')
            .filter((value, index, all) => value !== '' || index < all.length - 1);
        if (candidate.length !== 1 || candidate[0] !== pin.to)
            throw new Error('the locked replacement did not produce one exact fallback value');
        candidateContents = readFileSync(lockPath);
        renameSync(lockPath, locked.file);
        ownsLock = false;
        replacedFile = locked.file;
    }
    catch (e) {
        if (ownsLock)
            rmSync(lockPath, { force: true });
        const msg = e instanceof Error ? e.message.split('\n')[0] : '';
        console.log(`devkit sync-hook-runner: did not replace core.hooksPath (${msg || 'the value changed or git refused the update'}) — the live config was left intact`);
        return false;
    }
    const after = worktreeHooksPathState(gitRoot);
    if (after.status !== 'single' ||
        after.value !== pin.to ||
        sharedHooksPath(gitRoot) !== pin.to ||
        checkHookRunner(cwd).status !== 'OK') {
        const restored = original !== null && candidateContents !== null
            ? restoreConfig(replacedFile, original, candidateContents)
            : false;
        console.log(`devkit sync-hook-runner: the locked core.hooksPath replacement did not verify cleanly and ${restored ? 'the prior pin was restored' : 'could not be rolled back safely'} — inspect with 'devkit doctor'`);
        return false;
    }
    console.log(`devkit sync-hook-runner: replaced sibling core.hooksPath ${pin.from} with ${pin.to} — this checkout now runs its own hooks`);
    return true;
}
export default function run(args, cwd) {
    const { gitRoot } = detectGitRoot(cwd);
    const dryRun = args.includes('--dry-run');
    const files = unreachableRunnerFiles(gitRoot);
    if (files.length && dryRun)
        console.log(`devkit sync-hook-runner: [dry-run] would git add -f ${files.join(' ')}`);
    else if (files.length) {
        execFileSync('git', ['-C', gitRoot, 'add', '-f', ...files], { stdio: 'inherit' });
        console.log(`devkit sync-hook-runner: staged ${files.join(', ')}`);
    }
    // Read AFTER staging: force-adding the runner is one of the things that can make this checkout
    // self-gated, and therefore make the pin safe to drop in the same run.
    const pin = replaceableHooksPathPin(cwd);
    if (pin && dryRun)
        console.log(`devkit sync-hook-runner: [dry-run] would replace sibling core.hooksPath ${pin.from} with ${pin.to}`);
    else if (pin && !replacePin(cwd, gitRoot, pin))
        return 1;
    if (!files.length && !pin)
        console.log('devkit sync-hook-runner: this checkout already runs its own hooks — nothing to do');
    return 0;
}
