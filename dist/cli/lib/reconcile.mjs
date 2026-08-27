/**
 * devkit reconcile (manual lane) — engine.
 *
 * After a parallel-agent PR merges, replace the now-stale shipped files in the shared checkout
 * with the merged-upstream version WITHOUT moving the shared HEAD (the parallel-commit-isolation
 * invariant: N agents share one tree, so its branch ref is never moved under them). Reads the
 * per-branch manifest that ship-branch.sh wrote (frink: scripts/git/reconcile-manifest-write.mjs).
 *
 * Restore is `git checkout <upstreamSha> -- <path>`, which stages the merged blob into the INDEX.
 * That converts an UN-pullable stale-worktree edit (worktree=merged, index=stale-HEAD → a plain
 * `git pull --ff-only` aborts on "local changes would be overwritten") into a PULLABLE
 * staged-matching edit (index==target → git read-tree case-3 → the next ff-pull fast-forwards
 * cleanly). HEAD is never moved here; advancing it is the human's deliberate `git pull`.
 * Empirically verified — see the reconcile spec's end-state clarification.
 *
 * The gate is THREE blobs per path, and the index/worktree distinction is load-bearing:
 *   indexBlob  = `git rev-parse :<path>`        (what a pull would see — drives "already done")
 *   curBlob    = `git hash-object -- <path>`    (worktree — detects a human's post-ship edit)
 *   upstream   = `git rev-parse <upstreamSha>:<p>` (the merged target)
 *   shipped    = manifest blobSha               (what we sent to the PR)
 * already-reconciled (index==upstream==worktree) → skip; worktree ∈ {shipped, upstream} →
 * restore (stage, idempotent); worktree foreign to both → skip+warn (never clobber a human edit).
 * Divergence (local baseRef not an ancestor of upstream) → strictly hands-off (skip+warn all).
 *
 * Whether the tree ends up ff-pullable is then MEASURED, not asserted — see ffBlockers(). A file
 * left byte-for-byte (a peer agent's live edit) that upstream also changed still blocks the pull,
 * and the caller must say so rather than hand back a `git pull --ff-only` that is about to abort:
 * git answers that abort with "commit your changes or stash them", and stashing there destroys the
 * exact concurrent work this module declined to touch one step earlier.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeFileAtomic } from './atomic-write.mjs';
const ABSENT = Symbol('absent'); // a file/blob that does not exist on a given side (≠ any sha)
const MAX_BUFFER = 64 * 1024 * 1024; // a few thousand dirty paths overflow Node's 1 MiB default
/** Run a git PROBE in <root>: trimmed stdout, or null on any failure. Never throws. */
export function git(root, args) {
    try {
        return execFileSync('git', ['-C', root, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'], // stderr piped, never inherited: a probe must stay silent
            maxBuffer: MAX_BUFFER,
        }).trim();
    }
    catch {
        return null;
    }
}
/**
 * Run a git WRITE: null when it landed, else what git actually said. Neither silent nor fatal — an
 * unhandled throw here killed a run mid-manifest with Node's bare `Command failed: git -C <root>
 * checkout …`: the argv and nothing else — no exit status, no stderr, and an unquoted repo path that
 * reads as a path-quoting bug when the cause was elsewhere. The status is rendered, never assumed.
 */
function gitWrite(root, args) {
    try {
        execFileSync('git', ['-C', root, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: MAX_BUFFER,
        });
        return null;
    }
    catch (e) {
        // SAFETY: execFileSync throws Error-shaped values carrying git's exit status and its stderr.
        const err = e;
        // Just the DIAGNOSIS line: git pads a fatal with advice paragraphs an operator skims past.
        const said = String(err.stderr ?? '');
        const why = (said.match(/^\s*(fatal|error):.*/m) ?? said.match(/^\s*\S.*/m))?.[0].trim() ?? '';
        const code = err.status ?? '?'; // null on a spawn failure (ENOENT), where there is no exit code
        return `git ${args.join(' ')} failed (exit ${code})${why ? `: ${why}` : ''}`;
    }
}
/**
 * Untrimmed, NUL-split git output — `null` when the probe FAILED (distinct from `[]`, which means
 * it ran and found nothing). Not `git()`: that trims, and `trim()` eats the leading ' ' of a
 * porcelain status record (" M path") and of any path that genuinely starts with a space, both of
 * which silently drop a blocker. `--no-optional-locks` because porcelain diff/status otherwise
 * refresh-and-WRITE .git/index — a dry run must stay byte-pure, and N agents share this tree.
 */
