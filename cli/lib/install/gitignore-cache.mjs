/**
 * .gitignore wiring for devkit's regenerated gate caches — the per-repo artifacts the gate engine
 * writes under `.devkit/`: the deterministic-prefix cache, the decisions + review verdict caches,
 * the per-branch ship log, and the reconcile manifest. All are rebuildable and keyed on a tree/
 * evidence/branch hash, so they are never committed.
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
// commit-with-gate-capture.sh's log, reconcile-manifest-write.
export const DEVKIT_CACHE_IGNORES = [
  '.devkit/prefix-cache.json',
  '.devkit/decisions-verdict-cache.json',
  '.devkit/review-cache.json',
  '.devkit/review-progress-*.json',
  '.devkit/last-ship-gates-*.log',
  '.devkit/reconcile-manifest.json',
];

// Append any missing cache-ignore line to <cwd>/.gitignore (idempotent). Mirrors ensureFallowGitignore.
export function ensureDevkitCacheGitignore(cwd, dryRun) {
  const giPath = join(cwd, '.gitignore');
  const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = DEVKIT_CACHE_IGNORES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  if (dryRun) {
    console.log(`  [dry-run] ensure ${missing.length} devkit cache line(s) in .gitignore`);
    return;
  }
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(giPath, `${existing}${sep}${missing.join('\n')}\n`);
  console.log(`  ✓ ensured ${missing.length} devkit cache line(s) in .gitignore`);
}

// Remove the cache-ignore lines from <root>/.gitignore (clean reversal). No-op when none present.
export function pruneDevkitCacheGitignore(root, dryRun) {
  const giPath = join(root, '.gitignore');
  if (!existsSync(giPath)) return;
  const raw = readFileSync(giPath, 'utf8');
  const drop = new Set(DEVKIT_CACHE_IGNORES);
  const lines = raw.split('\n');
  const kept = lines.filter((l) => !drop.has(l.trim()));
  if (kept.length === lines.length) return;
  if (dryRun) {
    console.log('  [dry-run] prune devkit cache lines from .gitignore');
    return;
  }
  writeFileSync(giPath, kept.join('\n'));
  console.log('  ✓ pruned devkit cache lines from .gitignore');
}
