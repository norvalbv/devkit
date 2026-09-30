/** Hook-free, bounded git spawns for the repository-state capture; failures name what was read. */
import { spawnSync } from 'node:child_process';
import { errorMessage, fail, gitEnvironment } from '../shared/common.mjs';
export const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
export function spawnGit(root, args) {
    return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
        env: gitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT,
    });
}
export function gitFailure(label, result) {
    if (result.error)
        fail(`could not ${label} (${errorMessage(result.error)}).`);
    const detail = result.stderr.toString().trim();
    fail(`could not ${label} (git exited ${String(result.status)}${detail ? `: ${detail}` : ''}).`);
}
export function gitRaw(root, args, label) {
    const result = spawnGit(root, args);
    if (result.status !== 0)
        gitFailure(label, result);
    return result.stdout;
}
export function gitOptionalRaw(root, args, label) {
    const result = spawnGit(root, args);
    if (result.status === 0)
        return result.stdout;
    if (result.status === 1 && result.stdout.length === 0 && result.stderr.length === 0)
        return Buffer.alloc(0);
    return gitFailure(label, result);
}
export function gitLine(root, args, label) {
    const raw = gitRaw(root, args, label);
    if (raw.length === 0 || raw[raw.length - 1] !== 0x0a)
        fail(`${label} returned malformed output.`);
    return raw.subarray(0, -1);
}