function gitZ(root, args) {
    try {
        return execFileSync('git', ['-C', root, '--no-optional-locks', ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: MAX_BUFFER, // a few thousand dirty paths overflow Node's 1 MiB default
        })
            .split('\0')
            .filter((s) => s.length > 0);
    }
    catch {
        return null;
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
    // gh pr view takes the branch POSITIONALLY (`gh pr view [<number>|<url>|<branch>]`); --head is a
    // `gh pr list` flag and makes `gh pr view` exit non-zero, silently degrading every pr:null lookup to UNKNOWN.
    const sel = prNumber != null ? [String(prNumber)] : [branch];
    const debug = process.env.DEVKIT_RECONCILE_DEBUG; // surface gh's stderr instead of collapsing all failures to UNKNOWN
    try {
        const state = execFileSync('gh', ['pr', 'view', ...sel, '--repo', repo, '--json', 'state', '-q', '.state'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', debug ? 'pipe' : 'ignore'],
        }).trim();
        return state === 'MERGED' ? 'MERGED' : 'OPEN';
    }
    catch (e) {
        // gh absent / offline / no PR — clears no debt, never crashes.
        if (debug) {
            const stderr = e instanceof Error && 'stderr' in e ? String(e.stderr ?? '') : '';
            console.error(`detectMerged ${repo} ${branch}: gh failed — ${stderr.trim() || (e instanceof Error ? e.message : String(e))}`);
        }
        return 'UNKNOWN';
    }
}
/**
 * Three-way gate + restore for one path → {restored?} | {done?} | {warning, failed?}. Gate and write
 * read the SAME caller-resolved `upstreamSha`; a re-read between them lets a peer's fetch choose.
 */
export function reconcilePath(mainRepo, P, upstreamSha, apply) {
    if (P.path.startsWith('/') || P.path.split('/').includes('..')) {
        return { warning: `${P.path}: non-relative path refused (repo-relative paths only)` };
    }
    const upstream = blobAt(mainRepo, upstreamSha, P.path);
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
        if (apply) {
            // stage the deletion → pullable. Swallowing this used to print "✓ restored" and prune the entry.
            const failure = gitWrite(mainRepo, ['rm', '--cached', '--ignore-unmatch', '--', P.path]);
            if (failure)
                return { warning: `${P.path}: staging the deletion failed — ${failure}`, failed: true };
        }
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
        const failure = apply ? gitWrite(mainRepo, ['checkout', upstreamSha, '--', P.path]) : null;
        if (failure)
            return { warning: `${P.path}: restore failed — ${failure}`, failed: true };
        return { restored: true };
    }
    return { warning: `${P.path}: edited after ship — left byte-for-byte as you have it` };
}
/**
 * Porcelain-v1 worktree-column codes that make git overwrite the file. 'D' is EXCLUDED on purpose:
 * an UNSTAGED deletion hits verify_uptodate's `lstat` → ENOENT branch, which returns 0 (allowed).
 * Reporting it would be a false positive, and a false alarm here reads as "reconcile failed".
 */
