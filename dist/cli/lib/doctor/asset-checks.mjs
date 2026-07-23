/**
 * Doctor's drift checks for the SYNCED agent half — skills, agents, agent-hook scripts, and the
 * hook registrations that accompany them.
 *
 * All four share one contract: a `.devkit/*-manifest.json` records a sha256 per synced file, and
 * drift is any disagreement between that record, devkit's bundled source, and the consumer's copy.
 * They are leaf checks — they read the repo and return a {@link CheckResult}, calling nothing else
 * in doctor — so they live outside the command module, which keeps its orchestration deliberately
 * intact. Every path resolves from the GIT ROOT: the agent half is repo-wide, so a monorepo package
 * subdir must still verify the root's copies (W-3 — resolve from the consumer, never __dirname).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectGitRoot } from "../detect-git-root.mjs";
import { packageDir, readJson, sha256 } from "../fs-helpers.mjs";
import { isSafeAgentAssetPath } from "../install/agent-asset-manifest/lifecycle.mjs";
import { readAgentAssetManifest } from "../install/agent-asset-manifest/reader.mjs";
import { agentAssetDir, projectedAssetRel } from "../install/agent-assets.mjs";
import { checkHookRegistrations } from "../install/install-hooks.mjs";
import { bundledNames } from "../sync-manifest.mjs";
import { check } from "./check-result.mjs";
const AGENT_ASSET_CHECKS = {
    skills: ['skills', 'skills-manifest.json', 'run `devkit sync-skills`', 'file(s)'],
    agents: ['agents', 'agents-manifest.json', 'run `devkit sync-agents`', 'agent file(s)'],
    hooks: ['agent-hooks', 'agent-hooks-manifest.json', 'run `devkit init`', 'hook script(s)'],
};
function assetExistsOnAnyProvider(gitRoot, providers, kind, logicalRel) {
    return providers.some((provider) => existsSync(join(gitRoot, agentAssetDir(provider, kind), projectedAssetRel(provider, kind, logicalRel))));
}
/** Verify every selected provider projection, including Codex TOML agents and v2 manifests. */
export function checkAgentAssets(cwd, kind, providers, { guards = [], expected } = {}) {
    const [name, manifestFilename, remediation, countLabel] = AGENT_ASSET_CHECKS[kind];
    const { gitRoot } = detectGitRoot(cwd);
    let decoded;
    try {
        decoded = readAgentAssetManifest(join(gitRoot, '.devkit', manifestFilename), kind);
    }
    catch (error) {
        return check(name, 'DRIFT', `invalid ${manifestFilename}: ${error instanceof Error ? error.message : String(error)}`, `inspect, repair, or remove ${manifestFilename}, then ${remediation}`, false);
    }
    if (!decoded)
        return check(name, 'MISSING', `no ${manifestFilename}`, remediation, true);
    const { files } = decoded.manifest;
    const sourceRoot = join(packageDir(), kind === 'hooks' ? 'agents-hooks' : kind);
    const sourceDrift = Object.entries(files)
        .filter(([logicalRel, recordedSha]) => {
        const sourcePath = join(sourceRoot, logicalRel);
        return existsSync(sourcePath) && sha256(sourcePath) !== recordedSha;
    })
        .map(([logicalRel]) => logicalRel);
    const consumerDrift = [];
    const missingProviders = [];
    for (const provider of providers) {
        const outputs = decoded.version === 1
            ? decoded.manifest.targets.includes(provider)
                ? Object.fromEntries(Object.entries(files).map(([logicalRel, digest]) => [
                    projectedAssetRel(provider, kind, logicalRel),
                    digest,
                ]))
                : null
            : (decoded.manifest.providers[provider]?.files ?? null);
        if (!outputs) {
            missingProviders.push(provider);
            continue;
        }
        for (const [outputRel, recordedSha] of Object.entries(outputs)) {
            const outputRelPath = join(agentAssetDir(provider, kind), outputRel);
            const outputPath = join(gitRoot, outputRelPath);
            if (!isSafeAgentAssetPath(gitRoot, outputRelPath, true) ||
                !existsSync(outputPath) ||
                sha256(outputPath) !== recordedSha)
                consumerDrift.push(`${provider}/${outputRel}`);
        }
    }
    const expectedUnits = expected ??
        (kind === 'skills'
            ? bundledNames('skills', (entry) => entry.isDirectory()).filter((unit) => unit !== 'decisions' || guards.includes('decisions'))
            : kind === 'agents'
                ? bundledNames('agents', (entry) => entry.isFile() && entry.name.endsWith('.md'))
                : []);
    const representedUnits = new Set(Object.keys(files).map((logicalRel) => kind === 'skills' ? logicalRel.split('/')[0] : logicalRel));
    const unsynced = expectedUnits.filter((unit) => !representedUnits.has(unit) && !assetExistsOnAnyProvider(gitRoot, providers, kind, unit));
    const unexpected = expected
        ? [...representedUnits].filter((unit) => !expectedUnits.includes(unit))
        : kind === 'skills'
            ? [...representedUnits].filter((unit) => !expectedUnits.includes(unit))
            : [];
    if (sourceDrift.length ||
        consumerDrift.length ||
        missingProviders.length ||
        unsynced.length ||
        unexpected.length) {
        const parts = [];
        if (sourceDrift.length)
            parts.push(`devkit source ahead of manifest (${sourceDrift.length})`);
        if (consumerDrift.length)
            parts.push(kind === 'hooks'
                ? `${consumerDrift.length} script(s) drifted/absent`
                : `consumer copy drifted (${consumerDrift.length})`);
        if (missingProviders.length)
            parts.push(`manifest lacks selected provider(s): ${missingProviders.join(', ')}`);
        if (unsynced.length)
            parts.push(`bundle has ${unsynced.length} ${kind === 'skills' ? 'skill(s)' : 'agent(s)'} the manifest lacks (${unsynced.join(', ')})`);
        if (unexpected.length)
            parts.push(kind === 'skills'
                ? `manifest contains disabled skill(s) (${unexpected.join(', ')})`
                : `manifest contains deselected asset(s) (${unexpected.join(', ')})`);
        return check(name, 'DRIFT', parts.join('; '), remediation, true);
    }
    return check(name, 'OK', `${Object.keys(files).length} ${countLabel} in sync`);
}
// Reason: the branches ARE the manifest-drift algorithm — per file, two independent SHA comparisons
// (devkit source vs manifest, consumer copy vs manifest) feed two drift buckets, then a
// missing-manifest short-circuit and a source/consumer DRIFT split. Each branch is a distinct drift
// verdict; extracting them hides which side drifted.
// fallow-ignore-next-line complexity
export async function checkSkills(cwd, surface = 'claude', guards = []) {
    // Skills are repo-wide → manifest + the agent-surface dir live at the git root (cwd for a
    // single-package repo). Verify against the selected surface (.claude or .cursor — same content).
    const { gitRoot } = detectGitRoot(cwd);
    const manifestPath = join(gitRoot, '.devkit', 'skills-manifest.json');
    const manifest = readJson(manifestPath);
    if (!manifest) {
        return check('skills', 'MISSING', 'no skills-manifest.json', 'run `devkit sync-skills`', true);
    }
    const skillsSrc = join(packageDir(), 'skills');
    const consumerDrift = [];
    const sourceDrift = [];
    for (const [rel, recordedSha] of Object.entries(manifest.files)) {
        const srcPath = join(skillsSrc, rel);
        if (existsSync(srcPath) && sha256(srcPath) !== recordedSha)
            sourceDrift.push(rel);
        const consumerPath = join(gitRoot, `.${surface}`, 'skills', rel);
        if (!existsSync(consumerPath) || sha256(consumerPath) !== recordedSha)
            consumerDrift.push(rel);
    }
    // Bundle-completeness: a NEW bundled skill the (stale) manifest doesn't list — and that was never
    // synced under .<surface>/skills — is drift the per-file loop above can't see (it iterates manifest
    // keys only, so a just-added skill is invisible). A consumer-authored same-named skill (present on
    // disk, deliberately off-manifest) is NOT drift, so require absent-on-disk too — see the
    // non-devkit-asset-collision-preserve decision.
    const manifestSkillDirs = new Set(Object.keys(manifest.files).map((k) => k.split('/')[0]));
    const expectedNames = bundledNames('skills', (e) => e.isDirectory()).filter((name) => name !== 'decisions' || guards.includes('decisions'));
    const unexpected = [...manifestSkillDirs].filter((name) => !expectedNames.includes(name));
    const unsynced = expectedNames.filter((dir) => !manifestSkillDirs.has(dir) && !existsSync(join(gitRoot, `.${surface}`, 'skills', dir)));
    if (sourceDrift.length || consumerDrift.length || unsynced.length || unexpected.length) {
        const parts = [];
        if (sourceDrift.length)
            parts.push(`devkit source ahead of manifest (${sourceDrift.length})`);
        if (consumerDrift.length)
            parts.push(`consumer copy drifted (${consumerDrift.length})`);
        if (unsynced.length)
            parts.push(`bundle has ${unsynced.length} skill(s) the manifest lacks (${unsynced.join(', ')})`);
        if (unexpected.length)
            parts.push(`manifest contains disabled skill(s) (${unexpected.join(', ')})`);
        return check('skills', 'DRIFT', parts.join('; '), 'run `devkit sync-skills`', true);
    }
    return check('skills', 'OK', `${Object.keys(manifest.files).length} file(s) in sync`);
}
// Agents are repo-wide → manifest + the agent-surface dir live at the git root (same contract as skills).
// Reason: the branches ARE the manifest-drift algorithm (same contract as checkSkills): per file, two independent SHA comparisons (devkit source vs manifest, consumer copy vs manifest) feed two drift buckets, then a missing-manifest short-circuit and a source/consumer DRIFT split. Each branch is a distinct drift verdict; extracting them hides which side drifted.
// fallow-ignore-next-line complexity
export async function checkAgents(cwd, surface = 'claude') {
    const { gitRoot } = detectGitRoot(cwd);
    const manifest = readJson(join(gitRoot, '.devkit', 'agents-manifest.json'));
    if (!manifest) {
        return check('agents', 'MISSING', 'no agents-manifest.json', 'run `devkit sync-agents`', true);
    }
    const agentsSrc = join(packageDir(), 'agents');
    const consumerDrift = [];
    const sourceDrift = [];
    for (const [rel, recordedSha] of Object.entries(manifest.files)) {
        const srcPath = join(agentsSrc, rel);
        if (existsSync(srcPath) && sha256(srcPath) !== recordedSha)
            sourceDrift.push(rel);
        const consumerPath = join(gitRoot, `.${surface}`, 'agents', rel);
        if (!existsSync(consumerPath) || sha256(consumerPath) !== recordedSha)
            consumerDrift.push(rel);
    }
    // Bundle-completeness: a NEW bundled agent the (stale) manifest doesn't list — and that was never
    // synced under .<surface>/agents — is drift the per-file loop above can't see (it iterates manifest
    // keys only). A consumer-authored same-named agent (present on disk, deliberately off-manifest) is
    // NOT drift, so require absent-on-disk too — see the non-devkit-asset-collision-preserve decision.
    const unsynced = bundledNames('agents', (e) => e.isFile() && e.name.endsWith('.md')).filter((name) => !(name in manifest.files) && !existsSync(join(gitRoot, `.${surface}`, 'agents', name)));
    if (sourceDrift.length || consumerDrift.length || unsynced.length) {
        const parts = [];
        if (sourceDrift.length)
            parts.push(`devkit source ahead of manifest (${sourceDrift.length})`);
        if (consumerDrift.length)
            parts.push(`consumer copy drifted (${consumerDrift.length})`);
        if (unsynced.length)
            parts.push(`bundle has ${unsynced.length} agent(s) the manifest lacks (${unsynced.join(', ')})`);
        return check('agents', 'DRIFT', parts.join('; '), 'run `devkit sync-agents`', true);
    }
    return check('agents', 'OK', `${Object.keys(manifest.files).length} agent file(s) in sync`);
}
// agentHooks: the six synced scripts (under <surface>/hooks) match the manifest, and are present.
export function checkAgentHookScripts(cwd, surface = 'claude', expected = null) {
    const { gitRoot } = detectGitRoot(cwd);
    const manifest = readJson(join(gitRoot, '.devkit', 'agent-hooks-manifest.json'));
    if (!manifest) {
        return check('agent-hooks', 'MISSING', 'no agent-hooks-manifest.json', 'run `devkit init`', true);
    }
    const drift = Object.keys(manifest.files).filter((rel) => {
        const p = join(gitRoot, `.${surface}`, 'hooks', rel);
        return !existsSync(p) || sha256(p) !== manifest.files[rel];
    });
    const manifested = new Set(Object.keys(manifest.files));
    const missingExpected = expected?.filter((name) => !manifested.has(name)) ?? [];
    const unexpected = expected ? [...manifested].filter((name) => !expected.includes(name)) : [];
    if (drift.length || missingExpected.length || unexpected.length) {
        const details = [];
        if (drift.length)
            details.push(`${drift.length} script(s) drifted/absent`);
        if (missingExpected.length)
            details.push(`missing selected script(s): ${missingExpected.join(', ')}`);
        if (unexpected.length)
            details.push(`manifest contains deselected script(s): ${unexpected.join(', ')}`);
        return check('agent-hooks', 'DRIFT', details.join('; '), 'run `devkit init`', true);
    }
    return check('agent-hooks', 'OK', `${Object.keys(manifest.files).length} hook script(s) in sync`);
}
// Hook registrations present in .claude/settings.json for the selected hook-owning components.
export function checkRegistrations(cwd, hookComponents, targets, overlay = false) {
    const { gitRoot } = detectGitRoot(cwd);
    let result;
    try {
        result = checkHookRegistrations(gitRoot, hookComponents, {
            targets,
            overlay,
            legacyOwnedComponentIds: hookComponents,
        });
    }
    catch (error) {
        return check('hook registrations', 'DRIFT', error instanceof Error ? error.message : String(error), 'inspect or remove the invalid hook ownership ledger, then run `devkit init`', false);
    }
    const { ok, missing } = result;
    if (ok)
        return check('hook registrations', 'OK', `${hookComponents.join(', ')} registered`);
    return check('hook registrations', 'DRIFT', `${missing.length} provider registration issue(s)`, 'run `devkit init` to re-register', true);
}
