#!/usr/bin/env node
/** Narrates which failed config `extraGates` commands also exit 1 at the commit the gate worktree
 * was cut from. A run it could not finish prints nothing and exits non-zero; the caller ignores it. */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readlinkSync, rmSync, symlinkSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configExtraGates } from '../../../../gate-engine/deterministic/command-gates.mjs';
import { emitGateEvent } from '../../../../gate-engine/judge/gate-events.mjs';
import { telemetrySink } from '../../../../gate-engine/judge/run-context.mjs';
import { readShipEvents } from './gate-digest.mjs';
/** One budget for the worktree, its links and every rerun. Removing the worktree has its own bound. */
const CAP_MS = 120_000;
const KILL_GRACE_MS = 2_000;
const CLEANUP_MS = 30_000;
const WHITESPACE_RE = /\s+/;
const PGID_RE = /^[1-9]\d*$/;
const FORWARDED_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'];
/** Ship context a base rerun must not inherit, or its rows would join this attempt's digest. */
const SCRUBBED_ENV = [
    'DEVKIT_GATE_EVENTS',
    'DEVKIT_SHIP_ID',
    'DEVKIT_GATE_REASON_FILE',
    'DEVKIT_GATE_LOG',
    'DEVKIT_REVIEW_PROGRESS',
];
let interrupted = false;
let stopActive;
let guard;
function onSignal() {
    interrupted = true;
    stopActive?.();
}
function git(cwd, deadline, ...args) {
    return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        timeout: Math.max(1, deadline - Date.now()),
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
}
/** ESRCH = the group is gone; EPERM = macOS is mid-reap. Neither is worth a throw here. */
function signalGroup(pid, signal) {
    if (pid === undefined)
        return;
    try {
        process.kill(-pid, signal);
    }
    catch {
        // Nothing left to signal.
    }
}
/** A detached sibling whose stdin only this process holds: the kernel closes it when we die, SIGKILL
 * included, and the guardian then reaps what we leave. Failing to start only loses that backstop. */
