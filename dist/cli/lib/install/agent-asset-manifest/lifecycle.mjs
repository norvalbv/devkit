import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from "../../atomic-write.mjs";
import { writeIfAbsent } from "../../fs-helpers.mjs";
import { agentAssetDir, projectAgentAsset, projectedAssetRel } from "../agent-assets.mjs";
import { requireAgentProviders, SUPPORTED_AGENT_PROVIDERS, } from "../agent-providers.mjs";
import { encodeSyncManifestV2 } from "./codec.mjs";
import { AGENT_ASSET_MANIFESTS } from "./compatibility.mjs";
import { withAgentAssetLifecycleLock } from "./lock.mjs";
import { readAgentAssetManifest } from "./reader.mjs";
export { withAgentAssetLifecycleLock };
const digest = (content) => createHash('sha256').update(content).digest('hex');
function unitFor(kind, logicalRel) {
    return kind === 'skills' ? logicalRel.split('/')[0] : logicalRel;
}
const overrideKind = (kind) => kind === 'hooks' ? 'agent-hook' : kind.slice(0, -1);
function manifestPath(root, kind, requested) {
    const expected = AGENT_ASSET_MANIFESTS.find((entry) => entry.kind === kind)?.filename;
    if (!expected || (requested && requested !== expected))
        throw new Error(`Invalid ${kind} manifest filename: ${requested ?? ''}`);
    return join(root, '.devkit', expected);
}
export function isSafeAgentAssetPath(root, rel, regularLeaf = false) {
    let path = root;
    const parts = rel.split('/');
    for (const [index, part] of parts.entries()) {
        path = join(path, part);
        if (!pathExists(path))
            return true;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() ||
            (index < parts.length - 1 ? !stat.isDirectory() : regularLeaf && !stat.isFile()))
            return false;
    }
    return true;
}
function pathExists(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
export const requiresProviderNativeLifecycle = (decoded, targets) => decoded?.version === 2 || targets.includes('codex');
function oldOutputs(decoded, kind) {
    if (!decoded)
        return [];
    const out = [];
    const add = (provider, logicalRel, sha) => {
        const outputRel = projectedAssetRel(provider, kind, logicalRel);
        out.push({
            provider,
            logicalRel,
            unit: unitFor(kind, logicalRel),
            outputRel,
            rootRel: `${agentAssetDir(provider, kind)}/${outputRel}`,
            content: Buffer.alloc(0),
            sha,
        });
    };
    if (decoded.version === 1) {
        for (const provider of decoded.manifest.targets)
            for (const [logicalRel, sha] of Object.entries(decoded.manifest.files))
                add(provider, logicalRel, sha);
        return out;
    }
    for (const provider of SUPPORTED_AGENT_PROVIDERS) {
        const files = decoded.manifest.providers[provider]?.files ?? {};
        const logicalByOutput = new Map(Object.keys(decoded.manifest.files).map((logicalRel) => [
            projectedAssetRel(provider, kind, logicalRel),
            logicalRel,
        ]));
        for (const [outputRel, sha] of Object.entries(files)) {
            const logicalRel = logicalByOutput.get(outputRel);
            if (logicalRel)
                add(provider, logicalRel, sha);
        }
    }
    return out;
}
function projectionMatches(root, kind, outputs) {
    if (!outputs.length)
        return true;
    const dir = agentAssetDir(outputs[0].provider, kind);
    if (outputs.some((output) => !isSafeAgentAssetPath(root, output.rootRel)))
        return false;
    if (kind !== 'skills') {
        const output = outputs[0];
        const path = join(root, output.rootRel);
        if (!existsSync(path))
            return false;
        const stat = lstatSync(path);
        return !stat.isSymbolicLink() && stat.isFile() && digest(readFileSync(path)) === output.sha;
    }
    const unitRoot = join(root, dir, outputs[0].unit);
    if (!existsSync(unitRoot))
        return false;
    const expected = new Map(outputs.map((output) => [output.outputRel.slice(output.unit.length + 1), output.sha]));
    const actual = new Map();
    const walk = (path, rel = '') => {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink())
            return false;
        if (stat.isFile()) {
            actual.set(rel, digest(readFileSync(path)));
            return true;
        }
        if (!stat.isDirectory())
            return false;
        return readdirSync(path).every((name) => walk(join(path, name), rel ? `${rel}/${name}` : name));
    };
    return (walk(unitRoot) &&
        actual.size === expected.size &&
        [...expected].every(([rel, sha]) => actual.get(rel) === sha));
}
function buildPlan(options, decoded) {
    const providers = requireAgentProviders(options.targets);
    const sources = [...options.sources]
        .map((source) => ({ ...source, content: Buffer.from(source.content) }))
        .sort((left, right) => left.logicalRel.localeCompare(right.logicalRel, 'en'));
    const logicalRels = new Set();
    const outputsByUnit = new Map();
    const sourceShas = new Map();
    for (const source of sources) {
        projectedAssetRel('claude', options.kind, source.logicalRel);
        if (logicalRels.has(source.logicalRel))
            throw new Error(`Duplicate ${options.kind} source: ${source.logicalRel}`);
        logicalRels.add(source.logicalRel);
        sourceShas.set(source.logicalRel, digest(source.content));
        const unit = unitFor(options.kind, source.logicalRel);
        const projected = providers.map((provider) => {
            const outputRel = projectedAssetRel(provider, options.kind, source.logicalRel);
            const content = projectAgentAsset(provider, options.kind, source.logicalRel, source.content);
            return {
                provider,
                logicalRel: source.logicalRel,
                unit,
                outputRel,
                rootRel: `${agentAssetDir(provider, options.kind)}/${outputRel}`,
                content,
                sha: digest(content),
            };
        });
        outputsByUnit.set(unit, [...(outputsByUnit.get(unit) ?? []), ...projected]);
    }
    const owned = new Set(oldOutputs(decoded, options.kind).map((output) => `${output.provider}:${output.unit}`));
    const skips = [];
    const relinquished = new Set();
    const replacements = new Set();
    const includedUnits = new Set();
    for (const [unit, outputs] of outputsByUnit) {
        if (!outputs.length)
            continue;
        const tracked = outputs.filter((output) => options.skipTracked?.(output.rootRel));
        if (tracked.length) {
            for (const output of tracked) {
                relinquished.add(`${output.provider}:${unit}`);
                skips.push({ unit, reason: 'tracked', provider: output.provider, path: output.rootRel });
            }
            continue;
        }
        const conflicts = [];
        for (const provider of providers) {
            const projected = outputs.filter((output) => output.provider === provider);
            const dir = agentAssetDir(provider, options.kind);
            const unsafe = projected.some(({ rootRel }) => !isSafeAgentAssetPath(options.root, rootRel));
            const unitPath = options.kind === 'skills' ? `${dir}/${unit}` : (projected[0]?.rootRel ?? `${dir}/${unit}`);
            if (unsafe) {
                conflicts.push({ unit, reason: 'unsafe', provider, path: unitPath });
                continue;
            }
            const exists = pathExists(join(options.root, unitPath));
            if (!exists ||
                owned.has(`${provider}:${unit}`) ||
                projectionMatches(options.root, options.kind, projected))
                continue;
            conflicts.push({ unit, reason: 'foreign', provider, path: unitPath });
        }
        const canOverride = conflicts.length > 0 &&
            conflicts.every((conflict) => conflict.reason === 'foreign') &&
            Boolean(options.override?.(overrideKind(options.kind), unit));
        if (conflicts.length && !canOverride) {
            skips.push(...conflicts);
            continue;
        }
        for (const conflict of conflicts)
            replacements.add(conflict.path);
        includedUnits.add(unit);
    }
    const outputs = [...outputsByUnit]
        .filter(([unit]) => includedUnits.has(unit))
        .flatMap(([, projected]) => projected);
    const skippedUnits = new Set(skips.map((skip) => skip.unit));
    const previousOutputs = oldOutputs(decoded, options.kind);
    const retained = options.retainUnspecified
        ? previousOutputs.filter((output) => !logicalRels.has(output.logicalRel))
        : [];
    const carried = [
        ...retained,
        ...previousOutputs.filter((output) => providers.includes(output.provider) &&
            skippedUnits.has(output.unit) &&
            !relinquished.has(`${output.provider}:${output.unit}`)),
    ];
    const carriedSources = new Set(carried.map((output) => output.logicalRel));
    const previousFiles = decoded?.manifest.files ?? {};
    const files = Object.fromEntries([
        ...sources.flatMap((source) => {
            const unit = unitFor(options.kind, source.logicalRel);
            if (includedUnits.has(unit))
                return [[source.logicalRel, sourceShas.get(source.logicalRel)]];
            const previousSha = previousFiles[source.logicalRel];
            return carriedSources.has(source.logicalRel) && previousSha
                ? [[source.logicalRel, previousSha]]
                : [];
        }),
        ...Object.entries(previousFiles).filter(([logicalRel]) => retained.some((output) => output.logicalRel === logicalRel)),
    ]);
    const providerRecords = {};
    for (const provider of SUPPORTED_AGENT_PROVIDERS.filter((candidate) => providers.includes(candidate) || retained.some((output) => output.provider === candidate)))
        providerRecords[provider] = {
            files: Object.fromEntries([...outputs, ...carried]
                .filter((output) => output.provider === provider)
                .map((output) => [output.outputRel, output.sha])),
        };
    const base = {
        schemaVersion: 2,
        kind: options.kind,
        devkitRef: options.devkitRef,
        files,
        providers: providerRecords,
    };
    const priorTime = decoded?.version === 2 ? decoded.manifest.generatedAt : '';
    const withPriorTime = { ...base, generatedAt: priorTime };
    const unchanged = decoded?.version === 2 &&
        encodeSyncManifestV2(withPriorTime, options.kind) ===
            encodeSyncManifestV2(decoded.manifest, options.kind);
    const manifest = {
        ...base,
        generatedAt: unchanged ? priorTime : (options.now?.() ?? new Date().toISOString()),
    };
    const encoded = encodeSyncManifestV2(manifest, options.kind);
    const currentPaths = new Set([...outputs, ...carried].map((output) => output.rootRel));
    const stale = previousOutputs.filter((output) => {
        if (currentPaths.has(output.rootRel) || relinquished.has(`${output.provider}:${output.unit}`))
            return false;
        if (!options.skipTracked?.(output.rootRel))
            return true;
        const { unit, provider, rootRel: path } = output;
        skips.push({ unit, reason: 'tracked', provider, path });
        return false;
    });
    return {
        manifest,
        encoded,
        outputs,
        outputPaths: outputs.map((output) => output.rootRel),
        replacements: [...replacements],
        skips,
        stale,
    };
}
function refuse(action, path) {
    throw new Error(`Refusing to ${action} ${path} through an unsafe agent asset path`);
}
function removeOutput(root, kind, output) {
    const dir = agentAssetDir(output.provider, kind);
    if (!isSafeAgentAssetPath(root, output.rootRel, true))
        refuse('remove', output.rootRel);
    rmSync(join(root, output.rootRel), { force: true });
    let parent = dirname(join(root, output.rootRel));
    const boundary = join(root, dir);
    while (parent.startsWith(boundary) && existsSync(parent) && readdirSync(parent).length === 0) {
        rmSync(parent, { recursive: true });
        if (parent === boundary)
            break;
        parent = dirname(parent);
    }
}
export function syncProviderNativeAssets(options) {
    const dryRun = options.dryRun ?? false;
    return withAgentAssetLifecycleLock(options.root, dryRun, () => {
        const path = manifestPath(options.root, options.kind, options.manifestFilename);
        const decoded = readAgentAssetManifest(path, options.kind);
        const plan = buildPlan(options, decoded);
        if (!dryRun) {
            for (const path of [...plan.replacements, ...plan.outputPaths])
                if (!isSafeAgentAssetPath(options.root, path))
                    throw new Error(`Refusing to write ${path} through a non-directory agent asset path`);
            for (const output of plan.stale)
                if (!isSafeAgentAssetPath(options.root, output.rootRel, true))
                    refuse('remove', output.rootRel);
            for (const replacement of plan.replacements)
                rmSync(join(options.root, replacement), { recursive: true, force: true });
            for (const output of plan.outputs) {
                const outputPath = join(options.root, output.rootRel);
                writeIfAbsent(outputPath, output.content, { force: true });
                if (options.fileMode !== undefined)
                    chmodSync(outputPath, options.fileMode);
            }
            for (const output of plan.stale)
                removeOutput(options.root, options.kind, output);
            writeFileAtomic(path, plan.encoded);
        }
        return { manifest: plan.manifest, outputPaths: plan.outputPaths, skips: plan.skips };
    });
}
export function findProviderNativeAssetConflicts(options) {
    const path = manifestPath(options.root, options.kind, options.manifestFilename);
    const decoded = readAgentAssetManifest(path, options.kind);
    return buildPlan({ ...options, devkitRef: null }, decoded).skips;
}
export function removeProviderNativeAssets(options) {
    const dryRun = options.dryRun ?? false;
    return withAgentAssetLifecycleLock(options.root, dryRun, () => {
        const path = manifestPath(options.root, options.kind);
        const decoded = readAgentAssetManifest(path, options.kind);
        if (decoded?.version !== 2)
            return { handled: false, removed: [], manifest: null };
        const recorded = SUPPORTED_AGENT_PROVIDERS.filter((provider) => decoded.manifest.providers[provider]);
        const targets = options.dropManifest
            ? recorded
            : options.targets
                ? requireAgentProviders(options.targets)
                : recorded;
        const selected = new Set(targets);
        const removed = oldOutputs(decoded, options.kind).filter((output) => selected.has(output.provider) && !options.skipTracked?.(output.rootRel));
        const providers = {};
        for (const provider of SUPPORTED_AGENT_PROVIDERS)
            if (!selected.has(provider) && decoded.manifest.providers[provider])
                providers[provider] = decoded.manifest.providers[provider];
        const represented = new Set();
        for (const logicalRel of Object.keys(decoded.manifest.files))
            for (const provider of SUPPORTED_AGENT_PROVIDERS)
                if (providers[provider]?.files[projectedAssetRel(provider, options.kind, logicalRel)])
                    represented.add(logicalRel);
        const files = Object.fromEntries(Object.entries(decoded.manifest.files).filter(([logicalRel]) => represented.has(logicalRel)));
        const manifest = {
            ...decoded.manifest,
            files,
            providers,
            generatedAt: !targets.some((provider) => decoded.manifest.providers[provider])
                ? decoded.manifest.generatedAt
                : new Date().toISOString(),
        };
        const encoded = encodeSyncManifestV2(manifest, options.kind);
        if (!dryRun) {
            for (const output of removed)
                if (!isSafeAgentAssetPath(options.root, output.rootRel, true))
                    refuse('remove', output.rootRel);
            for (const output of removed)
                removeOutput(options.root, options.kind, output);
            if (options.dropManifest ?? false)
                rmSync(path, { force: true });
            else
                writeFileAtomic(path, encoded);
        }
        return {
            handled: true,
            removed: removed.map((output) => output.rootRel),
            manifest: options.dropManifest ? null : manifest,
        };
    });
}
