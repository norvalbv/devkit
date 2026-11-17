/**
 * The one resolver for `research.referenceCheckouts`: declared glob patterns in, the existing
 * directories they name out. Declared-only — it never scans an undeclared sibling (W-3).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILENAME, resolveGuardConfig } from '../config.mjs';
import { parsePriorArtResponse } from './response-contract.mjs';
function git(cwd, args) {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    }
    catch {
        return null;
    }
}
function realDir(candidate) {
    try {
        return statSync(candidate).isDirectory() ? realpathSync(candidate) : null;
    }
    catch {
        return null;
    }
}
/** The main worktree's root: the first `git worktree list` entry, unless that entry is bare. */
function mainWorktreeRoot(cwd) {
    const first = git(cwd, ['worktree', 'list', '--porcelain'])?.split('\n\n')[0]?.split('\n');
    const root = first?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    return root && !first?.includes('bare') ? realDir(root) : null;
}
/** Existing directories one pattern names from one base, minus the repository's own roots. */
function matchDirs(pattern, base, own) {
    let matches;
    try {
        matches = globSync(pattern, { cwd: base });
    }
    catch {
        return [];
    }
    return matches
        .map((match) => realDir(path.resolve(base, match)))
        .filter((dir) => dir !== null && !own.has(dir));
}
/** The repository's own roots, and cwd's same directory in the main worktree when cwd is linked. */
function worktreeRoots(cwd) {
    const top = realDir(git(cwd, ['rev-parse', '--show-toplevel'])?.trim() ?? '');
    const main = top && mainWorktreeRoot(cwd);
    const here = realDir(cwd);
    const own = new Set([top, main].filter((root) => Boolean(root)));
    const counterpart = top && main && here && main !== top ? path.join(main, path.relative(top, here)) : null;
    return { own, counterpart };
}
/** cwd's roots when it lacks its git-ignored guard.config.json, so the main worktree's copy is read. */
function borrowedRoots(cwd) {
    if (existsSync(path.join(cwd, CONFIG_FILENAME)))
        return null;
    return git(cwd, ['check-ignore', '-q', CONFIG_FILENAME]) === null ? null : worktreeRoots(cwd);
}
/**
 * A linked worktree without its git-ignored guard.config.json reads the main worktree's, as
 * projection links it. A broken config throws: its 0 would not be an honest 0.
 */
export function resolveReferenceCheckouts(cwd = process.cwd()) {
    const borrowed = borrowedRoots(cwd);
    const base = borrowed?.counterpart ?? cwd;
    const declared = resolveGuardConfig(base).research.referenceCheckouts;
    if (!declared.length)
        return { declared, resolved: [] };
    const { own, counterpart } = borrowed ?? worktreeRoots(cwd);
    const retryBase = base === cwd ? counterpart : null;
    const resolved = new Set();
    for (const pattern of declared) {
        const dirs = matchDirs(pattern, base, own);
        for (const dir of dirs.length || !retryBase ? dirs : matchDirs(pattern, retryBase, own))
            resolved.add(dir);
    }
    return { declared, resolved: [...resolved] };
}
/** Compare a prior-art response's self-reported local-leg counts with the resolver's. */
export function checkReferenceCheckouts(output, cwd) {
    const parsed = parsePriorArtResponse(output);
    const local = parsed.ok ? parsed.value.legs.find((leg) => leg.leg === 'local') : undefined;
    if (!parsed.ok || parsed.value.status !== 'reviewed' || !local)
        return { checkouts_check: 'unchecked' };
    let checkouts;
    try {
        checkouts = resolveReferenceCheckouts(cwd);
    }
    catch {
        return { checkouts_check: 'unchecked' };
    }
    const actual = { declared: checkouts.declared.length, resolved: checkouts.resolved.length };
    const claimed = {
        declared: local.declaredCheckouts ?? 0,
        resolved: local.resolvedCheckouts ?? 0,
    };
    if (claimed.declared === actual.declared && claimed.resolved === actual.resolved)
        return { checkouts_check: 'match' };
    return { checkouts_check: 'mismatch', checkouts_claimed: claimed, checkouts_actual: actual };
}
