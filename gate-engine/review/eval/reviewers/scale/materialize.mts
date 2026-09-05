/**
 * Materialize one archived ship diff onto a base commit in a shared per-diff worktree, under a
 * single-writer lock HELD FOR THE CALLER'S WHOLE RUN (two invocations judging one worktree would
 * clobber each other's lens checklist state files). Bench-only; extracted from scale-bench.mts.
 *
 * The worktree and the raw applied patch are materialized third-party data (frink diffs); per
 * `docs/decisions/scale-track-third-party-data.md` they stay under the private, mode-0700
 * research root (`~/.devkit/research/scale-bench/**`), never `os.tmpdir()` — a shared temp
 * directory is world-readable by default and its reaper can silently delete a live worktree
 * mid-run. The raw patch file is additionally removed once the apply loop is done with it.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { managedPath } from '../../../../critique/immutable-file.mts';
import { assertDiffSha256 } from './labels.mts';

/** Private, mode-0700 home for materialized third-party checkouts and their raw patches — see
 * the module doc comment and `docs/decisions/scale-track-third-party-data.md`. */
const RESEARCH_ROOT = path.join(os.homedir(), '.devkit', 'research', 'scale-bench');

type LockAcquisition = { release: () => void } | { heldBy: number };

/** Atomic acquire of a single-writer lock dir: the pid is written into a private mkdtemp dir
 * first, then renamed onto the lock path — a visible lock therefore ALWAYS names its holder. A
 * LIVE holder yields `{heldBy}` (never disturbed); a stale (dead-pid) lock is renamed ASIDE
 * (atomic single-claimant takeover, so two racing losers cannot delete a lock the other just
 * legitimately acquired) and the acquire is re-attempted. Shared by `materialize()` and
 * `cleanMaterialized()` so `--clean` decides "removable" by HOLDING the same lock a live run
 * holds, not by a check-then-delete race. */
function acquireLock(lock: string): LockAcquisition {
  const tmpLock = mkdtempSync(`${lock}.`);
  writeFileSync(path.join(tmpLock, 'pid'), `${process.pid}\n`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      renameSync(tmpLock, lock);
      return { release: () => rmSync(lock, { recursive: true, force: true }) };
    } catch {
      let holder = 0;
      try {
        holder = Number(readFileSync(path.join(lock, 'pid'), 'utf8').trim() || '0');
      } catch {
        continue;
      }
      let alive = false;
      if (holder > 0) {
        try {
          process.kill(holder, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (alive) {
        rmSync(tmpLock, { recursive: true, force: true });
        return { heldBy: holder };
      }
      try {
        const aside = `${lock}.stale.${holder}.${process.pid}`;
        renameSync(lock, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch {
        // Another claimant took the stale lock first — loop and re-attempt the acquire.
      }
    }
  }
  rmSync(tmpLock, { recursive: true, force: true });
  throw new Error(`lock: could not acquire ${lock} after stale takeover`);
}

/** Remove every materialized worktree under the research root (each records its source repo in a
 * `.scale-probe-repo` marker) and prune the source repos' worktree registrations. Worktrees here
 * are full third-party checkouts that nothing reaps automatically — run
 * `bun scale-bench.mts --clean` between rounds. Each worktree is removed only while HOLDING its
 * own single-writer lock: a live run's worktree is skipped (never force-removed mid-judge), and
 * holding the lock through the removal closes the check-then-delete race with a materialize()
 * that starts concurrently. */
export function cleanMaterialized(root: string = RESEARCH_ROOT): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.includes('.lock')) {
      // A bare `<wt>.lock` whose worktree is already gone is reaped through the same atomic
      // acquire (skips a live holder, single-claimant takeover of a stale one). `.lock.*`
      // staging/aside dirs are another process's transient acquire state — never touch them; a
      // crashed one leaks only a one-file dir.
      if (entry.name.endsWith('.lock')) {
        const orphan = path.join(root, entry.name);
        if (!existsSync(orphan.slice(0, -'.lock'.length))) {
          try {
            const acq = acquireLock(orphan);
            if ('release' in acq) acq.release();
          } catch {
            // contended — leave it for the next --clean
          }
        }
      }
      continue;
    }
    const wt = path.join(root, entry.name);
    let acq: LockAcquisition;
    try {
      acq = acquireLock(`${wt}.lock`);
    } catch {
      console.error(`clean: skipping ${wt} — lock contention`);
      continue;
    }
    if ('heldBy' in acq) {
      console.error(`clean: skipping ${wt} — in use by live pid ${acq.heldBy}`);
      continue;
    }
    try {
      const repoMarker = path.join(wt, '.scale-probe-repo');
      let sourceRepo: string | null = null;
      try {
        sourceRepo = readFileSync(repoMarker, 'utf8').trim();
      } catch {
        sourceRepo = null;
      }
      if (sourceRepo) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: sourceRepo });
          console.error(`clean: removed worktree ${wt}`);
          continue;
        } catch {
          // fall through to plain removal + prune below
        }
      }
      rmSync(wt, { recursive: true, force: true });
      if (sourceRepo) {
        try {
          execFileSync('git', ['worktree', 'prune'], { cwd: sourceRepo });
        } catch {
          // best-effort
        }
      }
      console.error(`clean: removed ${wt}`);
    } finally {
      acq.release();
    }
  }
}

