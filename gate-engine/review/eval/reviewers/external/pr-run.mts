/** One published-benchmark pull request through devkit's four-lens cascade: blobless clone, fetch
 * base and head, diff base...head locally, materialize onto the merge base, select the correctness
 * scope and plan its lens tasks. Shared by the ReviewBench and AACR-Bench adapters, which own only
 * their export. All checkouts stay under the caller's private research root. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { resolveGuardConfigJson } from '../../../../config.mts';
import { measureDiffEvidenceCap } from '../../../diff-evidence.mts';
import { stagedFiles } from '../../../evidence/staged-git.mts';
import { selectReviewers } from '../../../reviewers.mts';
import { materialize, reviewAssetProjections } from '../scale/materialize.mts';
import {
  estimateUsd,
  planLensTasks,
  runIdentity,
  runLensWave,
  syncReviewAssets,
} from '../scale/lens-run.mts';
import type { GuardConfig } from '../../../../config.mts';
import type { DiffEvidenceCap } from '../../../diff-evidence.mts';
import type { ReviewerSelection } from '../../../reviewers.mts';
import type { CheckpointRow, LensCheckpoint, LensTask } from '../scale/lens-run.mts';

export interface PreparedPr {
  wt: string;
  base: string;
  staged: string[];
  sel: ReviewerSelection;
  cfg: GuardConfig;
  tasks: LensTask[];
  identity: string;
  diffSha: string;
  diffText: string;
  /** Changed lines and files of the materialised base...head diff (binary files count 0 lines). */
  diffLines: number;
  diffFiles: number;
  evidence: DiffEvidenceCap;
}

export const ensurePrivateDir = (d: string): void => {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
};

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' },
  });

/** Blobless clone of `remotes[0]` under `reposDir`; tmp+rename so concurrent runs never share a
 * half-cloned checkout. Later remotes are fetch fallbacks for commits the first one lacks. */
export function ensureClone(reposDir: string, name: string, remotes: readonly string[]): string {
  ensurePrivateDir(reposDir);
  const repoDir = path.join(reposDir, name);
  if (existsSync(path.join(repoDir, '.git'))) return repoDir;
  const tmp = `${repoDir}.tmp.${process.pid}`;
  execFileSync(
    'git',
    ['clone', '--quiet', '--filter=blob:none', '--no-checkout', remotes[0], tmp],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
  try {
    renameSync(tmp, repoDir);
  } catch {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(path.join(repoDir, '.git')))
      throw new Error(`clone: ${repoDir} missing after a concurrent clone`);
  }
  return repoDir;
}

/** Fetch each sha the clone lacks, trying every remote in order. Returns false when some sha
 * cannot be fetched from any of them — the caller removes that PR from its denominator. */
