#!/usr/bin/env node

/** Narrates which failed config `extraGates` commands also exit 1 at the commit the gate worktree
 * was cut from. A run it could not finish prints nothing and exits non-zero; the caller ignores it. */
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configExtraGates } from '../../../../gate-engine/deterministic/command-gates.mts';
import { emitGateEvent } from '../../../../gate-engine/judge/gate-events.mts';
import { telemetrySink } from '../../../../gate-engine/judge/run-context.mts';
import { readShipEvents } from './gate-digest.mts';

/** One budget for the worktree, its links and every rerun. Removing the worktree has its own bound. */
const CAP_MS = 120_000;
const KILL_GRACE_MS = 2_000;
const CLEANUP_MS = 30_000;
const WHITESPACE_RE = /\s+/;
/** Written by commit-with-gate-capture.sh into the gate worktree's own git dir. */
const PRE_GATE_SNAPSHOT = 'devkit-pre-gate-untracked';
const FORWARDED_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
/** Ship context a base rerun must not inherit, or its rows would join this attempt's digest. */
const SCRUBBED_ENV = [
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_GATE_REASON_FILE',
  'DEVKIT_GATE_LOG',
  'DEVKIT_REVIEW_PROGRESS',
];

type Outcome = 'also-fails' | 'not-reproduced' | 'timeout';
interface CommandGate {
  label: string;
  cmd: string;
}

let interrupted = false;
let stopActive: (() => void) | undefined;

function onSignal(): void {
  interrupted = true;
  stopActive?.();
}

function git(cwd: string, deadline: number, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: Math.max(1, deadline - Date.now()),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** ESRCH = the group is gone; EPERM = macOS is mid-reap. Neither is worth a throw here. */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Nothing left to signal.
  }
}

/** The config command gates this attempt recorded as failed with a verdict (exit 1). */
function failedConfigGates(wt: string, sink: string, shipId: string): CommandGate[] {
  const events = readShipEvents(sink, shipId);
  const attempt = events.slice(events.map((e) => e.type).lastIndexOf('ship_attempt') + 1);
  const verdicts = attempt.filter((e) => e.type === 'gate_result' && e.family === 'deterministic');
  const failed = new Set(verdicts.filter((e) => e.status === 'fail').map((e) => e.gate));
  // `guard-structure` is resolved to devkit's own module by the gate runner, never spawned by name.
  return configExtraGates(wt).flatMap(({ label, cmd }) =>
    cmd && failed.has(label) && cmd.split(WHITESPACE_RE)[0] !== 'guard-structure'
      ? [{ label, cmd }]
      : [],
  );
}

