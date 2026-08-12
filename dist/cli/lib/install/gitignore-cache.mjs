/**
 * .gitignore wiring for devkit's generated `.devkit/` state: ignore regenerated gate caches while
 * keeping durable manifests trackable even when a consumer carries a broad `.devkit/*` rule.
 *
 * SPECIFIC filenames only — `.devkit/` ALSO holds TRACKED artifacts (agents-manifest.json,
 * skills-manifest.json) and, in standalone mode, vendored configs (.devkit/biome, .devkit/tsconfig).
 * A blanket `.devkit/` ignore would wrongly untrack those, so each line below is a single file/glob.
 *
 * init (package/standalone) ensures these lines; clean prunes them. Overlay never uses this — there
 * the whole `.devkit/` is hidden via `.git/info/exclude`, so the caches are already invisible.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Each entry matches its writer verbatim: prefix-cache.mjs STORE_FILE, decisions/verdict-cache.mjs
// STORE_FILE, review/cache.mjs CACHE_FILE, review/run-review.mjs progress (DEVKIT_REVIEW_PROGRESS),
// review-target.sh's per-run output, commit-with-gate-capture.sh's log, reconcile-manifest-write.
export const DEVKIT_CACHE_IGNORES = [
    '.devkit/prefix-cache.json',
    '.devkit/decisions-verdict-cache.json',
    '.devkit/review-cache.json',
    '.devkit/sentry-verdict-cache.json',
    '.devkit/review-progress-*.json',
    '.devkit/review-runs/',
    '.devkit/last-ship-gates-*.log',
    '.devkit/reconcile-manifest.json',
    // Not a cache — a LOCAL preference (adhd-session-start.mjs reads it as the durable off switch).
    // Ignored for the same reason the caches are: committing it would impose one reader's output
    // preference on everyone who clones the repo.
    '.devkit/adhd-off',
];
export const DEVKIT_TRACKED_UNIGNORES = ['!.devkit/agent-hook-registrations-manifest.json'];
const DEVKIT_GITIGNORE_LINES = [...DEVKIT_CACHE_IGNORES, ...DEVKIT_TRACKED_UNIGNORES];
const TRACKED_UNIGNORE_SET = new Set(DEVKIT_TRACKED_UNIGNORES);
// Append cache rules and keep tracked-state negations at the effective tail (gitignore is last-match
// wins, so presence alone is insufficient when a consumer later appends a broad `.devkit/*` rule).
export function ensureDevkitCacheGitignore(cwd, dryRun) {
    const giPath = join(cwd, '.gitignore');
    const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
    const have = new Set(existing.split('\n').map((l) => l.trim()));
    const missingCaches = DEVKIT_CACHE_IGNORES.filter((line) => !have.has(line));
    const kept = existing
        .split('\n')
        .filter((line) => !TRACKED_UNIGNORE_SET.has(line.trim()))
        .join('\n');
    const additions = [...missingCaches, ...DEVKIT_TRACKED_UNIGNORES];
    const separator = kept && !kept.endsWith('\n') ? '\n' : '';
    const next = `${kept}${separator}${additions.join('\n')}\n`;
    if (next === existing)
        return;
    if (dryRun) {
        console.log(`  [dry-run] ensure ${additions.length} devkit .gitignore line(s)`);
        return;
    }
    writeFileSync(giPath, next);
    console.log(`  ✓ ensured ${additions.length} devkit .gitignore line(s)`);
}
// Remove the generated-state lines from <root>/.gitignore (clean reversal). No-op when absent.
export function pruneDevkitCacheGitignore(root, dryRun) {
    const giPath = join(root, '.gitignore');
    if (!existsSync(giPath))
        return;
    const raw = readFileSync(giPath, 'utf8');
    const drop = new Set(DEVKIT_GITIGNORE_LINES);
    const lines = raw.split('\n');
    const kept = lines.filter((l) => !drop.has(l.trim()));
    if (kept.length === lines.length)
        return;
    if (dryRun) {
        console.log('  [dry-run] prune devkit .gitignore lines');
        return;
    }
    writeFileSync(giPath, kept.join('\n'));
    console.log('  ✓ pruned devkit .gitignore lines');
}
