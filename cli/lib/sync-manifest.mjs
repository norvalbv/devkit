/**
 * Reverse the sync-skills / sync-agents step: remove the devkit-synced files a manifest records
 * (from .claude + .cursor) and drop the manifest. Shared by `init --remove-deselected` and `clean`
 * so an uninstall removes the synced files, not just the manifest. `root` is the git root (skills +
 * agents are repo-wide), = cwd for a single-package repo.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS } from './components.mjs';
import { readJson } from './fs-helpers.mjs';

// Reason: flat manifest-teardown orchestration: sequential guarded steps (remove synced dirs, prune empty surface dirs, drop manifest) each gated by dryRun/dropManifest over the dirs list; high branch COUNT, each branch trivial, and the filesystem teardown is exercised end-to-end via init/clean not unit-tested (CRAP)
// fallow-ignore-next-line complexity
function removeManifested(root, manifestRel, dirs, kind, dryRun, dropManifest) {
  const manifestPath = join(root, '.devkit', manifestRel);
  const manifest = readJson(manifestPath);
  if (!manifest) {
    console.log(`  • no ${manifestRel} — no ${kind} to remove`);
    return;
  }
  // Manifest keys are "<name>/<file>"; devkit owns the whole "<name>/" dir under each target, so
  // remove the dir — removing only the listed files left empty "<name>/" dirs behind (the other
  // half of the clean leak). recursive+force: an already-partial/absent dir is fine.
  const names = new Set(
    Object.keys(manifest.files)
      .map((rel) => rel.split('/')[0])
      .filter(Boolean),
  );
  let n = 0;
  for (const name of names) {
    for (const dir of dirs) {
      const p = join(root, dir, name);
      if (existsSync(p)) {
        n++;
        if (!dryRun) rmSync(p, { recursive: true, force: true });
      }
    }
  }
  // Drop the now-empty surface dir (e.g. .cursor/skills) so a pruned surface leaves no footprint —
  // but ONLY when empty, since a consumer may author their own skills/agents alongside devkit's.
  if (!dryRun) {
    for (const dir of dirs) {
      const p = join(root, dir);
      if (existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
    }
  }
  // Keep the manifest when only pruning a surface (the surviving surface's copy is still tracked).
  if (dropManifest && !dryRun) rmSync(manifestPath, { force: true });
  console.log(
    `  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${n} synced ${kind} dir(s)${dropManifest ? ' + manifest' : ''}`,
  );
}

/**
 * @param {string} root git root
 * @param {boolean} dryRun
 * @param {string[]} [targets] surfaces to remove from (default both)
 * @param {boolean} [dropManifest] also delete the manifest (default true — a full uninstall)
 */
export function removeSkills(root, dryRun, targets = AGENT_TARGETS, dropManifest = true) {
  const dirs = targets.map((t) => `.${t}/skills`);
  removeManifested(root, 'skills-manifest.json', dirs, 'skill', dryRun, dropManifest);
}

export function removeAgents(root, dryRun, targets = AGENT_TARGETS, dropManifest = true) {
  const dirs = targets.map((t) => `.${t}/agents`);
  removeManifested(root, 'agents-manifest.json', dirs, 'agent', dryRun, dropManifest);
}
