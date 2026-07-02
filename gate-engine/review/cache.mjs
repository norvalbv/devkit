/**
 * PASS-verdict cache for the review gate. One JSON file per CONSUMER repo (never shipped —
 * per-repo data): presence of a key = that reviewer PASSed that exact staged domain diff, so an
 * identical diff re-run (amend, rebase replay, retry after an unrelated gate fix, a re-ship)
 * skips the judge entirely.
 *
 * Path anchors to the MAIN checkout's `.devkit/` via `git rev-parse --git-common-dir`: a linked
 * worktree (devkit ship) resolves to the same file as the main tree, so a diff already reviewed
 * before shipping costs nothing inside the ship worktree. Fallback (not a repo / git absent) is
 * the cwd — degraded but functional.
 *
 * Failure direction: a corrupt/unreadable cache reads as EMPTY (re-review, never skip); a failed
 * write is swallowed (the verdict still stands for this run, it just isn't remembered).
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CACHE_REL = path.join('.devkit', 'review-cache.json');
const MAX_ENTRIES = 100;

/** Absolute cache-file path for a consumer cwd (main-checkout `.devkit/review-cache.json`). */
export function cachePath(cwd) {
  let root = cwd;
  try {
    const common = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf8' }).trim();
    root = path.dirname(path.isAbsolute(common) ? common : path.resolve(cwd, common));
  } catch {
    // not a repo / git absent → per-cwd cache (degraded but functional)
  }
  return path.join(root, CACHE_REL);
}

/** entries map (key → {at, model}); corrupt/absent/foreign-version → {} (fails toward re-review). */
export function loadCache(cwd) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(cwd), 'utf8'));
    if (parsed?.version !== 1 || typeof parsed.entries !== 'object' || !parsed.entries) return {};
    return parsed.entries;
  } catch {
    return {};
  }
}

/** Record PASS keys (batch — one write per gate run). Prunes to the newest MAX_ENTRIES. */
export function savePasses(cwd, keyToMeta) {
  const merged = { ...loadCache(cwd), ...keyToMeta };
  const newest = Object.entries(merged)
    .sort((a, b) => String(b[1]?.at ?? '').localeCompare(String(a[1]?.at ?? '')))
    .slice(0, MAX_ENTRIES);
  try {
    const file = cachePath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ version: 1, entries: Object.fromEntries(newest) })}\n`);
  } catch {
    // unwritable cache = slower next run, never a gate failure
  }
}

/** Drop the cache file's entries (guard-review clear-cache). */
export function clearCache(cwd) {
  const file = cachePath(cwd);
  if (!existsSync(file)) return;
  writeFileSync(file, `${JSON.stringify({ version: 1, entries: {} })}\n`);
}
