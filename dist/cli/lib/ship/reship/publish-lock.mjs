// reship.sh's per-branch publication lock, held for the reship bash process rather than for this
// short-lived node process: bash passes its own pid ($$), and the lock lives until it releases.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isProcessId, psProcessStart } from '../../../../gate-engine/judge/process/identity.mjs';
import { acquireProcessLock, LockHeldError, releaseProcessLock, } from '../../../../gate-engine/judge/process/process-lock.mjs';
/** Exit status for a lock another live publisher holds (EX_TEMPFAIL), distinct from a failure. */
export const BUSY = 75;
function acquire(pid, lock) {
    // ps only: processStartIdentity's node: fallback would describe this helper, not the publisher.
    const start = isProcessId(pid) ? psProcessStart(pid) : null;
    if (start === null) {
        console.error(`publish lock: could not read the start time of publisher pid ${pid}`);
        return 1;
    }
    try {
        const owner = { pid, identity: `ps:${start}` };
        process.stdout.write(acquireProcessLock(lock, { label: 'publish', owner, waitMs: 30_000 }));
        return 0;
    }
    catch (error) {
        if (error instanceof LockHeldError) {
            console.error(error.message);
            return BUSY;
        }
        console.error(`publish lock: cannot take ${lock}: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}
/** `acquire <pid> <lockDir>` prints the nonce; `release <lockDir> <nonce>` frees only that one. */
export function run(argv) {
    const [verb, a, b] = argv;
    if (verb === 'acquire' && a && b)
        return acquire(Number(a), b);
    if (verb === 'release' && a && b) {
        releaseProcessLock(a, b);
        return 0;
    }
    console.error('usage: publish-lock.mts acquire <pid> <lockDir> | release <lockDir> <nonce>');
    return 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    process.exitCode = run(process.argv.slice(2));
}