export function fetchCommits(
  repoDir: string,
  remotes: readonly string[],
  shas: readonly string[],
): boolean {
  for (const sha of shas) {
    const has = (): boolean => {
      try {
        git(repoDir, ['cat-file', '-e', `${sha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    };
    if (has()) continue;
    for (const remote of remotes) {
      try {
        git(repoDir, ['fetch', '--quiet', '--filter=blob:none', remote, sha]);
      } catch {
        // try the next remote
      }
      if (has()) break;
    }
    if (!has()) return false;
  }
  return true;
}

/** Changed lines and files of base...head, read from numstat (a binary file counts 0 lines). */
export function diffSize(repoDir: string, base: string, head: string) {
  const numstat = git(repoDir, ['diff', '--numstat', `${base}...${head}`])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
  return {
    lines: numstat.reduce((a, [add, del]) => a + (Number(add) || 0) + (Number(del) || 0), 0),
    files: numstat.length,
  };
}

/** Ancestor directories of the projected review assets, relative to the worktree. */
function projectionAncestors(devkitRoot: string, wt: string): string[] {
  const out = new Set<string>();
  for (const { destination } of reviewAssetProjections(devkitRoot, wt))
    for (let at = path.dirname(destination); at !== wt; at = path.dirname(at))
      out.add(path.relative(wt, at));
  return [...out];
}

/** A benchmark repo may track `.claude/skills` as a symlink into its own tree. syncReviewAssets
 * refuses to project through one, so the disposable worktree (never the index) drops the link. */
function unlinkProjectionSymlinks(devkitRoot: string, wt: string): void {
  for (const rel of projectionAncestors(devkitRoot, wt))
    if (lstatSync(path.join(wt, rel), { throwIfNoEntry: false })?.isSymbolicLink())
      unlinkSync(path.join(wt, rel));
}

/** Undo unlinkProjectionSymlinks before a cached worktree is revalidated: materialize accepts no
 * working-tree change other than the projected assets themselves. */
function restoreProjectionSymlinks(devkitRoot: string, wt: string): void {
  if (!existsSync(path.join(wt, '.scale-probe-base'))) return;
  for (const rel of projectionAncestors(devkitRoot, wt)) {
    const tracked = git(wt, ['ls-files', '-s', '--', `:(literal)${rel}`]).trim();
    if (!tracked.startsWith('120000 ') || !tracked.endsWith(`\t${rel}`)) continue;
    rmSync(path.join(wt, rel), { recursive: true, force: true });
    git(wt, ['checkout-index', '-f', '-u', '--', rel]);
  }
}

export function preparePr(o: {
  repoDir: string;
  base: string;
  head: string;
  include: readonly string[];
  exclude: readonly string[];
  worktreesDir: string;
  devkitRoot: string;
  keyPrefix: string;
  arms: readonly string[];
  issueCap: string;
}): PreparedPr | { skip: string } {
  const start = git(o.repoDir, ['merge-base', o.base, o.head]).trim();
  const diffText = git(o.repoDir, ['diff', `${o.base}...${o.head}`]);
  const diffSha = createHash('sha256').update(diffText).digest('hex');
  const size = diffSize(o.repoDir, o.base, o.head);
  restoreProjectionSymlinks(
    o.devkitRoot,
    path.join(o.worktreesDir, `scale-probe-${diffSha.slice(0, 12)}`),
  );
  // --binary only for applying: a plain diff cannot apply a binary change, and the reviewer never
  // reads binary bytes. The epoch attemptTs empties materialize's time-window fallback.
  const { wt, base } = materialize({
    repo: o.repoDir,
    branch: start,
    diffSha,
    attemptTs: '1970-01-01T00:00:00Z',
    diffText: git(o.repoDir, ['diff', '--binary', `${o.base}...${o.head}`]),
    researchRoot: o.worktreesDir,
    reviewAssetsRoot: o.devkitRoot,
  });
  if (base !== start)
    return {
      skip: `diff did not apply at the merge base (applied at ${base})`,
    };
  unlinkProjectionSymlinks(o.devkitRoot, wt);
  syncReviewAssets(o.devkitRoot, wt);
  // In-process review config: language-scoped include, nothing written into the worktree.
  const cfg = resolveGuardConfigJson(
    JSON.stringify({
      review: { paths: { include: o.include, exclude: o.exclude } },
    }),
    wt,
  );
  const staged = stagedFiles(wt);
  const sel = selectReviewers(staged, cfg).find((s) => s.reviewer.name === 'correctness-reviewer');
  // A zero-file run would read as a total miss, so the PR leaves the denominator instead.
  if (!sel || sel.files.length === 0)
    return { skip: `correctness selected 0 of ${staged.length} staged files` };
  const identity = runIdentity({ base, wt, issueCap: o.issueCap });
  const tasks = o.arms.flatMap((arm) =>
    planLensTasks({
      arm,
      sel,
      diffText,
      keyPrefix: `${o.keyPrefix}|${diffSha.slice(0, 12)}`,
    }),
  );
  return {
    wt,
    base,
    staged,
    sel,
    cfg,
    tasks,
    identity,
    diffSha,
    diffText,
    diffLines: size.lines,
    diffFiles: size.files,
    evidence: measureDiffEvidenceCap(diffText),
  };
}

export interface PublishedPr {
  key: string;
  /** Clone directory name under `<research>/repos`. */
  repoName: string;
  remotes: readonly string[];
  base: string;
  head: string;
}
export interface RunSettings {
  research: string;
  devkitRoot: string;
  include: readonly string[];
  /** Checkpoint key prefix per PR; it carries model and run so repeats never share verdicts. */
  keyPrefix: (key: string) => string;
  arms: readonly string[];
  model: string;
  issueCap: string;
  concurrency: number;
  ckpt: LensCheckpoint;
}
export interface PreparedSet<P extends PublishedPr> {
  prepared: Array<{ pr: P; r: PreparedPr }>;
  /** Removed from the denominator and counted: unfetchable, unappliable or zero-scope PRs. */
  excluded: Array<{ key: string; reason: string }>;
  pendingTasks: number;
  pendingUsd: number;
}

/** Clone, fetch and prepare every PR; a failure excludes that PR with its reason. */
export function prepareAll<P extends PublishedPr>(
  prs: readonly P[],
  o: RunSettings,
): PreparedSet<P> {
  const out: PreparedSet<P> = {
    prepared: [],
    excluded: [],
    pendingTasks: 0,
    pendingUsd: 0,
  };
  for (const pr of prs) {
    let r: ReturnType<typeof preparePr>;
    try {
      const repoDir = ensureClone(path.join(o.research, 'repos'), pr.repoName, pr.remotes);
      r = fetchCommits(repoDir, pr.remotes, [pr.base, pr.head])
        ? preparePr({
            repoDir,
            base: pr.base,
            head: pr.head,
            include: o.include,
            exclude: [],
            worktreesDir: path.join(o.research, 'worktrees'),
            devkitRoot: o.devkitRoot,
            keyPrefix: o.keyPrefix(pr.key),
            arms: o.arms,
            issueCap: o.issueCap,
          })
        : { skip: 'base or head no longer fetches' };
    } catch (e) {
      // Counted, never silently dropped; a transient network failure clears on the next invocation.
      r = { skip: `prepare failed: ${String(e).split('\n')[0].slice(0, 200)}` };
    }
    if ('skip' in r) {
      out.excluded.push({ key: pr.key, reason: r.skip });
      continue;
    }
    const { identity } = r;
    const pending = r.tasks.filter((t) => !o.ckpt.reusable(t.key, identity));
    out.pendingTasks += pending.length;
    out.pendingUsd += estimateUsd(pending);
    console.error(
      `${pr.key}: ${r.diffLines} LOC ${r.diffFiles} files · ${r.sel.files.length} in scope · evidence ${(r.evidence.evidence_bytes_shown / 1024).toFixed(1)}KB omitted ${r.evidence.omitted_files} truncated ${r.evidence.truncated_files} · ${pending.length}/${r.tasks.length} task(s) to run`,
    );
    out.prepared.push({ pr, r });
  }
  for (const e of out.excluded) console.error(`excluded ${e.key}: ${e.reason}`);
  console.error(`plan: ${out.pendingTasks} lens task(s), est ~$${out.pendingUsd.toFixed(0)}`);
  return out;
}

/** Run one prepared PR's lens tasks; rows from a different run identity are dropped. */
export async function runPr(r: PreparedPr, o: RunSettings): Promise<CheckpointRow[]> {
  const rows = await runLensWave({
    tasks: r.tasks,
    sel: r.sel,
    wt: r.wt,
    cfg: r.cfg,
    model: o.model,
    issueCap: o.issueCap,
    identity: r.identity,
    diffSha: r.diffSha,
    base: r.base,
    ckpt: o.ckpt,
    concurrency: o.concurrency,
  });
  return rows.filter((x) => x.identity === r.identity);
}
