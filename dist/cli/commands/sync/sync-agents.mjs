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
import { AGENT_TARGETS } from "../../lib/components.mjs";
import { detectGitRoot } from "../../lib/detect-git-root.mjs";
import { packageDir, readJson, sha256, writeIfAbsent } from "../../lib/fs-helpers.mjs";
import { assertLegacyAssetWriterCompatible, nextLegacyManifestGeneratedAt, } from "../../lib/install/agent-asset-manifest/compatibility.mjs";
import { findProviderNativeAssetConflicts, requiresProviderNativeLifecycle, syncProviderNativeAssets, withAgentAssetLifecycleLock, } from "../../lib/install/agent-asset-manifest/lifecycle.mjs";
import { readAgentAssetManifest } from "../../lib/install/agent-asset-manifest/reader.mjs";
import { agentAssetDir } from "../../lib/install/agent-assets.mjs";
import { resolveExistingAgentProviders } from "../../lib/install/agent-providers.mjs";
import { findConflicts } from "../../lib/sync-manifest.mjs";
// Agents are a flat set of `.md` files (no nested references/ like skills) — a single readdir.
function listAgents(dir) {
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name);
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
export function syncAgents(args, cwd, targets = AGENT_TARGETS, { skipTracked, override = () => false } = {}) {
    const dryRun = args.includes('--dry-run');
    return withAgentAssetLifecycleLock(cwd, dryRun, () => syncAgentsLocked(args, cwd, targets, { skipTracked, override }));
}
function syncAgentsLocked(args, cwd, targets, { skipTracked, override = () => false }) {
    const dryRun = args.includes('--dry-run');
    const targetDirs = targets.map((t) => `.${t}/agents`);
    const agentsSrc = join(packageDir(), 'agents');
    const rels = listAgents(agentsSrc);
    const devkitPkg = readJson(join(packageDir(), 'package.json'));
    const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;
    // The prior manifest (reused for the idempotency check) — its keys are the provenance source for
    // findConflicts: a same-named agent the consumer authored (unmanifested + divergent) is PRESERVED.
    const manifestPath = join(cwd, '.devkit', 'agents-manifest.json');
    const decoded = readAgentAssetManifest(manifestPath, 'agents');
    if (requiresProviderNativeLifecycle(decoded, targets)) {
        const result = syncProviderNativeAssets({
            root: cwd,
            kind: 'agents',
            sources: rels.map((logicalRel) => ({
                logicalRel,
                content: readFileSync(join(agentsSrc, logicalRel)),
            })),
            targets,
            devkitRef,
            dryRun,
            skipTracked,
            override,
        });
        const reported = new Set();
        for (const skip of result.skips) {
            if (reported.has(skip.unit))
                continue;
            reported.add(skip.unit);
            console.log(skip.reason === 'tracked'
                ? `  ! skipping agent "${skip.unit}" — git-tracked in the repo (left untouched)`
                : `  ! preserving non-devkit agent "${skip.unit}" (left untouched — re-run with --force or select it to overwrite)`);
        }
        if (dryRun) {
            for (const outputPath of result.outputPaths)
                console.log(`  [dry-run] write ${outputPath}`);
            console.log(`  [dry-run] write .devkit/agents-manifest.json (${rels.length} files)`);
        }
        else {
            const dirs = targets.map((target) => agentAssetDir(target, 'agents'));
            console.log(`  ✓ synced ${Object.keys(result.manifest.files).length} agent file(s) → ${dirs.join(' + ')}`);
        }
        return result.manifest;
    }
    assertLegacyAssetWriterCompatible(decoded, targets, 'agents');
    const prev = decoded?.manifest ?? null;
    const conflicts = new Set(findConflicts(cwd, agentsSrc, rels, targets, 'agents', prev));
    const files = {};
    for (const rel of rels) {
        if (skipTracked && targetDirs.some((td) => skipTracked(`${td}/${rel}`))) {
            console.log(`  ! skipping agent "${rel}" — git-tracked in the repo (left untouched)`);
            continue;
        }
        // Non-devkit collision: leave the consumer's own agent untouched (and out of the manifest)
        // unless the caller opted to override it.
        if (conflicts.has(rel) && !override('agent', rel)) {
            console.log(`  ! preserving non-devkit agent "${rel}" (left untouched — re-run with --force or select it to overwrite)`);
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
            }
            else {
                // Agents are devkit-owned: always overwrite so a tag bump propagates the latest.
                writeIfAbsent(destPath, content, { force: true });
            }
        }
    }
    // Idempotency: keep generatedAt STABLE when nothing about the synced set changed, so a re-run
    // produces no spurious git diff (same contract as the skills manifest). (manifestPath + prev were
    // read above — reused here, also the provenance source for findConflicts.)
    const generatedAt = nextLegacyManifestGeneratedAt(prev, devkitRef, files);
    // `targets` records WHICH surfaces devkit wrote to → surface-aware ownership in findConflicts.
    const manifest = { devkitRef, generatedAt, targets: [...targets], files };
    if (dryRun) {
        console.log(`  [dry-run] write .devkit/agents-manifest.json (${rels.length} files)`);
    }
    else {
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
export function detectAgentConflicts(root, targets = AGENT_TARGETS) {
    const agentsSrc = join(packageDir(), 'agents');
    const decoded = readAgentAssetManifest(join(root, '.devkit', 'agents-manifest.json'), 'agents');
    if (requiresProviderNativeLifecycle(decoded, targets)) {
        return [
            ...new Set(findProviderNativeAssetConflicts({
                root,
                kind: 'agents',
                sources: listAgents(agentsSrc).map((logicalRel) => ({
                    logicalRel,
                    content: readFileSync(join(agentsSrc, logicalRel)),
                })),
                targets,
            })
                .filter((conflict) => conflict.reason !== 'tracked')
                .map((conflict) => conflict.unit)),
        ];
    }
    assertLegacyAssetWriterCompatible(decoded, targets, 'agents');
    return findConflicts(root, agentsSrc, listAgents(agentsSrc), targets, 'agents', decoded?.manifest ?? null);
}
export const meta = {
    name: 'sync-agents',
    summary: 'Copy review/testing agents into selected agent providers.',
    help: `devkit sync-agents — copy devkit's review/testing agents into Claude, Codex, and Cursor.

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
    // Config is package-local in a monorepo even though agent assets are repo-wide.
    const cfg = readJson(join(cwd, '.devkit', 'config.json'));
    const override = args.includes('--force') ? () => true : undefined;
    const targets = cfg
        ? resolveExistingAgentProviders(gitRoot, cfg.components?.agentTargets, ['agents'])
        : AGENT_TARGETS;
    syncAgents(args, gitRoot, targets, { override });
    return 0;
}
