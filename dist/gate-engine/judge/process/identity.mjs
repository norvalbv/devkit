/** Process identity and liveness primitives shared by owner-fenced local locks. */
import { execFileSync } from 'node:child_process';
const MAX_PROCESS_ID = 2_147_483_647;
export function isProcessId(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_PROCESS_ID;
}
/** Read the operating-system start time used to distinguish a live owner from PID reuse. */
export function psProcessStart(pid) {
    if (!isProcessId(pid))
        return null;
    try {
        const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf8',
            env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC0' },
            maxBuffer: 1_024,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1_000,
        })
            .trim()
            .replace(/\s+/g, ' ');
        return value || null;
    }
    catch {
        return null;
    }
}
/** Identity for this process. The Node fallback stays fail-safe because PID reuse is then unproven. */
export function processStartIdentity(resolve = psProcessStart) {
    return (resolve(process.pid)?.replace(/^/, 'ps:') ??
        `node:${Math.round(Date.now() - process.uptime() * 1_000)}`);
}
function processIsAlive(pid) {
    if (!isProcessId(pid))
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // SAFETY: process.kill reports liveness failures through Node's ErrnoException code contract.
        return error.code !== 'ESRCH';
    }
}
/** A live PID is gone only when its observable OS start time proves it belongs to a new process. */
export function processOwnerIsProvablyGone(owner, resolve = psProcessStart) {
    if (!processIsAlive(owner.pid))
        return true;
    if (!owner.processStart.startsWith('ps:'))
        return false;
    const observedStart = resolve(owner.pid);
    return observedStart !== null && `ps:${observedStart}` !== owner.processStart;
}
