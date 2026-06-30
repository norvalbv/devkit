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
import { findConflicts } from '../lib/sync-manifest.mjs';

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
 * @param {{ skipTracked?: (relPath: string) => boolean, override?: (kind: string, name: string) => boolean }} [opts]
 *   `skipTracked` (overlay-only): a skill `<name>/` whose dir git already TRACKS in any target is
 *   skipped wholesale (not written, not manifested, warned) — `.git/info/exclude` can't hide an edit
 *   to a tracked file (C2). `override(kind, name)` (default never): when a skill collides with the
 *   consumer's OWN same-named skill (on disk, unmanifested, content diverges from the bundle), it's
 *   PRESERVED unless `override('skill', name)` returns true — so an install never clobbers a user asset.
 * @returns {{ devkitRef: string|null, generatedAt: string, files: Record<string,string> }} the manifest (for init to embed in its log)
 */
export function syncSkills(
  args,
  cwd,
  targets = AGENT_TARGETS,
  { skipTracked, override = () => false } = {},
) {
  const dryRun = args.includes('--dry-run');
  const targetDirs = targets.map((t) => `.${t}/skills`);
  const skillsSrc = join(packageDir(), 'skills');
  const rels = walk(skillsSrc);

  const devkitPkg = readJson(join(packageDir(), 'package.json'));
  const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;
  // The prior manifest (also reused for the idempotency check below) — its keys tell findConflicts
  // which on-disk skills devkit already OWNS (overwrite freely) vs the consumer's own (preserve).
  const manifestPath = join(cwd, '.devkit', 'skills-manifest.json');
  const prev = readJson(manifestPath);

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
  // Non-devkit collisions: a same-named skill the consumer authored (unmanifested + divergent) is
  // PRESERVED (never clobbered) unless the caller opted to override it. Preserved names join
  // skipNames → excluded from the write loop AND the manifest (devkit never claims a file it didn't write).
  for (const name of findConflicts(
    cwd,
    skillsSrc,
    [...new Set(rels.map((r) => r.split('/')[0]))],
    targetDirs,
    prev,
  )) {
    if (skipNames.has(name) || override('skill', name)) continue;
    skipNames.add(name);
    console.log(
      `  ! preserving non-devkit skill "${name}" (left untouched — re-run with --force or select it to overwrite)`,
    );
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

  // Idempotency: keep generatedAt STABLE when nothing about the synced set changed
  // (same devkitRef + same file shas), so a re-run produces no spurious git diff. (manifestPath +
  // prev were read above — reused here, also the provenance source for findConflicts.)
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

/**
 * The consumer's OWN skills that collide with a devkit-bundled name (on disk, unmanifested, content
 * diverges from the bundle) — what an interactive `devkit init` lists for the user to pick from.
 * @param {string} root git root
 * @param {string[]} [targets] surfaces to check (default both)
 * @returns {string[]} colliding skill names
 */
export function detectSkillConflicts(root, targets = AGENT_TARGETS) {
  const skillsSrc = join(packageDir(), 'skills');
  const names = [...new Set(walk(skillsSrc).map((r) => r.split('/')[0]))];
  const targetDirs = targets.map((t) => `.${t}/skills`);
  return findConflicts(
    root,
    skillsSrc,
    names,
    targetDirs,
    readJson(join(root, '.devkit', 'skills-manifest.json')),
  );
}

export const meta = {
  name: 'sync-skills',
  summary: 'Copy bundled skills into .claude/skills + .cursor/skills.',
  help: `devkit sync-skills — copy devkit's bundled skills into .claude/skills + .cursor/skills.

Usage:
  devkit sync-skills [--dry-run] [--force]

A skill the consumer authored themselves (same name, content diverges from the bundle) is PRESERVED;
pass --force to overwrite those collisions with devkit's version.
Writes .devkit/skills-manifest.json (sha256 per file) so doctor can tell which side drifted.`,
};

export default function run(args, cwd) {
  // Skills are repo-wide → target the git root (= cwd for a single-package repo). Honour the
  // recorded agent-surface choice so a manual re-sync never re-adds a deselected surface.
  const { gitRoot } = detectGitRoot(cwd);
  const cfg = readJson(join(gitRoot, '.devkit', 'config.json'));
  // --force adopts/overwrites non-devkit collisions (the standalone CLI is all-or-nothing — the
  // per-asset picker is `devkit init` interactive only).
  const override = args.includes('--force') ? () => true : undefined;
  syncSkills(args, gitRoot, cfg?.components?.agentTargets ?? AGENT_TARGETS, { override });
  return 0;
}
