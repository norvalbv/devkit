import os from 'node:os';

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

export function setup() {
  stamp('start');
}

export function teardown() {
  stamp('end');
}
