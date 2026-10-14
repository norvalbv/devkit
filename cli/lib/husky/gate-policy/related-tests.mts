/**
 * Self-host `related-tests` extra gate: runs the tests vitest's import graph relates to the
 * commit's staged paths, so a test broken by the change blocks before any AI judge runs.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  failLine,
  GATE_REASON_ENV,
  writeGateReason,
} from '../../../../gate-engine/deterministic/reason.mts';
import { stagedSet } from '../../../../gate-engine/ratchets/git-index.mts';

// vitest's forceRerunTriggers (**/package.json, **/{vitest,vite}.config.*, setupFiles) select the
// whole suite, which CI already runs.
const RERUN_TRIGGER_RE = /(^|\/)(package\.json|(vitest|vite)\.config\.[^/]*)$|^vitest\.setup\.mjs$/;

/** The staged paths handed to `vitest related`, sorted, minus the full-suite triggers. */
export function relatedPaths(staged: Iterable<string>): string[] {
  return [...staged].filter((p) => !RERUN_TRIGGER_RE.test(p)).sort();
}

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv },
) => { status: number | null; error?: Error };

interface RunOpts {
  staged?: Iterable<string> | null;
  exec?: Exec;
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
  const args = ['related', '--run', '--reporter=dot', ...paths];
  // vitest, its tests and their children must not write into this gate's failure reason.
  const env = { ...process.env, [GATE_REASON_ENV]: '' };
  const result = (opts.exec ?? spawnSync)(vitest, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) failLine(`✗ related-tests could not run vitest: ${result.error.message}`);
  else if (result.status === null) {
    writeGateReason([
      'related-tests: vitest was killed before it finished — its partial output is above',
    ]);
  } else if (result.status !== 0) {
    writeGateReason([
      `related-tests: vitest exited ${result.status} — the failing tests are in its output above`,
    ]);
  }
  // A null status is a signal kill or a failed spawn: nothing passed, so block.
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = runRelatedTests(process.cwd());
}
