// One real queue participant per process for ship-queue.test.mts.
// Usage: <root> <label> <out> hold <ms> | group | die | seq
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  acquireShipSlot,
  enqueue,
  ensureRoot,
  registerGroup,
} from '../lib/ship/queue/ship-queue.mts';

const [root = '', label = '', out = '', mode = '', holdMs = '0'] = process.argv.slice(2);
const log = (line: string) => appendFileSync(out, `${line}\n`);

if (mode === 'seq') {
  ensureRoot(root);
  const fields = {
    pid: process.pid,
    identity: 'ps:x',
    repo: '/r',
    branch: label,
    mode: 'seq',
    startedAt: 0,
  };
  log(String(enqueue(root, fields).ticket.seq));
} else {
  const handle = await acquireShipSlot({
    repo: '/r',
    branch: label,
    mode: 'test',
    root,
    pollMs: 25,
    log: () => undefined,
  });
  log(`start ${label} ${handle.token}`.trim());
  if (mode === 'die') {
    process.kill(process.pid, 'SIGKILL'); // claimed, never registered a group
  } else if (mode === 'group') {
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    if (child.pid === undefined || !registerGroup(root, handle.token, child.pid)) process.exit(3);
    log(`group ${child.pid}`);
    setInterval(() => undefined, 1_000);
  } else {
    await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
    log(`end ${label}`);
    handle.release();
  }
}
