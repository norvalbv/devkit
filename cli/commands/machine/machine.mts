/** `devkit machine`: give the agent in this worktree its own machine for QA screenshots and video. */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  type Box,
  boxExec,
  boxRunning,
  engineProblem,
  ensureImage,
  removeBox,
  screenshot,
  startBox,
  viewUrl,
} from '../../lib/machine/box.mts';
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
import { VIDEO_CAP } from '../../lib/ship/evidence/media.mts';

const READY_TIMEOUT_MS = 120_000;
const BOX_READY_MS = 60_000;
const CRITICAL_PRESSURE = 4;
const WARN_PRESSURE = 2;

export const meta = {
  name: 'machine',
  agentFacing: true,
  summary:
    'Your own machine for QA: a private port, browser or whole desktop, app data and video of it working.',
  help: `devkit machine — this worktree's own machine for screenshots and video of the app working.

Usage:
  devkit machine up [--full|--light] [-- <command…>]   lease this worktree's slot, start its app, print its env
  devkit machine run <flow.mjs> [--name <label>]   run an asserted flow there, recording video + screenshots
  devkit machine attach <pr>             put the passing capture into that open PR's description now
  devkit machine screenshot [file.png]   full mode: save the desktop as a PNG and print its path
  devkit machine exec [-d] -- <command…> full mode: run a command on the desktop (xdotool, apt-get, an app)
  devkit machine env                     print \`export\` lines for this worktree's slot
  devkit machine status                  list every slot on this Mac
  devkit machine down                    stop this worktree's app and desktop, free its slot (evidence is kept)
  devkit machine clear                   delete this worktree's captures so none reaches a PR

A slot is a lease on this Mac for one worktree, like Grok Bot's "own screen on a shared computer":
its own port block (40000+10n), its own app-data dir, its own process group and its own evidence dir.
guard.config.json "machine": {"mode": "light" | "full"} (default light; --full/--light override it,
and each \`up\` brings the slot to that mode):
- light: a headless Chromium profile on this Mac. Web apps only.
- full: its own Linux desktop computer (1280x800, xfce, Chromium, sudo) in a container in Docker's
  Linux VM, with a live view (DEVKIT_MACHINE_VIEW) and DevTools (DEVKIT_MACHINE_CDP). The worktree is
  read-only at /work, and 127.0.0.1 on the slot's ports reaches this Mac's app. The first \`up --full\`
  builds the image (2-3 min, 1.9 GB). Electron and other Linux apps run there via \`exec\`.
Neither mode is a security boundary: CPU and RAM are shared, and a box reaches every 127.0.0.1 port
on this Mac. A slot no \`devkit machine\` command touches for 30 minutes is freed by the next \`up\`
on this Mac, its app and desktop stopped.

The app comes from \`-- <command…>\` or guard.config.json "machine": {"command": [...], "seed":
[...]}. {port}, {data}, {profile} and {slot} expand to this slot's own; the app also gets PORT and
DEVKIT_MACHINE_*. guard.config.json may be committed, so it holds no env: set an app variable in the
argv (["env", "DB={data}/app.db", "next", "dev", "-p", "{port}"]) and keep secrets in your own
environment, which the app inherits. \`up\` waits until the app answers HTTP on its port.

A flow is \`export default async ({ page, url, shot, exec }) => { … }\`: assert with
node:assert/strict and locator waits, call \`shot('name')\` for a screenshot. In full mode \`page\` is
whatever answers DevTools on the desktop (its Chromium, or an app started with
--remote-debugging-port=9222 after \`exec -- pkill chromium\`), \`exec([...])\` returns a desktop
command's stdout, and the video is the whole screen. A throw fails the run (exit 1). Captures land in
the worktree's git dir. \`devkit ship\` attaches the passing ones to its PR; for a capture recorded
after the ship, \`attach <pr>\` does it, either way only when it ran the code that PR ships. Anything
on screen ends up in the PR, so seed data must be fake.`,
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
  const desktop = lease.box && {
    DEVKIT_MACHINE_VIEW: viewUrl(lease.box),
    DEVKIT_MACHINE_CDP: `http://127.0.0.1:${lease.box.cdp}`,
  };
  const env = { ...slotEnv(slotVars(lease)), ...desktop };
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
const NO_DESKTOP = "this worktree's machine has no desktop; run `devkit machine up --full`";

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
  const started = updateLease(machinesRoot(), lease, { pgid, identity, port: lease.port });
  if (!started) {
    await stopGroup(pgid, identity);
    say("this worktree's slot was released while its app started, so the app was stopped");
    return null;
  }
  if (await waitForHttp(url, () => groupAlive(pgid), READY_TIMEOUT_MS)) {
    say(`slot ${lease.slot} is up at ${url} (log: ${log})`);
    return started;
  }
  await stopGroup(pgid, identity);
  updateLease(machinesRoot(), lease, { pgid: null, identity: null });
  say(`the app never answered at ${url}. Last log lines (${log}):\n${tail(log)}`);
  return null;
}

