#!/usr/bin/env node

/** Narrates which failed config `extraGates` commands also exit 1 at the commit the gate worktree
 * was cut from. A run it could not finish prints nothing and exits non-zero; the caller ignores it. */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  configExtraGates,
  STAGED_PLACEHOLDER,
} from '../../../../gate-engine/deterministic/command-gates.mts';
import { emitGateEvent } from '../../../../gate-engine/judge/gate-events.mts';
import { telemetrySink } from '../../../../gate-engine/judge/run-context.mts';
import { assertVitestReport, escapesRoot, summarise } from '../../baseline-status/produce.mts';
import { type GateEvent, readShipEvents } from './gate-digest.mts';

/** One budget for the worktree, its links and every rerun. Removing the worktree has its own bound. */
const CAP_MS = 120_000;
const KILL_GRACE_MS = 2_000;
const CLEANUP_MS = 30_000;
const WHITESPACE_RE = /\s+/;
/** Written by commit-with-gate-capture.sh into the gate worktree's own git dir. */
const PRE_GATE_SNAPSHOT = 'devkit-pre-gate-untracked';
const PGID_RE = /^[1-9]\d*$/;
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
  /** A gate's own failing tests to rerun instead of `cmd`; see rerunTestsOf. */
  tests?: RerunTest[];
}

let interrupted = false;
let stopActive: (() => void) | undefined;
let guard: ChildProcess | undefined;

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

/** A detached sibling whose stdin only this process holds: the kernel closes it when we die, SIGKILL
 * included, and the guardian then reaps what we leave. Failing to start only loses that backstop. */
function spawnGuard(commonDir: string, baseWt: string): ChildProcess | undefined {
  try {
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [self, '--guard', commonDir, baseWt], {
      cwd: '/',
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {});
    child.stdin?.on('error', () => {});
    child.unref();
    return child;
  } catch {
    return undefined;
  }
}

/** Guard mode. Stdin carries the in-flight rerun's pgid, or an empty line once it settled. */
function guardBase(commonDir: string, baseWt: string): void {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
  });
  process.stdin.on('end', () => {
    const lines = buf.split('\n');
    lines.pop();
    const last = lines.at(-1) ?? '';
    if (PGID_RE.test(last)) signalGroup(Number(last), 'SIGKILL');
    // Directory first: an add killed mid-way stays locked, and only `-f -f` drops a locked entry.
    rmSync(baseWt, { recursive: true, force: true });
    const remove = ['worktree', 'remove', '--force', '--force', baseWt];
    try {
      git('/', Date.now() + CLEANUP_MS, '--git-dir', commonDir, ...remove);
    } catch {
      // Not registered: the narrator's own cleanup already ran.
    }
  });
}

/** The tests a gate published for its base rerun (`gate_base_rerun`), at most 20 root-relative ones. */
const rerunTestsSchema = z
  .array(z.object({ file: z.string().min(1), name: z.string().min(1) }))
  .min(1)
  .max(20);
type RerunTest = z.infer<typeof rerunTestsSchema>[number];

/** The newest `gate_base_rerun` tests `label` published this attempt, when they are well formed. */
function rerunTestsOf(attempt: GateEvent[], label: string): RerunTest[] | undefined {
  const rows = attempt.filter((e) => e.type === 'gate_base_rerun' && e.gate === label);
  const row = rows.at(-1);
  const parsed = rerunTestsSchema.safeParse(row?.tests);
  if (!parsed.success) return undefined;
  return parsed.data.every((t) => !isAbsolute(t.file) && !escapesRoot(t.file))
    ? parsed.data
    : undefined;
}

