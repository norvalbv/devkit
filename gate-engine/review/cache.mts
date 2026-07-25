/**
 * PASS-verdict cache for the review gate. Presence of a key = that reviewer PASSed that
 * exact staged domain diff, so an identical diff re-run (amend, rebase replay, retry after
 * an unrelated gate fix, a re-ship) skips the judge entirely.
 *
 * Storage, worktree anchoring, atomicity, and failure direction live in the shared
 * judge/verdict-store (one `.devkit/review-cache.json` per consumer repo, main-checkout
 * anchored, atomic writes, corrupt → empty → re-review).
 */

import { emitGateEvent } from '../judge/gate-events.mts';
import {
  clearEntries,
  devkitDataFile,
  loadEntries,
  saveEntries,
  type VerdictMeta,
} from '../judge/verdict-store.mts';

const CACHE_FILE = 'review-cache.json';

/** Absolute cache-file path for a consumer cwd (main-checkout `.devkit/review-cache.json`). */
export function cachePath(cwd: string): string {
  return devkitDataFile(cwd, CACHE_FILE);
}

/** entries map (key → {at, model}); corrupt/absent/foreign-version → {} (fails toward re-review). */
export function loadCache(cwd: string): Record<string, VerdictMeta> {
  return loadEntries(cachePath(cwd));
}

/**
 * Record PASS keys (checkpointed per completed cascade). Prunes to the newest entries.
 *
 * Returns the store's own success flag, and NAMES a failure rather than swallowing it. `saveEntries`
 * returns false when the directory lock isn't won inside its wait budget, or when any write throws —
 * leaving the verdict earned but unremembered, so the next attempt silently re-judges it at full
 * price. Discarding that made lock contention (several worktrees sharing one main-checkout
 * `.devkit/`) indistinguishable from an ordinary cache miss, and it is a live hypothesis for the
 * low hit rate sc-1239 was filed about — so it has to be visible before it can be ruled in or out.
 *
 * The judge label is the key's prefix, which `cacheKey` (reviewers.mts) defines as the reviewer name
 * — `review:<reviewer>` for a domain reviewer, `review:completeness` for the commit-msg judge, so
 * the label matches the one judge_exec and cache_hit already use. Never throws: a telemetry problem
 * must not turn a passing review into a failing one.
 */
export function savePasses(cwd: string, keyToMeta: Record<string, VerdictMeta>): boolean {
  const saved = saveEntries(cachePath(cwd), keyToMeta);
  if (!saved)
    for (const key of Object.keys(keyToMeta)) {
      const judge = `review:${key.split(':')[0]}`;
      console.error(`guard-review: ${judge} — PASS earned but NOT cached (store write failed)`);
      emitGateEvent({ type: 'cache_write_failed', judge });
    }
  return saved;
}

/** Drop the cache file's entries (guard-review clear-cache). */
export function clearCache(cwd: string): void {
  clearEntries(cachePath(cwd));
}