const killNow = (lease: Lease): void => {
  if (lease.pgid && ownsGroup(lease.pgid, lease.identity)) signalGroup(lease.pgid, 'SIGKILL');
  if (lease.box) removeBox(lease.box.name);
};

const appCommand = (override: string[], config: MachineConfig, vars: SlotVars) =>
  (override.length > 0 ? override : config.command)?.map((arg) => expand(arg, vars));

const NOT_CLAIMED = {
  busy: "another `devkit machine up` is starting this worktree's machine; retry once it finishes",
  released: "this worktree's slot was released meanwhile; run `devkit machine up` again",
};

/** Null, after saying the slot was released while this `up` worked on it. */
function released(): null {
  say(NOT_CLAIMED.released);
  return null;
}

const appUp = (lease: Lease) =>
  lease.pgid !== null && groupAlive(lease.pgid) && ownsGroup(lease.pgid, lease.identity);
const boxUp = (lease: Lease) => lease.box !== null && boxRunning(lease.box.name);

/** Seed the slot and start its app; with no app command the slot is only leased. */
async function startSlotApp(root: string, lease: Lease, override: string[]) {
  const config = readMachineConfig(root);
  const port = await pickPort(PORT_BASE + lease.slot * PORTS_PER_SLOT);
  const vars = { ...slotVars(lease), port };
  mkdirSync(vars.profile, { recursive: true });
  if (!seedSlot({ root, machines: machinesRoot(), lease, seed: config.seed, vars }))
    return released();
  const env = slotProcessEnv(process.env, slotEnv(vars));
  const command = appCommand(override, config, vars);
  if (command) return startAndWait(root, { ...lease, port }, command, env);
  say(`slot ${lease.slot} leased; no app command, so start your app on $PORT yourself`);
  return updateLease(machinesRoot(), lease, { port }) ?? released();
}

/** Start the slot's box on two more ports of its block, under a fresh name and live-view password
 * (VNC passwords stop at 8 characters). A box whose lease was released meanwhile is removed. */
async function startSlotBox(root: string, lease: Lease, openApp: boolean) {
  if (lease.box) removeBox(lease.box.name);
  ensureImage(join(machinesRoot(), 'image-build.log'), say);
  const base = PORT_BASE + lease.slot * PORTS_PER_SLOT;
  const view = await pickPort(base, [lease.port]);
  const cdp = await pickPort(base, [lease.port, view]);
  const name = `devkit-machine-${lease.slot}-${randomBytes(4).toString('hex')}`;
  const box: Box = { name, view, cdp, password: randomBytes(6).toString('base64url') };
  if (!updateLease(machinesRoot(), lease, { box })) return released();
  startBox(box, root, base, openApp ? `http://127.0.0.1:${lease.port}` : null);
  const devtools = `http://127.0.0.1:${cdp}/json/version`;
  const ready = await waitForHttp(devtools, () => boxRunning(name), BOX_READY_MS);
  const current = updateLease(machinesRoot(), lease, {});
  if (ready && current) return current;
  removeBox(name);
  if (!current) return released();
  updateLease(machinesRoot(), lease, { box: null });
  say("the machine's desktop did not answer within a minute, so it was removed");
  return null;
}

/** `up [--full|--light] [-- <command…>]`: the mode flag overrides guard.config.json's. */
function upArgs(rest: string[]) {
  const flags = new Set<string>();
  let at = 0;
  for (; /^--(full|light)$/.test(rest[at] ?? ''); at++) flags.add(rest[at].slice(2));
  const after = rest.slice(at);
  const unknown = after[0]?.startsWith('-') && after[0] !== '--';
  return { flags: [...flags], unknown, override: after[0] === '--' ? after.slice(1) : after };
}

async function up(root: string, rest: string[]): Promise<number> {
  const { flags, unknown, override } = upArgs(rest);
  if (flags.length > 1 || unknown) {
    say('usage: devkit machine up [--full|--light] [-- <command…>]');
    return 1;
  }
  const full = (flags[0] ?? readMachineConfig(root).mode) === 'full';
  const problem = full ? engineProblem() : null;
  if (problem) say(problem);
  if (problem || !memoryAllows()) return 1;
  const { lease } = acquireLease(root, { root: machinesRoot(), kill: killNow });
  // Checked before the lease lock, so no docker call ever runs under it.
  const liveBox = full && lease.box && boxRunning(lease.box.name) ? lease.box.name : null;
  const claim = claimStart(
    machinesRoot(),
    lease,
    // A light slot still holding a box is not up: removing it needs the claim, like starting one.
    (l) => appUp(l) && (full ? l.box?.name === liveBox : !l.box),
  );
  if (claim === 'busy' || claim === 'released') {
    say(NOT_CLAIMED[claim]);
    return 1;
  }
  // Read again after the claim, which fences every other `up` of this lease until it is cleared.
  const fresh = findLease(machinesRoot(), root);
  let ready = fresh?.id === lease.id ? fresh : released();
  if (ready?.box && !full) {
    removeBox(ready.box.name);
    ready = updateLease(machinesRoot(), ready, { box: null }) ?? released();
  }
  if (ready && claim === 'running') say(`slot ${ready.slot} is already running for this worktree`);
  else if (ready) {
    if (!appUp(ready)) ready = await startSlotApp(root, ready, override);
    if (ready && full && !boxUp(ready))
      ready = await startSlotBox(root, ready, ready.pgid !== null);
    ready &&= updateLease(machinesRoot(), ready, { starter: null }) ?? released();
  }
  if (!ready) return 1;
  if (ready.box)
    say(`its desktop: ${viewUrl(ready.box)} (watch only; drop view_only=1 to take control)`);
  printEnv(root, ready);
  return 0;
}

