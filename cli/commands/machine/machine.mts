/** `devkit machine`: give the agent in this worktree its own machine for QA screenshots and video. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  groupAlive,
  ownsGroup,
  pickPort,
  seedSlot,
  signalGroup,
  slotProcessEnv,
  startApp,
  stopGroup,
  waitForHttp,
} from '../../lib/machine/app.mts';
import {
  expand,
  type MachineConfig,
  readMachineConfig,
  type SlotVars,
  slotEnv,
} from '../../lib/machine/config.mts';
import { type RunResult, runFlow } from '../../lib/machine/flow.mts';
import {
  acquireLease,
  claimStart,
  findLease,
  type Lease,
  listLeases,
  machinesRoot,
  memoryPressure,
  PORT_BASE,
  PORTS_PER_SLOT,
  releaseLease,
  slotDir,
  updateLease,
} from '../../lib/machine/lease.mts';
import { clearEvidence, evidenceDir } from '../../lib/machine/manifest.mts';
import { shellQuote } from '../../lib/ship/dist-integrity.mts';

const READY_TIMEOUT_MS = 120_000;
const CRITICAL_PRESSURE = 4;
const WARN_PRESSURE = 2;

export const meta = {
  name: 'machine',
  agentFacing: true,
  summary:
    'Your own machine for QA: a private port, browser, app data and video of your app working.',
  help: `devkit machine — this worktree's own machine for screenshots and video of the app working.

Usage:
  devkit machine up [-- <command…>]      lease this worktree's slot, seed and start its app, print its env
  devkit machine run <flow.mjs> [--name <label>]   run an asserted flow there, recording video + screenshots
  devkit machine env                     print \`export\` lines for this worktree's slot
  devkit machine status                  list every slot on this Mac
  devkit machine down                    stop this worktree's app and free its slot (evidence is kept)
  devkit machine clear                   delete this worktree's captures so none reaches a PR

A slot is a lease on this Mac for one worktree, like Grok Bot's "own screen on a shared computer":
its own port block (40000+10n), its own headless Chromium profile, its own app-data dir, its own
process group and its own evidence dir. It is not a VM and not a security boundary, CPU and RAM are
shared, and native OS dialogs are never captured. Web apps only for now. A slot no \`devkit machine\`
command touches for 30 minutes is freed by the next \`up\` on this Mac, its app stopped.

The app comes from \`-- <command…>\` or guard.config.json "machine": {"command": [...], "seed":
[...]}. {port}, {data}, {profile} and {slot} expand to this slot's own; the app also gets PORT and
DEVKIT_MACHINE_*. guard.config.json may be committed, so it holds no env: set an app variable in the
argv (["env", "DB={data}/app.db", "next", "dev", "-p", "{port}"]) and keep secrets in your own
environment, which the app inherits. \`up\` waits until the app answers HTTP on its port.

A flow is \`export default async ({ page, url, shot }) => { … }\`: assert with node:assert/strict
and locator waits, call \`shot('name')\` for a screenshot. A throw fails the run (exit 1). Captures
land in the worktree's git dir, and \`devkit ship\` attaches the passing ones to the PR when they ran
the code it ships. Anything on the page ends up in the PR, so seed data must be fake.`,
  valueFlags: ['--name'],
};

const worktreeRoot = (cwd: string): string =>
  realpathSync(
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim(),
  );

function slotVars(lease: Lease) {
  const dir = slotDir(machinesRoot(), lease.slot);
  return {
    port: lease.port,
    data: join(dir, 'data'),
    profile: join(dir, 'profile'),
    slot: lease.slot,
  };
}

function printEnv(root: string, lease: Lease): void {
  const env = slotEnv(slotVars(lease));
  for (const [key, value] of Object.entries(env)) console.log(`export ${key}=${shellQuote(value)}`);
}

function tail(file: string): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-20).join('\n');
  } catch {
    return '(no app log)';
  }
}

const say = (message: string): void => console.error(`devkit machine: ${message}`);
const NO_MACHINE = 'no machine for this worktree; run `devkit machine up` first';

/** False (after saying why) when macOS reports critical memory pressure; warns when it is raised. */
function memoryAllows(): boolean {
  const pressure = memoryPressure();
  if (pressure >= CRITICAL_PRESSURE)
    say(
      'macOS reports critical memory pressure; stop a machine (`devkit machine down`) or retry later',
    );
  else if (pressure >= WARN_PRESSURE)
    say('warning: macOS reports memory pressure; the app may be slow');
  return pressure < CRITICAL_PRESSURE;
}

/** Start `command` in the slot and wait for it to answer; on failure stop it and show its log. An app
 * whose slot was released while it started is stopped at once, so it never outlives its lease. */
async function startAndWait(root: string, lease: Lease, command: string[], env: NodeJS.ProcessEnv) {
  const log = join(slotDir(machinesRoot(), lease.slot), 'app.log');
  const url = `http://127.0.0.1:${lease.port}`;
  const { pgid, identity } = startApp(command, { cwd: root, env, log });
  const patch = { pgid, identity, port: lease.port, starter: null };
  if (!updateLease(machinesRoot(), lease, patch)) {
    await stopGroup(pgid, identity);
    say("this worktree's slot was released while its app started, so the app was stopped");
    return 1;
  }
  if (await waitForHttp(url, pgid, READY_TIMEOUT_MS)) {
    say(`slot ${lease.slot} is up at ${url} (log: ${log})`);
    printEnv(root, lease);
    return 0;
  }
  await stopGroup(pgid, identity);
  updateLease(machinesRoot(), lease, { pgid: null, identity: null });
  say(`the app never answered at ${url}. Last log lines (${log}):\n${tail(log)}`);
  return 1;
}