/** The untracked entries the ship recorded before its gates ran, or undefined when it recorded none. */
function preGateUntracked(wt: string, deadline: number): string[] | undefined {
  const args = ['rev-parse', '--path-format=absolute', '--git-path', PRE_GATE_SNAPSHOT];
  try {
    return readFileSync(git(wt, deadline, ...args).trim(), 'utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

/** Link each pre-gate entry into the base; a gate's own outputs were never recorded, so never fed. */
function linkPreGate(wt: string, baseWt: string, entries: string[]): void {
  for (const entry of entries) {
    const rel = entry.replace(/\/$/, '');
    const to = join(baseWt, rel);
    // A path the base already holds keeps the base's copy.
    if (lstatSync(to, { throwIfNoEntry: false })) continue;
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(join(wt, rel), to);
  }
}

function rerunEnv(baseWt: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVKIT_NO_TELEMETRY: '1',
    // The hook runner puts the repo's own binaries first; a bare `eslint .` gate relies on it.
    PATH: `${join(baseWt, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
  };
  for (const key of SCRUBBED_ENV) delete env[key];
  return env;
}

/** Run one command in its own process group, output to `outFile`, never past `deadline`. */
function rerun(cmd: string, baseWt: string, outFile: string, deadline: number) {
  const [file = '', ...args] = cmd.split(WHITESPACE_RE).filter(Boolean);
  return new Promise<Outcome>((done) => {
    const fd = openSync(outFile, 'w');
    const child = spawn(file, args, {
      cwd: baseWt,
      env: rerunEnv(baseWt),
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    let stopped = false;
    let killTimer: NodeJS.Timeout | undefined;
    stopActive = () => {
      if (stopped) return;
      stopped = true;
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(stopActive, Math.max(0, deadline - Date.now()));
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      stopActive = undefined;
      // A leader that exited can leave members behind; nothing may outlive the worktree.
      signalGroup(child.pid, 'SIGKILL');
      if (stopped) done('timeout');
      else done(code === 1 && signal === null ? 'also-fails' : 'not-reproduced');
    };
    child.once('error', () => settle(null, null));
    child.once('exit', settle);
  });
}

/** Rerun each gate the base config declares identically; the output file of each that exits 1. */
async function rerunAtBase(
  gates: CommandGate[],
  baseWt: string,
  outPrefix: string,
  deadline: number,
) {
  const alsoFailing = new Map<string, string>();
  const atBase = new Map(configExtraGates(baseWt).map((g) => [g.label, g.cmd]));
  for (const { label, cmd } of gates) {
    if (interrupted || Date.now() >= deadline) break;
    // A change that adds or repoints the gate has no base run to compare against.
    if (atBase.get(label) !== cmd) continue;
    const outFile = `${outPrefix}.base-${label}.log`;
    const started = Date.now();
    const outcome = await rerun(cmd, baseWt, outFile, deadline);
    const duration_ms = Date.now() - started;
    emitGateEvent({ type: 'base_attribution', gate: label, outcome, duration_ms });
    if (outcome === 'also-fails') alsoFailing.set(label, outFile);
    else rmSync(outFile, { force: true });
  }
  return alsoFailing;
}

/**
 * The narration lines for the blocked attempt in `wt`, or none. Reads the attempt's failed gates
 * from the telemetry sink and the cut commit from DEVKIT_SHIP_BASE_SHA.
 */
export async function attributeToBase(wt: string, outPrefix: string, capMs = CAP_MS) {
  const deadline = Date.now() + capMs;
  const { DEVKIT_SHIP_ID: shipId = '', DEVKIT_SHIP_BASE_SHA: sha = '' } = process.env;
  // A HEAD that is not the cut commit means something moved it; the base is then unknown.
  if (!wt || !sha || git(wt, deadline, 'rev-parse', 'HEAD').trim() !== sha) return [];
  const gates = failedConfigGates(wt, telemetrySink() ?? '', shipId);
  const untracked = gates.length > 0 ? preGateUntracked(wt, deadline) : undefined;
  if (!untracked) return [];

  const baseWt = mkdtempSync(join(tmpdir(), `devkit-ship-base-${sha.slice(0, 7)}-`));
  interrupted = false;
  for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal);
  try {
    const add = ['worktree', 'add', '-q', '--detach', baseWt, sha];
    git(wt, deadline, '-c', 'core.hooksPath=/dev/null', ...add);
    linkPreGate(wt, baseWt, untracked);
    const alsoFailing = await rerunAtBase(gates, baseWt, outPrefix, deadline);
    if (interrupted) throw new Error('interrupted before every rerun finished');
    return [...alsoFailing].map(
      ([label, outFile]) =>
        `ship: ${label} also exits 1 at ${sha.slice(0, 7)}, the commit this gate worktree was cut from (run with this checkout's linked node_modules). Base run output: ${outFile}`,
    );
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, onSignal);
    try {
      git(wt, Date.now() + CLEANUP_MS, 'worktree', 'remove', '--force', baseWt);
    } catch {
      // The directory removal below still happens; git prunes the stale entry on its own.
    }
    rmSync(baseWt, { recursive: true, force: true });
  }
}

// CLI: `node base-attribution.mjs <gate-worktree> <output-prefix>`, shelled by
// commit-with-gate-capture.sh. A failure prints nothing and exits 1, never a partial answer.
if (/[/\\]base-attribution\.m[jt]s$/.test(process.argv[1] ?? '')) {
  const [wt = '', outPrefix = ''] = process.argv.slice(2);
  attributeToBase(wt, outPrefix).then(
    (lines) => {
      if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    },
    () => {
      process.exitCode = 1;
    },
  );
}
