/**
 * Self-host `related-tests` extra gate: runs the tests vitest's import graph relates to the
 * commit's staged paths, so a test broken by the change blocks before any AI judge runs.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  opts: { cwd: string; stdio: 'inherit' },
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
  const result = (opts.exec ?? spawnSync)(vitest, args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(`✗ related-tests could not run vitest: ${result.error.message}`);
  // A null status is a signal kill or a failed spawn: nothing passed, so block.
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = runRelatedTests(process.cwd());
}
