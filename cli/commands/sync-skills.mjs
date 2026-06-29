/**
 * `devkit sync-skills` — copy devkit's bundled skills into the consumer's .claude/skills
 * and .cursor/skills trees, recursively (SKILL.md + references/ + scripts/). Replaces the
 * `npx skills add` flow (buggy for private repos): skills ship INSIDE the package, so the
 * source is always devkit's own packageDir()/skills, never a network fetch.
 *
 * Writes .devkit/skills-manifest.json with a sha256 per file so `doctor` can tell which
 * side (consumer copy vs devkit source) drifted.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AGENT_TARGETS } from '../lib/components.mjs';
import { detectGitRoot } from '../lib/detect-git-root.mjs';
import { packageDir, readJson, sha256, writeIfAbsent } from '../lib/fs-helpers.mjs';

// Recursively list every file under `dir`, returned as paths relative to `dir`.
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

/**
 * @param {string[]} args
 * @param {string} cwd consumer root
 * @param {string[]} [targets] agent surfaces to write to (default both — see AGENT_TARGETS)
 * @param {{ skipTracked?: (relPath: string) => boolean }} [opts] overlay-only: when given, a skill
 *   `<name>/` whose dir git already TRACKS in any target is skipped wholesale (not written, not
 *   manifested, warned) — `.git/info/exclude` can't hide an edit to a tracked file (C2).
 * @returns {{ devkitRef: string|null, generatedAt: string, files: Record<string,string> }} the manifest (for init to embed in its log)
 */
export function syncSkills(args, cwd, targets = AGENT_TARGETS, { skipTracked } = {}) {
  const dryRun = args.includes('--dry-run');
  const targetDirs = targets.map((t) => `.${t}/skills`);
  const skillsSrc = join(packageDir(), 'skills');
  const rels = walk(skillsSrc);

  const devkitPkg = readJson(join(packageDir(), 'package.json'));
  const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;

  // Tracked-skip is per-skill `<name>/` (the unit devkit owns + clean removes): if any target's
  // `.<surface>/skills/<name>` is git-tracked, the whole skill is left untouched.
  const skipNames = new Set();
  if (skipTracked) {
    for (const name of new Set(rels.map((r) => r.split('/')[0]))) {
      if (targetDirs.some((td) => skipTracked(`${td}/${name}`))) {
        skipNames.add(name);
        console.log(`  ! skipping skill "${name}" — git-tracked in the repo (left untouched)`);
      }
    }
  }

  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of rels) {
    if (skipNames.has(rel.split('/')[0])) continue;
    // Reason: sync-skills and sync-agents are deliberately parallel modules (see headers "Parallel to …"): identical write+manifest mechanics to different dirs. One shared abstraction over two short readable commands would obscure both; the parallelism IS the design.
    // fallow-ignore-next-line code-duplication
    const srcPath = join(skillsSrc, rel);
    const content = readFileSync(srcPath);
    files[rel] = sha256(srcPath);

    for (const target of targetDirs) {
      const destPath = join(cwd, target, rel);
      if (dryRun) {
        console.log(`  [dry-run] write ${target}/${rel}`);
      } else {
        // Skills are devkit-owned: always overwrite so a tag bump propagates the latest.
        writeIfAbsent(destPath, content, { force: true });
      }
    }
  }

  // Reason: sync-agents and sync-skills are deliberately parallel modules (headers say 'Parallel to'): identical write+manifest mechanics to different dirs; the parallelism IS the design
  // fallow-ignore-next-line code-duplication
  const manifestPath = join(cwd, '.devkit', 'skills-manifest.json');
  // Idempotency: keep generatedAt STABLE when nothing about the synced set changed
  // (same devkitRef + same file shas), so a re-run produces no spurious git diff.
  const prev = readJson(manifestPath);
  const unchanged =
    prev && prev.devkitRef === devkitRef && JSON.stringify(prev.files) === JSON.stringify(files);
  const generatedAt = unchanged ? prev.generatedAt : new Date().toISOString();
  const manifest = { devkitRef, generatedAt, files };

  if (dryRun) {
    console.log(`  [dry-run] write .devkit/skills-manifest.json (${rels.length} files)`);
  } else {
    writeIfAbsent(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { force: true });
    console.log(`  ✓ synced ${rels.length} skill file(s) → ${targetDirs.join(' + ')}`);
  }

  return manifest;
}

export const meta = {
  name: 'sync-skills',
  summary: 'Copy bundled skills into .claude/skills + .cursor/skills.',
  help: `devkit sync-skills — copy devkit's bundled skills into .claude/skills + .cursor/skills.

Usage:
  devkit sync-skills [--dry-run]

Writes .devkit/skills-manifest.json (sha256 per file) so doctor can tell which side drifted.`,
};

export default function run(args, cwd) {
  // Skills are repo-wide → target the git root (= cwd for a single-package repo). Honour the
  // recorded agent-surface choice so a manual re-sync never re-adds a deselected surface.
  const { gitRoot } = detectGitRoot(cwd);
  const cfg = readJson(join(gitRoot, '.devkit', 'config.json'));
  syncSkills(args, gitRoot, cfg?.components?.agentTargets ?? AGENT_TARGETS);
  return 0;
}
