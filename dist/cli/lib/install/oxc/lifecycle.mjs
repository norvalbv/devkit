/** Collision-safe install, drift, and uninstall lifecycle for core Oxc repository state. */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { overlayInstall } from '../../../../gate-engine/overlay-mode.mjs';
import { withLock, writeFileAtomic } from '../../atomic-write.mjs';
import { check } from '../../doctor/check-result.mjs';
import { assertRunnerMayWrite, runnerSkew } from '../../doctor/pin/runner-identity.mjs';
import { digest, packageDir } from '../../fs-helpers.mjs';
import { probeOxcRuntime } from './runtime.mjs';
export const OXLINT_CONFIGS = [
    '.oxlintrc.json',
    '.oxlintrc.jsonc',
    'oxlint.config.ts',
    'oxlint.config.mts',
];
/**
 * Overlay's entry config — deliberately NOT an `OXLINT_CONFIGS` discovery name. It must stay at the
 * package ROOT: oxlint resolves `overrides[].files` globs against the ENTRY config's directory.
 */
export const OVERLAY_ENTRY_REL = 'oxlint.devkit.json';
const OVERLAY_ENTRY = `${JSON.stringify({ extends: ['./.devkit/oxc/oxlint.base.json'] }, null, 2)}\n`;
export const OXFMT_CONFIGS = [
    '.oxfmtrc.json',
    '.oxfmtrc.jsonc',
    'oxfmt.config.ts',
    'oxfmt.config.mts',
];
const OXLINT_STARTER = `${JSON.stringify({ extends: ['./.devkit/oxc/oxlint.base.json'], jsPlugins: [], overrides: [], rules: {} }, null, 2)}\n`;
const OXFMT_STARTER = '{}\n';
const MANIFEST_REL = '.devkit/oxc/manifest.json';
const BASE_REL = '.devkit/oxc/oxlint.base.json';
const LOCK_REL = '.devkit/oxc.lock';
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
/**
 * The entry config to pass to `-c`, or null when oxlint's own discovery is correct. READ-side only:
 * resolved from the manifest so no stray root file can redirect a lint, and a snapshot cwd works.
 */
export function resolveOxlintEntryConfig(cwd) {
    if (!isOverlayManifest(readManifest(cwd)))
        return null;
    return existsSync(join(cwd, OVERLAY_ENTRY_REL)) ? OVERLAY_ENTRY_REL : null;
}
/** Overlay install per the manifest stamp alone — true even when the entry file has gone missing. */
export function isOverlayOxcInstall(cwd) {
    return isOverlayManifest(readManifest(cwd));
}
/**
 * The read-side mode stamp, as ONE predicate every reader shares. Compared against the only filename
 * devkit writes, so a manifest naming another path cannot redirect a lint's whole ruleset.
 */
function isOverlayManifest(manifest) {
    return manifest?.overlayEntryConfig === OVERLAY_ENTRY_REL;
}
/**
 * WRITE-side mode resolution: explicit flag, then the repository marker, then the stamp LAST —
 * `readManifest` returns null for a corrupt manifest, which is the state doctor --fix repairs.
 */
