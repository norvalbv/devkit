/**
 * Agent-hook INSTALLER — writes/merges the consumer's `.claude/settings.json` hooks block
 * (Claude) and mirrors to `.cursor/hooks.json` (Cursor) from the devkit hook registry
 * (hook-registrations.mjs), for the components the consumer selected.
 *
 * Idempotent + non-destructive:
 *  - merges INTO an existing settings.json, preserving the consumer's own hooks/keys;
 *  - a devkit-owned command is recognised by a marker substring, so a re-run REPLACES the
 *    devkit set (never duplicates it) and leaves foreign commands untouched;
 *  - removal strips exactly the devkit commands, leaving the consumer's intact.
 *
 * "Ship the generator, never the data": the registry is the mechanism; the consumer's
 * settings.json (their data) is merged, never clobbered.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS } from "../components.mjs";
import { packageDir, readJson, sha256, writeIfAbsent } from "../fs-helpers.mjs";
import { bundledNames, findConflicts, removeManifested, } from "../sync-manifest.mjs";
export { checkHookRegistrations, installHookRegistrations, removeHookRegistrations, } from "./hook-settings.mjs";
// Surface `<name>` (claude|cursor) → its hook-scripts dir (.claude/hooks | .cursor/hooks).
const hookDirs = (targets) => targets.map((t) => `.${t}/hooks`);
export const DECISION_EDIT_HOOK = 'decision-edit-guard.mjs';
function bundledHookNames() {
    return readdirSync(join(packageDir(), 'agents-hooks'), {
        withFileTypes: true,
    })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
}
/** The exact hook-script set implied by Devkit component selection. */
export function hookScriptsFor({ agentHooks, decisions, }) {
    const all = bundledHookNames();
    return all.filter((name) => (agentHooks && name !== DECISION_EDIT_HOOK) || (decisions && name === DECISION_EDIT_HOOK));
}
// Copy the bundled agent-hook scripts (agents-hooks/*.mjs|.sh) into the consumer's hook dirs and
// write .devkit/agent-hooks-manifest.json (per-file sha256, like skills/agents). The registrations
// reference these by path, so the scripts must be present for the hooks to resolve. Scripts are
// kept executable (chmod +x) — the .sh/.mjs are invoked directly by the agent harness.
/**
 * @param {string} root the git root
 * @param {{ dryRun?: boolean, targets?: string[], only?: string[], skipTracked?: (relPath: string) => boolean, override?: (kind: string, name: string) => boolean }} [opts]
 *   `only` (default all): sync ONLY the named hooks — incremental per-hook adoption. Throws on a name
 *   devkit doesn't ship, and carries the prior manifest forward so an `only` run ADDS to the owned set
 *   rather than shrinking it to the one hook synced. `skipTracked` (overlay-only): leaves a git-tracked
 *   hook script untouched (C2). `override(kind, name)` (default never): a hook script colliding with the
 *   consumer's OWN same-named file (on disk, unmanifested, divergent) is PRESERVED unless
 *   `override('agent-hook', name)` is true.
 */
