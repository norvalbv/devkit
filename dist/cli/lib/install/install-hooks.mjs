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
import { assertLegacyAssetWriterCompatible, nextLegacyManifestGeneratedAt, } from "./agent-asset-manifest/compatibility.mjs";
import { findProviderNativeAssetConflicts, isSafeAgentAssetPath, removeProviderNativeAssets, requiresProviderNativeLifecycle, syncProviderNativeAssets, } from "./agent-asset-manifest/lifecycle.mjs";
import { readAgentAssetManifest } from "./agent-asset-manifest/reader.mjs";
import { agentAssetDir } from "./agent-assets.mjs";
import { LEGACY_AGENT_PROVIDERS, requireAgentProviders } from "./agent-providers.mjs";
import { HOOK_REGISTRATION_LEDGER_REL, hookRegistrationDestination, } from "./hook-registration-ledger/codec.mjs";
import { adopt, adoptExactLegacy, ledgerOf, ownedKey, providerDocument, publishPlan, release, skipProvider, } from "./hook-registration-ledger/install-support.mjs";
import { checkProjectedHookRegistrations, installProjectedHookRegistrations, projectHookRegistrations, readHookRegistrationLedger, removeLedgerAuthorizedHookRegistrations, transferHookRegistrationScope, withAgentAssetLifecycleLock, } from "./hook-registration-ledger/lifecycle.mjs";
import { HOOK_REGISTRATIONS } from "./hook-registration-ledger/registrations.mjs";
const hookDirs = (targets) => targets.map((target) => agentAssetDir(target, 'hooks'));
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
    return withAgentAssetLifecycleLock(root, dryRun, () => {
        const src = join(packageDir(), 'agents-hooks');
        const dirs = hookDirs(targets);
        let rels = readdirSync(src, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => e.name);
        const manifestPath = join(root, '.devkit', 'agent-hooks-manifest.json');
        const decoded = readAgentAssetManifest(manifestPath, 'hooks');
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
        const devkitPkg = readJson(join(packageDir(), 'package.json'));
        const devkitRef = devkitPkg ? `v${devkitPkg.version}` : null;
        if (requiresProviderNativeLifecycle(decoded, targets)) {
            const result = syncProviderNativeAssets({
                root,
                kind: 'hooks',
                manifestFilename: 'agent-hooks-manifest.json',
                sources: rels.map((logicalRel) => ({
                    logicalRel,
                    content: readFileSync(join(src, logicalRel)),
                })),
                targets,
                devkitRef,
                dryRun,
                skipTracked,
                override,
                retainUnspecified: Boolean(only?.length),
                fileMode: 0o755,
            });
            const reported = new Set();
            for (const skip of result.skips) {
                if (reported.has(skip.unit))
                    continue;
                reported.add(skip.unit);
                console.log(skip.reason === 'tracked'
                    ? `  ! skipping agent-hook "${skip.unit}" — git-tracked (left untouched)`
                    : `  ! preserving non-devkit agent-hook "${skip.unit}" (left untouched — re-run with --force or select it to overwrite)`);
            }
            console.log(`  ${dryRun ? '[dry-run] sync' : '✓ synced'} ${rels.length} agent-hook script(s) → ${hookDirs(targets).join(' + ')}`);
            return result.manifest;
        }
        assertLegacyAssetWriterCompatible(decoded, targets, 'hooks');
        const prev = decoded?.manifest ?? null;
        const conflicts = new Set(findConflicts(root, src, rels, targets, 'hooks', prev));
        const files = only?.length ? { ...(prev?.files ?? {}) } : {};
        if (desired) {
            const kept = new Set(rels);
            const oldNames = new Set(Object.keys(prev?.files ?? {}).map((rel) => rel.split('/')[0]));
            const cleanupTargets = new Set([...(prev?.targets ?? []), ...targets]);
            for (const name of oldNames) {
                if (kept.has(name))
                    continue;
                for (const target of cleanupTargets) {
                    const dest = join(root, agentAssetDir(target, 'hooks'), name);
                    if (!dryRun && existsSync(dest))
                        rmSync(dest, { force: true });
                }
            }
        }
        for (const rel of rels) {
            if (skipTracked && dirs.some((d) => skipTracked(`${d}/${rel}`))) {
                console.log(`  ! skipping agent-hook "${rel}" — git-tracked (left untouched)`);
                continue;
            }
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
        const generatedAt = nextLegacyManifestGeneratedAt(prev, devkitRef, files);
        const manifest = {
            devkitRef,
            generatedAt,
            targets: [...targets],
            files,
        };
        if (dryRun) {
            console.log(`  [dry-run] sync ${rels.length} agent-hook script(s) → ${dirs.join(' + ')}`);
            return manifest;
        }
        writeIfAbsent(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { force: true });
        console.log(`  ✓ synced ${rels.length} agent-hook script(s) → ${dirs.join(' + ')}`);
        return manifest;
    });
}
/**
 * The consumer's OWN agent-hook scripts that collide with a devkit-bundled name.
 */