const WT_BLOCKING = new Set(['M', 'T', 'A', 'U']);
/** Which of `paths` exist as untracked, non-ignored files (git's verify_absent case). Chunked for ARG_MAX. */
function untrackedAt(root, paths) {
    const found = [];
    for (let i = 0; i < paths.length; i += 500) {
        // :(literal) so a filename containing *, ? or [ is not read back as a glob.
        const recs = gitZ(root, [
            'ls-files',
            '-o',
            '--exclude-standard',
            '-z',
            '--',
            ...paths.slice(i, i + 500).map((p) => `:(literal)${p}`),
        ]);
        if (!recs)
            return null;
        found.push(...recs);
    }
    return found;
}
/**
 * The paths that would make `git pull --ff-only` abort right now — VERIFIED against the tree, not
 * inferred from this run's warnings (a peer agent's dirty file that no ship ever recorded blocks
 * the ff identically, and produces no warning at all). `exempt` is what this run restores/would
 * restore; under --apply the checkout already made index==upstream, under a dry run nothing is
 * staged yet, so subtracting it in BOTH modes makes the dry run predict the apply exactly.
 *
 * An ff is not a merge: checkout_fast_forward runs unpack_trees/twoway_merge, which per path
 * (H=HEAD blob, U=FETCH_HEAD blob, I=index, W=worktree) refuses iff U!=H and NOT I==U and either
 * I!=H (a third blob staged → reject_merge), or W differs from I (verify_uptodate), or the path is
 * an upstream ADD sitting under an untracked file (verify_absent). I==U is an absolute exemption —
 * git takes keep_entry and never looks at the worktree, which is exactly the end state the restore
 * above produces. Not detected, all benign misses rather than false claims: macOS case-fold
 * collisions on an upstream add (git compares with ignore_case, our pathspec probe does not),
 * `merge.overwriteIgnore=false` (devkit never sets it), and submodule CONTENT dirtiness
 * (suppressed below — a gitlink SHA change still counts, via the index column).
 */