export function syncHookScripts(root, { dryRun = false, targets = AGENT_TARGETS, only, desired, skipTracked, override = () => false, } = {}) {
    const src = join(packageDir(), 'agents-hooks');
    const dirs = hookDirs(targets);
    let rels = bundledHookNames();
    const manifestPath = join(root, '.devkit', 'agent-hooks-manifest.json');
    const prev = readJson(manifestPath);
    if (only?.length && desired)
        throw new Error('syncHookScripts: only and desired are mutually exclusive');
    if (only?.length) {
        const unknown = only.filter((n) => !rels.includes(n));
        if (unknown.length)
            throw new Error(`sync-hooks --only: devkit ships no hook named ${unknown.join(', ')}`);
        rels = rels.filter((r) => only.includes(r));
    }
    if (desired) {
        const unknown = desired.filter((name) => !rels.includes(name));
        if (unknown.length)
            throw new Error(`syncHookScripts: devkit ships no hook named ${unknown.join(', ')}`);
        rels = rels.filter((name) => desired.includes(name));
    }
    const conflicts = new Set(findConflicts(root, src, rels, targets, 'hooks', prev));
    // `only` carries the prior manifest forward (add-to-owned-set); a full sync starts clean.
    const files = only?.length ? { ...(prev?.files ?? {}) } : {};
    // Exact reconciliation removes only manifest-owned scripts that are no longer selected. Include
    // prior surfaces so a claude+cursor → claude switch cannot strand the old Cursor copy.
    if (desired) {
        const kept = new Set(rels);
        const oldNames = new Set(Object.keys(prev?.files ?? {}).map((rel) => rel.split('/')[0]));
        const cleanupTargets = new Set([...(prev?.targets ?? []), ...targets]);
        for (const name of oldNames) {
            if (kept.has(name))
                continue;
            for (const target of cleanupTargets) {
                const dest = join(root, `.${target}`, 'hooks', name);
                if (!dryRun && existsSync(dest))
                    rmSync(dest, { force: true });
            }
        }
    }
    for (const rel of rels) {
        // Overlay: a hook script git already tracks can't be hidden by .git/info/exclude → skip it (C2).
        if (skipTracked && dirs.some((d) => skipTracked(`${d}/${rel}`))) {
            console.log(`  ! skipping agent-hook "${rel}" — git-tracked (left untouched)`);
            continue;
        }
        // Non-devkit collision: leave the consumer's own hook script untouched (+ out of the manifest).
        if (conflicts.has(rel) && !override('agent-hook', rel)) {
            console.log(`  ! preserving non-devkit agent-hook "${rel}" (left untouched — re-run with --force or select it to overwrite)`);
            continue;
        }
        const content = readFileSync(join(src, rel));
        files[rel] = sha256(join(src, rel));
        if (dryRun)
            continue;
        for (const dir of dirs) {
            const dest = join(root, dir, rel);
            writeIfAbsent(dest, content, { force: true });
            chmodSync(dest, 0o755);
        }
    }
    const devkitPkg = readJson(join(packageDir(), 'package.json'));
    const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;
    const unchanged = prev && prev.devkitRef === devkitRef && JSON.stringify(prev.files) === JSON.stringify(files);
    const manifest = {
        devkitRef,
        generatedAt: unchanged && prev ? prev.generatedAt : new Date().toISOString(),
        // `targets` records WHICH surfaces devkit wrote to → surface-aware ownership in findConflicts.
        targets: [...targets],
        files,
    };
    if (dryRun) {
        console.log(`  [dry-run] sync ${rels.length} agent-hook script(s) → ${dirs.join(' + ')}`);
        return manifest;
    }
    writeIfAbsent(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        force: true,
    });
    console.log(`  ✓ synced ${rels.length} agent-hook script(s) → ${dirs.join(' + ')}`);
    return manifest;
}
/**
 * The consumer's OWN agent-hook scripts that collide with a devkit-bundled name (on disk,
 * unmanifested, divergent) — what an interactive `devkit init` lists for the user to pick from.
 * @param {string} root git root
 * @param {string[]} [targets] surfaces to check (default both)
 * @returns {string[]} colliding hook-script filenames
 */
export function detectHookConflicts(root, targets = AGENT_TARGETS, desired) {
    const src = join(packageDir(), 'agents-hooks');
    const rels = bundledHookNames().filter((name) => !desired || desired.includes(name));
    return findConflicts(root, src, rels, targets, 'hooks', readJson(join(root, '.devkit', 'agent-hooks-manifest.json')));
}
/**
 * Remove the synced agent-hook scripts (per manifest) from the given surfaces' hook dirs.
 * `dropManifest` (default true) also deletes the manifest — pass false when pruning ONE surface
 * while the other still holds tracked scripts (a both → single-surface switch).
 *
 * @param {string} root the git root
 * @param {{ dryRun?: boolean, targets?: string[], dropManifest?: boolean }} [opts]
 */
export function removeHookScripts(root, { dryRun = false, targets = AGENT_TARGETS, dropManifest = true } = {}) {
    // Hook scripts are flat files in <surface>/hooks — the same teardown removeManifested does for
    // skills/agents (manifest names, or the bundled set as fallback, tracked-safe on the fallback).
    removeManifested(root, 'agent-hooks-manifest.json', hookDirs(targets), 'agent-hook script', dryRun, dropManifest, bundledNames('agents-hooks', (e) => e.isFile()), join(packageDir(), 'agents-hooks'));
}
