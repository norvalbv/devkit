// Regenerated dist is release-only (typescript-source-prebuilt-mjs, 2026-07-26): a PR's committed tree
// may add or delete dist, never rewrite it. CI judges it (gate.yml); ship only names drift (sc-2467).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** The branch `devkit release` opens (cli/commands/release.mts): `release/v<x.y.z>`, never more. */
const RELEASE_BRANCH = /^release\/v(\d+\.\d+\.\d+)$/;
const VersionedPackage = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });
const NamedPackage = z.object({ name: z.literal('@norvalbv/devkit') });
/** Only these statuses leave tracked dist bytes untouched: a new artifact, or a deletion (sc-2060). */
const FEATURE_SAFE = new Set(['A', 'D']);

export function releaseVersion(branch: string | undefined): string | undefined {
  return branch === undefined ? undefined : RELEASE_BRANCH.exec(branch)?.[1];
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }).toString('utf8');
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

/** With `tree` (CI: the PR head's committed tree) this refuses; without it (ship's caller-side
 *  preflight) it only names the working tree's drift, so nobody sorts it by hand. */
export function inspectReleaseOnlyDist(
  root: string,
  base: string,
  branch: string | undefined,
  { tree }: { tree?: string } = {},
): ReleaseOnlyReport {
  if (!isDevkit(root, base, tree)) return { active: false, releaseOnly: [], drift: [] };
  const target = tree === undefined ? [base] : [base, tree];
  const diff = ['diff', '--no-renames', '--name-status', '-z', ...target, '--', 'dist'];
  const rewritten = statusPairs(git(root, diff))
    .filter(([status]) => !FEATURE_SAFE.has(status))
    .map(([, file]) => file)
    .sort();
  if (tree === undefined) return { active: true, releaseOnly: [], drift: rewritten };
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
  return 1;
}
