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
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { usableChunkCount } from './chunk-index.mts';

const MTIME_TOLERANCE_MS = 1;
const BACKSLASH_RE = /\\/g;

export interface IndexFreshnessDb {
  prepare(sql: string): {
    all(): Record<string, unknown>[];
  };
}

export interface IndexFreshness {
  status: 'fresh' | 'stale' | 'unverifiable';
  checkedFiles: number;
  staleFiles: string[];
  sourceRoot: string | null;
  reason?: string;
}

/** The primary checkout's working root, shared by every linked worktree (null outside git). A
 * submodule names it by core.worktree, relative to its common dir under .git/modules. */
export function primaryCheckout(cwd: string): string | null {
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!commonDir) return null;
    const worktree = execFileSync(
      'git',
      ['-C', cwd, 'config', '--default', '', '--get', 'core.worktree'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return worktree ? resolve(commonDir, worktree) : dirname(commonDir);
  } catch {
    return null;
  }
}

/** `path` at the same place under the primary checkout, relative to this linked worktree's toplevel.
 * Null in the primary itself, outside git, or for a path outside this worktree. */
function primaryCounterpart(path: string, cwd: string): string | null {
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const primary = primaryCheckout(cwd);
    if (!top || !primary || realpathSync(top) === realpathSync(primary)) return null;
    const rel = relative(realpathSync(top), resolve(realpathSync(cwd), relative(cwd, path)));
    return rel.startsWith('..') || isAbsolute(rel) ? null : resolve(primary, rel);
  } catch {
    return null;
  }
}

/** The index's usable chunk count, read-only; null when it is missing, unreadable or a foreign schema.
 * sqlite loads lazily so importers that only want `primaryCheckout` never pay for it. */
