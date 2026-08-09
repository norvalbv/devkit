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
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
const MTIME_TOLERANCE_MS = 1;
const BACKSLASH_RE = /\\/g;
/**
 * Absolute working root of the PRIMARY checkout — the one holding the real `.git`. Every linked
 * worktree of a repo shares that common dir, so this resolves to the same place from anywhere in
 * the repo family, which is what makes it a usable "link the index from HERE" hint. null when git
 * is unavailable or this is not a repo (callers degrade the hint to a placeholder).
 */
export function primaryCheckout(cwd) {
    try {
        const commonDir = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return commonDir ? dirname(commonDir) : null;
    }
    catch {
        return null;
    }
}
/**
 * True only when the index file physically lives INSIDE this checkout — the exact invariant the
 * refresh needs. Comparing realpaths catches every aliasing route into another checkout, not just
 * the symlinked-index case we happened to think of.
 */
export function indexIsInThisCheckout(indexPath, cwd) {
    try {
        // path.relative, not a string prefix: a `${cwd}/` prefix test never matches on Windows
        // (native separators are '\'), which would decline every safe refresh there. Inside means a
        // non-empty relative path that neither escapes upward nor re-anchors as absolute.
        const rel = relative(realpathSync(cwd), realpathSync(indexPath));
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    }
    catch {
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
export function indexSourceRoot(indexPath, cfg) {
    try {
        if (indexIsInThisCheckout(indexPath, cfg.cwd))
            return realpathSync(cfg.cwd);
        if (!cfg.indexPath)
            return null;
        const primary = primaryCheckout(cfg.cwd);
        if (!primary)
            return null;
        const expected = realpathSync(resolve(primary, cfg.indexPath));
        return realpathSync(indexPath) === expected ? realpathSync(primary) : null;
    }
    catch {
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
export function inspectIndexFreshness(db, indexPath, cfg) {
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
    let rows;
    try {
        rows = db
            .prepare('SELECT file_path, MIN(file_mtime) AS min_mtime, MAX(file_mtime) AS max_mtime FROM chunks GROUP BY file_path')
            .all();
    }
    catch {
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
    const staleFiles = [];
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
            if (!Number.isFinite(minMtime) ||
                !Number.isFinite(maxMtime) ||
                Math.abs(minMtime - maxMtime) > MTIME_TOLERANCE_MS ||
                Math.abs(diskMtime - maxMtime) > MTIME_TOLERANCE_MS) {
                staleFiles.push(file);
            }
        }
        catch {
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
export function staleIndexMessage(freshness) {
    const sample = freshness.staleFiles.slice(0, 6);
    const more = freshness.staleFiles.length - sample.length;
    const files = `${sample.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
    return (`search-code index is STALE — ${freshness.staleFiles.length}/${freshness.checkedFiles} indexed file(s) changed or disappeared in ${freshness.sourceRoot ?? 'its source checkout'}.\n` +
        `  ${files}\n` +
        '  Refresh affected files with `touch <files> && search-code index --seed-files "<files>"`.');
}
/**
 * What to tell someone whose checkout has no index. The common case by far is a linked worktree,
 * where the gate is not broken and not fixable by "build an index" — the primary checkout already
 * has one, and linking it is both cheaper and what `devkit ship` does. So name that path with a
 * command they can paste, rather than leaving a bare "no index" to be read as a hang or a bug.
 */
export function missingIndexMessage(indexPath, cfg) {
    const indexDir = dirname(cfg.indexPath ?? '.search-code/index.db');
    const primary = primaryCheckout(cfg.cwd) ?? '<primary-checkout>';
    return (`No index at ${indexPath}. This checkout has no index — dup gate opted out (fail-open).\n` +
        `  Build one with your indexer, or in a LINKED WORKTREE reuse the primary checkout's:\n` +
        `    ln -s ${primary}/${indexDir} .\n` +
        `  (devkit ship --link ${indexDir} does this for you.)`);
}
/**
 * Run the configured indexer, or do nothing. Never throws, never blocks: one attempt, hard
 * wall-clock kill, output discarded, every failure swallowed. A slightly stale index is a weaker
 * gate; a commit that hangs or fails on its indexer is a broken one.
 */
export function refreshIndex(indexPath, cfg) {
    if (!cfg.indexCommand || !indexIsInThisCheckout(indexPath, cfg.cwd))
        return;
    try {
        execSync(cfg.indexCommand, {
            cwd: cfg.cwd,
            stdio: 'ignore',
            timeout: cfg.indexCommandTimeoutMs,
            killSignal: 'SIGKILL',
        });
    }
    catch {
        // Timeout, missing binary, a concurrent writer holding the DB — all non-fatal by design.
    }
}
