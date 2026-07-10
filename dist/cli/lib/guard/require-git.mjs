/**
 * Friendly preflight for the commands that shell out to git. Many devkit commands
 * (ship, move, release, update, clean, doctor, init) call `git` via execFileSync/spawnSync;
 * without git on PATH those throw a cryptic ENOENT deep inside a child_process call. assertGit
 * surfaces a clear, actionable error at the door instead — index.mjs's top-level catch prints it.
 */
import { spawnSync } from 'node:child_process';
/**
 * Throw a friendly Error when git is not installed / not on PATH. No-op when git is present.
 * @param cmd the devkit subcommand needing git (for the message)
 */
export function assertGit(cmd) {
    const r = spawnSync('git', ['--version']);
    const err = r.error;
    if (err?.code === 'ENOENT') {
        throw new Error(`git is not installed or not on PATH — \`devkit ${cmd}\` needs git. Install: https://git-scm.com/downloads`);
    }
}
