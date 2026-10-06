// Regenerated dist is release-only (typescript-source-prebuilt-mjs, 2026-07-26): a PR's committed tree
// may add or delete dist, never rewrite it. CI judges it (gate.yml); ship only names drift (sc-2467).
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** The branch `devkit release` opens (cli/commands/release.mts): `release/v<x.y.z>`, never more. */
const RELEASE_BRANCH = /^release\/v(\d+\.\d+\.\d+)$/;
const VersionedPackage = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });
const NamedPackage = z.object({ name: z.literal('@norvalbv/devkit') });
/** Only these statuses leave tracked dist bytes untouched: a new artifact, or a deletion (sc-2060). */
const FEATURE_SAFE = new Set(['A', 'D']);
const REGULAR_FILE = new Set(['100644', '100755']);

export function releaseVersion(branch: string | undefined): string | undefined {
  return branch === undefined ? undefined : RELEASE_BRANCH.exec(branch)?.[1];
}

function git(root: string, args: string[], input?: Buffer): string {
  return execFileSync('git', ['-C', root, '--no-optional-locks', ...args], {
    input,
    stdio: 'pipe',
  }).toString('utf8');
}

/** A symlink's blob is its target text; `hash-object <path>` would hash the file it points at. */
function linkBlob(root: string, file: string): string {
  const target = readlinkSync(path.join(root, file), { encoding: 'buffer' });
  return git(root, ['hash-object', '--stdin'], target).trim();
}

/** Parse one package.json read; any read, parse or shape failure is `undefined`. */
function parsed<T>(schema: z.ZodType<T>, read: () => string): T | undefined {
  try {
    return schema.safeParse(JSON.parse(read())).data;
  } catch {
    return undefined;
  }
}

/** The package.json being judged: the given tree's, else the working tree's. */
function shippedPackage(root: string, tree: string | undefined): () => string {
  return tree === undefined
    ? () => readFileSync(path.join(root, 'package.json'), 'utf8')
    : () => git(root, ['show', `${tree}:package.json`]);
}

/** devkit's own repo if EITHER base or the judged tree says so: breaking one side cannot disarm it. */
function isDevkit(root: string, base: string, tree: string | undefined): boolean {
  const atBase = () => git(root, ['show', `${base}:package.json`]);
  return [atBase, shippedPackage(root, tree)].some((read) => parsed(NamedPackage, read));
}

/** A branch name proves nothing; the version bump it names, in the judged tree, does. Unreadable → no. */
function provenRelease(root: string, base: string, branch: string | undefined, tree: string) {
  const version = releaseVersion(branch);
  if (version === undefined) return false;
  const shipped = parsed(VersionedPackage, shippedPackage(root, tree))?.version;
  const prior = parsed(VersionedPackage, () =>
    git(root, ['show', `${base}:package.json`]),
  )?.version;
  return shipped === version && prior !== undefined && prior !== version;
}

export interface ReleaseOnlyReport {
  active: boolean;
  /** Staged rewrites of tracked dist (any status but A/D): refused unless a proven release. */
  releaseOnly: string[];
  /** Caller-side rewrites of tracked dist: main's drift, named so nobody sorts it by hand. */
  drift: string[];
}

/** Each `<status>\0<path>` pair of a NUL-delimited `--name-status` diff. */
function statusPairs(raw: string): Array<[string, string]> {
  const fields = raw.split('\0').filter(Boolean);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < fields.length; i += 2) pairs.push([fields[i]!, fields[i + 1]!]);
  return pairs;
}

/** Caller-side dist rewrites vs `base`, via `diff-index`: porcelain `git diff` rewrites the shared
 *  index. A null worktree sha (stat-dirty, no refresh) is settled by hashing the file's bytes. */
function callerDrift(root: string, base: string): string[] {
  const raw = git(root, ['diff-index', '--raw', '-z', '--no-renames', base, '--', 'dist']);
  const fields = raw.split('\0').filter(Boolean);
  const rewritten: string[] = [];
  const unhashed = new Map<string, string>(); // path → base blob
  for (let i = 0; i + 1 < fields.length; i += 2) {
    // `:<srcMode> <dstMode> <srcSha> <dstSha> <status>`, then the path.
    const [srcMode, dstMode, srcSha, dstSha, status] = fields[i]!.slice(1).split(' ');
    const file = fields[i + 1]!;
    if (FEATURE_SAFE.has(status!)) continue;
    const statDirty = srcMode === dstMode && /^0+$/.test(dstSha!);
    if (statDirty && REGULAR_FILE.has(srcMode!)) unhashed.set(file, srcSha!);
    else if (!statDirty || srcMode !== '120000' || linkBlob(root, file) !== srcSha) {
      rewritten.push(file);
    }
  }
  const files = [...unhashed.keys()];
  // argv, never newline-delimited --stdin-paths: a tracked path may itself contain a newline.
  for (let i = 0; i < files.length; i += 500) {
    const batch = files.slice(i, i + 500);
    const hashes = git(root, ['hash-object', '--', ...batch]).split('\n');
    rewritten.push(...batch.filter((file, j) => hashes[j] !== unhashed.get(file)));
  }
  return rewritten.sort();
}

/** With `tree` (CI: the PR head's committed tree) this refuses; without it (ship's caller-side
 *  preflight) it only names the working tree's drift, so nobody sorts it by hand. */
export function inspectReleaseOnlyDist(
  root: string,
  base: string,
  branch: string | undefined,
  { tree }: { tree?: string } = {},
): ReleaseOnlyReport {
  if (!isDevkit(root, base, tree)) return { active: false, releaseOnly: [], drift: [] };
  if (tree === undefined) return { active: true, releaseOnly: [], drift: callerDrift(root, base) };
  const diff = ['diff', '--no-renames', '--name-status', '-z', base, tree, '--', 'dist'];
  const rewritten = statusPairs(git(root, diff))
    .filter(([status]) => !FEATURE_SAFE.has(status))
    .map(([, file]) => file)
    .sort();
  if (provenRelease(root, base, branch, tree)) return { active: true, releaseOnly: [], drift: [] };
  return { active: true, releaseOnly: rewritten, drift: [] };
}

const DRIFT_LISTED = 10;

export function printReleaseOnlyDist(report: ReleaseOnlyReport): number {
  if (!report.active) return 0;
  if (report.drift.length > 0) {
    console.error(
      `devkit ship: ${report.drift.length} regenerated dist file(s) are release-only drift from main — leave them out of the brief:`,
    );
    for (const file of report.drift.slice(0, DRIFT_LISTED)) console.error(`    ${file}`);
    const rest = report.drift.length - DRIFT_LISTED;
    if (rest > 0) console.error(`    +${rest} more`);
  }
  if (report.releaseOnly.length === 0) return 0;
  console.error('✗ devkit ship: this ship rewrites tracked dist, which is release-only.');
  for (const file of report.releaseOnly) console.error(`    ${file}`);
  console.error(
    '  Regenerated dist ships only with `devkit release` (docs/decisions/typescript-source-prebuilt-mjs.md, 2026-07-26).',
  );
  console.error(
    '  Fix: drop these from the brief. Brief source plus only the NEW dist paths named here.',
  );
  console.error(
    '  A review finding that asks for one of these files does not override this: a tracked dist file stays stale until the next release.',
  );
  return 1;
}
