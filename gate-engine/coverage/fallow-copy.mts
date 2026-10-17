/** fallow's CRAP input (FALLOW_COVERAGE): a private copy of coverage-final.json, hits clamped and
 * keys moved onto this checkout. The artifact itself is never rewritten; the coverage gate binds it. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalPath } from './gate-shared.mts';
import { COVERAGE_FILE } from './produce.mts';

/** vitest's v8→istanbul conversion can emit a negative hit count, which fails fallow's u32 parse
 * of the whole file. A negative hit is a miss and the gate counts only hits > 0: 0 keeps totals. */
const hitSchema = z.int().transform((hits) => Math.max(0, hits));
const hitsSchema = z.record(z.string(), hitSchema).optional();

/**
 * One istanbul file entry. `path` is rekeyed onto this checkout and the s/f/b hit counts are clamped; every
 * other field (statementMap, fnMap, branchMap, …) passes through untouched.
 */
const coverageEntrySchema = z.looseObject({
  path: z.string().optional(),
  s: hitsSchema,
  f: hitsSchema,
  b: z.record(z.string(), z.array(hitSchema)).optional(),
});

/** coverage-final.json: file key → istanbul entry. A map that does not parse is never handed to
 * fallow, which then scores CRAP from estimates instead of failing on counts it cannot read. */
export const coverageMapSchema = z.record(z.string(), coverageEntrySchema);
export type CoverageMap = z.infer<typeof coverageMapSchema>;

const countsSchema = z.record(z.string(), z.int()).optional();
/** The unclamped hit counts alone, for asking whether fallow can read the artifact as it stands. */
const rawHitsSchema = z.record(
  z.string(),
  z.object({
    s: countsSchema,
    f: countsSchema,
    b: z.record(z.string(), z.array(z.int())).optional(),
  }),
);

/** Whether any s/f/b hit count in an unclamped map is negative. */
function hasNegativeHit(map: z.infer<typeof rawHitsSchema>): boolean {
  return Object.values(map).some((entry) =>
    [entry.s, entry.f, entry.b].some(
      (counts) =>
        counts &&
        Object.values(counts)
          .flat()
          .some((hits) => hits < 0),
    ),
  );
}

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

/** Every path git tracks in `top`, repo-relative. */
export function trackedPaths(top: string): Set<string> {
  const listed = execFileSync('git', ['-C', top, 'ls-files', '-z'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Set(listed.split('\0').filter(Boolean));
}

/** The root `top`'s artifact keys were produced under when that is another checkout, else null. A
 * key under `top` can still be foreign: a worktree nested in the checkout shares its prefix. */
function foreignRoot(keys: string[], top: string): string | null {
  const root = canonicalPath(top);
  const foreign = deriveForeignRoot(keys, trackedPaths(top), root);
  return foreign === null || canonicalPath(foreign) === root ? null : foreign;
}

/** Write fallow's copy of `<top>`'s artifact to a new temp file and return its path. Null when
 * fallow reads the artifact unaided or there is none; throws on a map that does not parse. */
export function writeFallowCopy(top: string, cwd: string): string | null {
  const report = join(top, COVERAGE_FILE);
  if (!existsSync(report)) return null;
  const raw: unknown = JSON.parse(readFileSync(report, 'utf8'));
  const counts = rawHitsSchema.safeParse(raw);
  if (!counts.success) throw new Error(`${report}: ${z.prettifyError(counts.error)}`);
  const foreign = foreignRoot(Object.keys(counts.data), top);
  const atTop = canonicalPath(cwd) === canonicalPath(top);
  if (foreign === null && atTop && !hasNegativeHit(counts.data)) return null;
  const map = coverageMapSchema.parse(raw);
  const out = join(tmpdir(), `devkit-fallow-coverage-${randomUUID()}.json`);
  const copy = foreign === null ? map : rebaseCoverageMap(map, foreign, canonicalPath(top));
  writeFileSync(out, JSON.stringify(copy), { flag: 'wx', mode: 0o600 });
  return out;
}