function spawnGuard(commonDir, baseWt) {
    try {
        const self = fileURLToPath(import.meta.url);
        const child = spawn(process.execPath, [self, '--guard', commonDir, baseWt], {
            cwd: '/',
            detached: true,
            stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.on('error', () => { });
        child.stdin?.on('error', () => { });
        child.unref();
        return child;
    }
    catch {
        return undefined;
    }
}
/** Guard mode. Stdin carries the in-flight rerun's pgid, or an empty line once it settled. */
function guardBase(commonDir, baseWt) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buf += chunk;
    });
    process.stdin.on('end', () => {
        const lines = buf.split('\n');
        lines.pop();
        const last = lines.at(-1) ?? '';
        if (PGID_RE.test(last))
            signalGroup(Number(last), 'SIGKILL');
        // Directory first: an add killed mid-way stays locked, and only `-f -f` drops a locked entry.
        rmSync(baseWt, { recursive: true, force: true });
        const remove = ['worktree', 'remove', '--force', '--force', baseWt];
        try {
            git('/', Date.now() + CLEANUP_MS, '--git-dir', commonDir, ...remove);
        }
        catch {
            // Not registered: the narrator's own cleanup already ran.
        }
    });
}
/** The config command gates this attempt recorded as failed with a verdict (exit 1). */
function failedConfigGates(wt, sink, shipId) {
    const events = readShipEvents(sink, shipId);
    const attempt = events.slice(events.map((e) => e.type).lastIndexOf('ship_attempt') + 1);
    const verdicts = attempt.filter((e) => e.type === 'gate_result' && e.family === 'deterministic');
    const failed = new Set(verdicts.filter((e) => e.status === 'fail').map((e) => e.gate));
    // `guard-structure` is resolved to devkit's own module by the gate runner, never spawned by name.
    return configExtraGates(wt).flatMap(({ label, cmd }) => cmd && failed.has(label) && cmd.split(WHITESPACE_RE)[0] !== 'guard-structure'
        ? [{ label, cmd }]
        : []);
}
/** Recreate the gate worktree's untracked symlinks (node_modules, untracked configs) at the base. */
function mirrorLinks(wt, baseWt, deadline) {
    for (const rel of git(wt, deadline, 'ls-files', '--others', '-z').split('\0').filter(Boolean)) {
        const from = join(wt, rel);
        if (!lstatSync(from).isSymbolicLink())
            continue;
        const to = join(baseWt, rel);
        mkdirSync(dirname(to), { recursive: true });
        symlinkSync(resolve(dirname(from), readlinkSync(from)), to);
    }
}
function rerunEnv(baseWt) {
    const env = {
        ...process.env,
        DEVKIT_NO_TELEMETRY: '1',
        // The hook runner puts the repo's own binaries first; a bare `eslint .` gate relies on it.
        PATH: `${join(baseWt, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
    };
    for (const key of SCRUBBED_ENV)
        delete env[key];
    return env;
}
/** Run one command in its own process group, output to `outFile`, never past `deadline`. */
function rerun(cmd, baseWt, outFile, deadline) {
    const [file = '', ...args] = cmd.split(WHITESPACE_RE).filter(Boolean);
    return new Promise((done) => {
        const fd = openSync(outFile, 'w');
        const child = spawn(file, args, {
            cwd: baseWt,
            env: rerunEnv(baseWt),
            detached: true,
            stdio: ['ignore', fd, fd],
        });
        closeSync(fd);
        // A SIGKILL before this write leaks this one group; the guardian cannot know its pgid.
        guard?.stdin?.write(`${child.pid ?? ''}\n`);
        let stopped = false;
        let killTimer;
        stopActive = () => {
            if (stopped)
                return;
            stopped = true;
            signalGroup(child.pid, 'SIGTERM');
            killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
        };
        const timer = setTimeout(stopActive, Math.max(0, deadline - Date.now()));
        const settle = (code, signal) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            stopActive = undefined;
            // A leader that exited can leave members behind; nothing may outlive the worktree.
            signalGroup(child.pid, 'SIGKILL');
            guard?.stdin?.write('\n');
            if (stopped)
                done('timeout');
            else
                done(code === 1 && signal === null ? 'also-fails' : 'not-reproduced');
        };
        child.once('error', () => settle(null, null));
        child.once('exit', settle);
    });
}
/** Rerun each gate the base config declares identically; the output file of each that exits 1. */
async function rerunAtBase(gates, baseWt, outPrefix, deadline) {
    const alsoFailing = new Map();
    const atBase = new Map(configExtraGates(baseWt).map((g) => [g.label, g.cmd]));
    for (const { label, cmd } of gates) {
        if (interrupted || Date.now() >= deadline)
            break;
        // A change that adds or repoints the gate has no base run to compare against.
        if (atBase.get(label) !== cmd)
            continue;
        const outFile = `${outPrefix}.base-${label}.log`;
        const started = Date.now();
        const outcome = await rerun(cmd, baseWt, outFile, deadline);
        const duration_ms = Date.now() - started;
        emitGateEvent({ type: 'base_attribution', gate: label, outcome, duration_ms });
        if (outcome === 'also-fails')
            alsoFailing.set(label, outFile);
        else
            rmSync(outFile, { force: true });
    }
    return alsoFailing;
}
/**
 * The narration lines for the blocked attempt in `wt`, or none. Reads the attempt's failed gates
 * from the telemetry sink and the cut commit from DEVKIT_SHIP_BASE_SHA.
 */
export async function attributeToBase(wt, outPrefix, capMs = CAP_MS) {
    const deadline = Date.now() + capMs;
    const { DEVKIT_SHIP_ID: shipId = '', DEVKIT_SHIP_BASE_SHA: sha = '' } = process.env;
    // A HEAD that is not the cut commit means something moved it; the base is then unknown.
    if (!wt || !sha || git(wt, deadline, 'rev-parse', 'HEAD').trim() !== sha)
        return [];
    const gates = failedConfigGates(wt, telemetrySink() ?? '', shipId);
    if (gates.length === 0)
        return [];
    // Not `--path-format=absolute`: git before 2.31 rejects it, which would silence every narration.
    const commonDir = resolve(wt, git(wt, deadline, 'rev-parse', '--git-common-dir').replace(/\n$/, ''));
    const baseWt = mkdtempSync(join(tmpdir(), `devkit-ship-base-${sha.slice(0, 7)}-`));
    guard = spawnGuard(commonDir, baseWt);
    interrupted = false;
    for (const signal of FORWARDED_SIGNALS)
        process.on(signal, onSignal);
    try {
        const add = ['worktree', 'add', '-q', '--detach', baseWt, sha];
        git(wt, deadline, '-c', 'core.hooksPath=/dev/null', ...add);
        mirrorLinks(wt, baseWt, deadline);
        const alsoFailing = await rerunAtBase(gates, baseWt, outPrefix, deadline);
        if (interrupted)
            throw new Error('interrupted before every rerun finished');
        return [...alsoFailing].map(([label, outFile]) => `ship: ${label} also exits 1 at ${sha.slice(0, 7)}, the commit this gate worktree was cut from (run with this checkout's linked node_modules). Base run output: ${outFile}`);
    }
    finally {
        for (const signal of FORWARDED_SIGNALS)
            process.off(signal, onSignal);
        try {
            git(wt, Date.now() + CLEANUP_MS, 'worktree', 'remove', '--force', baseWt);
        }
        catch {
            // The directory removal below still happens; git prunes the stale entry on its own.
        }
        rmSync(baseWt, { recursive: true, force: true });
        guard?.stdin?.end();
        guard = undefined;
    }
}
// CLI: `<gate-worktree> <output-prefix>` from commit-with-gate-capture.sh (a failure prints nothing,
// exits 1), or `--guard <git-common-dir> <base-worktree>`, the guardian this module spawns.
if (/[/\\]base-attribution\.m[jt]s$/.test(process.argv[1] ?? '')) {
    const [first = '', second = '', third = ''] = process.argv.slice(2);
    if (first === '--guard')
        guardBase(second, third);
    else
        attributeToBase(first, second).then((lines) => {
            if (lines.length > 0)
                process.stdout.write(`${lines.join('\n')}\n`);
        }, () => {
            process.exitCode = 1;
        });
}
