/** fallow's CRAP input (FALLOW_COVERAGE): a private copy of coverage-final.json, hits clamped, keys
 * moved onto this checkout. The artifact itself is never rewritten; the coverage gate binds it. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { commitIndexEnv } from '../ratchets/commit-index.mts';
import { canonicalPath, TEST_PATH } from './gate-shared.mts';
import { COVERAGE_FILE } from './produce.mts';
import {
  type ArtifactRead,
  artifactKeysSchema,
  boundManifest,
  type Classify,
  checkProvenance,
  git,
  isScopedRun,
  keysByPath,
  readArtifact,
} from './provenance.mts';

/** vitest's v8→istanbul conversion can emit a negative hit count, which fails fallow's u32 parse
 * of the whole file. A negative hit is a miss and the gate counts only hits > 0: 0 keeps totals. */
const hitSchema = z.int().transform((hits) => Math.max(0, hits));
const hitsSchema = z.record(z.string(), hitSchema).optional();

/**
 * One istanbul file entry. `path` is rekeyed onto this checkout and the s/f/b hit counts are
 * clamped; every other field (statementMap, fnMap, branchMap, …) passes through untouched.
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
    env: commitIndexEnv(top),
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

/** The args of the scoped `devkit coverage-run` that wrote these bytes; null for a full or unbound
 * run. Its loaded-but-unrun files read as measured 0%, so fallow must estimate instead. */
export function scopedRunArgs(coverageDir: string, artifact: ArtifactRead): string[] | null {
  const args = boundManifest(coverageDir, artifact)?.args ?? [];
  return isScopedRun(args) ? args : null;
}

/** A new private temp file holding `body`, for FALLOW_COVERAGE. */
function writePrivate(body: string): string {
  const out = join(tmpdir(), `devkit-fallow-coverage-${randomUUID()}.json`);
  writeFileSync(out, body, { flag: 'wx', mode: 0o600 });
  return out;
}

/** Measured files edited after the run, with their map keys, and test files edited after it. */
export interface StaleCoverage {
  files: string[];
  keys: string[];
  tests: string[];
}

const classifyForFallow: Classify = (path, measured) =>
  TEST_PATH.test(path) ? 'test' : measured ? 'production' : 'other';

/** Briefed files whose blob changed since `artifact` was measured; null when fresh or unknown. No
 * runtime-neutral exemption: a deleted comment still moves the lines fallow joins functions on. */
export function staleCoverage(
  cwd: string,
  coverageDir: string,
  artifact: ArtifactRead,
): StaleCoverage | null {
  const provenance = checkProvenance(cwd, coverageDir, artifact, classifyForFallow);
  if (provenance.state !== 'drift') return null;
  const parsed = artifactKeysSchema.safeParse(JSON.parse(artifact.bytes));
  const byPath = keysByPath(Object.keys(parsed.data ?? {}), provenance.manifest.roots);
  const files = inIndex(cwd, provenance.production);
  if (files.length === 0 && provenance.tests.length === 0) return null;
  return { files, keys: files.flatMap((f) => byPath.get(f) ?? []), tests: provenance.tests };
}

/** The paths still in the commit's index: fallow scores nothing for a deleted file. provenance's
 * `git` passes --literal-pathspecs, so `src/[id].mts` matches only itself. */
function inIndex(cwd: string, paths: string[]): string[] {
  if (paths.length === 0) return paths;
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const listed = new Set(git(top, ['ls-files', '-z', '--', ...paths]).split('\0'));
  return paths.filter((p) => listed.has(p));
}

/** fallow ≥3.21 estimates a function with no map entry, so dropping a stale file's key estimates
 * exactly that file and leaves every fresh file measured. */
export function withoutKeys(map: CoverageMap, keys: readonly string[]): CoverageMap {
  const drop = new Set(keys);
  return Object.fromEntries(Object.entries(map).filter(([key]) => !drop.has(key)));
}

/** The one line both fallow callers print for a stale artifact. */
export function staleNotice({ files, tests }: StaleCoverage): string {
  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(
      `fallow scores CRAP for ${files.length} file(s) from static estimates — coverage predates their edits: ${files.join(', ')}; re-measure with a full \`devkit coverage-run\``,
    );
  }
  if (tests.length > 0) {
    parts.push(
      `the coverage run predates edits to ${tests.join(', ')}, so measured CRAP may be off`,
    );
  }
  return parts.join(' · ');
}

/** What fallow-copy handed fallow: a temp map (`{}` for a scoped run), and why it was changed. */
export interface FallowCopy {
  path?: string;
  scopedArgs?: string[];
  stale?: StaleCoverage;
}

/** The map fallow should read for `<top>`'s artifact, or `<cwd>`'s when the root has none. Null when
 * fallow reads it unaided or there is none; throws on an unscoped `<top>` map that does not parse. */
export function writeFallowCopy(top: string, cwd: string): FallowCopy | null {
  const atTop = join(top, COVERAGE_FILE);
  const report = existsSync(atTop) ? atTop : join(cwd, COVERAGE_FILE);
  if (!existsSync(report)) return null;
  const artifact = readArtifact(report);
  // `{}`, not an unset FALLOW_COVERAGE: fallow auto-reads coverage/ under its cwd.
  const scopedArgs = scopedRunArgs(dirname(report), artifact);
  if (scopedArgs) return { path: writePrivate('{}'), scopedArgs };
  const stale = staleCoverage(cwd, dirname(report), artifact);
  const path = writeCopy(top, cwd, report, artifact, stale?.keys ?? []);
  if (path === null) return stale ? { stale } : null;
  return stale ? { path, stale } : { path };
}

/** The clamped, rekeyed, pruned copy's path; null when fallow can read the artifact as it stands. */
function writeCopy(
  top: string,
  cwd: string,
  report: string,
  artifact: ArtifactRead,
  staleKeys: string[],
): string | null {
  const atTop = report === join(top, COVERAGE_FILE);
  if (!atTop && staleKeys.length === 0) return null;
  const raw: unknown = JSON.parse(artifact.bytes);
  const counts = rawHitsSchema.safeParse(raw);
  if (!counts.success) throw new Error(`${report}: ${z.prettifyError(counts.error)}`);
  const foreign = atTop ? foreignRoot(Object.keys(counts.data), top) : null;
  const inTop = canonicalPath(cwd) === canonicalPath(top);
  const unaided = foreign === null && inTop && !hasNegativeHit(counts.data);
  if (unaided && staleKeys.length === 0) return null;
  const map = withoutKeys(coverageMapSchema.parse(raw), staleKeys);
  const copy = foreign === null ? map : rebaseCoverageMap(map, foreign, canonicalPath(top));
  return writePrivate(JSON.stringify(copy));
}