/** The config command gates this attempt recorded as failed with a verdict (exit 1). */
function failedConfigGates(wt: string, sink: string, shipId: string): CommandGate[] {
  const events = readShipEvents(sink, shipId);
  const attempt = events.slice(events.map((e) => e.type).lastIndexOf('ship_attempt') + 1);
  const verdicts = attempt.filter((e) => e.type === 'gate_result' && e.family === 'deterministic');
  const failed = new Set(verdicts.filter((e) => e.status === 'fail').map((e) => e.gate));
  // `guard-structure` is resolved to devkit's own module by the gate runner, never spawned by name.
  return configExtraGates(wt).flatMap(({ label, cmd }) => {
    if (!cmd || !failed.has(label) || cmd.split(WHITESPACE_RE)[0] === 'guard-structure') return [];
    const tests = rerunTestsOf(attempt, label);
    if (tests) return [{ label, cmd, tests }];
    // The staged set does not exist at the base, so a `{staged}` command has nothing to rerun.
    return cmd.includes(STAGED_PLACEHOLDER) ? [] : [{ label, cmd }];
  });
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

/** Link each pre-gate entry, live, into the base; an entry a gate added during the run was never recorded. */
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
function rerun(argv: string[], baseWt: string, outFile: string, deadline: number) {
  const [file = '', ...args] = argv;
  return new Promise<Outcome>((done) => {
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
      guard?.stdin?.write('\n');
      if (stopped) done('timeout');
      else done(code === 1 && signal === null ? 'also-fails' : 'not-reproduced');
    };
    child.once('error', () => settle(null, null));
    child.once('exit', settle);
  });
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Each failed `[file, names]` of a base run's json report; null when it is unreadable. */
function failedAtBase(report: string, root: string): Map<string, string[]> | null {
  try {
    const summary = summarise(assertVitestReport(JSON.parse(readFileSync(report, 'utf8'))), root);
    const failed = Object.keys(summary.files).filter((f) => summary.files[f] === 'failed');
    return new Map(failed.map((f) => [f, summary.tests?.[f]?.failed ?? []]));
  } catch {
    return null;
  }
}

/** Rerun only `tests` at the base, labelled one per line; a file absent there is new without a run. */
async function labelTestsAtBase(
  { label, tests = [] }: CommandGate,
  baseWt: string,
  outPrefix: string,
  deadline: number,
  sha: string,
): Promise<string[]> {
  const root = realpathSync(baseWt);
  const present = tests.filter((t) => lstatSync(join(root, t.file), { throwIfNoEntry: false }));
  let failed = new Map<string, string[]>();
  let output = '';
  if (present.length) {
    const [log, report] = [`${outPrefix}.base-${label}.log`, `${outPrefix}.base-${label}.json`];
    const pattern = `^(${[...new Set(present.map((t) => escapeRe(t.name)))].join('|')})$`;
    const files = [...new Set(present.map((t) => join(root, t.file)))];
    const vitest = join(root, 'node_modules', '.bin', 'vitest');
    const argv = [vitest, 'run', '--passWithNoTests', '-t', pattern, '--reporter=json'];
    const started = Date.now();
    const outcome = await rerun(
      [...argv, `--outputFile.json=${report}`, ...files],
      root,
      log,
      deadline,
    );
    emitGateEvent({
      type: 'base_attribution',
      gate: label,
      outcome,
      duration_ms: Date.now() - started,
    });
    const read = outcome === 'timeout' ? null : failedAtBase(report, root);
    if (!read) return [];
    [failed, output] = [read, ` Base run output: ${log}`];
  }
  // A file that failed at the base with no test names did not load there: every test in it fails.
  const inherited = (t: RerunTest) => {
    const names = failed.get(t.file);
    return names !== undefined && (names.length === 0 || names.includes(t.name));
  };
  const labelled = tests.map((t) => {
    const absent = present.includes(t) ? '' : ' (file not at the base)';
    return `  ${inherited(t) ? 'inherited' : 'new'} · ${t.file} > ${t.name}${absent}`;
  });
  const old = tests.filter(inherited).length;
  return [
    `ship: ${label} ${present.length ? 're-ran only' : 'needed no rerun for'} its ${tests.length} failing test(s) at ${sha.slice(0, 7)}, the commit this gate worktree was cut from, on this machine: ${old} inherited, ${tests.length - old} new.${output}`,
    ...labelled,
  ];
}

/** Rerun each gate the base config declares identically; the narration lines for each. */
async function rerunAtBase(
  gates: CommandGate[],
  baseWt: string,
  outPrefix: string,
  deadline: number,
  sha: string,
) {
  const lines: string[] = [];
  const atBase = new Map(configExtraGates(baseWt).map((g) => [g.label, g.cmd]));
  for (const gate of gates) {
    const { label, cmd } = gate;
    if (interrupted || Date.now() >= deadline) break;
    // A change that adds or repoints the gate has no base run to compare against.
    if (atBase.get(label) !== cmd) continue;
    if (gate.tests) {
      // A throw here (an unreadable base path) silences this gate only, never the others.
      const labelled = await labelTestsAtBase(gate, baseWt, outPrefix, deadline, sha).catch(
        () => [],
      );
      lines.push(...labelled);
      continue;
    }
    const outFile = `${outPrefix}.base-${label}.log`;
    const started = Date.now();
    const argv = cmd.split(WHITESPACE_RE).filter(Boolean);
    const outcome = await rerun(argv, baseWt, outFile, deadline);
    const duration_ms = Date.now() - started;
    emitGateEvent({ type: 'base_attribution', gate: label, outcome, duration_ms });
    if (outcome !== 'also-fails') rmSync(outFile, { force: true });
    else
      lines.push(
        `ship: ${label} also exits 1 at ${sha.slice(0, 7)}, the commit this gate worktree was cut from (run with this checkout's linked node_modules). Base run output: ${outFile}`,
      );
  }
  return lines;
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

  // Not `--path-format=absolute`: git before 2.31 rejects it, which would silence every narration.
  const commonDir = resolve(
    wt,
    git(wt, deadline, 'rev-parse', '--git-common-dir').replace(/\n$/, ''),
  );
  const baseWt = mkdtempSync(join(tmpdir(), `devkit-ship-base-${sha.slice(0, 7)}-`));
  guard = spawnGuard(commonDir, baseWt);
  interrupted = false;
  for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal);
  try {
    const add = ['worktree', 'add', '-q', '--detach', baseWt, sha];
    git(wt, deadline, '-c', 'core.hooksPath=/dev/null', ...add);
    linkPreGate(wt, baseWt, untracked);
    const lines = await rerunAtBase(gates, baseWt, outPrefix, deadline, sha);
    if (interrupted) throw new Error('interrupted before every rerun finished');
    return lines;
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, onSignal);
    try {
      git(wt, Date.now() + CLEANUP_MS, 'worktree', 'remove', '--force', baseWt);
    } catch {
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
  if (first === '--guard') guardBase(second, third);
  else
    attributeToBase(first, second).then(
      (lines) => {
        if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
      },
      () => {
        process.exitCode = 1;
      },
    );
}
