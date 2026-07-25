/**
 * `devkit reconcile` — manual lane. After your PR merges, replace the now-stale shipped files in
 * the shared checkout with the merged-upstream version (no stash/pull pain). Engine: ../lib/reconcile.mjs.
 *
 * DRY-RUN by default (prints the plan, mutates nothing). `--apply` performs the restores and prunes
 * finished branches. Reads the per-branch manifest at <main-repo>/.devkit/reconcile-manifest.json.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectGitRoot } from "../lib/detect-git-root.mjs";
import { ffBlockers, git, loadManifest, reconcileBranch, } from "../lib/reconcile.mjs";
/** Same git top-level on both sides, comparing REALPATHS (git resolves /var→/private/var on macOS). */
function sameRoot(a, b) {
    try {
        return realpathSync(a) === realpathSync(b);
    }
    catch {
        return false;
    }
}
export const meta = {
    name: 'reconcile',
    summary: 'After a PR merges, refresh stale files in a shared checkout.',
    help: `devkit reconcile — after your PR merges, replace stale local copies with the merged
version in the shared checkout (no stash/pull). Manual lane.

Usage:
  devkit reconcile [--apply] [--branch <name>] [--main-repo <path>] [--json]

  (default)         DRY-RUN: print the plan, touch nothing.
  --apply           Perform the restores + prune finished branches from the manifest.
  --branch <name>   Only this manifest branch (default: every recorded branch).
  --main-repo <p>   The shared checkout root (default: the git root of the cwd).
  --json            Emit the machine envelope on stdout instead of human text.
  --mode manual     Accepted for forward-compat (the only mode in v1). --mode auto is rejected.`,
};
function parse(args) {
    const f = {
        branch: null,
        'main-repo': null,
        mode: null,
        apply: false,
        json: false,
        help: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--apply')
            f.apply = true;
        else if (a === '--json')
            f.json = true;
        else if (a === '--help' || a === '-h')
            f.help = true;
        else if (a === '--branch')
            f.branch = args[++i];
        else if (a === '--main-repo')
            f['main-repo'] = args[++i];
        else if (a === '--mode')
            f.mode = args[++i];
    }
    return f;
}
/**
 * Measure ff-pullability ONCE PER BASE REF, after every branch has finished restoring, and name any
 * base ref that could not be measured at all.
 *
 * Two things this ordering buys, both of which a per-branch measurement gets wrong. (1) A run
 * reconciles N branches; a file branch 2 restores still looks dirty to a measurement taken right
 * after branch 1, so pooling per-branch results reports a blocker that no longer exists. (2) A
 * measurement is only meaningful against the upstream it was taken from — pooling across base refs
 * would claim a file blocks a pull of `main` because it differs from `release/1.x`.
 *
 * `unverified` is keyed on baseRef rather than "did every branch measure": a measurement is
 * whole-tree (upstream-changed ∩ dirty), not manifest-scoped, so one measured branch answers for
 * every branch sharing its baseRef. Demanding all of them would print a NOT-verified caveat
 * whenever an un-merged branch sits beside a merged one — the normal state of an accumulating
 * manifest, and a second false statement in place of the one being fixed. A baseRef NO branch could
 * measure is a real hole, where an empty blocker list is ignorance rather than an all-clear.
 */
function measureBases(mainRepo, results, apply) {
    const upstreamOf = new Map(); // baseRef → resolved upstream sha
    const restoredBy = new Map(); // baseRef → paths this run restores
    for (const r of results) {
        if (r.baseRef === null)
            continue;
        if (r.upstreamSha)
            upstreamOf.set(r.baseRef, r.upstreamSha);
        const seen = restoredBy.get(r.baseRef) ?? new Set();
        for (const p of r.restored)
            seen.add(p);
        restoredBy.set(r.baseRef, seen);
    }
    const verdicts = [];
    const unverified = [];
    for (const [ref, sha] of upstreamOf) {
        // Under --apply the restores are already staged (index==upstream exempts them anyway); under a
        // dry run nothing is staged, so the would-restore paths must be subtracted explicitly.
        const blockers = ffBlockers(mainRepo, sha, apply ? new Set() : (restoredBy.get(ref) ?? new Set()));
        if (blockers === null)
            unverified.push(ref); // a git probe failed — don't know, never an all-clear
        else
            verdicts.push({ ref, blockers: blockers.sort() });
    }
    for (const ref of restoredBy.keys())
        if (!upstreamOf.has(ref))
            unverified.push(ref);
    return {
        verdicts: verdicts.sort((a, b) => a.ref.localeCompare(b.ref)),
        unverified: [...new Set(unverified)].sort(),
    };
}
/**
 * The trailer: what to do next. Never hands back a `git pull --ff-only` that is about to abort.
 * Every blocker is reported UNDER the base ref it was measured against — a file that differs from
 * `release/1.x` says nothing about pulling `main`, so one pooled list would mislead on both.
 */
