/**
 * Self-host `related-tests` extra gate: runs the tests vitest's import graph relates to the
 * commit's staged paths, so a test broken by the change blocks before any AI judge runs.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stagedSet } from '../../../../gate-engine/ratchets/git-index.mts';
import { errorMessage } from '../../ship/review/shared/common.mts';

// vitest's forceRerunTriggers (**/package.json, **/{vitest,vite}.config.*, setupFiles) select the
// whole suite, which CI already runs.
const RERUN_TRIGGER_RE = /(^|\/)(package\.json|(vitest|vite)\.config\.[^/]*)$|^vitest\.setup\.mjs$/;

/** The staged paths the related-test listing starts from, sorted, minus the full-suite triggers. */
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
  list?: typeof listRelated;
}

/** The test files `vitest related` would select, resolved in-process so no queued vitest CLI starts. */
export async function listRelated(root: string, paths: string[]): Promise<string[]> {
  const { createVitest } = await import('vitest/node');
  const related = paths.map((p) => join(root, p));
  const ctx = await createVitest({ root, related, watch: false, run: true });
  try {
    const specs = await ctx.getRelevantTestSpecifications();
    return [...new Set(specs.map((s) => s.moduleId))].sort();
  } finally {
    await ctx.close();
  }
}

/** Exit code of the related-tests run: 0 when nothing is selected, vitest's status otherwise. */
export async function runRelatedTests(root: string, opts: RunOpts = {}): Promise<number> {
  const paths = relatedPaths(('staged' in opts ? opts.staged : stagedSet(root)) ?? []);
  if (!paths.length) {
    console.log('related-tests: none selected');
    return 0;
  }
  let files: string[];
  try {
    files = await (opts.list ?? listRelated)(root, paths);
  } catch (err) {
    console.error(`✗ related-tests could not list related tests: ${errorMessage(err)}`);
    return 1;
  }
  if (!files.length) {
    console.log(`related-tests: no test relates to the ${paths.length} staged path(s)`);
    return 0;
  }
  console.log(`related-tests: ${files.length} test file(s) for ${paths.length} staged path(s)`);
  const vitest = join(root, 'node_modules', '.bin', 'vitest');
  const args = ['run', '--reporter=dot', ...files];
  const result = (opts.exec ?? spawnSync)(vitest, args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(`✗ related-tests could not run vitest: ${result.error.message}`);
  // A null status is a signal kill or a failed spawn: nothing passed, so block.
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await runRelatedTests(process.cwd());
}
