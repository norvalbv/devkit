/**
 * `devkit sync-skills` — copy devkit's bundled skills into the consumer's .claude/skills
 * and .cursor/skills trees, recursively (SKILL.md + references/ + scripts/). Replaces the
 * `npx skills add` flow (buggy for private repos): skills ship INSIDE the package, so the
 * source is always devkit's own packageDir()/skills, never a network fetch.
 *
 * Writes .devkit/skills-manifest.json with a sha256 per file so `doctor` can tell which
 * side (consumer copy vs devkit source) drifted.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AGENT_TARGETS } from '../../lib/components.mts';
import { detectGitRoot } from '../../lib/detect-git-root.mts';
import { packageDir, readJson, sha256, writeIfAbsent } from '../../lib/fs-helpers.mts';
import type { SyncManifestV2 } from '../../lib/install/agent-asset-manifest/codec.mts';
import {
  assertLegacyAssetWriterCompatible,
  nextLegacyManifestGeneratedAt,
} from '../../lib/install/agent-asset-manifest/compatibility.mts';
import {
  findProviderNativeAssetConflicts,
  requiresProviderNativeLifecycle,
  syncProviderNativeAssets,
  withAgentAssetLifecycleLock,
} from '../../lib/install/agent-asset-manifest/lifecycle.mts';
import { readAgentAssetManifest } from '../../lib/install/agent-asset-manifest/reader.mts';
import { agentAssetDir } from '../../lib/install/agent-assets.mts';
import { resolveExistingAgentProviders } from '../../lib/install/agent-providers.mts';
import { findConflicts, type SyncManifest } from '../../lib/sync-manifest.mts';

// The manifest devkit writes for a synced asset set: the SyncManifest ownership shape (files +
// targets) plus the provenance fields (which devkit tag wrote it, and when).
interface LegacyAssetManifest extends SyncManifest {
  devkitRef: string | null;
  generatedAt: string;
}
type AssetManifest = LegacyAssetManifest | SyncManifestV2;

// The relevant slice of `.devkit/config.json` this command reads.
interface DevkitConfig {
  components?: { agentTargets?: string[]; guards?: string[] };
}

// Recursively list every file under `dir`, returned as paths relative to `dir`.
function walk(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

interface SyncOpts {
  skipTracked?: (relPath: string) => boolean;
  override?: (kind: string, name: string) => boolean;
  guards?: string[];
}

export function skillNamesForGuards(allNames: string[], guards: string[] = []): string[] {
  return allNames.filter((name) => name !== 'decisions' || guards.includes('decisions'));
}

/**
 * Sync devkit's bundled skills into the consumer's agent surfaces + write the manifest.
 *
 * `cwd` is the consumer root. `targets` are the agent surfaces to write to (default both — see
 * AGENT_TARGETS).
 *
 * `skipTracked` (overlay-only): a skill `<name>/` whose dir git already TRACKS in any target is
 * skipped wholesale (not written, not manifested, warned) — `.git/info/exclude` can't hide an edit
 * to a tracked file (C2). `override(kind, name)` (default never): when a skill collides with the
 * consumer's OWN same-named skill (on disk, unmanifested, content diverges from the bundle), it's
 * PRESERVED unless `override('skill', name)` returns true — so an install never clobbers a user asset.
 *
 * Returns the manifest (for init to embed in its log).
 */
export function syncSkills(
  args: string[],
  cwd: string,
  targets: string[] = AGENT_TARGETS,
  { skipTracked, override = () => false, guards = [] }: SyncOpts = {},
): AssetManifest {
  const dryRun = args.includes('--dry-run');
  return withAgentAssetLifecycleLock(cwd, dryRun, () =>
    syncSkillsLocked(args, cwd, targets, { skipTracked, override, guards }),
  );
}

