#!/usr/bin/env node
/** sc-1292: write a PRIVATE copy of the linked coverage map, keys moved onto the ship worktree, for
 * fallow's CRAP join (FALLOW_COVERAGE). Never touches <wt>/coverage, which the provenance gate reads. */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { REPORT_NAME } from '../../../../gate-engine/coverage/produce.mts';
import {
  boundManifest,
  isScopedRun,
  readArtifact,
} from '../../../../gate-engine/coverage/provenance.mts';

/** vitest's v8→istanbul conversion can emit a negative hit count, which fails fallow's u32 parse
 * of the whole file. A negative hit is a miss and the gate counts only hits > 0: 0 keeps totals. */
const hitSchema = z.int().transform((hits) => Math.max(0, hits));
const hitsSchema = z.record(z.string(), hitSchema).optional();

/**
 * One istanbul file entry. `path` is rekeyed and the s/f/b hit counts are clamped; every other field
 * (statementMap, fnMap, branchMap, …) passes through untouched.
 */
const coverageEntrySchema = z.looseObject({
  path: z.string().optional(),
  s: hitsSchema,
  f: hitsSchema,
  b: z.record(z.string(), z.array(hitSchema)).optional(),
});

/** coverage-final.json: file key → istanbul entry. A map that does not parse is never rebased, so
 * fallow is never handed counts it cannot read and scores CRAP from estimates instead. */
export const coverageMapSchema = z.record(z.string(), coverageEntrySchema);
export type CoverageMap = z.infer<typeof coverageMapSchema>;

/** `/a/b` → `/a/b/`, and `/` stays `/` — the boundary a key must start with to sit under `root`. */
const boundary = (root: string): string => `${root.replace(/\/+$/, '')}/`;

/** The SHORTEST prefix of `key` whose remainder is tracked — a root `index.ts` cannot claim
 * `/prod/src/index.ts` as `/prod/src`. */
function producingPrefix(key: string, tracked: ReadonlySet<string>): string | null {
  const parts = key.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (tracked.has(parts.slice(i).join('/'))) return parts.slice(0, i).join('/') || '/';
  }
  return null;
}

/**
 * The root the map's absolute keys were produced under, or null when there is nothing to rebase: no
 * key joins a tracked path, the keys are relative, or the majority already sits at `wtRoot`.
 */
export function deriveForeignRoot(
  keys: Iterable<string>,
  tracked: ReadonlySet<string>,
  wtRoot: string,
): string | null {
  const votes = new Map<string, number>();
  for (const key of keys) {
    if (!key.startsWith('/')) continue;
    const prefix = producingPrefix(key, tracked);
    if (prefix !== null) votes.set(prefix, (votes.get(prefix) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestVotes = 0;
  for (const [prefix, count] of votes) {
    if (count > bestVotes) [best, bestVotes] = [prefix, count];
  }
  return best === null || boundary(best) === boundary(wtRoot) ? null : best;
}

/** Move every key and istanbul `path` under `fromRoot` to `toRoot`; others stay. On a collision the
 * key already at `toRoot` wins — it was produced from this tree. */
export function rebaseCoverageMap(map: CoverageMap, fromRoot: string, toRoot: string): CoverageMap {
  const from = boundary(fromRoot);
  const to = boundary(toRoot);
  const move = (path: string): string =>
    path.startsWith(from) ? to + path.slice(from.length) : path;
  const out: CoverageMap = {};
  const moved: Array<[string, CoverageMap[string]]> = [];
  for (const [key, original] of Object.entries(map)) {
    const path = original.path === undefined ? undefined : move(original.path);
    const entry = path === original.path ? original : { ...original, path };
    if (key.startsWith(from)) moved.push([move(key), entry]);
    else out[key] = entry;
  }
  for (const [key, entry] of moved) if (!(key in out)) out[key] = entry;
  return out;
}

function trackedPaths(wt: string): Set<string> {
  const listed = execFileSync('git', ['-C', wt, 'ls-files', '-z'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Set(listed.split('\0').filter(Boolean));
}

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
