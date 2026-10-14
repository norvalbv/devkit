/**
 * Self-host `related-tests` extra gate: runs the tests vitest's import graph relates to the
 * commit's staged paths, so a test broken by the change blocks before any AI judge runs.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  displayPath,
  readDiagnosis,
  RESULTS_NAME,
  type RunDiagnosis,
  UNHANDLED_REPORTER,
} from '../../../../gate-engine/coverage/failures.mts';
import { GATE_REASON_ENV, writeGateReason } from '../../../../gate-engine/deterministic/reason.mts';
import { stagedSet } from '../../../../gate-engine/ratchets/git-index.mts';

// vitest's forceRerunTriggers (**/package.json, **/{vitest,vite}.config.*, setupFiles) select the
// whole suite, which CI already runs.
const RERUN_TRIGGER_RE = /(^|\/)(package\.json|(vitest|vite)\.config\.[^/]*)$|^vitest\.setup\.mjs$/;

/** Failing tests named in the reason; the rest stay in vitest's own output above it. */
const NAMED_TESTS = 5;

/** The staged paths handed to `vitest related`, sorted, minus the full-suite triggers. */
export function relatedPaths(staged: Iterable<string>): string[] {
  return [...staged].filter((p) => !RERUN_TRIGGER_RE.test(p)).sort();
}

interface SpawnResult {
  status: number | null;
  error?: Error;
}

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv },
) => SpawnResult;

interface RunOpts {
  staged?: Iterable<string> | null;
  exec?: Exec;
}

/** Why a failed run blocked: the failing tests by file and title, or why vitest never reported. */
export function relatedTestsReason(
  result: SpawnResult,
  diagnosis: RunDiagnosis | null,
  root: string,
): string[] {
  if (result.error || result.status === null) {
    const why = result.error?.message ?? 'it was killed before exiting';
    return [`related-tests could not run vitest: ${why}`];
  }
  if (!diagnosis) {
    return [
      `vitest exited ${result.status} without a test report — its output is in the full log above`,
    ];
  }
  if (diagnosis.unhandled) {
    return [
      'No test failed; the run ended on:',
      ...diagnosis.unhandled.map((e) =>
        e.file ? `${displayPath(e.file, root)}: ${e.message}` : e.message,
      ),
    ];
  }
  const named = [
    ...(diagnosis.failures?.tests ?? []).map((t) => `${displayPath(t.file, root)} > ${t.name}`),
    ...(diagnosis.collection ?? []).map(
      (c) => `${displayPath(c.file, root)} — failed to load: ${c.message.split('\n')[0]}`,
    ),
  ];
  const hidden = named.length - NAMED_TESTS;
  return [
    `${diagnosis.failedFiles.length} test file(s) failed:`,
    ...named.slice(0, NAMED_TESTS),
    ...(hidden > 0 ? [`(${hidden} more in the full log above)`] : []),
  ];
}

/** A private directory for vitest's json report; '' when none can be made, and the run goes unnarrated. */
function reportDir(): string {
  try {
    return mkdtempSync(join(tmpdir(), 'devkit-related-tests-'));
  } catch {
    return '';
  }
}

/** Record the failure reason. Narration only: nothing here may throw into the verdict. */
function narrate(result: SpawnResult, report: string, root: string): void {
  try {
    const diagnosis = report ? readDiagnosis(report, result.status ?? 1) : null;
    writeGateReason(relatedTestsReason(result, diagnosis, root));
  } catch {
    // The exit code already carries the verdict.
  }
}

/** Exit code of the related-tests run: 0 when nothing is selected, vitest's status otherwise. */
export function runRelatedTests(root: string, opts: RunOpts = {}): number {
  const paths = relatedPaths(('staged' in opts ? opts.staged : stagedSet(root)) ?? []);
  if (!paths.length) {
    console.log('related-tests: none selected');
    return 0;
  }
  console.log(`related-tests: ${paths.length} staged path(s)`);
  const vitest = join(root, 'node_modules', '.bin', 'vitest');
  const dir = reportDir();
  const report = dir && join(dir, RESULTS_NAME);
  const reporters = report
    ? ['--reporter=json', `--outputFile.json=${report}`, `--reporter=${UNHANDLED_REPORTER}`]
    : [];
  const args = ['related', '--run', '--reporter=dot', ...reporters, ...paths];
  // A test that drives gate code must not write into this gate's own reason file.
  const env = { ...process.env };
  delete env[GATE_REASON_ENV];
  try {
    const result = (opts.exec ?? spawnSync)(vitest, args, { cwd: root, stdio: 'inherit', env });
    if (result.error)
      console.error(`✗ related-tests could not run vitest: ${result.error.message}`);
    // A null status is a signal kill or a failed spawn: nothing passed, so block.
    const status = result.status ?? 1;
    if (status !== 0) narrate(result, report, root);
    return status;
  } finally {
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir never outranks the verdict.
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = runRelatedTests(process.cwd());
}
