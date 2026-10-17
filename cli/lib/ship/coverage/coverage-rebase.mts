#!/usr/bin/env node
/** sc-1292: write a PRIVATE copy of the linked coverage map, keys moved onto the ship worktree, for
 * fallow's CRAP join (FALLOW_COVERAGE). Never touches <wt>/coverage, which the provenance gate reads. */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

/** Write `source`'s map, rekeyed onto `wt`, to a NEW `outFile` when it was produced elsewhere.
 * Returns the foreign root, or null (nothing written). */
export function rebaseWorktreeCoverage(wt: string, source: string, outFile: string): string | null {
  const report = join(source, REPORT_NAME);
  if (!existsSync(report)) return null;
  const parsed = coverageMapSchema.safeParse(JSON.parse(readFileSync(report, 'utf8')));
  if (!parsed.success) throw new Error(`${report}: ${z.prettifyError(parsed.error)}`);
  const map = parsed.data;
  const wtRoot = realpathSync(wt);
  const root = deriveForeignRoot(Object.keys(map), trackedPaths(wt), wtRoot);
  if (root === null) return null;
  writeFileSync(outFile, JSON.stringify(rebaseCoverageMap(map, root, wtRoot)), { flag: 'wx' });
  return root;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [wt, source, outFile] = process.argv.slice(2);
  try {
    if (!wt || !source || !outFile) {
      throw new Error('usage: coverage-rebase <worktree> <linked-coverage-dir> <out-file>');
    }
    const root = rebaseWorktreeCoverage(wt, source, outFile);
    if (root !== null) process.stdout.write(`${root}\n`);
  } catch (error) {
    process.stderr.write(
      `devkit ship: coverage paths not rebased (${error instanceof Error ? error.message : String(error)}) — fallow may score CRAP without measured coverage\n`,
    );
  }
}
