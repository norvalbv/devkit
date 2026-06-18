/**
 * Reverse the sync-skills / sync-agents step: remove the devkit-synced files a manifest records
 * (from .claude + .cursor) and drop the manifest. Shared by `init --remove-deselected` and `clean`
 * so an uninstall removes the synced files, not just the manifest. `root` is the git root (skills +
 * agents are repo-wide), = cwd for a single-package repo.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './fs-helpers.mjs';

function removeManifested(root, manifestRel, targets, kind, dryRun) {
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
    for (const t of targets) {
      const p = join(root, t, name);
      if (existsSync(p)) {
        n++;
        if (!dryRun) rmSync(p, { recursive: true, force: true });
      }
    }
  }
  if (!dryRun) rmSync(manifestPath, { force: true });
  console.log(
    `  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${n} synced ${kind} dir(s) + manifest`,
  );
}

export function removeSkills(root, dryRun) {
  removeManifested(
    root,
    'skills-manifest.json',
    ['.claude/skills', '.cursor/skills'],
    'skill',
    dryRun,
  );
}

export function removeAgents(root, dryRun) {
  removeManifested(
    root,
    'agents-manifest.json',
    ['.claude/agents', '.cursor/agents'],
    'agent',
    dryRun,
  );
}
