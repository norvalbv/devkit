/** Full mode's box: one container per slot inside the container engine's Linux VM, with its own
 * desktop, filesystem, Chromium, live view and screen recorder (Grok Bot's "own screen"). */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { digest } from '../fs-helpers.mts';
import { shellQuote } from '../ship/dist-integrity.mts';

const START = fileURLToPath(new URL('./box-start.sh', import.meta.url));
const DOCKERFILE = `FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 DISPLAY=:1
RUN apt-get update && apt-get install -y --no-install-recommends \\
    xvfb xfce4 xfce4-terminal dbus-x11 x11vnc novnc websockify xdotool x11-utils ffmpeg chromium \\
    fonts-dejavu fonts-noto-color-emoji ca-certificates curl unzip git socat sudo procps \\
  && rm -rf /var/lib/apt/lists/* \\
  && useradd -m -s /bin/bash agent && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent
COPY box-start.sh /usr/local/bin/box-start.sh
USER agent
WORKDIR /home/agent
ENTRYPOINT ["sh", "/usr/local/bin/box-start.sh"]
`;
const SCREEN = '1280x800';
const GRAB = ['ffmpeg', '-loglevel', 'error', '-f', 'x11grab', '-video_size', SCREEN];
const RECORDINGS = '/tmp/devkit-recordings';
/** A recording nobody stops ends itself, so a forgotten one cannot fill the VM's disk. */
const MAX_RECORDING_SECONDS = '600';
const STOP_POLL_MS = 200;
const STOP_TIMEOUT_MS = 15_000;
/** Bounds every quick docker call: a CLI hung on an engine that is starting must not hang `up`. */
const QUICK_MS = 30_000;
/** A flow's `exec` blocks the flow's own timeout, so it carries the same bound itself. */
const EXEC_MS = 5 * 60_000;
const START_POLL_MS = 100;
/** The build message promises 10 minutes; a wedged build must not hold `up` past them. */
const BUILD_MS = 10 * 60_000;

/** Where a slot's box listens on this Mac: its live view (noVNC, behind `password`) and its Chrome
 * DevTools port. */
export interface Box {
  name: string;
  view: number;
  cdp: number;
  password: string;
}

const docker = (args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: QUICK_MS,
  }).trim();
const quietly = (args: string[]) =>
  spawnSync('docker', args, { stdio: 'ignore', timeout: QUICK_MS }).status === 0;

/** The image tag names its own definition, so a devkit that changes the box rebuilds it. */
export const boxImage = (): string =>
  `devkit-machine:${digest(DOCKERFILE + readFileSync(START, 'utf8')).slice(0, 12)}`;

/** Why full mode cannot run here, or null when a container engine answers. */
export function engineProblem(): string | null {
  if (quietly(['info'])) return null;
  return 'full mode needs Docker Desktop running (`docker info` must answer); light mode (`devkit machine up --light`) needs none';
}

/** Build the box image unless it exists, then delete the images of older box definitions. */
export function ensureImage(log: string, say: (message: string) => void): void {
  const image = boxImage();
  if (quietly(['image', 'inspect', image])) return;
  say(
    `building the machine image once: 2-3 minutes and 1.9 GB (allow this call 10 minutes); log: ${log}`,
  );
  const out = openSync(log, 'w');
  try {
    const args = ['build', '-t', image, '-f', '-', dirname(START)];
    const built = spawnSync('docker', args, {
      input: DOCKERFILE,
      stdio: ['pipe', out, out],
      timeout: BUILD_MS,
    });
    if (built.status !== 0) throw new Error(`the machine image did not build; see ${log}`);
  } finally {
    closeSync(out);
  }
  const older = docker(['image', 'ls', 'devkit-machine', '--format', '{{.Repository}}:{{.Tag}}']);
  for (const tag of older.split('\n').filter((t) => t && t !== image)) quietly(['rmi', tag]);
}

export const boxRunning = (name: string): boolean =>
  spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], {
    encoding: 'utf8',
    timeout: QUICK_MS,
  }).stdout?.trim() === 'true';

/** Remove the box without waiting, so a caller holding the lease lock never waits on docker. */
export function removeBox(name: string): void {
  const child = spawn('docker', ['rm', '-f', name], { detached: true, stdio: 'ignore' });
  child.once('error', () => undefined);
  child.unref();
}

/** Start the box with the worktree read-only at /work. Inside it, 127.0.0.1 on every port of the
 * slot's block reaches the host, so the box opens the URLs light mode uses. */
export function startBox(box: Box, worktree: string, block: number, open: string | null): void {
  const run = ['run', '-d', '--rm', '--init', '--name', box.name, '--shm-size', '1g'];
  const ports = ['-p', `127.0.0.1:${box.view}:6080`, '-p', `127.0.0.1:${box.cdp}:9223`];
  const host = ['--add-host', 'host.docker.internal:host-gateway', '-e', `PORT_BLOCK=${block}`];
  const env = ['-e', `VNC_PASSWORD=${box.password}`, ...(open ? ['-e', `OPEN_URL=${open}`] : [])];
  docker([...run, ...ports, ...host, ...env, '-v', `${worktree}:/work:ro`, boxImage()]);
}

