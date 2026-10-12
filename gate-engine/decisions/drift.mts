/**
 * Drift: has a decision record lost its grip on the code — or the ruling — it governs?
 *
 * A decision RECORD does not rot. It is append-only, one file per axis, and its content reads the
 * same in a century. What rots is its REACH. `check-alignment` only judges a Target whose
 * `**Scope:**` glob matches a staged file; a Target matching nothing is free-skipped and the gate
 * exits 0. So when a scope glob stops resolving — a directory reorganised, an extension migrated,
 * a file moved — the ruling stays perfectly readable and silently stops being loaded, and the
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

/** A still-loaded axis carrying individual Scope globs that match nothing. */
export interface PartialDrift {
  slug: string;
  deadGlobs: string[];
}

// Filesystem walks yield OS-native separators; scope globs are ALWAYS authored repo-root-relative
// with forward slashes. Without this, every scoped axis misreports as drifted on Windows — the same
// normalization clone-detector.mts already applies to walk-produced paths.
const BACKSLASH_RE = /\\/g;

const RESCOPE_REMEDY =
  'Fix with `guard-decisions rescope <slug> --scope "<live-glob>" --reason "<why>"` — an ' +
  'append-only correction that leaves the original Scope line untouched.';

const MAX_FILES = 20000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', '.turbo']);

/**
 * Repo-relative paths of tracked-ish files. Walks the tree rather than shelling out to git so the
 * check works in a fixture or an unstaged worktree, and skips the usual generated/vendored trees —
 * a scope that only matches inside node_modules governs nothing in any meaningful sense.
 */
export function repoFiles(root: string, max = MAX_FILES, dotDirs = new Set<string>()): string[] {
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
      if (SKIP_DIRS.has(name) || (name.startsWith('.') && !dotDirs.has(name))) continue;
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

// Only dot-entries a Scope names are walked: a blanket walk would spend the file cap on `.venv`.
function scopeHealth(root: string, decisionsDir?: string | null, max = MAX_FILES) {
  const targets = loadScopedTargets(decisionsDir).filter((t) => t.scopeGlobs.length);
  const dotDirs = new Set(
    targets.flatMap((t) =>
      t.scopeGlobs.flatMap((g) => g.split('/').filter((s) => s.startsWith('.'))),
    ),
  );
  const files = targets.length ? repoFiles(root, max, dotDirs) : [];
  if (!files.length) return { drifted: [], partial: [] }; // nothing to match against → no conclusion
  const drifted: DriftedAxis[] = [];
  const partial: PartialDrift[] = [];
  const capped = files.length >= max; // an unwalked remainder may hold the "dead" glob's file
  for (const t of targets) {
    const deadGlobs = t.scopeGlobs.filter((g) => !matchScope(files, [g]));
    if (deadGlobs.length === t.scopeGlobs.length)
      drifted.push({ slug: t.slug, globs: t.scopeGlobs });
    else if (deadGlobs.length && !capped) partial.push({ slug: t.slug, deadGlobs });
  }
  return { drifted, partial };
}

/**
 * Every scoped axis whose globs match no file in the tree.
 *
 * Reuses the gate's own `matchScope`, so the question asked here is EXACTLY the question the gate
 * asks when it runs. A separate glob implementation could disagree with the gate and report an
 * axis as live when it is not — which is the failure this exists to catch.
 */
export function findDrift(root: string, decisionsDir?: string | null): DriftedAxis[] {
  return scopeHealth(root, decisionsDir).drifted;
}

/** Axes still loaded through one live glob whose other globs match nothing — a file they moved. */
export function findPartialDrift(
  root: string,
  decisionsDir?: string | null,
  max?: number,
): PartialDrift[] {
  return scopeHealth(root, decisionsDir, max).partial;
}

/** `guard-decisions drift` — exit 1 when any ruling has silently stopped being loaded, a
 * `**Supersedes:**` id resolves to nothing, or an axis carries more than one un-superseded Target. */
export function runDrift(root: string, decisionsDir?: string | null): number {
  if (!existsSync(root)) {
    console.error(`guard-decisions drift: no such directory ${root}`);
    return 2;
  }
  const { drifted, partial } = scopeHealth(root, decisionsDir);
  const { unresolved, multipleLive } = resolveSupersession(decisionsDir);
  if (partial.length) {
    console.error(
      `⚠ ${partial.length} live decision record(s) carry Scope globs that match nothing — files they ` +
        'govern may have moved out of reach (report-only):',
    );
    for (const p of partial) console.error(`   ${p.slug}\n     Dead: ${p.deadGlobs.join(',')}`);
    console.error(`   ${RESCOPE_REMEDY}`);
  }
  if (!drifted.length && !unresolved.length && !multipleLive.length) {
    if (!partial.length) console.log('decision drift: every scoped ruling still matches code ✓');
    return 0;
  }
  if (drifted.length) {
    console.error(
      `🚫 ${drifted.length} decision record(s) scope code that no longer exists — these rulings are ` +
        'NO LONGER LOADED BY SCOPE (the pre-edit brief and check-alignment skip a Target whose scope matches nothing):',
    );
    for (const d of drifted) console.error(`   ${d.slug}\n     Scope: ${d.globs.join(',')}`);
    console.error(`\n   ${RESCOPE_REMEDY}`);
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
