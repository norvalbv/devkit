import os from 'node:os';
import type { Reporter, SerializedError, TestRunEndReason } from 'vitest/node';

const MAX_FILES = 10;

/** The slice of vitest's TestModule read here, so tests can pass plain objects. */
type FailSource = { relativeModuleId: string; state(): string };

const command = (file: string) => `  node cli/index.mts baseline-status --file ${file} --json`;

/** One line per failing file naming main's CI verdict for it; nothing when no file failed. */
export function formatBaselinePointer(files: string[], loadavg: number[], cpus: number) {
  if (files.length === 0) return [];
  const lines = [
    "devkit test baseline: check whether these files are already red on main's CI before re-running anything:",
  ];
  const load = loadavg[0] ?? 0;
  if (load > cpus) {
    lines.push(
      `  loadavg ${load.toFixed(2)} > ${cpus} cpus: a re-run on a clean base under this load proves nothing`,
    );
  }
  lines.push(...files.slice(0, MAX_FILES).map(command));
  if (files.length > MAX_FILES) {
    lines.push(
      `  …and ${files.length - MAX_FILES} more — node cli/index.mts baseline-status --json lists every file failing on main`,
    );
  }
  return lines;
}

/** A red local run otherwise invites a clean-base re-run, which fails the same way under load. */
export default class BaselinePointerReporter implements Reporter {
  onTestRunEnd(
    testModules: ReadonlyArray<FailSource>,
    _errors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ) {
    if (reason === 'interrupted') return;
    const failing = testModules
      .filter((m) => m.state() === 'failed')
      .map((m) => m.relativeModuleId);
    for (const line of formatBaselinePointer(failing, os.loadavg(), os.availableParallelism())) {
      console.error(line);
    }
  }
}