export function ffBlockers(root, upstream, exempt) {
    // `upstream` is the SHA the caller already resolved, never the literal FETCH_HEAD ref: .git/FETCH_HEAD
    // is a mutable file and N agents share this tree, so a peer's fetch landing between these probes
    // would measure `changed` and `idxVsUpstream` against two different commits and yield a blocker
    // list that reflects no real state — the one failure mode that must not hide behind a claim.
    //
    // --no-renames is load-bearing, not cosmetic: unpack_trees is a path-wise tree compare that knows
    // nothing about renames, but porcelain diff defaults to detecting them and then prints ONLY the
    // new path — hiding the deleted old path, i.e. a false negative on a path that really blocks.
    const changed = gitZ(root, ['diff', '--name-status', '-z', '--no-renames', 'HEAD', upstream]);
    // I==U. Needed on top of `exempt` for idempotent re-runs: a path a PREVIOUS run staged returns
    // {done} and never enters `restored`, so the exempt set alone would re-report it as a blocker.
    const idxVsUpstream = gitZ(root, [
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        '--cached',
        upstream,
    ]);
    // Both dirtiness columns. `git diff --name-only HEAD` alone would be wrong: stage an edit then
    // revert the worktree and it prints nothing, yet I!=H && I!=U still hits reject_merge.
    const status = gitZ(root, [
        'status',
        '--porcelain=v1',
        '-z',
        '--no-renames',
        '--untracked-files=no', // untracked collisions are probed by path below, far cheaper than a full scan
        '--ignore-submodules=dirty',
    ]);
    if (!changed || !idxVsUpstream || !status)
        return null;
    const candidates = [];
    const upstreamAdds = new Set();
    for (let i = 0; i + 1 < changed.length; i += 2) {
        const path = changed[i + 1];
        candidates.push(path);
        if (changed[i].startsWith('A'))
            upstreamAdds.add(path);
    }
    const stale = new Set(idxVsUpstream);
    const code = new Map(status.map((r) => [r.slice(3), r.slice(0, 2)]));
    const blocked = [];
    const maybeUntracked = [];
    for (const p of candidates) {
        if (exempt.has(p) || !stale.has(p))
            continue; // I==U (or this run makes it so) → keep_entry
        const st = code.get(p);
        if (st === undefined) {
            // Clean and tracked ⇒ git updates it cleanly. The one exception is an upstream ADD, where
            // there is nothing to track and an untracked file may be sitting in its way.
            if (upstreamAdds.has(p))
                maybeUntracked.push(p);
        }
        else if (st[0] !== ' ')
            blocked.push(p); // index differs from HEAD → reject_merge
        else if (WT_BLOCKING.has(st[1]))
            blocked.push(p); // worktree differs from index → verify_uptodate
    }
    if (maybeUntracked.length > 0) {
        const collisions = untrackedAt(root, maybeUntracked);
        if (!collisions)
            return null;
        blocked.push(...collisions);
    }
    return [...new Set(blocked)].sort();
}
/** Reconcile one manifest branch (STEP A–D). Pure read under !apply. */
export function reconcileBranch({ mainRepo, branch, entry, apply, }) {
    // ffBlockers: null on every early return below — none of them resolves an upstream commit, and
    // reporting [] there would let the renderer read a verified all-clear out of a branch that never
    // fetched. Only the full path at the bottom produces a measurement.
    const base = {
        branch,
        restored: [],
        restoreFailures: [],
        warnings: [],
        upstreamSha: null,
        baseRef: entry.baseRef,
    };
    const merged = detectMerged({ repo: entry.repo, prNumber: entry.prNumber, branch });
    if (merged !== 'MERGED') {
        return {
            ...base,
            merged: merged === 'UNKNOWN' ? 'unknown' : false,
            action: 'keep',
            warnings: merged === 'UNKNOWN' ? ['gh unavailable — merge state unknown'] : [],
        };
    }
    // Fetch the BRANCH — a remote tag of that name wins git's DWIM, and the prefix also makes a
    // '-'-leading baseRef unreadable as a flag — into a ref THIS PROCESS OWNS. No shared landing site
    // can answer "what did I just fetch?": .git/FETCH_HEAD is one file every peer rewrites, and a
    // peer's fetch of this base advances refs/remotes/origin/<baseRef> between our fetch and our read.
    const pin = `refs/devkit/reconcile/${process.pid}/${entry.baseRef}`;
    if (git(mainRepo, ['fetch', 'origin', `+refs/heads/${entry.baseRef}:${pin}`]) === null) {
        return {
            ...base,
            merged: true,
            action: 'keep',
            warnings: [`fetch origin ${entry.baseRef} failed`],
        };
    }
    const localTip = git(mainRepo, ['rev-parse', entry.baseRef]) ?? git(mainRepo, ['rev-parse', 'HEAD']); // fall back to the checked-out tip if baseRef isn't a local branch
    const upstreamSha = git(mainRepo, ['rev-parse', `${pin}^{commit}`]); // ^{commit} peels a tag
    // Dropped once read; gc's two-week floor keeps the objects, so no pin outlives the run that made it.
    git(mainRepo, ['update-ref', '-d', pin]);
    if (!localTip || !upstreamSha)
        return {
            ...base,
            merged: true,
            action: 'keep',
            warnings: [`could not resolve ${entry.baseRef} or its fetched upstream commit`],
        };
    if (!isAncestor(mainRepo, localTip, upstreamSha)) {
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
    const restoreFailures = [];
    const warnings = [];
    for (const P of entry.paths) {
        const r = reconcilePath(mainRepo, P, upstreamSha, apply);
        if (r.restored)
            restored.push(P.path);
        if (r.failed)
            restoreFailures.push(P.path);
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
    // `action` deliberately still keys on warnings alone: the manifest records SHIPPED debt, and a
    // peer's unrelated dirty file is not this branch's debt to hold the entry open for.
    return {
        branch,
        merged: true,
        action,
        restored,
        restoreFailures,
        warnings,
        // Carried, not re-resolved: the tracking ref moves on the next fetch of this base, so the sha
        // this branch restored FROM is the only thing the caller can honestly measure it against.
        upstreamSha,
        baseRef: entry.baseRef,
    };
}
