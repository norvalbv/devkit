/**
 * The commit a reviewer's diff was computed against (sc-2480): the gate cwd's own HEAD, never an
 * env var, so a printed base always describes the tree the reviewers actually saw.
 */

import { execFileSync } from 'node:child_process';
import { headHash } from './staged-git.mts';

export type BaseSource = 'ship base' | 'review merge-base' | 'local HEAD';

export interface ReviewBaseContext {
  /** The commit `git diff --cached` was computed against; null when HEAD is unborn or unreadable. */
  baseSha: string | null;
  source: BaseSource;
  /** An env hint naming a commit other than the tree that was reviewed. */
  envHintMismatch: string | null;
  /** The calling worktree's HEAD, or null when the caller IS the reviewed tree. */
  callerHead: string | null;
  /** Commits the caller is behind the base, or null when git could not count them. DIAGNOSTIC
   * ONLY — never a trigger (sc-2297). Null is not 0: a fabricated distance reads as a measurement. */
  behind: number | null;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const PATHS_SHOWN = 10;

export const shortSha = (sha: string): string => sha.slice(0, 12);

/** Two spellings of one commit. A ship exports a full sha, but a hand-set hint is often abbreviated,
 * and reporting an abbreviation of the reviewed base as a DISAGREEMENT is a false alarm. */
const sameCommit = (hint: string, base: string): boolean =>
  SHA_RE.test(hint) && (base.startsWith(hint) || hint.startsWith(base));

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function resolve(
  cwd: string,
  env: NodeJS.ProcessEnv,
  pinnedHead: string | null,
): ReviewBaseContext {
  const head = pinnedHead ?? headHash(cwd);
  const baseSha = head !== null && !head.startsWith('unborn:') ? head : null;
  const shipBase = env.DEVKIT_SHIP_BASE_SHA?.trim() || null;
  const reviewBase = env.DEVKIT_REVIEW_MERGE_BASE?.trim() || null;
  const hint = shipBase ?? reviewBase;
  const source: BaseSource = shipBase
    ? 'ship base'
    : reviewBase
      ? 'review merge-base'
      : 'local HEAD';
  const callerRaw = env.DEVKIT_SHIP_SOURCE_HEAD?.trim() || null;
  // Resolved, not string-compared: a hint may be abbreviated, and an abbreviation of the reviewed
  // base is the caller sitting ON the base — no divergence to report, and no diff worth running.
  const resolved =
    callerRaw && SHA_RE.test(callerRaw)
      ? (git(cwd, ['rev-parse', '--verify', '--quiet', `${callerRaw}^{commit}`])?.trim() ?? null)
      : null;
  const callerHead = resolved && resolved !== baseSha ? resolved : null;
  const counted =
    callerHead && baseSha
      ? Number.parseInt(
          git(cwd, ['rev-list', '--count', `${callerHead}..${baseSha}`])?.trim() ?? '',
          10,
        )
      : Number.NaN;
  return {
    baseSha,
    source,
    envHintMismatch: hint && baseSha && !sameCommit(hint, baseSha) ? hint : null,
    callerHead,
    behind: callerHead && Number.isFinite(counted) ? counted : null,
  };
}

const cache = new Map<string, ReviewBaseContext>();

const cacheKeyFor = (cwd: string, env: NodeJS.ProcessEnv): string =>
  [
    cwd,
    env.DEVKIT_SHIP_BASE_SHA ?? '',
    env.DEVKIT_REVIEW_MERGE_BASE ?? '',
    env.DEVKIT_SHIP_SOURCE_HEAD ?? '',
  ].join('\0');

/** Resolved once per (cwd, env-hint) pair: every reviewer's scope row and block note reports the
 * same base, and the git reads do not repeat per reviewer. */
export function reviewBaseContext(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ReviewBaseContext {
  const key = cacheKeyFor(cwd, env);
  const hit = cache.get(key);
  if (hit) return hit;
  const ctx = resolve(cwd, env, null);
  cache.set(key, ctx);
  return ctx;
}

/** Seed the context from a head the caller already pinned. The gate snapshots HEAD before it reads
 * any evidence, so re-reading it here could name a tree the reviewers never judged (sc-2054). */
export function primeReviewBaseContext(
  cwd: string,
  head: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ReviewBaseContext {
  const ctx = resolve(cwd, env, head);
  cache.set(cacheKeyFor(cwd, env), ctx);
  return ctx;
}

/** Test seam: the resolution reads live git state, which a fixture repo mutates between cases. */
export function resetReviewBaseContext(): void {
  cache.clear();
}

/** Paths the base changed since the caller diverged; NULL when git could not answer — a shallow
 * clone exits 128 here, and that is not the same fact as "nothing moved". */
export function movedOnBase(cwd: string, ctx: ReviewBaseContext): string[] | null {
  if (!ctx.callerHead || !ctx.baseSha) return [];
  const raw = git(cwd, [
    'diff',
    '--name-status',
    '-z',
    '--no-renames',
    `${ctx.callerHead}...${ctx.baseSha}`,
  ]);
  if (raw === null) return null;
  const fields = raw.split('\0');
  const moved: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i + 1]) moved.push(fields[i + 1]);
  return moved;
}

/** Exact path or directory containment — the trailing slash keeps `cli/lib/ship` from matching
 * `cli/lib/shipwreck.mts`. Deliberately not globbing (sc-2297). */
function overlaps(moved: string, reviewed: string[]): boolean {
  return reviewed.some((file) => moved === file || moved.startsWith(`${file}/`));
}

/** Printed once per run on PASS as well as FAIL. Keyed on PATH OVERLAP, never the behind-count or sha
 * inequality: in a shared checkout those are permanently red (base-drift-surfaced-at-read-time (b)).
 */
export function baseProvenanceLines(
  cwd: string,
  reviewedFiles: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const ctx = reviewBaseContext(cwd, env);
  if (!ctx.baseSha)
    return [
      'guard-review: base UNKNOWN — the reviewed tree has no readable HEAD, so no finding’s ' +
        'location can be verified against it. Treat every finding as unresolved rather than refuted.',
    ];
  const behind = ctx.behind ? `, ${ctx.behind} commit(s) ahead of your worktree` : '';
  const lines = [
    `guard-review: reviewed against ${shortSha(ctx.baseSha)} (${ctx.source}${behind}) — ` +
      'findings below name lines in THAT tree.',
  ];
  if (ctx.envHintMismatch)
    lines.push(
      `guard-review: the invoking ship named base ${shortSha(ctx.envHintMismatch)} but the ` +
        `reviewed tree is at ${shortSha(ctx.baseSha)}; the reviewed tree is what the findings describe.`,
    );
  if (!ctx.callerHead) return lines;
  const moved = movedOnBase(cwd, ctx);
  if (moved === null) {
    lines.push(
      `guard-review: whether any reviewed path also moved on the base COULD NOT BE DETERMINED ` +
        `(git could not diff ${shortSha(ctx.callerHead)}...${shortSha(ctx.baseSha)} — a shallow ` +
        `clone or unrelated histories do this). Resolve findings against the base above, not your HEAD.`,
    );
    return lines;
  }
  const overlapping = moved.filter((path) => overlaps(path, reviewedFiles));
  if (overlapping.length === 0) return lines;
  const shown = overlapping.slice(0, PATHS_SHOWN);
  const more =
    overlapping.length > shown.length ? ` …and ${overlapping.length - shown.length} more` : '';
  lines.push(
    `guard-review: ${overlapping.length} reviewed path(s) ALSO changed on the base after your ` +
      `worktree was cut — \`git show HEAD:<path>\` in your worktree can neither confirm nor refute ` +
      `a finding about them: ${shown.join(', ')}${more}`,
  );
  return lines;
}
