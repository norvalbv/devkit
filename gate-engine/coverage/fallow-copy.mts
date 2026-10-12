/** The coverage map fallow can read: a private, hit-clamped copy of coverage-final.json for its
 * CRAP join (FALLOW_COVERAGE). The artifact itself is never rewritten; the coverage gate binds it. */
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
 * One istanbul file entry. `path` is rekeyed by ship and the s/f/b hit counts are clamped; every
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

/** Write the clamped copy of `<top>`'s artifact to a new temp file and return its path. Null when
 * fallow reads the artifact unaided or there is none; throws on a map that does not parse. */
export function writeFallowCopy(top: string, cwd: string): string | null {
  const report = join(top, COVERAGE_FILE);
  if (!existsSync(report)) return null;
  const raw: unknown = JSON.parse(readFileSync(report, 'utf8'));
  const counts = rawHitsSchema.safeParse(raw);
  if (!counts.success) throw new Error(`${report}: ${z.prettifyError(counts.error)}`);
  if (canonicalPath(cwd) === canonicalPath(top) && !hasNegativeHit(counts.data)) return null;
  const out = join(tmpdir(), `devkit-fallow-coverage-${randomUUID()}.json`);
  writeFileSync(out, JSON.stringify(coverageMapSchema.parse(raw)), { flag: 'wx', mode: 0o600 });
  return out;
}