function report(result: RunResult, evidence: string): number {
  for (const entry of result.entries)
    console.log(`${entry.kind}: ${join(evidence, entry.file)} (${entry.bytes} bytes)`);
  if (result.entries.some((entry) => entry.kind === 'video' && entry.bytes > VIDEO_CAP))
    say('the video is over the 9 MB a PR attaches; shorten the flow so it can be uploaded');
  if (result.passed)
    say(
      `flow "${result.flow}" passed; \`devkit ship\` attaches it, or \`devkit machine attach <pr>\` once the PR is open`,
    );
  else
    say(
      `flow "${result.flow}" failed: ${result.error}\n  its capture is kept locally and never uploaded`,
    );
  return result.passed ? 0 : 1;
}

/** This worktree's lease, touched so no other `up` reaps it as idle mid-command, or null after saying
 * why it has none. With `desktop`, only a lease whose box still runs. */
function ownLease(root: string, desktop: boolean): Lease | null {
  const lease = findLease(machinesRoot(), root);
  if (!lease) say(NO_MACHINE);
  else if (desktop && !lease.box) say(NO_DESKTOP);
  else if (lease.box && !boxRunning(lease.box.name))
    say(
      "this worktree's desktop is gone (was the container engine restarted?); run `devkit machine up` again",
    );
  else return updateLease(machinesRoot(), lease, {}) ?? released();
  return null;
}

async function run(root: string, rest: string[]): Promise<number> {
  const options = { name: { type: 'string' } } as const;
  const { values, positionals } = parseArgs({ args: rest, options, allowPositionals: true });
  const [flowPath] = positionals;
  if (!flowPath) say('usage: devkit machine run <flow.mjs> [--name <label>]');
  const lease = flowPath ? ownLease(root, false) : null;
  if (!flowPath || !lease) return 1;
  const { profile } = slotVars(lease);
  const evidence = evidenceDir(root);
  const url = `http://127.0.0.1:${lease.port}`;
  const { box } = lease;
  const result = await runFlow({ root, flowPath, name: values.name, url, profile, evidence, box });
  return report(result, evidence);
}

/** `exec [-d] -- <command…>`: run anything in the box: xdotool input, apt-get, an Electron app. */
function exec(root: string, rest: string[]): number {
  const detach = rest[0] === '-d';
  const argv = detach ? rest.slice(1) : rest;
  const command = argv[0] === '--' ? argv.slice(1) : argv;
  if (command.length === 0) say('usage: devkit machine exec [-d] -- <command…>');
  const lease = command.length > 0 ? ownLease(root, true) : null;
  return lease?.box ? boxExec(lease.box.name, command, detach) : 1;
}

function screen(root: string, rest: string[]): number {
  const lease = ownLease(root, true);
  if (!lease?.box) return 1;
  const file = resolve(rest[0] ?? join(slotDir(machinesRoot(), lease.slot), 'screen.png'));
  screenshot(lease.box.name, file);
  console.log(file);
  return 0;
}

async function down(root: string): Promise<number> {
  const lease = findLease(machinesRoot(), root);
  if (!lease) {
    say('no machine for this worktree');
    return 0;
  }
  const freed = await releaseLease(machinesRoot(), lease, ({ pgid, identity, box }) => {
    if (box) removeBox(box.name);
    return pgid ? stopGroup(pgid, identity) : undefined;
  });
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
  const desktop = lease.box ? `  desktop :${lease.box.view}` : '';
  const idle = Math.round((Date.now() - lease.touchedAt) / 60_000);
  return `slot ${lease.slot}  :${lease.port}  app ${app}${desktop}  idle ${idle}m  ${lease.worktree}`;
}

function status(): number {
  const leases = listLeases(machinesRoot());
  console.log(leases.length ? leases.map(statusLine).join('\n') : 'no machines');
  return 0;
}

type Verb = (root: string, rest: string[]) => number | Promise<number>;

// Loaded on use: the upload path pulls in ship's evidence modules, which no other verb needs.
const attach: Verb = async (root, rest) =>
  (await import('../../lib/ship/evidence/attach.mts')).attachCapture(root, rest[0]);

const VERBS = new Map<string, Verb>([
  ['up', up],
  ['run', run],
  ['attach', attach],
  ['exec', exec],
  ['screenshot', screen],
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
