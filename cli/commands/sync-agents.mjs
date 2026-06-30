/**
 * `devkit sync-agents` — copy devkit's bundled agent definitions (agents/*.md) into the
 * consumer's .claude/agents + .cursor/agents trees. Parallel to `sync-skills`: agents ship
 * INSIDE the package (same repo, same tag as the gate-engine an agent's review skill drives),
 * so the source is always devkit's own packageDir()/agents, never a network fetch.
 *
 * Writes .devkit/agents-manifest.json with a sha256 per file so `doctor` can tell which side
 * (consumer copy vs devkit source) drifted — exactly the skills-manifest contract.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS } from '../lib/components.mjs';
import { detectGitRoot } from '../lib/detect-git-root.mjs';
import { packageDir, readJson, sha256, writeIfAbsent } from '../lib/fs-helpers.mjs';
import { findConflicts } from '../lib/sync-manifest.mjs';

// Agents are a flat set of `.md` files (no nested references/ like skills) — a single readdir.
function listAgents(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name);
}

/**
 * @param {string[]} args
 * @param {string} cwd consumer root (the git root — agents are repo-wide, like skills)
 * @param {string[]} [targets] agent surfaces to write to (default both — see AGENT_TARGETS)
 * @param {{ skipTracked?: (relPath: string) => boolean, override?: (kind: string, name: string) => boolean }} [opts]
 *   `skipTracked` (overlay-only): an agent `.md` git already TRACKS in any target is skipped (not
 *   written, not manifested, warned) — C2. `override(kind, name)` (default never): an agent that
 *   collides with the consumer's OWN same-named file (on disk, unmanifested, divergent) is PRESERVED
 *   unless `override('agent', name)` is true — so an install never clobbers a user asset.
 * @returns {{ devkitRef: string|null, generatedAt: string, files: Record<string,string> }} the manifest
 */
export function syncAgents(
  args,
  cwd,
  targets = AGENT_TARGETS,
  { skipTracked, override = () => false } = {},
) {
  const dryRun = args.includes('--dry-run');
  const targetDirs = targets.map((t) => `.${t}/agents`);
  const agentsSrc = join(packageDir(), 'agents');
  const rels = listAgents(agentsSrc);

  const devkitPkg = readJson(join(packageDir(), 'package.json'));
  const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;
  // The prior manifest (reused for the idempotency check) — its keys are the provenance source for
  // findConflicts: a same-named agent the consumer authored (unmanifested + divergent) is PRESERVED.
  const manifestPath = join(cwd, '.devkit', 'agents-manifest.json');
  const prev = readJson(manifestPath);
  const conflicts = new Set(findConflicts(cwd, agentsSrc, rels, targetDirs, prev));

  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of rels) {
    if (skipTracked && targetDirs.some((td) => skipTracked(`${td}/${rel}`))) {
      console.log(`  ! skipping agent "${rel}" — git-tracked in the repo (left untouched)`);
      continue;
    }
    // Non-devkit collision: leave the consumer's own agent untouched (and out of the manifest)
    // unless the caller opted to override it.
    if (conflicts.has(rel) && !override('agent', rel)) {
      console.log(
        `  ! preserving non-devkit agent "${rel}" (left untouched — re-run with --force or select it to overwrite)`,
      );
      continue;
    }
    // Reason: sync-agents and sync-skills are deliberately parallel modules (see headers "Parallel to …"): identical write+manifest mechanics to different dirs. One shared abstraction over two short readable commands would obscure both; the parallelism IS the design.
    // fallow-ignore-next-line code-duplication
    const srcPath = join(agentsSrc, rel);
    const content = readFileSync(srcPath);
    files[rel] = sha256(srcPath);

    for (const target of targetDirs) {
      const destPath = join(cwd, target, rel);
      if (dryRun) {
        console.log(`  [dry-run] write ${target}/${rel}`);
      } else {
        // Agents are devkit-owned: always overwrite so a tag bump propagates the latest.
        writeIfAbsent(destPath, content, { force: true });
      }
    }
  }

  // Idempotency: keep generatedAt STABLE when nothing about the synced set changed, so a re-run
  // produces no spurious git diff (same contract as the skills manifest). (manifestPath + prev were
  // read above — reused here, also the provenance source for findConflicts.)
  const unchanged =
    prev && prev.devkitRef === devkitRef && JSON.stringify(prev.files) === JSON.stringify(files);
  const generatedAt = unchanged ? prev.generatedAt : new Date().toISOString();
  const manifest = { devkitRef, generatedAt, files };

  if (dryRun) {
    console.log(`  [dry-run] write .devkit/agents-manifest.json (${rels.length} files)`);
  } else {
    writeIfAbsent(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { force: true });
    console.log(`  ✓ synced ${rels.length} agent file(s) → ${targetDirs.join(' + ')}`);
  }

  return manifest;
}

/**
 * The consumer's OWN agents that collide with a devkit-bundled name (on disk, unmanifested, divergent)
 * — what an interactive `devkit init` lists for the user to pick from.
 * @param {string} root git root
 * @param {string[]} [targets] surfaces to check (default both)
 * @returns {string[]} colliding agent filenames
 */
export function detectAgentConflicts(root, targets = AGENT_TARGETS) {
  const agentsSrc = join(packageDir(), 'agents');
  const targetDirs = targets.map((t) => `.${t}/agents`);
  return findConflicts(
    root,
    agentsSrc,
    listAgents(agentsSrc),
    targetDirs,
    readJson(join(root, '.devkit', 'agents-manifest.json')),
  );
}

export const meta = {
  name: 'sync-agents',
  summary: 'Copy review/testing agents into .claude + .cursor.',
  help: `devkit sync-agents — copy devkit's review/testing agents into .claude/agents + .cursor/agents.

Usage:
  devkit sync-agents [--dry-run] [--force]

An agent the consumer authored themselves (same name, content diverges from the bundle) is PRESERVED;
pass --force to overwrite those collisions with devkit's version.
Writes .devkit/agents-manifest.json (sha256 per file) so doctor can tell which side drifted.`,
};

export default function run(args, cwd) {
  // Agents are repo-wide → target the git root (= cwd for a single-package repo). Honour the
  // recorded agent-surface choice so a manual re-sync never re-adds a deselected surface.
  const { gitRoot } = detectGitRoot(cwd);
  const cfg = readJson(join(gitRoot, '.devkit', 'config.json'));
  const override = args.includes('--force') ? () => true : undefined;
  syncAgents(args, gitRoot, cfg?.components?.agentTargets ?? AGENT_TARGETS, { override });
  return 0;
}