const killNow = (pgid: number, identity: string | null): void => {
  if (ownsGroup(pgid, identity)) signalGroup(pgid, 'SIGKILL');
};

const appCommand = (override: string[], config: MachineConfig, vars: SlotVars) =>
  (override.length > 0 ? override : config.command)?.map((arg) => expand(arg, vars));

const NOT_CLAIMED = {
  busy: "another `devkit machine up` is starting this worktree's machine; retry once it finishes",
  released: "this worktree's slot was released meanwhile; run `devkit machine up` again",
};

async function up(root: string, override: string[]): Promise<number> {
  if (!memoryAllows()) return 1;
  const config = readMachineConfig(root);
  const { lease } = acquireLease(root, { root: machinesRoot(), kill: killNow });
  const running = (pgid: number, identity: string | null) =>
    groupAlive(pgid) && ownsGroup(pgid, identity);
  const claim = claimStart(machinesRoot(), lease, running);
  if (claim === 'running') {
    say(`slot ${lease.slot} is already running for this worktree`);
    printEnv(root, lease);
    return 0;
  }
  if (claim !== 'claimed') {
    say(NOT_CLAIMED[claim]);
    return 1;
  }
  const port = await pickPort(PORT_BASE + lease.slot * PORTS_PER_SLOT);
  const vars = { ...slotVars(lease), port };
  mkdirSync(vars.profile, { recursive: true });
  if (!seedSlot({ root, machines: machinesRoot(), lease, seed: config.seed, vars })) {
    say(NOT_CLAIMED.released);
    return 1;
  }
  const env = slotProcessEnv(process.env, slotEnv(vars));
  const command = appCommand(override, config, vars);
  if (command) return startAndWait(root, { ...lease, port }, command, env);
  if (!updateLease(machinesRoot(), lease, { port, starter: null })) {
    say(NOT_CLAIMED.released);
    return 1;
  }
  say(`slot ${lease.slot} leased; no app command, so start your app on $PORT yourself`);
  printEnv(root, { ...lease, port });
  return 0;
}

function report(result: RunResult, evidence: string): number {
  for (const entry of result.entries)
    console.log(`${entry.kind}: ${join(evidence, entry.file)} (${entry.bytes} bytes)`);
  if (result.passed)
    say(
      `flow "${result.flow}" passed; \`devkit ship\` attaches it unless shipped code changes first`,
    );
  else
    say(
      `flow "${result.flow}" failed: ${result.error}\n  its capture is kept locally and never uploaded`,
    );
  return result.passed ? 0 : 1;
}

async function run(root: string, rest: string[]): Promise<number> {
  const options = { name: { type: 'string' } } as const;
  const { values, positionals } = parseArgs({ args: rest, options, allowPositionals: true });
  const [flowPath] = positionals;
  const found = findLease(machinesRoot(), root);
  // Touched before the flow, so another worktree's `up` never reaps this slot as idle mid-flow.
  const lease = found && updateLease(machinesRoot(), found, {});
  if (!flowPath || !lease) {
    say(flowPath ? NO_MACHINE : `usage: devkit machine run <flow.mjs> [--name <label>]`);
    return 1;
  }
  const { profile } = slotVars(lease);
  const evidence = evidenceDir(root);
  const url = `http://127.0.0.1:${lease.port}`;
  const result = await runFlow({ root, flowPath, name: values.name, url, profile, evidence });
  updateLease(machinesRoot(), lease, {});
  return report(result, evidence);
}

async function down(root: string): Promise<number> {
  const lease = findLease(machinesRoot(), root);
  if (!lease) {
    say('no machine for this worktree');
    return 0;
  }
  const freed = await releaseLease(machinesRoot(), lease, ({ pgid, identity }) =>
    pgid ? stopGroup(pgid, identity) : undefined,
  );
  if (freed === 'busy') {
    say("a `devkit machine up` is starting this worktree's machine; run `down` once it finishes");
    return 1;
  }
  say(`slot ${lease.slot} stopped and freed; evidence kept in ${evidenceDir(root)}`);
  return 0;
}

function clear(root: string): number {
  clearEvidence(evidenceDir(root));
  say('captures deleted for this worktree');
  return 0;
}

function env(root: string): number {
  const lease = findLease(machinesRoot(), root);
  if (!lease) say(NO_MACHINE);
  else printEnv(root, lease);
  return lease ? 0 : 1;
}

function statusLine(lease: Lease): string {
  const app = lease.pgid && groupAlive(lease.pgid) ? 'running' : 'stopped';
  const idle = Math.round((Date.now() - lease.touchedAt) / 60_000);
  return `slot ${lease.slot}  :${lease.port}  app ${app}  idle ${idle}m  ${lease.worktree}`;
}

function status(): number {
  const leases = listLeases(machinesRoot());
  console.log(leases.length ? leases.map(statusLine).join('\n') : 'no machines');
  return 0;
}

type Verb = (root: string, rest: string[]) => number | Promise<number>;

const VERBS = new Map<string, Verb>([
  ['up', (root, rest) => up(root, rest[0] === '--' ? rest.slice(1) : rest)],
  ['run', run],
  ['down', down],
  ['env', env],
  ['clear', clear],
]);

export default async function machine(args: string[], cwd: string): Promise<number> {
  const [verb = '', ...rest] = args;
  if (verb === 'status') return status();
  const handler = VERBS.get(verb);
  if (!handler) {
    console.error(meta.help);
    return 1;
  }
  return handler(worktreeRoot(cwd), rest);
}