/** Raw replay evidence is confined to private research directories, including symlink ancestry. */
export function researchOutputDirectory(directory: string): string {
  const home = realpathSync(os.homedir());
  const root = path.join(home, '.devkit', 'research');
  const relative = path.relative(root, path.resolve(directory));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('raw replay output requires a directory under ~/.devkit/research');
  const resolved = managedPath(home, ['.devkit', 'research', ...relative.split(path.sep)], true);
  if (!resolved) throw new Error('private research output directory is absent');
  return resolved;
}

export interface Materialized {
  wt: string;
  base: string;
}

export interface MaterializeOpts {
  repo: string;
  branch: string;
  diffSha: string;
  attemptTs: string;
  diffText: string;
  /** Private home for the worktree + raw patch; defaults to the scale-bench research root. An
   * external-PR bench keeps its checkouts under its own 0700 root so `--clean` scopes correctly. */
  researchRoot?: string;
  reviewAssetsRoot?: string;
}

/** These destinations are the complete review-asset projection used by the native scale runner. */
export function reviewAssetProjections(devkitRoot: string, wt: string) {
  return [
    {
      source: path.join(devkitRoot, 'agents', 'correctness-reviewer.md'),
      destination: path.join(wt, '.claude', 'agents', 'correctness-reviewer.md'),
      recursive: false,
    },
    ...['correctness', '_devkit'].map((name) => ({
      source: path.join(devkitRoot, 'skills', name),
      destination: path.join(wt, '.claude', 'skills', name),
      recursive: true,
    })),
  ];
}