export function usableChunksAt(dbPath: string): number | null {
  if (!existsSync(dbPath)) return null;
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return usableChunkCount(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** The primary checkout's populated index when this linked worktree's own is missing or empty — what
 * `devkit ship` links into its gate worktree. Null whenever the local index is the one to read. */
export function primaryIndexFallback(indexPath: string, cwd: string): string | null {
  if (existsSync(indexPath) && usableChunksAt(indexPath) !== 0) return null;
  const primary = primaryCounterpart(indexPath, cwd);
  return primary && (usableChunksAt(primary) ?? 0) > 0 ? primary : null;
}

/** The index the matcher reads: the configured one, or (when `borrow`) the primary's when a linked
 * worktree has none usable. A caller that writes the index passes false: it must own what it writes. */
export function linkedWorktreeIndex(
  cfg: { cwd: string; indexPath: string | null },
  borrow: boolean,
): string | null {
  if (cfg.indexPath == null) return null;
  const local = resolve(cfg.cwd, cfg.indexPath);
  const primary = borrow ? primaryIndexFallback(local, cfg.cwd) : null;
  if (!primary) return local;
  process.stderr.write(
    `guard-dup: this linked worktree has no usable index — reading the primary checkout's ${primary} read-only, as \`devkit ship\` does.\n`,
  );
  return primary;
}

/**
 * True only when the index file physically lives INSIDE this checkout — the exact invariant the
 * refresh needs. Comparing realpaths catches every aliasing route into another checkout, not just
 * the symlinked-index case we happened to think of.
 */
export function indexIsInThisCheckout(indexPath: string, cwd: string): boolean {
  try {
    // path.relative, not a string prefix: a `${cwd}/` prefix test never matches on Windows
    // (native separators are '\'), which would decline every safe refresh there. Inside means a
    // non-empty relative path that neither escapes upward nor re-anchors as absolute.
    const rel = relative(realpathSync(cwd), realpathSync(indexPath));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * The checkout whose file mtimes search-code recorded in this database. A normal checkout owns its
 * index directly. A ship/link worktree reaches the PRIMARY checkout's copy through a symlink, so
 * validate the physical index against that primary tree instead of against the ephemeral worktree
 * whose checkout operation necessarily gave every file a different mtime.
 *
 * An arbitrary external SEARCH_CODE_DB has no provable source tree and stays unverifiable; the
 * candidate-level body check remains the fallback there.
 */
export function indexSourceRoot(
  indexPath: string,
  cfg: { cwd: string; indexPath: string | null },
): string | null {
  try {
    if (indexIsInThisCheckout(indexPath, cfg.cwd)) return realpathSync(cfg.cwd);
    if (!cfg.indexPath) return null;
    const counterpart = primaryCounterpart(resolve(cfg.cwd, cfg.indexPath), cfg.cwd);
    const root = primaryCounterpart(cfg.cwd, cfg.cwd);
    if (!counterpart || !root) return null;
    return realpathSync(indexPath) === realpathSync(counterpart) ? realpathSync(root) : null;
  } catch {
    return null;
  }
}

/**
 * Whole-index freshness proof using search-code's own per-file `file_mtime` stamp. This catches the
 * small/generic chunks that candidate-level body verification must conservatively keep as
 * unverifiable. It is deliberately all-or-nothing: once any indexed file changed or disappeared,
 * the embeddings no longer describe one coherent tree and the matcher must not present their hits
 * as current duplication findings.
 */
export function inspectIndexFreshness(
  db: IndexFreshnessDb,
  indexPath: string,
  cfg: { cwd: string; indexPath: string | null },
): IndexFreshness {
  const sourceRoot = indexSourceRoot(indexPath, cfg);
  if (!sourceRoot) {
    return {
      status: 'unverifiable',
      checkedFiles: 0,
      staleFiles: [],
      sourceRoot: null,
      reason: 'the index is not owned by this checkout or its primary checkout',
    };
  }

  let rows: Record<string, unknown>[];
  try {
    rows = db
      .prepare(
        'SELECT file_path, MIN(file_mtime) AS min_mtime, MAX(file_mtime) AS max_mtime FROM chunks GROUP BY file_path',
      )
      .all();
  } catch {
    return {
      status: 'unverifiable',
      checkedFiles: 0,
      staleFiles: [],
      sourceRoot,
      reason: 'the index has no readable per-file freshness stamps',
    };
  }

  if (rows.length === 0) {
    return {
      status: 'unverifiable',
      checkedFiles: 0,
      staleFiles: [],
      sourceRoot,
      reason: 'the index contains no source files',
    };
  }

  const staleFiles: string[] = [];
  for (const row of rows) {
    const file = typeof row.file_path === 'string' ? row.file_path.replace(BACKSLASH_RE, '/') : '';
    if (row.min_mtime == null || row.max_mtime == null) {
      return {
        status: 'unverifiable',
        checkedFiles: rows.length,
        staleFiles: [],
        sourceRoot,
        reason: 'the index has empty per-file freshness stamps',
      };
    }
    const minMtime = Number(row.min_mtime);
    const maxMtime = Number(row.max_mtime);
    const abs = resolve(sourceRoot, file);
    const rel = relative(sourceRoot, abs);
    if (!file || rel.startsWith('..') || isAbsolute(rel)) {
      return {
        status: 'unverifiable',
        checkedFiles: rows.length,
        staleFiles: [],
        sourceRoot,
        reason: 'the index contains a path outside its source checkout',
      };
    }
    try {
      const diskMtime = statSync(abs).mtimeMs;
      if (
        !Number.isFinite(minMtime) ||
        !Number.isFinite(maxMtime) ||
        Math.abs(minMtime - maxMtime) > MTIME_TOLERANCE_MS ||
        Math.abs(diskMtime - maxMtime) > MTIME_TOLERANCE_MS
      ) {
        staleFiles.push(file);
      }
    } catch {
      staleFiles.push(file);
    }
  }

  return {
    status: staleFiles.length > 0 ? 'stale' : 'fresh',
    checkedFiles: rows.length,
    staleFiles,
    sourceRoot,
  };
}

export function staleIndexMessage(freshness: IndexFreshness): string {
  const sample = freshness.staleFiles.slice(0, 6);
  const more = freshness.staleFiles.length - sample.length;
  const files = `${sample.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
  return (
    `search-code index is STALE — ${freshness.staleFiles.length}/${freshness.checkedFiles} indexed file(s) changed or disappeared in ${freshness.sourceRoot ?? 'its source checkout'}.\n` +
    `  ${files}\n` +
    '  Refresh affected files with `touch <files> && search-code index --seed-files "<files>"`.'
  );
}

/** Reached when no checkout holds a usable index, or when a command that writes the index declined to
 * borrow the primary's. Names the checkout to build in, or to run the writing command in. */
export function missingIndexMessage(indexPath: string, cfg: { cwd: string }): string {
  const primary = primaryCounterpart(indexPath, cfg.cwd);
  const head = `No index at ${indexPath} — dup gate opted out (fail-open).\n`;
  if (!primary) return `${head}  Build one with your indexer.`;
  if ((usableChunksAt(primary) ?? 0) > 0)
    return `${head}  This command writes the index, so it never borrows the primary checkout's ${primary}: run it in the primary checkout.`;
  return `${head}  A linked worktree reads the primary checkout's index automatically, but ${primary} has no usable index either: build it there with your indexer.`;
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