export const viewUrl = (box: Box): string =>
  `http://127.0.0.1:${box.view}/vnc.html?autoconnect=1&resize=scale&view_only=1&password=${box.password}`;

/** Run `argv` in the box as its user, on its display; `detach` returns at once. */
export function boxExec(name: string, argv: string[], detach: boolean): number {
  const args = ['exec', ...(detach ? ['-d'] : []), name, ...argv];
  return spawnSync('docker', args, { stdio: 'inherit' }).status ?? 1;
}

/** `argv`'s stdout in the box; a non-zero exit throws with its stderr, failing a flow. */
export const boxOutput = (name: string, argv: string[]): string =>
  execFileSync('docker', ['exec', name, ...argv], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: EXEC_MS,
  });

/** The whole screen as a PNG at `file`, in the pixels xdotool clicks. */
export function screenshot(name: string, file: string): void {
  const png = execFileSync(
    'docker',
    ['exec', name, ...GRAB, '-i', ':1', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'],
    { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: QUICK_MS },
  );
  writeFileSync(file, png);
}

const recordingFile = (flow: string) => `${RECORDINGS}/${flow}.mp4`;

/** Whether `mp4` is whole atoms, one a top-level moov, which ffmpeg writes only when it finishes the
 * file; `moov` bytes inside media data do not count, and neither does a file cut off mid-atom. */
export function hasMoovAtom(mp4: Buffer): boolean {
  let moov = false;
  for (let at = 0; at < mp4.length;) {
    if (at + 8 > mp4.length) return false;
    const size = mp4.readUInt32BE(at);
    const atom = size === 1 && at + 16 <= mp4.length ? Number(mp4.readBigUInt64BE(at + 8)) : size;
    if (atom < 8 || at + atom > mp4.length) return false;
    moov ||= mp4.toString('latin1', at + 4, at + 8) === 'moov';
    at += atom;
  }
  return moov;
}
/** One recording per box: ffmpeg inherits flock's lock and holds it until it exits. */
const RECORDING_LOCK = '/tmp/devkit-recording.lock';
const LOCK_HELD = 75;
// yuv420p and faststart, so the PR plays it inline.
const ENCODE = [
  '-framerate',
  '15',
  '-i',
  ':1',
  '-t',
  MAX_RECORDING_SECONDS,
  '-c:v',
  'libx264',
].concat(['-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);

const recorderRunning = (name: string, flow: string): boolean =>
  quietly(['exec', name, 'pgrep', '-f', recordingFile(flow)]);

/** Kill `flow`'s recorder and delete its file: what it wrote is not a playable video. */
function discardRecording(name: string, flow: string): void {
  quietly(['exec', name, 'pkill', '-KILL', '-f', recordingFile(flow)]);
  quietly(['exec', name, 'rm', '-f', recordingFile(flow)]);
}

/** Start recording the whole screen as `flow`, returning once frames reach the file; throws while
 * another run records this box, or when no frame arrives (its recorder is then killed). */
export async function startRecording(name: string, flow: string): Promise<void> {
  const file = recordingFile(flow);
  const ffmpeg = [...GRAB, ...ENCODE, '-y', file].map(shellQuote).join(' ');
  const script = `mkdir -p ${RECORDINGS} && rm -f ${file} && (${ffmpeg} </dev/null >/dev/null 2>&1 &)`;
  const lock = ['flock', '-n', '-E', String(LOCK_HELD), RECORDING_LOCK, 'sh', '-c', script];
  const started = spawnSync('docker', ['exec', name, ...lock], { timeout: QUICK_MS });
  if (started.status === LOCK_HELD)
    throw new Error('another run is recording this machine; wait for it to finish');
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (started.status !== 0 || !quietly(['exec', name, 'test', '-s', file])) {
    if (started.status !== 0 || Date.now() > deadline) {
      discardRecording(name, flow);
      throw new Error("the screen recorder never started on this machine's desktop");
    }
    await sleep(START_POLL_MS);
  }
}

/** Stop `flow`'s recording (ffmpeg finishes the file on SIGINT) and copy it to `file`; false unless
 * a finished mp4 (one with its moov index, which a recorder that died never writes) was copied. */
export async function stopRecording(name: string, flow: string, file: string): Promise<boolean> {
  quietly(['exec', name, 'pkill', '-INT', '-f', recordingFile(flow)]);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (recorderRunning(name, flow) && Date.now() < deadline) await sleep(STOP_POLL_MS);
  if (recorderRunning(name, flow)) {
    discardRecording(name, flow);
    return false;
  }
  const copied = quietly(['cp', `${name}:${recordingFile(flow)}`, file]);
  quietly(['exec', name, 'rm', '-f', recordingFile(flow)]);
  if (copied && hasMoovAtom(readFileSync(file))) return true;
  rmSync(file, { force: true });
  return false;
}
