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
import { agentSurfaceDir, DEFAULT_AGENT_TARGETS } from '../../lib/components.mts';
import { detectGitRoot } from '../../lib/detect-git-root.mts';
import { packageDir, readJson, sha256, writeIfAbsent } from '../../lib/fs-helpers.mts';
import { findConflicts, type SyncManifest } from '../../lib/sync-manifest.mts';

// The manifest devkit writes for a synced asset set: the SyncManifest ownership shape (files +
// targets) plus the provenance fields (which devkit tag wrote it, and when).
interface AssetManifest extends SyncManifest {
  devkitRef: string | null;
  generatedAt: string;
}

// The relevant slice of `.devkit/config.json` this command reads.
interface DevkitConfig {
  components?: { agentTargets?: string[] };
}

// Agents are a flat set of `.md` files (no nested references/ like skills) — a single readdir.
function listAgents(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name);
}

interface SyncOpts {
  skipTracked?: (relPath: string) => boolean;
  override?: (kind: string, name: string) => boolean;
}

/**
 * Sync devkit's bundled agents into the consumer's agent surfaces + write the manifest.
 *
 * `cwd` is the consumer root (the git root — agents are repo-wide, like skills). `targets` are the
 * agent surfaces to write to (default both — see AGENT_TARGETS).
 *
 * `skipTracked` (overlay-only): an agent `.md` git already TRACKS in any target is skipped (not
 * written, not manifested, warned) — C2. `override(kind, name)` (default never): an agent that
 * collides with the consumer's OWN same-named file (on disk, unmanifested, divergent) is PRESERVED
 * unless `override('agent', name)` is true — so an install never clobbers a user asset.
 *
 * Returns the manifest (for init to embed in its log).
 */
export function syncAgents(
  args: string[],
  cwd: string,
  targets: string[] = DEFAULT_AGENT_TARGETS,
  { skipTracked, override = () => false }: SyncOpts = {},
): AssetManifest {
  const dryRun = args.includes('--dry-run');
  const targetDirs = targets.map((t) => agentSurfaceDir(t, 'agents'));
  const agentsSrc = join(packageDir(), 'agents');
  const rels = listAgents(agentsSrc);

  const devkitPkg: { version?: string } | null = readJson(join(packageDir(), 'package.json'));
  const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;
  // The prior manifest (reused for the idempotency check) — its keys are the provenance source for
  // findConflicts: a same-named agent the consumer authored (unmanifested + divergent) is PRESERVED.
  const manifestPath = join(cwd, '.devkit', 'agents-manifest.json');
  const prev: AssetManifest | null = readJson(manifestPath);
  const conflicts = new Set(findConflicts(cwd, agentsSrc, rels, targets, 'agents', prev));

  const files: Record<string, string> = {};
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
  const generatedAt = unchanged && prev ? prev.generatedAt : new Date().toISOString();
  // `targets` records WHICH surfaces devkit wrote to → surface-aware ownership in findConflicts.
  const manifest = { devkitRef, generatedAt, targets: [...targets], files };

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
 * — what an interactive `devkit init` lists for the user to pick from. `root` is the git root;
 * `targets` are the surfaces to check (default both). Returns colliding agent filenames.
 */
export function detectAgentConflicts(
  root: string,
  targets: string[] = DEFAULT_AGENT_TARGETS,
): string[] {
  const agentsSrc = join(packageDir(), 'agents');
  return findConflicts(
    root,
    agentsSrc,
    listAgents(agentsSrc),
    targets,
    'agents',
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

export default function run(args: string[], cwd: string): number {
  // Agents are repo-wide → target the git root (= cwd for a single-package repo). Honour the
  // recorded agent-surface choice so a manual re-sync never re-adds a deselected surface.
  const { gitRoot } = detectGitRoot(cwd);
  const cfg: DevkitConfig | null = readJson(join(gitRoot, '.devkit', 'config.json'));
  const override = args.includes('--force') ? () => true : undefined;
  syncAgents(args, gitRoot, cfg?.components?.agentTargets ?? DEFAULT_AGENT_TARGETS, { override });
  return 0;
}
