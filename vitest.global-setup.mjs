import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// sc-2785: stamps machine load at both ends of a run so a timeout-shaped failure can be weighed from
// the output. Not a reporter: `devkit test-report-run` passes --reporter, replacing config reporters.

/** Windows reports [0, 0, 0]; printed verbatim rather than guessed at. */
export function formatLoad(loadavg, cpus) {
  return `loadavg=${loadavg.map((n) => n.toFixed(2)).join('/')} cpus=${cpus}`;
}

/** One greppable line per end of the run. */
export function formatLoadLine(label, loadavg, cpus) {
  return `devkit test load: ${label} ${formatLoad(loadavg, cpus)}`;
}

const stamp = (label) =>
  console.error(formatLoadLine(label, os.loadavg(), os.availableParallelism()));

export const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const GATE_LOG = /^last-commit-gates-.*\.log$/;

/** Each commit gate log under `root`/.devkit → the `=== devkit … gates` header lines it holds. */
export function readGateLogHeaders(root) {
  const dir = path.join(root, '.devkit');
  if (!existsSync(dir)) return new Map();
  const logs = readdirSync(dir).filter((name) => GATE_LOG.test(name));
  return new Map(
    logs.map((name) => [
      name,
      readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('=== devkit ')),
    ]),
  );
}

/** Throws on a header present after the run but not before; a live commit's own appends add none. */
export function assertNoNewGateLogHeaders(before, after) {
  const stray = [...after].flatMap(([name, headers]) =>
    headers.filter((h) => !before.get(name)?.includes(h)).map((h) => `${name}: ${h}`),
  );
  if (stray.length === 0) return;
  throw new Error(
    `A hook wrote the repository's own commit gate log during the test run:\n  ${stray.join('\n  ')}\n` +
      'A test ran a hook without a fixture cwd, or a real commit ran in this worktree mid-suite.',
  );
}

let gateLogsAtStart = new Map();

export function setup() {
  stamp('start');
  gateLogsAtStart = readGateLogHeaders(REPO_ROOT);
}

export function teardown() {
  stamp('end');
  assertNoNewGateLogHeaders(gateLogsAtStart, readGateLogHeaders(REPO_ROOT));
}
