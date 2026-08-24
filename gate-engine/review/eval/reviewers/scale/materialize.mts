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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

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
export function cleanMaterialized(): void {
  if (!existsSync(RESEARCH_ROOT)) return;
  for (const entry of readdirSync(RESEARCH_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.includes('.lock')) {
      // A bare `<wt>.lock` whose worktree is already gone is reaped through the same atomic
      // acquire (skips a live holder, single-claimant takeover of a stale one). `.lock.*`
      // staging/aside dirs are another process's transient acquire state — never touch them; a
      // crashed one leaks only a one-file dir.
      if (entry.name.endsWith('.lock')) {
        const orphan = path.join(RESEARCH_ROOT, entry.name);
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
    const wt = path.join(RESEARCH_ROOT, entry.name);
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

function ensureResearchRoot(): void {
  mkdirSync(RESEARCH_ROOT, { recursive: true, mode: 0o700 });
  chmodSync(RESEARCH_ROOT, 0o700);
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
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

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
  ensureResearchRoot();
  const wt = path.join(RESEARCH_ROOT, `scale-probe-${o.diffSha.slice(0, 12)}`);
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
      console.error(`materialize: reusing worktree at ${wt} (base ${base.slice(0, 12)})`);
      return { wt, base };
    }
    return materializeLocked(o, wt, marker);
  } catch (e) {
    release();
    process.removeListener('exit', release);
    throw e;
  }
}

function materializeLocked(o: MaterializeOpts, wt: string, marker: string): Materialized {
  const candidates = candidateCommits(o);
  if (candidates.length === 0) throw new Error('no candidate commits in the time window');
  const patch = path.join(RESEARCH_ROOT, `scale-probe-${o.diffSha.slice(0, 12)}.patch`);
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
      writeFileSync(marker, `${sha}\n`);
      writeFileSync(path.join(wt, '.scale-probe-repo'), `${o.repo}\n`);
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