function syncSkillsLocked(
  args: string[],
  cwd: string,
  targets: string[],
  { skipTracked, override = () => false, guards = [] }: SyncOpts,
): AssetManifest {
  const dryRun = args.includes('--dry-run');
  const targetDirs = targets.map((t) => `.${t}/skills`);
  const skillsSrc = join(packageDir(), 'skills');
  const allRels = walk(skillsSrc);
  const selectedNames = new Set(
    skillNamesForGuards([...new Set(allRels.map((rel) => rel.split('/')[0]))], guards),
  );
  const rels = allRels.filter((rel) => selectedNames.has(rel.split('/')[0]));

  const devkitPkg: { version?: string } | null = readJson(join(packageDir(), 'package.json'));
  const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;
  // The prior manifest (also reused for the idempotency check below) — its keys tell findConflicts
  // which on-disk skills devkit already OWNS (overwrite freely) vs the consumer's own (preserve).
  const manifestPath = join(cwd, '.devkit', 'skills-manifest.json');
  const decoded = readAgentAssetManifest(manifestPath, 'skills');
  if (requiresProviderNativeLifecycle(decoded, targets)) {
    const result = syncProviderNativeAssets({
      root: cwd,
      kind: 'skills',
      sources: rels.map((logicalRel) => ({
        logicalRel,
        content: readFileSync(join(skillsSrc, logicalRel)),
      })),
      targets,
      devkitRef,
      dryRun,
      skipTracked,
      override,
    });
    const reported = new Set<string>();
    for (const skip of result.skips) {
      if (reported.has(skip.unit)) continue;
      reported.add(skip.unit);
      console.log(
        skip.reason === 'tracked'
          ? `  ! skipping skill "${skip.unit}" — git-tracked in the repo (left untouched)`
          : `  ! preserving non-devkit skill "${skip.unit}" (left untouched — re-run with --force or select it to overwrite)`,
      );
    }
    if (dryRun) {
      for (const outputPath of result.outputPaths) console.log(`  [dry-run] write ${outputPath}`);
      console.log(`  [dry-run] write .devkit/skills-manifest.json (${rels.length} files)`);
    } else {
      const dirs = targets.map((target) => agentAssetDir(target, 'skills'));
      console.log(
        `  ✓ synced ${Object.keys(result.manifest.files).length} skill file(s) → ${dirs.join(' + ')}`,
      );
    }
    return result.manifest;
  }
  assertLegacyAssetWriterCompatible(decoded, targets, 'skills');
  const prev = decoded?.manifest ?? null;

  // Guard-aware exact reconciliation: only remove skill dirs that the previous manifest proves
  // Devkit owned. A consumer-authored, unmanifested `decisions` collision remains untouched.
  const previousNames = new Set(Object.keys(prev?.files ?? {}).map((rel) => rel.split('/')[0]));
  const cleanupTargets = new Set([...(prev?.targets ?? []), ...targets]);
  for (const name of previousNames) {
    if (selectedNames.has(name)) continue;
    for (const target of cleanupTargets) {
      const dir = join(cwd, `.${target}`, 'skills', name);
      if (!dryRun && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }

  // Tracked-skip is per-skill `<name>/` (the unit devkit owns + clean removes): if any target's
  // `.<surface>/skills/<name>` is git-tracked, the whole skill is left untouched.
  const skipNames = new Set<string>();
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
    targets,
    'skills',
    prev,
  )) {
    if (skipNames.has(name) || override('skill', name)) continue;
    skipNames.add(name);
    console.log(
      `  ! preserving non-devkit skill "${name}" (left untouched — re-run with --force or select it to overwrite)`,
    );
  }

  const files: Record<string, string> = {};
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
  const generatedAt = nextLegacyManifestGeneratedAt(prev, devkitRef, files);
  // `targets` records WHICH surfaces devkit wrote to, so findConflicts can tell a name it owns on
  // one surface from a same-named divergent asset on another (surface-aware ownership).
  const manifest = { devkitRef, generatedAt, targets: [...targets], files };

  if (dryRun) {
    console.log(`  [dry-run] write .devkit/skills-manifest.json (${rels.length} files)`);
  } else {
    writeIfAbsent(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      force: true,
    });
    console.log(`  ✓ synced ${rels.length} skill file(s) → ${targetDirs.join(' + ')}`);
  }

  return manifest;
}

/**
 * The consumer's OWN skills that collide with a devkit-bundled name (on disk, unmanifested, content
 * diverges from the bundle) — what an interactive `devkit init` lists for the user to pick from.
 * `root` is the git root; `targets` are the surfaces to check (default both). Returns colliding
 * skill names.
 */
export function detectSkillConflicts(
  root: string,
  targets: string[] = AGENT_TARGETS,
  guards: string[] = [],
): string[] {
  const skillsSrc = join(packageDir(), 'skills');
  const names = skillNamesForGuards(
    [...new Set(walk(skillsSrc).map((r) => r.split('/')[0]))],
    guards,
  );
  const decoded = readAgentAssetManifest(join(root, '.devkit', 'skills-manifest.json'), 'skills');
  if (requiresProviderNativeLifecycle(decoded, targets)) {
    return [
      ...new Set(
        findProviderNativeAssetConflicts({
          root,
          kind: 'skills',
          sources: walk(skillsSrc)
            .filter((logicalRel) => names.includes(logicalRel.split('/')[0]))
            .map((logicalRel) => ({
              logicalRel,
              content: readFileSync(join(skillsSrc, logicalRel)),
            })),
          targets,
        })
          .filter((conflict) => conflict.reason !== 'tracked')
          .map((conflict) => conflict.unit),
      ),
    ];
  }
  assertLegacyAssetWriterCompatible(decoded, targets, 'skills');
  return findConflicts(root, skillsSrc, names, targets, 'skills', decoded?.manifest ?? null);
}

export const meta = {
  name: 'sync-skills',
  summary: 'Copy bundled skills into selected agent providers.',
  help: `devkit sync-skills — copy devkit's bundled skills into Claude, Codex, and Cursor.

Usage:
  devkit sync-skills [--dry-run] [--force]

A skill the consumer authored themselves (same name, content diverges from the bundle) is PRESERVED;
pass --force to overwrite those collisions with devkit's version.
Writes .devkit/skills-manifest.json (sha256 per file) so doctor can tell which side drifted.`,
};

export default function run(args: string[], cwd: string): number {
  // Skills are repo-wide → target the git root (= cwd for a single-package repo). Honour the
  // recorded agent-surface choice so a manual re-sync never re-adds a deselected surface.
  const { gitRoot } = detectGitRoot(cwd);
  // Config is package-local in a monorepo even though agent assets are repo-wide.
  const cfg: DevkitConfig | null = readJson(join(cwd, '.devkit', 'config.json'));
  // --force adopts/overwrites non-devkit collisions (the standalone CLI is all-or-nothing — the
  // per-asset picker is `devkit init` interactive only).
  const override = args.includes('--force') ? () => true : undefined;
  const targets = cfg
    ? resolveExistingAgentProviders(gitRoot, cfg.components?.agentTargets, ['skills'])
    : AGENT_TARGETS;
  syncSkills(args, gitRoot, targets, {
    override,
    guards: cfg?.components?.guards ?? [],
  });
  return 0;
}
