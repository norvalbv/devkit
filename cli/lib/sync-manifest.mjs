/**
 * Reverse the sync-skills / sync-agents step: remove the devkit-synced files a manifest records
 * (from .claude + .cursor) and drop the manifest. Shared by `init --remove-deselected` and `clean`
 * so an uninstall removes the synced files, not just the manifest. `root` is the git root (skills +
 * agents are repo-wide), = cwd for a single-package repo.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS } from './components.mjs';
import { packageDir, readJson } from './fs-helpers.mjs';
import { isTracked } from './git-tracked.mjs';

// The names devkit BUNDLES (top-level skill dirs / agent .md files / hook scripts) — the fallback
// name source when a manifest is gone (an orphaned or partial clean), so strays can still be
// enumerated + removed. Shared with install-hooks' removeHookScripts (one place, no dup).
export function bundledNames(sub, isMatch) {
  const dir = join(packageDir(), sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(isMatch)
    .map((e) => e.name);
}

// Shared teardown tail (skills/agents AND agent-hook scripts): drop each now-empty surface dir so a
// full uninstall leaves no footprint — but ONLY when empty (a consumer may keep their own files
// there) — then drop the manifest if asked + it existed. No-op under dryRun.
export function pruneEmptyDirsAndManifest(
  root,
  dirs,
  manifestPath,
  manifest,
  dropManifest,
  dryRun,
) {
  if (dryRun) return;
  for (const dir of dirs) {
    const p = join(root, dir);
    if (existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
  }
  if (dropManifest && manifest) rmSync(manifestPath, { force: true });
}

// Remove the devkit-synced entries a manifest records (skills/agents `<name>/` dirs OR flat agent-
// hook script files) from each surface dir, then prune empty dirs + the manifest. When the manifest
// is gone (orphaned/partial clean), falls back to `fallbackNames` (the package's bundled set) and
// then NEVER deletes a git-tracked path (the user's own). Shared by skills/agents + hook-scripts.
// Reason: flat manifest-teardown orchestration: sequential guarded steps (remove synced dirs, prune empty surface dirs, drop manifest) each gated by dryRun/dropManifest over the dirs list; high branch COUNT, each branch trivial, and the filesystem teardown is exercised end-to-end via init/clean not unit-tested (CRAP)
// fallow-ignore-next-line complexity
export function removeManifested(
  root,
  manifestRel,
  dirs,
  kind,
  dryRun,
  dropManifest,
  fallbackNames = [],
) {
  const manifestPath = join(root, '.devkit', manifestRel);
  const manifest = readJson(manifestPath);
  // Names from the manifest (exactly what devkit wrote) or, when it's gone, the package's bundled
  // set — so an orphaned/partial clean can still find + remove strays.
  const names = manifest
    ? new Set(
        Object.keys(manifest.files)
          .map((rel) => rel.split('/')[0])
          .filter(Boolean),
      )
    : new Set(fallbackNames);
  if (!names.size) {
    console.log(`  • no ${manifestRel} — no ${kind} to remove`);
    return;
  }
  // Manifest keys are "<name>/<file>"; devkit owns the whole "<name>/" dir under each target, so
  // remove the dir — removing only the listed files left empty "<name>/" dirs behind (the other
  // half of the clean leak). recursive+force: an already-partial/absent dir is fine.
  // The tracked-skip guards ONLY the fallback path (no manifest): there `names` is the package's
  // whole bundled set, which could match a user's OWN committed same-named dir — never delete that.
  // With a manifest, `names` is exactly what devkit WROTE, and a package-mode uninstall MUST remove
  // its committed (tracked) files, so removal is unconditional.
  const guardTracked = !manifest;
  let n = 0;
  for (const name of names) {
    for (const dir of dirs) {
      const rel = `${dir}/${name}`;
      const p = join(root, dir, name);
      if (existsSync(p) && (!guardTracked || !isTracked(root, rel))) {
        n++;
        if (!dryRun) rmSync(p, { recursive: true, force: true });
      }
    }
  }
  pruneEmptyDirsAndManifest(root, dirs, manifestPath, manifest, dropManifest, dryRun);
  if (n || manifest) {
    console.log(
      `  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${n} synced ${kind} dir(s)${dropManifest && manifest ? ' + manifest' : ''}`,
    );
  }
}

/**
 * @param {string} root git root
 * @param {boolean} dryRun
 * @param {string[]} [targets] surfaces to remove from (default both)
 * @param {boolean} [dropManifest] also delete the manifest (default true — a full uninstall)
 */
export function removeSkills(root, dryRun, targets = AGENT_TARGETS, dropManifest = true) {
  const dirs = targets.map((t) => `.${t}/skills`);
  const fallback = bundledNames('skills', (e) => e.isDirectory());
  removeManifested(root, 'skills-manifest.json', dirs, 'skill', dryRun, dropManifest, fallback);
}

export function removeAgents(root, dryRun, targets = AGENT_TARGETS, dropManifest = true) {
  const dirs = targets.map((t) => `.${t}/agents`);
  const fallback = bundledNames('agents', (e) => e.isFile() && e.name.endsWith('.md'));
  removeManifested(root, 'agents-manifest.json', dirs, 'agent', dryRun, dropManifest, fallback);
}
