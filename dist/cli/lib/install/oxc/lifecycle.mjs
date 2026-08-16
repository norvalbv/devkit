/** Collision-safe install, drift, and uninstall lifecycle for the opt-in Oxc repository config. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeFileAtomic } from "../../atomic-write.mjs";
import { check } from "../../doctor/check-result.mjs";
import { packageDir } from "../../fs-helpers.mjs";
import { probeOxcRuntime } from "./runtime.mjs";
const OXLINT_CONFIGS = [
    '.oxlintrc.json',
    '.oxlintrc.jsonc',
    'oxlint.config.ts',
    'oxlint.config.mts',
];
const OXFMT_CONFIGS = ['.oxfmtrc.json', '.oxfmtrc.jsonc', 'oxfmt.config.ts', 'oxfmt.config.mts'];
const OXLINT_STARTER = `${JSON.stringify({ extends: ['./.devkit/oxc/oxlint.base.json'], jsPlugins: [], overrides: [], rules: {} }, null, 2)}\n`;
const OXFMT_STARTER = '{}\n';
const MANIFEST_REL = '.devkit/oxc/manifest.json';
const BASE_REL = '.devkit/oxc/oxlint.base.json';
const LOCK_REL = '.devkit/oxc.lock';
/** Explain why an explicitly requested capability cannot activate in a non-repository mode. */
export function warnIfOxcUnavailable(mode, requested) {
    if (!requested || mode !== 'overlay')
        return;
    console.warn(`devkit init --${mode}: --oxc is unavailable because Oxc activation writes tracked repository config; skipping it.`);
}
const digest = (content) => createHash('sha256').update(content).digest('hex');
const fileDigest = (path) => digest(readFileSync(path));
function baseContent(antiSlop) {
    const source = readFileSync(join(packageDir(), 'oxc', 'oxlint.base.json'), 'utf8');
    if (!antiSlop)
        return source;
    const parsed = JSON.parse(source);
    parsed.extends = ['../anti-slop/oxlint.json'];
    return `${JSON.stringify(parsed, null, 2)}\n`;
}
function isOwnership(value) {
    if (!value || typeof value !== 'object')
        return false;
    const candidate = value;
    return (typeof candidate.path === 'string' &&
        (candidate.createdDigest === null || typeof candidate.createdDigest === 'string'));
}
function readManifest(cwd) {
    const path = join(cwd, MANIFEST_REL);
    if (!existsSync(path))
        return null;
    try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return value.schemaVersion === 1 &&
            typeof value.pins?.oxlint === 'string' &&
            typeof value.pins?.oxfmt === 'string' &&
            typeof value.baseDigest === 'string' &&
            isOwnership(value.configs?.oxlint) &&
            isOwnership(value.configs?.oxfmt)
            ? { ...value, antiSlop: value.antiSlop === true }
            : null;
    }
    catch {
        return null;
    }
}
function candidates(cwd, names) {
    return names.filter((name) => existsSync(join(cwd, name)));
}
function assertNoConfigCollisions(cwd) {
    for (const names of [OXLINT_CONFIGS, OXFMT_CONFIGS]) {
        const found = candidates(cwd, names);
        if (found.length > 1) {
            throw new Error(`multiple Oxc configs in one directory: ${found.join(', ')}`);
        }
    }
}
/** Read-only preflight used before a dependent capability publishes managed state. */
export function assertOxcCapabilityReady(cwd) {
    const lint = probeOxcRuntime('lint');
    const fmt = probeOxcRuntime('fmt');
    if (!lint.ok || !fmt.ok || !lint.runtime || !fmt.runtime) {
        throw new Error(`bundled Oxc runtime unavailable: ${lint.detail}; ${fmt.detail}`);
    }
    assertNoConfigCollisions(cwd);
}
/** Require the managed base bytes and recorded digest to match the current selected capabilities. */
export function oxcBaseCapabilityIssue(cwd) {
    const manifest = readManifest(cwd);
    if (!manifest)
        return 'managed Oxc manifest is missing or invalid';
    const expected = digest(baseContent(manifest.antiSlop));
    if (manifest.baseDigest !== expected)
        return 'managed Oxlint base manifest digest is stale';
    const path = join(cwd, BASE_REL);
    if (!existsSync(path) || fileDigest(path) !== expected)
        return 'managed Oxlint base is missing or drifted';
    return null;
}
function ownershipFor(cwd, names, starterPath, starter, previous, dryRun) {
    const found = candidates(cwd, names);
    if (found.length === 1) {
        const path = found[0];
        return previous?.path === path ? previous : { path, createdDigest: null };
    }
    if (!dryRun)
        writeFileAtomic(join(cwd, starterPath), starter);
    return { path: starterPath, createdDigest: digest(starter) };
}
function syncOxcCapabilityUnlocked(cwd, dryRun, antiSlop) {
    const previous = readManifest(cwd);
    const lint = probeOxcRuntime('lint');
    const fmt = probeOxcRuntime('fmt');
    if (!lint.ok || !fmt.ok || !lint.runtime || !fmt.runtime) {
        throw new Error(`bundled Oxc runtime unavailable: ${lint.detail}; ${fmt.detail}`);
    }
    // Validate both tools before creating either starter: a formatter collision must not leave a
    // half-installed linter config (and vice versa).
    assertNoConfigCollisions(cwd);
    const base = baseContent(antiSlop);
    if (!dryRun) {
        mkdirSync(join(cwd, '.devkit', 'oxc'), { recursive: true });
        writeFileAtomic(join(cwd, BASE_REL), base);
    }
    const created = [];
    try {
        const hadOxlint = candidates(cwd, OXLINT_CONFIGS).length > 0;
        const oxlint = ownershipFor(cwd, OXLINT_CONFIGS, '.oxlintrc.json', OXLINT_STARTER, previous?.configs.oxlint, dryRun);
        if (!dryRun && !hadOxlint)
            created.push([oxlint.path, digest(OXLINT_STARTER)]);
        const hadOxfmt = candidates(cwd, OXFMT_CONFIGS).length > 0;
        const oxfmt = ownershipFor(cwd, OXFMT_CONFIGS, '.oxfmtrc.json', OXFMT_STARTER, previous?.configs.oxfmt, dryRun);
        if (!dryRun && !hadOxfmt)
            created.push([oxfmt.path, digest(OXFMT_STARTER)]);
        const manifest = {
            schemaVersion: 1,
            pins: { oxlint: lint.runtime.expectedVersion, oxfmt: fmt.runtime.expectedVersion },
            antiSlop,
            baseDigest: digest(base),
            configs: { oxlint, oxfmt },
        };
        if (dryRun) {
            console.log(`  [dry-run] sync ${BASE_REL} + ${MANIFEST_REL}; preserve existing root configs`);
            return;
        }
        writeFileAtomic(join(cwd, MANIFEST_REL), `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`  ✓ Oxc capability: oxlint@${manifest.pins.oxlint} + oxfmt@${manifest.pins.oxfmt}`);
    }
    catch (error) {
        for (const [path, createdDigest] of created) {
            try {
                if (existsSync(join(cwd, path)) && fileDigest(join(cwd, path)) === createdDigest)
                    rmSync(join(cwd, path));
            }
            catch {
                // Preserve a config another process changed or removed while the failed sync rolled back.
            }
        }
        throw error;
    }
}
/** Install or upgrade managed base/provenance while preserving every existing root config byte. */
export function syncOxcCapability(cwd, { dryRun = false, antiSlop = false } = {}) {
    if (dryRun) {
        syncOxcCapabilityUnlocked(cwd, true, antiSlop);
        return;
    }
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    withLock(join(cwd, LOCK_REL), () => syncOxcCapabilityUnlocked(cwd, false, antiSlop));
}
function parseJsonConfig(cwd, ownership) {
    if (!ownership.path.endsWith('.json'))
        return null;
    try {
        JSON.parse(readFileSync(join(cwd, ownership.path), 'utf8'));
        return null;
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
function configCheck(cwd, tool, ownership, allNames) {
    const found = candidates(cwd, allNames);
    if (found.length > 1) {
        return check(`${tool} config`, 'DRIFT', `multiple configs: ${found.join(', ')}`, 'keep one config');
    }
    const path = join(cwd, ownership.path);
    if (!existsSync(path)) {
        return check(`${tool} config`, 'MISSING', ownership.path, 'run `devkit doctor --fix`', true);
    }
    const invalid = parseJsonConfig(cwd, ownership);
    if (invalid)
        return check(`${tool} config`, 'DRIFT', `invalid JSON: ${invalid}`, 'fix the config');
    const changed = ownership.createdDigest !== null && fileDigest(path) !== ownership.createdDigest;
    if (tool === 'oxlint' && ownership.createdDigest !== null) {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const extended = Array.isArray(parsed.extends) ? parsed.extends : [];
        if (!extended.includes('./.devkit/oxc/oxlint.base.json')) {
            return check('oxlint config', 'DRIFT', `${ownership.path} no longer extends the Devkit base`, 'restore the base pointer or mark the config consumer-owned by reinstalling after removing the Oxc manifest');
        }
    }
    const detail = ownership.createdDigest === null
        ? `${ownership.path} (pre-existing, consumer-owned)`
        : changed
            ? `${ownership.path} (customized, preserved)`
            : `${ownership.path} (Devkit starter)`;
    return check(`${tool} config`, 'OK', detail);
}
/** Read-only doctor checks. Runtime probes never load repository configs or JS plugins. */
export function checkOxcCapability(cwd) {
    const manifest = readManifest(cwd);
    if (!manifest) {
        return [check('Oxc manifest', 'MISSING', MANIFEST_REL, 'run `devkit doctor --fix`', true)];
    }
    const lint = probeOxcRuntime('lint');
    const fmt = probeOxcRuntime('fmt');
    const runtimeOk = lint.ok &&
        fmt.ok &&
        lint.runtime?.expectedVersion === manifest.pins.oxlint &&
        fmt.runtime?.expectedVersion === manifest.pins.oxfmt;
    const runtime = runtimeOk
        ? check('Oxc runtime', 'OK', `${lint.detail}; ${fmt.detail}`)
        : check('Oxc runtime', 'DRIFT', `${lint.detail}; ${fmt.detail}`, 'reinstall the pinned @norvalbv/devkit package with optional platform dependencies');
    const basePath = join(cwd, BASE_REL);
    const baseCurrent = oxcBaseCapabilityIssue(cwd) === null;
    const base = baseCurrent
        ? check('Oxlint base', 'OK', BASE_REL)
        : check('Oxlint base', existsSync(basePath) ? 'DRIFT' : 'MISSING', BASE_REL, 'run `devkit doctor --fix`', true);
    return [
        runtime,
        base,
        configCheck(cwd, 'oxlint', manifest.configs.oxlint, OXLINT_CONFIGS),
        configCheck(cwd, 'oxfmt', manifest.configs.oxfmt, OXFMT_CONFIGS),
    ];
}
function removeOxcCapabilityUnlocked(cwd, dryRun) {
    const manifest = readManifest(cwd);
    if (manifest) {
        for (const ownership of Object.values(manifest.configs)) {
            const path = join(cwd, ownership.path);
            if (!existsSync(path) || ownership.createdDigest === null)
                continue;
            if (fileDigest(path) !== ownership.createdDigest) {
                console.log(`  • kept customized ${ownership.path}`);
                continue;
            }
            console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${ownership.path}`);
            if (!dryRun)
                rmSync(path);
        }
    }
    const managed = join(cwd, '.devkit', 'oxc');
    if (existsSync(managed)) {
        console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} .devkit/oxc/`);
        if (!dryRun)
            rmSync(managed, { recursive: true, force: true });
    }
}
/** Remove only unchanged root starters; customized or pre-existing configs are never deleted. */
export function removeOxcCapability(cwd, dryRun = false) {
    if (dryRun) {
        removeOxcCapabilityUnlocked(cwd, true);
        return;
    }
    const managed = join(cwd, '.devkit', 'oxc');
    if (!existsSync(managed))
        return;
    withLock(join(cwd, LOCK_REL), () => removeOxcCapabilityUnlocked(cwd, false));
}
