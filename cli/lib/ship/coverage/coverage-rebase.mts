#!/usr/bin/env node
/** sc-1292: write a PRIVATE copy of the linked coverage map, keys moved onto the ship worktree, for
 * fallow's CRAP join (FALLOW_COVERAGE). Never touches <wt>/coverage, which the provenance gate reads. */
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  coverageMapSchema,
  deriveForeignRoot,
  rebaseCoverageMap,
  type StaleCoverage,
  scopedRunArgs,
  staleCoverage,
  staleNotice,
  trackedPaths,
  withoutKeys,
} from '../../../../gate-engine/coverage/fallow-copy.mts';
import { REPORT_NAME } from '../../../../gate-engine/coverage/produce.mts';
import { readArtifact } from '../../../../gate-engine/coverage/provenance.mts';

/** What fallow was handed: the root a rekeyed copy came from (null: only stale keys were dropped),
 * and the briefed files the run predates; or the args of a scoped run. */
export type FallowCoverage =
  | { root: string | null; stale?: StaleCoverage }
  | { scopedArgs: string[] };

/** Write `source`'s map, rekeyed onto `wt`, to a NEW `outFile`; a scoped run's loaded-but-unrun files
 * read as measured 0%, so it gets `{}` (unset would let fallow find coverage/). Null: nothing written. */
export function rebaseWorktreeCoverage(
  wt: string,
  source: string,
  outFile: string,
): FallowCoverage | null {
  const report = join(source, REPORT_NAME);
  if (!existsSync(report)) return null;
  const artifact = readArtifact(report);
  const scopedArgs = scopedRunArgs(source, artifact);
  if (scopedArgs) {
    writeFileSync(outFile, '{}', { flag: 'wx' });
    return { scopedArgs };
  }
  const stale = staleCoverage(wt, source, artifact) ?? undefined;
  const parsed = coverageMapSchema.safeParse(JSON.parse(artifact.bytes));
  if (!parsed.success) throw new Error(`${report}: ${z.prettifyError(parsed.error)}`);
  const wtRoot = realpathSync(wt);
  const root = deriveForeignRoot(Object.keys(parsed.data), trackedPaths(wt), wtRoot);
  const keys = stale?.keys ?? [];
  if (root === null && keys.length === 0) return stale ? { root, stale } : null;
  const map = withoutKeys(parsed.data, keys);
  const copy = root === null ? map : rebaseCoverageMap(map, root, wtRoot);
  writeFileSync(outFile, JSON.stringify(copy), { flag: 'wx' });
  return { root, stale };
}

/** stdout for the shell: the rekeyed root, `pruned` when only stale keys were dropped, or nothing. */
function printResult(result: FallowCoverage | null): void {
  if (result === null) return;
  if ('scopedArgs' in result) {
    process.stdout.write(`scoped ${result.scopedArgs.join(' ')}\n`);
    return;
  }
  if (result.stale) process.stderr.write(`devkit ship: ${staleNotice(result.stale)}\n`);
  if (result.root !== null) process.stdout.write(`${result.root}\n`);
  else if (result.stale?.keys.length) process.stdout.write('pruned\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [wt, source, outFile] = process.argv.slice(2);
  try {
    if (!wt || !source || !outFile) {
      throw new Error('usage: coverage-rebase <worktree> <linked-coverage-dir> <out-file>');
    }
    printResult(rebaseWorktreeCoverage(wt, source, outFile));
  } catch (error) {
    process.stderr.write(
      `devkit ship: coverage paths not rebased (${error instanceof Error ? error.message : String(error)}) — fallow may score CRAP without measured coverage\n`,
    );
  }
}
