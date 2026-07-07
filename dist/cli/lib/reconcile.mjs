/**
 * devkit reconcile (manual lane) — engine.
 *
 * After a parallel-agent PR merges, replace the now-stale shipped files in the shared checkout
 * with the merged-upstream version WITHOUT moving the shared HEAD (the parallel-commit-isolation
 * invariant: N agents share one tree, so its branch ref is never moved under them). Reads the
 * per-branch manifest that ship-branch.sh wrote (frink: scripts/git/reconcile-manifest-write.mjs).
 *
 * Restore is `git checkout FETCH_HEAD -- <path>`, which stages the merged blob into the INDEX.
 * That converts an UN-pullable stale-worktree edit (worktree=merged, index=stale-HEAD → a plain
 * `git pull --ff-only` aborts on "local changes would be overwritten") into a PULLABLE
 * staged-matching edit (index==target → git read-tree case-3 → the next ff-pull fast-forwards
 * cleanly). HEAD is never moved here; advancing it is the human's deliberate `git pull`.
 * Empirically verified — see the reconcile spec's end-state clarification.
 *
 * The gate is THREE blobs per path, and the index/worktree distinction is load-bearing:
 *   indexBlob  = `git rev-parse :<path>`        (what a pull would see — drives "already done")
 *   curBlob    = `git hash-object -- <path>`    (worktree — detects a human's post-ship edit)
 *   upstream   = `git rev-parse FETCH_HEAD:<p>` (the merged target)
 *   shipped    = manifest blobSha               (what we sent to the PR)
 * already-reconciled (index==upstream==worktree) → skip; worktree ∈ {shipped, upstream} →
 * restore (stage, idempotent); worktree foreign to both → skip+warn (never clobber a human edit).
 * Divergence (local baseRef not an ancestor of upstream) → strictly hands-off (skip+warn all).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from "./atomic-write.mjs";
const ABSENT = Symbol('absent'); // a file/blob that does not exist on a given side (≠ any sha)
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5_000;
/** Run git in <root>; trimmed stdout, or null on failure (allowFail) — never throws by default. */
export function git(root, args, { allowFail = true } = {}) {
    try {
        return execFileSync('git', ['-C', root, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    }
    catch (e) {
        if (allowFail)
            return null;
        throw e;
    }
}
/** Boolean exit of `git merge-base --is-ancestor a b` (a is an ancestor of b ⇒ clean ff). */
function isAncestor(root, a, b) {
    try {
        execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
const blobAt = (root, ref, path) => git(root, ['rev-parse', `${ref}:${path}`]) ?? ABSENT;
const indexBlob = (root, path) => git(root, ['rev-parse', `:${path}`]) ?? ABSENT;
const worktreeBlob = (root, path) => existsSync(join(root, path)) ? (git(root, ['hash-object', '--', path]) ?? ABSENT) : ABSENT;
const manifestFile = (mainRepo) => join(mainRepo, '.devkit', 'reconcile-manifest.json');
export function loadManifest(mainRepo) {
    try {
        const m = JSON.parse(readFileSync(manifestFile(mainRepo), 'utf8'));
        if (m && m.version === 1 && m.branches)
            return m;
    }
    catch {
        /* absent / torn / wrong version → no debt (a torn file is never trusted) */
    }
    return { version: 1, branches: {} };
}
/** Atomic-mkdir mutex (flock is absent on macOS) — see the manifest writer for the rationale. */
function withLock(lockDir, fn) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    let held = false;
    while (Date.now() <= deadline) {
        try {
            mkdirSync(lockDir);
            held = true;
            break;
        }
        catch (e) {
            if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST'))
                throw e;
            try {
                if (Date.now() - lstatSync(lockDir).mtimeMs > LOCK_STALE_MS)
                    rmSync(lockDir, { recursive: true, force: true });
            }
            catch {
                /* lock vanished — retry */
            }
        }
    }
    // Never run fn() unlocked: an unsynchronized read-modify-write would let a concurrent ship or
    // reconcile clobber another branch's entry (the rename is atomic, but the read+merge is not).
    if (!held)
        throw new Error(`timed out acquiring manifest lock: ${lockDir}`);
    try {
        return fn();
    }
    finally {
        rmSync(lockDir, { recursive: true, force: true });
    }
}
/** Remove a fully-reconciled branch entry (atomic temp+rename under the lock). */
export function pruneBranch(mainRepo, branch) {
    const file = manifestFile(mainRepo);
    if (!existsSync(file))
        return; // no manifest on disk → nothing to prune
    withLock(`${file}.lock`, () => {
        const m = loadManifest(mainRepo);
        if (!m.branches[branch])
            return;
        delete m.branches[branch];
        writeFileAtomic(file, `${JSON.stringify(m, null, 2)}\n`); // temp+rename, inside the lock
    });
}
/** MERGED | OPEN | UNKNOWN. Test seam: DEVKIT_RECONCILE_MERGED_OVERRIDE (mirrors ship's SHIP_RESOLVE_ONLY). */
export function detectMerged({ repo, prNumber, branch, }) {
    const override = process.env.DEVKIT_RECONCILE_MERGED_OVERRIDE;
    if (override && process.env.VITEST)
        return override; // test-only seam — inert in production (never bypasses the real gh MERGED gate)
    const sel = prNumber != null ? [String(prNumber)] : ['--head', branch];
    try {
        const state = execFileSync('gh', ['pr', 'view', ...sel, '--repo', repo, '--json', 'state', '-q', '.state'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return state === 'MERGED' ? 'MERGED' : 'OPEN';
    }
    catch {
        return 'UNKNOWN'; // gh absent / offline / no PR — clears no debt, never crashes
    }
}
/** Three-way gate + restore for one path. Returns {restored?} | {done?} | {warning}. */
function reconcilePath(mainRepo, P, apply) {
    if (P.path.startsWith('/') || P.path.split('/').includes('..')) {
        return { warning: `${P.path}: non-relative path refused (repo-relative paths only)` };
    }
    const upstream = blobAt(mainRepo, 'FETCH_HEAD', P.path);
    const cur = worktreeBlob(mainRepo, P.path);
    const idx = indexBlob(mainRepo, P.path);
    if (P.op === 'delete') {
        if (upstream !== ABSENT)
            return {
                warning: `${P.path}: shipped a deletion but upstream kept the file — resolve by hand`,
            };
        if (cur !== ABSENT)
            return { warning: `${P.path}: re-created after a shipped deletion — left as-is` };
        if (idx === ABSENT)
            return { done: true }; // deletion already staged
        if (apply)
            git(mainRepo, ['rm', '--cached', '--ignore-unmatch', '--', P.path]); // stage the deletion → pullable
        return { restored: true };
    }
    // modify / add
    if (idx === upstream && cur === upstream)
        return { done: true }; // already reconciled (index + worktree match merged)
    if (cur === P.blobSha || cur === upstream) {
        if (upstream === ABSENT)
            return {
                warning: `${P.path}: upstream merged a different shape (path absent) — resolve by hand`,
            };
        if (apply)
            git(mainRepo, ['checkout', 'FETCH_HEAD', '--', P.path], { allowFail: false });
        return { restored: true };
    }
    return { warning: `${P.path}: edited after ship — left byte-for-byte as you have it` };
}
/** Reconcile one manifest branch (STEP A–D). Pure read under !apply. */
export function reconcileBranch({ mainRepo, branch, entry, apply, }) {
    const base = { branch, restored: [], warnings: [] };
    const merged = detectMerged({ repo: entry.repo, prNumber: entry.prNumber, branch });
    if (merged !== 'MERGED') {
        return {
            ...base,
            merged: merged === 'UNKNOWN' ? 'unknown' : false,
            action: 'keep',
            warnings: merged === 'UNKNOWN' ? ['gh unavailable — merge state unknown'] : [],
        };
    }
    if (git(mainRepo, ['fetch', 'origin', entry.baseRef]) === null) {
        return {
            ...base,
            merged: true,
            action: 'keep',
            warnings: [`fetch origin ${entry.baseRef} failed`],
        };
    }
    const localTip = git(mainRepo, ['rev-parse', entry.baseRef]) ?? git(mainRepo, ['rev-parse', 'HEAD']); // fall back to the checked-out tip if baseRef isn't a local branch
    const fetchHead = git(mainRepo, ['rev-parse', 'FETCH_HEAD']);
    if (!localTip || !fetchHead)
        return {
            ...base,
            merged: true,
            action: 'keep',
            warnings: ['could not resolve baseRef/FETCH_HEAD'],
        };
    if (!isAncestor(mainRepo, localTip, fetchHead)) {
        return {
            ...base,
            merged: true,
            action: 'keep',
            warnings: [
                `${entry.baseRef} diverged from upstream — resolve by hand after the tree settles; no files touched`,
            ],
        };
    }
    const restored = [];
    const warnings = [];
    for (const P of entry.paths) {
        const r = reconcilePath(mainRepo, P, apply);
        if (r.restored)
            restored.push(P.path);
        if (r.warning)
            warnings.push(r.warning);
    }
    const action = warnings.length === 0 ? 'prune' : 'keep';
    if (action === 'prune' && apply) {
        try {
            pruneBranch(mainRepo, branch);
        }
        catch (e) {
            // Restores already landed; only the manifest cleanup was contended. The entry stays and a
            // later run prunes it (idempotent) — don't fail the whole reconcile over a lock timeout.
            const msg = e instanceof Error ? e.message : String(e);
            warnings.push(`manifest entry not pruned (${msg}); a re-run will clear it`);
        }
    }
    return { branch, merged: true, action, restored, warnings };
}