function guidance(verdicts, unverified, apply, anyRestore) {
    const blocked = verdicts.filter((v) => v.blockers.length > 0);
    const restoreLine = apply
        ? 'Shipped files restored to merged-upstream content.'
        : 'These files would be restored to merged-upstream content (run with --apply).';
    if (blocked.length === 0) {
        if (unverified.length > 0)
            return [
                ...(anyRestore ? [restoreLine] : []),
                `ff-pullability is NOT verified: ${unverified.join(', ')} could not be checked.`,
                '`git pull --ff-only` may still abort. If it names files, do NOT stash, restore or checkout',
                "them — commit or ship them instead; they are another agent's in-flight work.",
            ];
        return [
            apply
                ? 'Shipped files restored to merged-upstream content; the tree is now ff-pullable.'
                : restoreLine,
            'Finalize with `git pull --ff-only` — HEAD is intentionally not advanced (shared-tree invariant).',
        ];
    }
    const total = blocked.reduce((n, v) => n + v.blockers.length, 0);
    return [
        ...(anyRestore ? [restoreLine] : []),
        `${total} file(s) ${apply ? 'still block' : 'would still block'} \`git pull --ff-only\` — upstream changed them too and your copy is uncommitted:`,
        ...blocked.flatMap((v) => [`  ${v.ref}:`, ...v.blockers.map((p) => `    ✗ ${p}`)]),
        ...(unverified.length > 0 ? [`(${unverified.join(', ')} could not be checked at all.)`] : []),
        'Left byte-for-byte on purpose: these are live concurrent edits in this shared tree.',
        'Do NOT stash, restore, checkout or delete them — git answers this abort with "commit your',
        'changes or stash them", and following that advice here destroys another agent\'s in-flight work.',
        'Ship each one instead (`devkit ship <branch> "<title>" -- <path>`), or leave it to its owner and',
        're-run `devkit reconcile --apply` once that PR merges. The pull is safe only once this list is empty.',
    ];
}
function render(mainRepo, results, { apply }) {
    const pruned = results.filter((r) => r.action === 'prune').length;
    const restoredN = results.reduce((n, r) => n + r.restored.length, 0);
    const warnedN = results.reduce((n, r) => n + r.warnings.length, 0);
    const lines = [
        `${results.length} branch(es) · ${pruned} ${apply ? 'pruned' : 'to prune'} · ${restoredN} file(s) ${apply ? 'restored' : 'to restore'} · ${warnedN} warning(s)`,
    ];
    let anyRestore = false;
    for (const r of results) {
        const state = r.merged === true ? 'MERGED' : r.merged === 'unknown' ? 'merge-state unknown' : 'not merged';
        lines.push(`${r.branch} — ${state} · ${apply ? r.action : `would ${r.action}`}`);
        for (const p of r.restored) {
            lines.push(`  ${apply ? '✓ restored' : '· would restore'} ${p}`);
            anyRestore = true;
        }
        for (const w of r.warnings)
            lines.push(`  ⚠ ${w}`);
    }
    const { verdicts, unverified } = measureBases(mainRepo, results, apply);
    const anyBlocked = verdicts.some((v) => v.blockers.length > 0);
    // Blockers alone are enough to speak up: a run where every path warned restores nothing and used
    // to print no trailer at all, leaving the operator to invent a next step. That is the worst case.
    // With blockers, guidance() keeps the restore facts but sheds the ff claim and withholds the
    // `git pull --ff-only` instruction — handing an agent a command that is about to abort is what
    // sent the last one toward stashing a peer's work.
    if (anyRestore || anyBlocked || unverified.length > 0) {
        lines.push('');
        lines.push(...guidance(verdicts, unverified, apply, anyRestore));
    }
    return lines.join('\n');
}
export default function reconcile(args, cwd) {
    const f = parse(args);
    if (f.help) {
        console.log(meta.help);
        return 0;
    }
    if (f.mode && f.mode !== 'manual') {
        console.error(`devkit reconcile: --mode ${f.mode} is not implemented in v1 (manual only)`);
        return 1;
    }
    const mainRepo = f['main-repo'] ? resolve(cwd, f['main-repo']) : detectGitRoot(cwd).gitRoot;
    // STEP 0 — root-assert: hash-object must run from the SAME top-level ship used, else a future
    // .gitattributes/LFS filter could id a file differently on the two sides. Refuse a subdir/worktree.
    const top = git(mainRepo, ['rev-parse', '--show-toplevel']);
    if (!top || !sameRoot(top, mainRepo)) {
        console.error(`devkit reconcile: --main-repo must be a git top-level (got "${mainRepo}")`);
        return 1;
    }
    const manifest = loadManifest(mainRepo);
    const names = f.branch ? [f.branch] : Object.keys(manifest.branches);
    const results = names.map((name) => {
        const entry = manifest.branches[name];
        if (!entry?.paths || entry.paths.length === 0) {
            return {
                branch: name,
                merged: false,
                action: 'keep',
                restored: [],
                warnings: [entry ? 'empty manifest entry' : 'no such branch in manifest'],
                upstreamSha: null, // never fetched
                baseRef: null, // no manifest entry ⇒ no upstream it could even be measured against
            };
        }
        return reconcileBranch({ mainRepo, branch: name, entry, apply: f.apply });
    });
    if (f.json) {
        // --json skips render() entirely, and a machine consumer is exactly who acts on "ff-pullable"
        // without reading the warnings. Keyed by base ref, never pooled: a caller pulls ONE base, and a
        // file that differs from another base's upstream says nothing about theirs.
        const { verdicts, unverified } = measureBases(mainRepo, results, f.apply);
        console.log(JSON.stringify({
            branches: results,
            ffBlockersByBase: Object.fromEntries(verdicts.map((v) => [v.ref, v.blockers])),
            ffUnverifiedBases: unverified, // base refs no branch could measure at all
            // null = don't know. An empty blocker list under an unmeasured base ref is ignorance, and
            // a machine caller must never read it as an all-clear.
            ffPullable: unverified.length > 0 || verdicts.length === 0
                ? null
                : verdicts.every((v) => v.blockers.length === 0),
        }, null, 2));
    }
    else
        console.log(names.length
            ? render(mainRepo, results, { apply: f.apply })
            : 'reconcile: nothing recorded (no manifest branches).');
    return 0;
}
