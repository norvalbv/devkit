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
  trackedPaths,
} from '../../../../gate-engine/coverage/fallow-copy.mts';
import { REPORT_NAME } from '../../../../gate-engine/coverage/produce.mts';
import {
  boundManifest,
  isScopedRun,
  readArtifact,
} from '../../../../gate-engine/coverage/provenance.mts';

/** What fallow was handed: the root a rekeyed copy came from, or the args of a scoped run. */
export type FallowCoverage = { root: string } | { scopedArgs: string[] };

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
  const scopedArgs = boundManifest(source, artifact)?.args ?? [];
  if (isScopedRun(scopedArgs)) {
    writeFileSync(outFile, '{}', { flag: 'wx' });
    return { scopedArgs };
  }
  const parsed = coverageMapSchema.safeParse(JSON.parse(artifact.bytes));
  if (!parsed.success) throw new Error(`${report}: ${z.prettifyError(parsed.error)}`);
  const map = parsed.data;
  const wtRoot = realpathSync(wt);
  const root = deriveForeignRoot(Object.keys(map), trackedPaths(wt), wtRoot);
  if (root === null) return null;
  writeFileSync(outFile, JSON.stringify(rebaseCoverageMap(map, root, wtRoot)), { flag: 'wx' });
  return { root };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [wt, source, outFile] = process.argv.slice(2);
  try {
    if (!wt || !source || !outFile) {
      throw new Error('usage: coverage-rebase <worktree> <linked-coverage-dir> <out-file>');
    }
    const result = rebaseWorktreeCoverage(wt, source, outFile);
    if (result && 'root' in result) process.stdout.write(`${result.root}\n`);
    else if (result) process.stdout.write(`scoped ${result.scopedArgs.join(' ')}\n`);
  } catch (error) {
    process.stderr.write(
      `devkit ship: coverage paths not rebased (${error instanceof Error ? error.message : String(error)}) — fallow may score CRAP without measured coverage\n`,
    );
  }
}
