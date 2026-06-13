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
import { packageDir, readJson, sha256, writeIfAbsent } from '../lib/fs-helpers.mjs';

const TARGET_DIRS = ['.claude/skills', '.cursor/skills'];

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
 * @returns {{ devkitRef: string|null, generatedAt: string, files: Record<string,string> }} the manifest (for init to embed in its log)
 */
export function syncSkills(args, cwd) {
  const dryRun = args.includes('--dry-run');
  const skillsSrc = join(packageDir(), 'skills');
  const rels = walk(skillsSrc);

  const devkitPkg = readJson(join(packageDir(), 'package.json'));
  const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;

  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of rels) {
    const srcPath = join(skillsSrc, rel);
    const content = readFileSync(srcPath);
    files[rel] = sha256(srcPath);

    for (const target of TARGET_DIRS) {
      const destPath = join(cwd, target, rel);
      if (dryRun) {
        console.log(`  [dry-run] write ${target}/${rel}`);
      } else {
        // Skills are devkit-owned: always overwrite so a tag bump propagates the latest.
        writeIfAbsent(destPath, content, { force: true });
      }
    }
  }

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
    console.log(`  ✓ synced ${rels.length} skill file(s) → .claude/skills + .cursor/skills`);
  }

  return manifest;
}

export default function run(args, cwd) {
  syncSkills(args, cwd);
  return 0;
}
