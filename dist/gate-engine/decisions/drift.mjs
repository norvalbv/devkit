/**
 * Drift: has a decision record lost its grip on the code it governs?
 *
 * A decision RECORD does not rot. It is append-only, one file per axis, and its content reads the
 * same in a century. What rots is ENFORCEMENT. `check-alignment` only judges a Target whose
 * `**Scope:**` glob matches a staged file; a Target matching nothing is free-skipped and the gate
 * exits 0. So when a scope glob stops resolving — a directory reorganised, an extension migrated,
 * a file moved — the ruling stays perfectly readable and silently stops being enforced, and the
 * green gate is indistinguishable from a gate that looked and found nothing wrong.
 *
 * Measured on this repo when the check was written: 5 of 28 scoped records pointed at no path
 * on disk, from two entirely mechanical causes — a `.mjs`→`.mts` migration, and ordinary file moves.
 * One of them was broken the same morning by the very refactor that motivated this check, which is
 * the point: nobody does this deliberately and nothing was watching.
 *
 * Deliberately mechanical. It answers "does this glob still match anything?", never "does this code
 * still honour this ruling" — traceability-link recovery is brittle even with a model in the loop,
 * and a false block on a legitimate commit is how a gate gets switched off for good.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadScopedTargets, matchScope } from "./check-alignment.mjs";
// Filesystem walks yield OS-native separators; scope globs are ALWAYS authored repo-root-relative
// with forward slashes. Without this, every scoped axis misreports as drifted on Windows — the same
// normalization clone-detector.mts already applies to walk-produced paths.
const BACKSLASH_RE = /\\/g;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', '.turbo']);
/**
 * Repo-relative paths of tracked-ish files. Walks the tree rather than shelling out to git so the
 * check works in a fixture or an unstaged worktree, and skips the usual generated/vendored trees —
 * a scope that only matches inside node_modules is not enforced in any meaningful sense.
 */
export function repoFiles(root, max = 20000) {
    const out = [];
    const walk = (dir) => {
        if (out.length >= max)
            return;
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return; // unreadable dir is not drift evidence — skip it rather than fail the check
        }
        for (const name of entries) {
            if (SKIP_DIRS.has(name) || name.startsWith('.'))
                continue;
            const full = path.join(dir, name);
            let isDir;
            try {
                isDir = statSync(full).isDirectory();
            }
            catch {
                continue;
            }
            if (isDir)
                walk(full);
            else
                out.push(path.relative(root, full).replace(BACKSLASH_RE, '/'));
            if (out.length >= max)
                return;
        }
    };
    walk(root);
    return out;
}
/**
 * Every scoped axis whose globs match no file in the tree.
 *
 * Reuses the gate's own `matchScope`, so the question asked here is EXACTLY the question the gate
 * asks at commit time. A separate glob implementation could disagree with the gate and report an
 * axis as enforced when it is not — which is the failure this exists to catch.
 */
export function findDrift(root, decisionsDir) {
    const targets = loadScopedTargets(decisionsDir);
    if (!targets.length)
        return [];
    const files = repoFiles(root);
    if (!files.length)
        return []; // nothing to match against → cannot conclude drift
    return targets
        .filter((t) => t.scopeGlobs.length && !matchScope(files, t.scopeGlobs))
        .map((t) => ({ slug: t.slug, globs: t.scopeGlobs }));
}
/** `guard-decisions drift` — exit 1 when any ruling has silently stopped being enforced. */
export function runDrift(root, decisionsDir) {
    if (!existsSync(root)) {
        console.error(`guard-decisions drift: no such directory ${root}`);
        return 2;
    }
    const drifted = findDrift(root, decisionsDir);
    if (!drifted.length) {
        console.log('decision drift: every scoped ruling still matches code ✓');
        return 0;
    }
    console.error(`🚫 ${drifted.length} decision record(s) scope code that no longer exists — these rulings are ` +
        'NO LONGER ENFORCED (check-alignment free-skips a Target whose scope matches nothing):');
    for (const d of drifted)
        console.error(`   ${d.slug}\n     Scope: ${d.globs.join(',')}`);
    console.error('\n   Fix the Scope to the paths that exist now — `guard-decisions amend <slug> --target … ' +
        '--scope "…"` when the ruling is unchanged and only the code moved.');
    return 1;
}
