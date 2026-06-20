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
 * @returns {{ devkitRef: string|null, generatedAt: string, files: Record<string,string> }} the manifest
 */
export function syncAgents(args, cwd, targets = AGENT_TARGETS) {
  const dryRun = args.includes('--dry-run');
  const targetDirs = targets.map((t) => `.${t}/agents`);
  const agentsSrc = join(packageDir(), 'agents');
  const rels = listAgents(agentsSrc);

  const devkitPkg = readJson(join(packageDir(), 'package.json'));
  const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;

  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of rels) {
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

  const manifestPath = join(cwd, '.devkit', 'agents-manifest.json');
  // Idempotency: keep generatedAt STABLE when nothing about the synced set changed, so a
  // re-run produces no spurious git diff (same contract as the skills manifest).
  const prev = readJson(manifestPath);
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

export default function run(args, cwd) {
  // Agents are repo-wide → target the git root (= cwd for a single-package repo). Honour the
  // recorded agent-surface choice so a manual re-sync never re-adds a deselected surface.
  const { gitRoot } = detectGitRoot(cwd);
  const cfg = readJson(join(gitRoot, '.devkit', 'config.json'));
  syncAgents(args, gitRoot, cfg?.components?.agentTargets ?? AGENT_TARGETS);
  return 0;
}
