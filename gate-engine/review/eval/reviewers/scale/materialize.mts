/**
 * Materialize one archived ship diff onto a base commit in a shared per-diff worktree, under a
 * single-writer lock HELD FOR THE CALLER'S WHOLE RUN (two invocations judging one worktree would
 * clobber each other's lens checklist state files). Bench-only; extracted from scale-bench.mts.
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

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
  const wt = path.join(os.tmpdir(), `scale-probe-${o.diffSha.slice(0, 12)}`);
  const marker = path.join(wt, '.scale-probe-base');
  const lock = `${wt}.lock`;
  // Atomic acquire: pid is written into a private temp dir first, then renamed onto the lock path
  // — a visible lock therefore ALWAYS names its holder. Stale takeover renames the dead lock
  // ASIDE (atomic single-claimant) instead of rm'ing in place, so two racing losers cannot delete
  // a lock the other just legitimately acquired. The marker fast-path sits INSIDE the lock.
  const tmpLock = mkdtempSync(`${lock}.`);
  writeFileSync(path.join(tmpLock, 'pid'), `${process.pid}\n`);
  let acquired = false;
  for (let attempt = 0; attempt < 5 && !acquired; attempt++) {
    try {
      renameSync(tmpLock, lock);
      acquired = true;
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
        throw new Error(`materialize: ${wt} is locked by live pid ${holder}`);
      }
      try {
        const aside = `${lock}.stale.${holder}.${process.pid}`;
        renameSync(lock, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch {
        // Another loser claimed the stale lock first — loop and re-attempt the acquire.
      }
    }
  }
  if (!acquired) {
    rmSync(tmpLock, { recursive: true, force: true });
    throw new Error(`materialize: could not acquire ${lock} after stale takeover`);
  }
  const release = (): void => rmSync(lock, { recursive: true, force: true });
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
  const patch = path.join(os.tmpdir(), `scale-probe-${o.diffSha.slice(0, 12)}.patch`);
  writeFileSync(patch, o.diffText);
  if (!existsSync(wt)) {
    try {
      git(o.repo, ['worktree', 'add', '--detach', wt, candidates[0]]);
    } catch {
      // A tmp-reaped worktree can leave a stale registration that blocks re-adding at the same
      // path — prune and retry once.
      git(o.repo, ['worktree', 'prune']);
      git(o.repo, ['worktree', 'add', '--detach', wt, candidates[0]]);
    }
  } else {
    // Recovery sweep: a kill between apply/add and the marker write leaves staged changes that
    // would make every later `checkout --detach` throw. No marker ⇒ nothing to preserve.
    git(wt, ['reset', '--hard']);
    git(wt, ['clean', '-fd']);
  }
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
    console.error(`materialize: diff applies at ${sha.slice(0, 12)} (${wt})`);
    return { wt, base: sha };
  }
  throw new Error(`none of ${candidates.length} candidate commits accepts this diff cleanly`);
}
