/**
 * Optional pre-scan refresh of the semantic matcher's search index, so the dup gate judges the
 * code being COMMITTED rather than whatever was last indexed.
 *
 * Lives apart from matcher.mts because the interesting part is not the refresh — it is the two
 * conditions under which it must NOT happen, both of which are severe and neither of which is
 * obvious at the call site:
 *
 *   · No index yet. A cold build walks the whole corpus: minutes to hours, and inside a commit
 *     hook it is indistinguishable from a hang. The gate fails open on a missing index long
 *     before this runs; never "helpfully" build one.
 *   · A linked worktree reusing the primary checkout's index (the documented way to gate there).
 *     Indexers resolve their DB from the working root and key chunks repo-relative, so refreshing
 *     through a symlinked index overwrites the PRIMARY's rows with this checkout's code — and the
 *     primary's next commit is then gated against a branch it never saw.
 */

import { execFileSync, execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Absolute working root of the PRIMARY checkout — the one holding the real `.git`. Every linked
 * worktree of a repo shares that common dir, so this resolves to the same place from anywhere in
 * the repo family, which is what makes it a usable "link the index from HERE" hint. null when git
 * is unavailable or this is not a repo (callers degrade the hint to a placeholder).
 */
export function primaryCheckout(cwd: string): string | null {
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return commonDir ? dirname(commonDir) : null;
  } catch {
    return null;
  }
}

/**
 * True only when the index file physically lives INSIDE this checkout — the exact invariant the
 * refresh needs. Comparing realpaths catches every aliasing route into another checkout, not just
 * the symlinked-index case we happened to think of.
 */
export function indexIsInThisCheckout(indexPath: string, cwd: string): boolean {
  try {
    return realpathSync(indexPath).startsWith(`${realpathSync(cwd)}/`);
  } catch {
    return false;
  }
}

/**
 * What to tell someone whose checkout has no index. The common case by far is a linked worktree,
 * where the gate is not broken and not fixable by "build an index" — the primary checkout already
 * has one, and linking it is both cheaper and what `devkit ship` does. So name that path with a
 * command they can paste, rather than leaving a bare "no index" to be read as a hang or a bug.
 */
export function missingIndexMessage(
  indexPath: string,
  cfg: { cwd: string; indexPath: string | null },
): string {
  const indexDir = dirname(cfg.indexPath ?? '.search-code/index.db');
  const primary = primaryCheckout(cfg.cwd) ?? '<primary-checkout>';
  return (
    `No index at ${indexPath}. This checkout has no index — dup gate opted out (fail-open).\n` +
    `  Build one with your indexer, or in a LINKED WORKTREE reuse the primary checkout's:\n` +
    `    ln -s ${primary}/${indexDir} .\n` +
    `  (devkit ship --link ${indexDir} does this for you.)`
  );
}

/**
 * Run the configured indexer, or do nothing. Never throws, never blocks: one attempt, hard
 * wall-clock kill, output discarded, every failure swallowed. A slightly stale index is a weaker
 * gate; a commit that hangs or fails on its indexer is a broken one.
 */
export function refreshIndex(
  indexPath: string,
  cfg: { cwd: string; indexCommand: string | null; indexCommandTimeoutMs: number },
): void {
  if (!cfg.indexCommand || !indexIsInThisCheckout(indexPath, cfg.cwd)) return;
  try {
    execSync(cfg.indexCommand, {
      cwd: cfg.cwd,
      stdio: 'ignore',
      timeout: cfg.indexCommandTimeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch {
    // Timeout, missing binary, a concurrent writer holding the DB — all non-fatal by design.
  }
}
