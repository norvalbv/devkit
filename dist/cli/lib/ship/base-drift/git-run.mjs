/**
 * The single spawn boundary for base-drift. Non-zero is DATA here, not an error: `show-ref` exit 1
 * means the base does not exist, `merge-base --is-ancestor` exit 1 means we have drifted, and a
 * non-zero fetch means the freshness is unknown — which is why the repo's throwing git helpers
 * cannot be reused.
 */
import { spawnSync } from 'node:child_process';
import { gitEnvironment } from '../review/shared/common.mjs';
/** Local git calls are sub-100ms warm; this only has to be past any plausible cold cache. */
export const LOCAL_TIMEOUT_MS = 10_000;
/**
 * Build a runner bound to one checkout.
 *
 * `core.hooksPath=/dev/null` because this can run from inside a PreToolUse hook in a repo whose
 * own hooks would then re-enter. GIT_TERMINAL_PROMPT and the BatchMode ssh default matter for the
 * fetch specifically: without them an auth-prompting remote blocks on a tty that a hook does not
 * have, and the spawn timeout cannot reap a child that is waiting on input rather than the network.
 */
export function gitRunner(root, env) {
    const baseEnv = gitEnvironment({
        GIT_TERMINAL_PROMPT: '0',
        // A lazy fetch inside a partial clone would be an unbounded network call we never asked for.
        GIT_NO_LAZY_FETCH: '1',
        GIT_SSH_COMMAND: env?.GIT_SSH_COMMAND ??
            process.env.GIT_SSH_COMMAND ??
            'ssh -o BatchMode=yes -o ConnectTimeout=2',
    });
    const merged = env ? { ...baseEnv, ...env } : baseEnv;
    return (args, opts = {}) => {
        const run = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
            encoding: 'utf8',
            env: merged,
            timeout: opts.timeoutMs ?? LOCAL_TIMEOUT_MS,
            // Inheriting stdin would let a credential helper read the agent's terminal. /dev/null makes
            // any prompt an immediate EOF instead of a hang the timeout has to clean up.
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 32 * 1024 * 1024,
        });
        return {
            // A signalled or spawn-failed child reports status null; 128 is git's own "fatal", which is
            // what every caller already treats as "could not answer".
            status: run.status ?? 128,
            stdout: run.stdout ?? '',
            stderr: run.stderr ?? '',
        };
    };
}
/** stdout with the single trailing newline git adds, and nothing else, removed. */
export function line(result) {
    return result.stdout.replace(/\n$/, '');
}
/** Exit-status-as-boolean, for the probes whose whole answer is the code (see the header). */
export function ok(result) {
    return result.status === 0;
}