function resolveOverlayMode(cwd, explicit, stamp) {
    if (explicit !== undefined)
        return explicit;
    if (overlayInstall(cwd))
        return true;
    return Boolean(stamp);
}
function assertNoConfigCollisions(cwd) {
    for (const names of [OXLINT_CONFIGS, OXFMT_CONFIGS]) {
        const found = candidates(cwd, names);
        if (found.length > 1) {
            throw new Error(`multiple Oxc configs in one directory: ${found.join(', ')}`);
        }
    }
}
/** Preflight for a dependent capability; refuses before any managed byte moves. */
export function assertOxcCapabilityReady(cwd, opts = {}) {
    if (opts.publish)
        assertRunnerMayWrite(opts.pinRoot ?? cwd);
    const lint = probeOxcRuntime('lint');
    const fmt = probeOxcRuntime('fmt');
    if (!lint.ok || !fmt.ok || !lint.runtime || !fmt.runtime) {
        throw new Error(`bundled Oxc runtime unavailable: ${lint.detail}; ${fmt.detail}`);
    }
    // Mirrors the writer's own `if (!overlay)`. Caller-passed, not inferred: on a first overlay init
    // the marker is written after `installOverlay`, so inference resolves false when it is true.
    if (!opts.overlay)
        assertNoConfigCollisions(cwd);
}
// Name the devkit that produced the bytes, so a stale digest distinguishes "the content drifted"
// from "a different devkit version wrote this" — the second is invisible without a stamp, and is
// the whole of sc-2100. Works where no node_modules pin exists to compare against (overlay, ship).
function writtenBy(manifest) {
    return manifest.devkitRef ? `written by ${manifest.devkitRef}` : 'writer unrecorded';
}
/** Require the managed base bytes and recorded digest to match the current selected capabilities. */
export function oxcBaseCapabilityIssue(cwd) {
    const manifest = readManifest(cwd);
    if (!manifest)
        return 'managed Oxc manifest is missing or invalid';
    const expected = digest(baseContent(manifest.antiSlop));
    if (manifest.baseDigest !== expected)
        return `managed Oxlint base manifest digest is stale (${writtenBy(manifest)})`;
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
    // Last line of defence: makes a visible root config UNREACHABLE while the repo is still overlaid,
    // even with every mode signal lost. Both remedies are named — the caller's intent is ambiguous.
    if (overlayInstall(cwd)) {
        throw new Error(`refusing to create ${starterPath} in an overlay install: overlay writes no tracked root config. To stay on overlay, run \`devkit init --overlay\` (restores ${OVERLAY_ENTRY_REL}). To convert this repo to a package install, run \`devkit clean\` first.`);
    }
    if (!dryRun)
        writeFileAtomic(join(cwd, starterPath), starter);
    return { path: starterPath, createdDigest: digest(starter) };
}
function syncOxcCapabilityUnlocked(cwd, dryRun, plan) {
    const { antiSlop, pinRoot, allowSkew } = plan;
    const previous = readManifest(cwd);
    const overlay = resolveOverlayMode(cwd, plan.overlay, previous?.overlayEntryConfig);
    const lint = probeOxcRuntime('lint');
    const fmt = probeOxcRuntime('fmt');
    if (!lint.ok || !fmt.ok || !lint.runtime || !fmt.runtime) {
        throw new Error(`bundled Oxc runtime unavailable: ${lint.detail}; ${fmt.detail}`);
    }
    // A consumer's own root configs are irrelevant to an overlay install — it never reads them and
    // never writes one — so a pre-existing pair is not a collision there, only in the owned geometry.
    // Validate both tools before creating either starter: a formatter collision must not leave a
    // half-installed linter config (and vice versa).
    if (!overlay)
        assertNoConfigCollisions(cwd);
    const base = baseContent(antiSlop);
    // Validated HERE, immediately before the first write rather than on entry: the runtime probes
    // above take seconds, and a concurrent `bun install` moving the pin inside that window would let
    // an older devkit publish state the new pin rejects. Dry runs write nothing, so they stay open.
    const skew = dryRun ? null : assertRunnerMayWrite(pinRoot ?? cwd, allowSkew);
    if (!dryRun) {
        mkdirSync(join(cwd, '.devkit', 'oxc'), { recursive: true });
        writeFileAtomic(join(cwd, BASE_REL), base);
    }
    const created = [];
    try {
        // Overlay owns a root entry config outright and never adopts or creates a discovery-named one:
        // `.git/info/exclude` cannot hide a tracked file, and a consumer's is not devkit's to edit.
        const hadOxlint = !overlay && candidates(cwd, OXLINT_CONFIGS).length > 0;
        const oxlint = overlay
            ? { path: OVERLAY_ENTRY_REL, createdDigest: digest(OVERLAY_ENTRY) }
            : ownershipFor(cwd, OXLINT_CONFIGS, '.oxlintrc.json', OXLINT_STARTER, previous?.configs.oxlint, dryRun);
        if (overlay && !dryRun)
            writeFileAtomic(join(cwd, OVERLAY_ENTRY_REL), OVERLAY_ENTRY);
        if (!dryRun && !hadOxlint && !overlay)
            created.push([oxlint.path, digest(OXLINT_STARTER)]);
        if (!dryRun && overlay)
            created.push([OVERLAY_ENTRY_REL, digest(OVERLAY_ENTRY)]);
        const hadOxfmt = overlay || candidates(cwd, OXFMT_CONFIGS).length > 0;
        const oxfmt = overlay
            ? { path: '.oxfmtrc.json', createdDigest: null }
            : ownershipFor(cwd, OXFMT_CONFIGS, '.oxfmtrc.json', OXFMT_STARTER, previous?.configs.oxfmt, dryRun);
        if (!dryRun && !hadOxfmt)
            created.push([oxfmt.path, digest(OXFMT_STARTER)]);
        const manifest = {
            schemaVersion: 1,
            pins: { oxlint: lint.runtime.expectedVersion, oxfmt: fmt.runtime.expectedVersion },
            antiSlop,
            baseDigest: digest(base),
            configs: { oxlint, oxfmt },
        };
        if (overlay)
            manifest.overlayEntryConfig = OVERLAY_ENTRY_REL;
        if (skew?.running)
            manifest.devkitRef = `v${skew.running}`;
        // Only reachable through the visible opt-out — assertRunnerMayWrite throws otherwise.
        if (skew?.kind === 'older')
            manifest.writtenUnderSkew = true;
        if (dryRun) {
            console.log(overlay
                ? `  [dry-run] sync ${BASE_REL} + ${MANIFEST_REL} + ${OVERLAY_ENTRY_REL} (git-excluded); touch no consumer config`
                : `  [dry-run] sync ${BASE_REL} + ${MANIFEST_REL}; preserve existing root configs`);
            return;
        }
        // The pin is re-read once more before the manifest — the LAST write — because nothing devkit
        // holds serialises a concurrent `bun install`. Throwing here leaves the base updated but the
        // manifest's old digest intact, which `oxcBaseCapabilityIssue` reports as drift and the next
        // doctor repairs. A mid-flight pin change therefore fails into a detectable state, never a
        // silent one that a newer pin would later reject without explanation.
        if (skew && runnerSkew(pinRoot ?? cwd).pinned !== skew.pinned) {
            throw new Error(`devkit pin changed to ${runnerSkew(pinRoot ?? cwd).pinned} while publishing managed state (was ${skew.pinned}) — re-run \`devkit doctor --fix\``);
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
export function syncOxcCapability(cwd, { dryRun = false, antiSlop = false, pinRoot, allowSkew, overlay } = {}) {
    // ONE plan value shared by both arms: the dry-run arm previously dropped `pinRoot`/`allowSkew`,
    // so a dry run narrated a different install than the real one. One object makes that impossible.
    const plan = { antiSlop, pinRoot, allowSkew, overlay };
    if (dryRun) {
        syncOxcCapabilityUnlocked(cwd, true, plan);
        return;
    }
    mkdirSync(join(cwd, '.devkit'), { recursive: true });
    withLock(join(cwd, LOCK_REL), () => syncOxcCapabilityUnlocked(cwd, false, plan));
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
    return [runtime, base, ...configRows(cwd, manifest)];
}
/**
 * Mode-dependent config rows. Overlay owns one root file and adopts none, so package-mode ownership
 * questions invert: no phantom oxfmt row, and instead a check for a consumer config `-c` shadows.
 */
function configRows(cwd, manifest) {
    if (!isOverlayManifest(manifest)) {
        return [
            configCheck(cwd, 'oxlint', manifest.configs.oxlint, OXLINT_CONFIGS),
            configCheck(cwd, 'oxfmt', manifest.configs.oxfmt, OXFMT_CONFIGS),
        ];
    }
    const consumer = candidates(cwd, OXLINT_CONFIGS);
    return [
        configCheck(cwd, 'oxlint', manifest.configs.oxlint, [OVERLAY_ENTRY_REL]),
        consumer.length > 0
            ? check('oxlint discovery', 'DRIFT', `this repo now owns ${consumer.join(', ')}, which the overlay gate never reads (\`-c ${OVERLAY_ENTRY_REL}\` replaces discovery)`, 'remove it, or run `devkit clean` and reinstall in package mode')
            : check('oxlint discovery', 'OK', 'no consumer Oxlint config is being shadowed'),
        check('oxfmt config', 'OK', 'not owned in overlay (devkit writes no formatter config here)'),
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
