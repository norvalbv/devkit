/**
 * `devkit reconcile` — manual lane. After your PR merges, replace the now-stale shipped files in
 * the shared checkout with the merged-upstream version (no stash/pull pain). Engine: ../lib/reconcile.mjs.
 *
 * DRY-RUN by default (prints the plan, mutates nothing). `--apply` performs the restores and prunes
 * finished branches. Reads the per-branch manifest at <main-repo>/.devkit/reconcile-manifest.json.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectGitRoot } from '../lib/detect-git-root.mjs';
import { git, loadManifest, reconcileBranch } from '../lib/reconcile.mjs';
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
function render(results, { apply }) {
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
    if (anyRestore) {
        lines.push('');
        lines.push(apply
            ? 'Shipped files restored to merged-upstream content; the tree is now ff-pullable.'
            : 'These files would be restored to merged-upstream content (run with --apply).');
        lines.push('Finalize with `git pull --ff-only` — HEAD is intentionally not advanced (shared-tree invariant).');
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
            };
        }
        return reconcileBranch({ mainRepo, branch: name, entry, apply: f.apply });
    });
    if (f.json)
        console.log(JSON.stringify({ branches: results }, null, 2));
    else
        console.log(names.length
            ? render(results, { apply: f.apply })
            : 'reconcile: nothing recorded (no manifest branches).');
    return 0;
}