function matchesProjectedAsset(devkitRoot: string, wt: string, name: string): boolean {
  const actual = path.resolve(wt, name);
  return reviewAssetProjections(devkitRoot, wt).some((projection) => {
    const relative = path.relative(projection.destination, actual);
    if (
      relative !== '' &&
      (!projection.recursive ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative))
    )
      return false;
    const expected = path.resolve(projection.source, relative);
    const actualStat = lstatSync(actual, { throwIfNoEntry: false });
    const expectedStat = lstatSync(expected, { throwIfNoEntry: false });
    if (!actualStat || !expectedStat) return !actualStat && !expectedStat;
    return (
      actualStat.isFile() &&
      expectedStat.isFile() &&
      realpathSync(actual) === actual &&
      realpathSync(expected) === expected &&
      (actualStat.mode & 0o111) === (expectedStat.mode & 0o111) &&
      readFileSync(actual).equals(readFileSync(expected))
    );
  });
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function validateCached(o: MaterializeOpts, wt: string, base: string): void {
  const inspect = (cwd: string, args: string[], index?: string, input?: string): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      input,
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: index,
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
  let scratch: string | undefined;
  try {
    const recordedRepo = readFileSync(path.join(wt, '.scale-probe-repo'), 'utf8').trim();
    if (realpathSync(recordedRepo) !== realpathSync(o.repo))
      throw new Error('source repository marker does not match the requested repository');
    const commonDir = (repo: string) =>
      realpathSync(
        inspect(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(),
      );
    if (commonDir(wt) !== commonDir(o.repo))
      throw new Error('cached worktree belongs to a different Git common directory');
    if (
      inspect(wt, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim() !==
        base ||
      inspect(wt, ['rev-parse', '--verify', 'HEAD']).trim() !== base
    )
      throw new Error('base marker must be the full commit identity of cached HEAD');
    scratch = mkdtempSync(path.join(wt, '.scale-identity-'));
    chmodSync(scratch, 0o700);
    const expectedIndex = path.join(scratch, 'expected-index');
    inspect(wt, ['read-tree', base], expectedIndex);
    inspect(wt, ['apply', '--cached'], expectedIndex, o.diffText);
    const expectedTree = inspect(wt, ['write-tree'], expectedIndex).trim();
    const capturedIndex = path.join(scratch, 'captured-index');
    copyFileSync(
      inspect(wt, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim(),
      capturedIndex,
    );
    if (inspect(wt, ['write-tree'], capturedIndex).trim() !== expectedTree)
      throw new Error('cached index does not reproduce the requested diff on its recorded base');
    const tracked = inspect(wt, ['ls-files', '-z'], capturedIndex);
    for (const flag of ['--no-assume-unchanged', '--no-skip-worktree'])
      inspect(wt, ['update-index', flag, '-z', '--stdin'], capturedIndex, tracked);
    const changed = inspect(wt, ['diff-files', '--name-only', '-z'], capturedIndex)
      .split('\0')
      .filter(Boolean);
    for (const name of changed)
      if (!o.reviewAssetsRoot || !matchesProjectedAsset(o.reviewAssetsRoot, wt, name))
        throw new Error(
          'cached working-tree change is not an exact intended review-asset projection',
        );
  } catch (cause) {
    throw new Error(
      `materialize: cached context identity validation failed for ${wt}; use a fresh research root`,
      { cause },
    );
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function resolveRef(o: MaterializeOpts): string {
  for (const ref of [o.branch, `origin/${o.branch}`]) {
    try {
      git(o.repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      // try the next form
    }
  }
  git(o.repo, ['fetch', 'origin', o.branch]);
  return `origin/${o.branch}`;
}

/** Branch names in telemetry are often LOCAL to a deleted checkout: fall back to a commit-time
 * window over --all so any reachable commit can host the diff. */
function windowCandidates(o: MaterializeOpts): string[] {
  const t = Date.parse(o.attemptTs);
  const since = new Date(t - 21 * 86400_000).toISOString();
  const until = new Date(t + 2 * 86400_000).toISOString();
  return git(o.repo, [
    'rev-list',
    '--all',
    '--max-count=4000',
    `--since=${since}`,
    `--until=${until}`,
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
}

/** Branch-ref candidates first (cheap, usually right), then the attempt-time window appended —
 * a resolvable ref that has MOVED past the base (recycled branch, long-lived branch) would
 * otherwise dead-end a fallback that only fired on unresolvable refs. */
function candidateCommits(o: MaterializeOpts): string[] {
  let fromRef: string[] = [];
  try {
    const ref = resolveRef(o);
    fromRef = git(o.repo, ['rev-list', '--max-count=200', ref]).trim().split('\n').filter(Boolean);
  } catch {
    console.error(
      `materialize: ref ${o.branch} unresolvable — falling back to the attempt-time window`,
    );
  }
  const seenShas = new Set(fromRef);
  return [...fromRef, ...windowCandidates(o).filter((sha) => !seenShas.has(sha))];
}

export function materialize(o: MaterializeOpts): Materialized {
  assertDiffSha256(o.diffSha);
  const root = researchOutputDirectory(o.researchRoot ?? RESEARCH_ROOT);
  const wt = path.join(root, `scale-probe-${o.diffSha.slice(0, 12)}`);
  const marker = path.join(wt, '.scale-probe-base');
  const lock = `${wt}.lock`;
  // Single-writer lock held for the caller's whole run — see acquireLock(). The marker fast-path
  // sits INSIDE the lock.
  const acq = acquireLock(lock);
  if ('heldBy' in acq) throw new Error(`materialize: ${wt} is locked by live pid ${acq.heldBy}`);
  const release = acq.release;
  process.on('exit', release);
  try {
    if (existsSync(marker)) {
      const base = readFileSync(marker, 'utf8').trim();
      validateCached(o, wt, base);
      console.error(`materialize: reusing worktree at ${wt} (base ${base.slice(0, 12)})`);
      return { wt, base };
    }
    return materializeLocked(o, wt, marker, root);
  } catch (e) {
    release();
    process.removeListener('exit', release);
    throw e;
  }
}

function materializeLocked(
  o: MaterializeOpts,
  wt: string,
  marker: string,
  root: string,
): Materialized {
  const candidates = candidateCommits(o);
  if (candidates.length === 0) throw new Error('no candidate commits in the time window');
  const patch = path.join(root, `scale-probe-${o.diffSha.slice(0, 12)}.patch`);
  writeFileSync(patch, o.diffText, { mode: 0o600 });
  if (!existsSync(wt)) {
    try {
      git(o.repo, ['worktree', 'add', '--detach', wt, candidates[0]]);
    } catch {
      // A worktree can go missing from under git (manual cleanup, a prior partial run) and leave
      // a stale registration that blocks re-adding at the same path — prune and retry once. The
      // research root itself is never OS-tmp-reaped, but this fallback stays cheap insurance.
      git(o.repo, ['worktree', 'prune']);
      git(o.repo, ['worktree', 'add', '--detach', wt, candidates[0]]);
    }
  } else {
    // Recovery sweep: a kill between apply/add and the marker write leaves staged changes that
    // would make every later `checkout --detach` throw. No marker ⇒ nothing to preserve.
    git(wt, ['reset', '--hard']);
    git(wt, ['clean', '-fd']);
  }
  try {
    for (const sha of candidates) {
      git(wt, ['checkout', '--detach', sha]);
      try {
        git(wt, ['apply', '--check', patch]);
      } catch {
        continue;
      }
      git(wt, ['apply', patch]);
      git(wt, ['add', '-A']);
      writeFileSync(path.join(wt, '.scale-probe-repo'), `${o.repo}\n`, { mode: 0o600 });
      const pendingMarker = `${marker}.pending-${randomUUID()}`;
      try {
        writeFileSync(pendingMarker, `${sha}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(pendingMarker, marker);
      } finally {
        rmSync(pendingMarker, { force: true });
      }
      console.error(`materialize: diff applies at ${sha.slice(0, 12)} (${wt})`);
      return { wt, base: sha };
    }
    throw new Error(`none of ${candidates.length} candidate commits accepts this diff cleanly`);
  } finally {
    // The raw patch is materialized third-party data too — it must not linger once the apply
    // loop is done with it, success or failure.
    rmSync(patch, { force: true });
  }
}