export function detectHookConflicts(root, targets = AGENT_TARGETS, desired) {
    const src = join(packageDir(), 'agents-hooks');
    const rels = bundledHookNames().filter((name) => !desired || desired.includes(name));
    const decoded = readAgentAssetManifest(join(root, '.devkit', 'agent-hooks-manifest.json'), 'hooks');
    if (requiresProviderNativeLifecycle(decoded, targets)) {
        return [
            ...new Set(findProviderNativeAssetConflicts({
                root,
                kind: 'hooks',
                manifestFilename: 'agent-hooks-manifest.json',
                sources: rels.map((logicalRel) => ({
                    logicalRel,
                    content: readFileSync(join(src, logicalRel)),
                })),
                targets,
            })
                .filter((conflict) => conflict.reason !== 'tracked')
                .map((conflict) => conflict.unit)),
        ];
    }
    assertLegacyAssetWriterCompatible(decoded, targets, 'hooks');
    return findConflicts(root, src, rels, targets, 'hooks', decoded?.manifest ?? null);
}
export function removeHookScripts(root, { dryRun = false, targets, dropManifest = true, skipTracked } = {}) {
    withAgentAssetLifecycleLock(root, dryRun, () => {
        const native = removeProviderNativeAssets({
            root,
            kind: 'hooks',
            targets,
            dryRun,
            dropManifest,
            skipTracked,
        });
        if (native.handled) {
            console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${native.removed.length} synced agent-hook script(s)${dropManifest ? ' + manifest' : ''}`);
            return;
        }
        const decoded = readAgentAssetManifest(join(root, '.devkit', 'agent-hooks-manifest.json'), 'hooks');
        const inferredTargets = decoded?.version === 1 ? decoded.manifest.targets : [...LEGACY_AGENT_PROVIDERS];
        const legacyTargets = (targets ?? inferredTargets).filter((target) => LEGACY_AGENT_PROVIDERS.includes(target));
        if (!legacyTargets.length)
            return;
        removeManifested(root, 'agent-hooks-manifest.json', hookDirs(legacyTargets), 'agent-hook script', dryRun, dropManifest, bundledNames('agents-hooks', (e) => e.isFile()), join(packageDir(), 'agents-hooks'), skipTracked);
    });
}
export function installHookRegistrations(root, componentIds, { dryRun = false, targets = AGENT_TARGETS, overlay = false, legacyOwnedComponentIds, } = {}) {
    if (!componentIds.some((id) => HOOK_REGISTRATIONS[id]?.length))
        return { wrote: [] };
    const scope = overlay ? 'overlay' : 'shared';
    return withAgentAssetLifecycleLock(root, dryRun, () => {
        const initial = readHookRegistrationLedger(root) ?? ledgerOf();
        let entries = [...initial.entries];
        let published = initial;
        const wrote = [];
        const obsoleteIds = Object.keys(HOOK_REGISTRATIONS).filter((id) => !componentIds.includes(id));
        for (const provider of requireAgentProviders(targets)) {
            const rel = hookRegistrationDestination(provider, scope);
            if (skipProvider(root, provider, rel, overlay))
                continue;
            let document = providerDocument(root, provider, rel);
            entries = adoptExactLegacy(entries, document, legacyOwnedComponentIds, provider, scope);
            entries = transferHookRegistrationScope(entries, provider, scope);
            const removed = removeLedgerAuthorizedHookRegistrations(document, projectHookRegistrations(obsoleteIds, [provider], scope), ledgerOf(entries), provider, scope);
            entries = release(entries, [...removed.removed, ...removed.alreadyAbsent]);
            document = removed.document;
            const installed = installProjectedHookRegistrations(document, projectHookRegistrations(componentIds, [provider], scope), ledgerOf(entries), provider, scope);
            const unresolved = removed.blocked.length ||
                removed.drifted.length ||
                installed.blocked.length ||
                installed.collisions.length;
            if (unresolved)
                throw new Error(`${provider} hook registration conflicts require resolution`);
            entries = adopt(entries, installed.ownershipEntries);
            const plan = {
                provider,
                rel,
                document: installed.document,
                changed: removed.changed || installed.changed,
                report: removed.changed || installed.ownershipEntries.length > 0,
            };
            published = publishPlan(root, plan, entries, published, dryRun);
            if (plan.report)
                wrote.push(plan.rel);
        }
        if (wrote.length && published.entries.length)
            wrote.push(HOOK_REGISTRATION_LEDGER_REL);
        console.log(`  ${dryRun ? '[dry-run] merge' : '✓ registered'} hook registrations`);
        return { wrote: [...new Set(wrote)] };
    });
}
export function removeHookRegistrations(root, { dryRun = false, targets = AGENT_TARGETS, overlay = false, legacyOwnedComponentIds, } = {}) {
    const scope = overlay ? 'overlay' : 'shared';
    withAgentAssetLifecycleLock(root, dryRun, () => {
        const storedLedger = readHookRegistrationLedger(root);
        if (!storedLedger && !legacyOwnedComponentIds) {
            console.log('  • no hook registration ledger — preserving provider settings');
            return;
        }
        const ledger = storedLedger ?? ledgerOf();
        let entries = [...ledger.entries];
        let published = ledger;
        const storedKeys = new Set(entries.map(ownedKey));
        for (const provider of requireAgentProviders(targets)) {
            const rel = hookRegistrationDestination(provider, scope);
            if (skipProvider(root, provider, rel, overlay))
                continue;
            const document = providerDocument(root, provider, rel);
            entries = adoptExactLegacy(entries, document, legacyOwnedComponentIds, provider, scope);
            entries = transferHookRegistrationScope(entries, provider, scope);
            const removed = removeLedgerAuthorizedHookRegistrations(document, projectHookRegistrations(Object.keys(HOOK_REGISTRATIONS), [provider], scope), ledgerOf(entries), provider, scope);
            entries = release(entries, [...removed.removed, ...removed.alreadyAbsent]);
            entries = entries.filter((entry) => storedKeys.has(ownedKey(entry)));
            const plan = { provider, rel, document: removed.document, changed: removed.changed };
            published = publishPlan(root, plan, entries, published, dryRun);
        }
        console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} hook registrations`);
    });
}
export function checkHookRegistrations(root, componentIds, { overlay = false, targets = AGENT_TARGETS, legacyOwnedComponentIds, } = {}) {
    if (!componentIds.some((id) => HOOK_REGISTRATIONS[id]?.length))
        return { ok: true, missing: [] };
    const scope = overlay ? 'overlay' : 'shared';
    const ledger = readHookRegistrationLedger(root);
    const missing = [];
    for (const provider of requireAgentProviders(targets)) {
        const rel = hookRegistrationDestination(provider, scope);
        if (!isSafeAgentAssetPath(root, rel, true)) {
            missing.push(`${provider}:unsafe-config`);
            continue;
        }
        const document = providerDocument(root, provider, rel);
        const effectiveLedger = legacyOwnedComponentIds?.length
            ? ledgerOf(adoptExactLegacy([...(ledger?.entries ?? [])], document, legacyOwnedComponentIds, provider, scope))
            : ledger;
        const result = checkProjectedHookRegistrations(document, projectHookRegistrations(componentIds, [provider], scope), effectiveLedger, provider, scope);
        for (const [reason, candidates] of Object.entries({
            missing: result.missing,
            drifted: result.drifted,
            collision: result.collisions,
            blocked: result.blocked,
            'untrusted-ledger': result.untrustedLedgerEntries,
        }))
            for (const candidate of candidates)
                missing.push(`${provider}:${candidate.registrationId}:${reason}`);
    }
    return { ok: missing.length === 0, missing };
}
