/** A slot's app process: started detached in its own process group, stopped by that group only. */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import getPort, { portNumbers } from 'get-port';
import { processOwnerIsProvablyGone, psProcessStart, } from '../../../gate-engine/judge/process/identity.mjs';
import { DEFAULT_PROBE } from '../ship/queue/ship-queue.mjs';
import { expand, slotEnv } from './config.mjs';
import { PORTS_PER_SLOT, publishSeed } from './lease.mjs';
const STOP_GRACE_MS = 5_000;
/** A seed that hangs must not hold the slot's start claim forever. */
const SEED_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
/** Host-app variables that would point the slot's app at someone else's dev server or run mode. */
const INHERITED_NOISE = new Set(['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_ENV']);
const IGNORED_KILL_ERRORS = new Set(['ESRCH', 'EPERM']);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** A free port, preferring the slot's block; every local host is probed, so a port held on `::` or
 * `0.0.0.0` by another program never reads as free. */
export function pickPort(base, exclude = []) {
    return getPort({ port: portNumbers(base, base + PORTS_PER_SLOT - 1), exclude });
}
/** The env a slot's processes start from: the caller's, minus ship's own and host-app run mode. */
export function slotProcessEnv(base, slot) {
    const kept = Object.entries(base).filter(([key]) => !(key.startsWith('DEVKIT_') || INHERITED_NOISE.has(key)));
    return { ...Object.fromEntries(kept), ...slot };
}
/** Spawn `argv` detached (its pid is its process group id), output appended to `log`; the identity
 * lets a later stop refuse to signal a group whose leader pid was reused. */
export function startApp(argv, { cwd, env, log }) {
    const out = openSync(log, 'a');
    try {
        const [bin, ...args] = argv;
        const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', out, out] });
        // A binary that cannot start also emits 'error' on the next tick; the throw below reports it.
        child.once('error', () => undefined);
        if (!child.pid)
            throw new Error(`could not start ${bin}`);
        child.unref();
        return { pgid: child.pid, identity: psProcessStart(child.pid) };
    }
    finally {
        closeSync(out);
    }
}
export const groupAlive = (pgid) => DEFAULT_PROBE.groupAlive(pgid);
/** The recorded group is still ours when its leader is gone (a live group keeps its id) or is the
 * very process we started; an unknown identity on a live leader is never assumed ours. */
export function ownsGroup(pgid, identity, resolve = psProcessStart) {
    const start = resolve(pgid);
    // A null read is a gone leader, or a `ps` that failed on a live one, which is never assumed ours.
    if (start === null)
        return processOwnerIsProvablyGone({ pid: pgid, processStart: 'unread' });
    return identity !== null && start === identity;
}
async function answers(url, ms) {
    try {
        await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'manual' });
        return true;
    }
    catch {
        return false;
    }
}
/** Wait until `url` answers any HTTP response (a dev server compiles its first page here); false
 * when what serves it died or time ran out. */
export async function waitForHttp(url, alive, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await answers(url, Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))))
            return true;
        if (!alive())
            return false;
        await sleep(POLL_MS);
    }
    return false;
}
/** Signal the whole group; a group already gone (ESRCH) or not ours to signal (EPERM) is done. */
export function signalGroup(pgid, signal) {
    try {
        process.kill(-pgid, signal);
    }
    catch (cause) {
        // SAFETY: process.kill reports failures through Node's ErrnoException code contract.
        if (!IGNORED_KILL_ERRORS.has(String(cause.code)))
            throw cause;
    }
}
/** TERM the group, give it a grace period, then KILL whatever is left; a reused group is left alone. */
export async function stopGroup(pgid, identity) {
    if (!ownsGroup(pgid, identity))
        return;
    signalGroup(pgid, 'SIGTERM');
    const deadline = Date.now() + STOP_GRACE_MS;
    while (groupAlive(pgid) && Date.now() < deadline)
        await sleep(POLL_MS);
    if (groupAlive(pgid))
        signalGroup(pgid, 'SIGKILL');
}
/** Seed an unseeded slot into a staging dir of its own lease, swapped in only while that lease holds
 * the slot, so a slot freed and re-leased meanwhile is never touched; false when it was. */
export function seedSlot({ root, machines, lease, seed, vars }) {
    if (lease.seeded) {
        mkdirSync(vars.data, { recursive: true });
        return true;
    }
    const staging = join(machines, 'seeding', lease.id);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
        if (seed) {
            const seedVars = { ...vars, data: staging };
            const env = slotProcessEnv(process.env, slotEnv(seedVars));
            const [bin, ...args] = seed.map((arg) => expand(arg, seedVars));
            // stdout goes to stderr: `up` prints export lines on stdout, which a caller may eval.
            execFileSync(bin, args, {
                cwd: root,
                env,
                stdio: ['ignore', 2, 2],
                timeout: SEED_TIMEOUT_MS,
            });
        }
        return publishSeed(machines, lease, staging, vars.data);
    }
    finally {
        rmSync(staging, { recursive: true, force: true });
    }
}
