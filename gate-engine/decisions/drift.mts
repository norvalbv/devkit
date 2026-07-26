/**
 * Drift: has a decision record lost its grip on the code — or the ruling — it governs?
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
 *
 * Also mechanical, and just as load-bearing: a `**Supersedes:** <id>` that names no real block is a
 * dangling pointer nobody reads twice, and an axis with more than one un-superseded Target block is
 * exactly the two-live-rulings-no-tiebreak state Supersedes exists to prevent (recall/supersession.mts
 * resolves both, read-time, over the whole corpus).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadScopedTargets, matchScope } from './check-alignment.mts';
import { resolveSupersession } from './recall/supersession.mts';

/** One axis whose scope no longer resolves. `globs` is reported so the fix is obvious on sight. */
export interface DriftedAxis {
  slug: string;
  globs: string[];
}

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
export function repoFiles(root: string, max = 20000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir is not drift evidence — skip it rather than fail the check
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else out.push(path.relative(root, full).replace(BACKSLASH_RE, '/'));
      if (out.length >= max) return;
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
export function findDrift(root: string, decisionsDir?: string | null): DriftedAxis[] {
  const targets = loadScopedTargets(decisionsDir);
  if (!targets.length) return [];
  const files = repoFiles(root);
  if (!files.length) return []; // nothing to match against → cannot conclude drift
  return targets
    .filter((t) => t.scopeGlobs.length && !matchScope(files, t.scopeGlobs))
    .map((t) => ({ slug: t.slug, globs: t.scopeGlobs }));
}

/** `guard-decisions drift` — exit 1 when any ruling has silently stopped being enforced, a
 * `**Supersedes:**` id resolves to nothing, or an axis carries more than one un-superseded Target. */
export function runDrift(root: string, decisionsDir?: string | null): number {
  if (!existsSync(root)) {
    console.error(`guard-decisions drift: no such directory ${root}`);
    return 2;
  }
  const drifted = findDrift(root, decisionsDir);
  const { unresolved, multipleLive } = resolveSupersession(decisionsDir);
  if (!drifted.length && !unresolved.length && !multipleLive.length) {
    console.log('decision drift: every scoped ruling still matches code ✓');
    return 0;
  }
  if (drifted.length) {
    console.error(
      `🚫 ${drifted.length} decision record(s) scope code that no longer exists — these rulings are ` +
        'NO LONGER ENFORCED (check-alignment free-skips a Target whose scope matches nothing):',
    );
    for (const d of drifted) console.error(`   ${d.slug}\n     Scope: ${d.globs.join(',')}`);
    console.error(
      '\n   Fix with `guard-decisions rescope <slug> --scope "<live-glob>" --reason "<why>"` — an ' +
        'append-only correction that leaves the original Scope line untouched.',
    );
  }
  if (unresolved.length) {
    console.error(`🚫 ${unresolved.length} **Supersedes:** reference(s) resolve to no real entry:`);
    for (const u of unresolved) console.error(`   ${u.slug}: Supersedes: ${u.raw}`);
  }
  if (multipleLive.length) {
    console.error(
      `🚫 ${multipleLive.length} axis(es) carry more than one un-superseded Target block — which one is live?`,
    );
    for (const m of multipleLive) console.error(`   ${m.slug}: ${m.ids.join(', ')}`);
  }
  return 1;
}
