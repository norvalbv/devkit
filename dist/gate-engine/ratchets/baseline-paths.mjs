import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertBaselineTrackable, indexTracksBaseline, stageBaselineMigration, stageBaseline, } from './git-index.mjs';
export const FANOUT_BASELINE = '.devkit/baselines/fanout.json';
export const LINES_BASELINE = '.devkit/baselines/size-lines.json';
export const SIZE_BASELINE = '.devkit/baselines/size.json';
export const LEGACY_FANOUT_BASELINE = 'eslint/baselines/fanout.json';
export const LEGACY_LINES_BASELINE = 'eslint/baselines/size-lines.json';
export const LEGACY_SIZE_BASELINE = 'eslint/baselines/size.json';
export const IMPORT_WALL_BASELINE = '.devkit/baselines/imports.mjs';
export const STRUCTURE_BASELINE_DIR = '.devkit/baselines/structure';
export const STRUCTURE_EXEMPT = '.devkit/structure/exempt.mjs';
export const LEGACY_IMPORT_WALL_BASELINE = 'eslint/baselines/imports.mjs';
export const LEGACY_STRUCTURE_BASELINE_DIR = 'eslint/baselines';
export const LEGACY_STRUCTURE_EXEMPT = 'eslint/baselines/exempt.mjs';
const LEGACY_RATCHET_BASELINES = [
    { from: LEGACY_FANOUT_BASELINE, to: FANOUT_BASELINE },
    { from: LEGACY_LINES_BASELINE, to: LINES_BASELINE },
    { from: LEGACY_SIZE_BASELINE, to: SIZE_BASELINE },
];
function legacyDevkitBaselines(root) {
    const legacyDir = join(root, LEGACY_STRUCTURE_BASELINE_DIR);
    const canonicalDir = join(root, STRUCTURE_BASELINE_DIR);
    const modules = new Set([legacyDir, canonicalDir].flatMap((dir) => existsSync(dir)
        ? readdirSync(dir).filter((name) => name.endsWith('.mjs') && name !== 'imports.mjs' && name !== 'exempt.mjs')
        : []));
    return [
        ...LEGACY_RATCHET_BASELINES,
        { from: LEGACY_IMPORT_WALL_BASELINE, to: IMPORT_WALL_BASELINE },
        { from: LEGACY_STRUCTURE_EXEMPT, to: STRUCTURE_EXEMPT },
        ...[...modules].sort().map((name) => ({
            from: `${LEGACY_STRUCTURE_BASELINE_DIR}/${name}`,
            to: `${STRUCTURE_BASELINE_DIR}/${name}`,
        })),
    ];
}
const BASELINE_SETTLE = new Int32Array(new SharedArrayBuffer(4));
const MODULE_TOKEN_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s+|./g;
function comparableModuleTokens(contents) {
    return (contents.toString('utf8').match(MODULE_TOKEN_RE) ?? [])
        .filter((token) => !/^\s|^\/\//.test(token) && !token.startsWith('/*'))
        .join('');
}
function sameBaselineDebt(left, right) {
    if (left.equals(right))
        return true;
    try {
        return isDeepStrictEqual(JSON.parse(left.toString('utf8')), JSON.parse(right.toString('utf8')));
    }
    catch {
        // MJS baselines are declarative exports. Ignore comments and formatting while retaining every
        // executable token, so a generated-header change cannot masquerade as different debt.
        return comparableModuleTokens(left) === comparableModuleTokens(right);
    }
}
function canCopyAfterLinkFailure(error) {
    return error.code === 'EXDEV' || error.code === 'EPERM';
}
function createBaselineExclusively(path, contents) {
    writeFileSync(path, contents, { flag: 'wx' });
}
function hasStableBaselineConflict(canonicalFile, legacyFile) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const canonical = readExisting(canonicalFile);
        const legacy = readExisting(legacyFile);
        if (canonical === null || legacy === null || sameBaselineDebt(canonical, legacy))
            return false;
        if (attempt < 19)
            Atomics.wait(BASELINE_SETTLE, 0, 0, 5);
    }
    return true;
}
function concurrentBaselineCreateSettled(canonicalFile, legacyFile, expected) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const canonical = readExisting(canonicalFile);
        const legacy = readExisting(legacyFile);
        if (canonical !== null) {
            if (sameBaselineDebt(canonical, expected))
                return true;
            if (legacy !== null && sameBaselineDebt(canonical, legacy))
                return true;
            if (legacy === null) {
                try {
                    JSON.parse(canonical.toString('utf8'));
                    return true;
                }
                catch {
                    // The exclusive creator has published the name but is still writing its bytes.
                }
            }
        }
        if (attempt < 19)
            Atomics.wait(BASELINE_SETTLE, 0, 0, 5);
    }
    return false;
}
/** Read debt across a concurrent legacy→canonical move without observing a false missing state. */
export function readRatchetBaseline(root, canonical, legacy) {
    const read = (relativePath) => {
        const bytes = readExisting(join(root, relativePath));
        return bytes ? { contents: bytes.toString('utf8'), relativePath } : null;
    };
    return read(canonical) ?? read(legacy) ?? read(canonical);
}
/** Persist current debt canonically; removing the legacy copy makes a concurrent migration safe. */
export function writeRatchetBaseline(root, canonical, legacy, contents, { stage = false, link = linkSync } = {}) {
    const overlay = (() => {
        if (process.env.DEVKIT_OVERLAY === '1')
            return true;
        try {
            // SAFETY: init owns this local JSON marker; strict equality treats absent values as false.
            return (JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8')).overlay === true);
        }
        catch {
            return false;
        }
    })();
    if (!overlay)
        assertBaselineTrackable(root, canonical);
    const canonicalFile = join(root, canonical);
    const legacyFile = join(root, legacy);
    mkdirSync(dirname(canonicalFile), { recursive: true });
    if (hasStableBaselineConflict(canonicalFile, legacyFile)) {
        throw new Error(`Devkit ratchet baseline write stopped: ${legacy} and ${canonical} contain different debt ceilings.`);
    }
    const canonicalBytes = readExisting(canonicalFile);
    const legacyBytes = readExisting(legacyFile);
    if (canonicalBytes === null && legacyBytes !== null) {
        // Update the legacy inode first. A simultaneous migration hard-links this same inode, so both
        // names are identical for their entire overlap and the newer write cannot be stranded.
        writeFileSync(legacyFile, contents);
        try {
            link(legacyFile, canonicalFile);
        }
        catch (error) {
            const concurrentCanonical = readExisting(canonicalFile);
            if (concurrentCanonical === null) {
                // SAFETY: link() follows Node's filesystem contract and reports failures as ErrnoException.
                const linkFailure = error;
                if (!canCopyAfterLinkFailure(linkFailure))
                    throw error;
                // Copying the shared legacy path can capture a peer's bytes. Persist this writer's payload.
                writeFileSync(canonicalFile, contents);
            }
            else
                writeFileSync(canonicalFile, contents);
        }
    }
    else {
        writeFileSync(canonicalFile, contents);
    }
    rmSync(legacyFile, { force: true });
    if (stage) {
        stageBaseline(root, canonical);
        stageBaseline(root, legacy);
    }
}
/** Clear debt from both storage generations so migration cannot preserve a stale copy. */
export function removeRatchetBaseline(root, canonical, legacy, { stage = false } = {}) {
    rmSync(join(root, canonical), { force: true });
    rmSync(join(root, legacy), { force: true });
    if (stage) {
        stageBaseline(root, canonical);
        stageBaseline(root, legacy);
    }
}
function readExisting(path) {
    try {
        return readFileSync(path);
    }
    catch (error) {
        // SAFETY: Node filesystem failures carry ErrnoException.code; unknown failures are rethrown.
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
/**
 * Move Devkit-owned ratchet state out of the ESLint policy directory without re-snapshotting it.
 * Every conflict is checked before the first write so a partial migration cannot split authority.
 */
export function migrateRatchetBaselines(root, { dryRun = false, link = linkSync, create = createBaselineExclusively, } = {}) {
    const legacyBaselines = legacyDevkitBaselines(root);
    const present = legacyBaselines.flatMap(({ from, to }) => {
        const bytes = readExisting(join(root, from));
        return bytes ? [{ bytes, from, to }] : [];
    });
    // Recover cleanly if a prior run moved the file but Git staging was interrupted: the old index
    // entry still protects the debt, and this pass finishes the tracked rename.
    const pendingIndexMoves = legacyBaselines.flatMap(({ from, to }) => !existsSync(join(root, from)) && existsSync(join(root, to)) && indexTracksBaseline(root, from)
        ? [{ from, to }]
        : []);
    const conflicts = present.filter(({ from, to }) => {
        return hasStableBaselineConflict(join(root, to), join(root, from));
    });
    if (conflicts.length > 0) {
        const details = conflicts
            .map(({ from, to }) => `both ${from} and ${to} exist with different contents`)
            .join('; ');
        throw new Error(`Devkit ratchet baseline migration stopped: ${details}. Keep the intended debt ceiling, remove the other copy, then rerun.`);
    }
    const planned = [
        ...present.map(({ from, to }) => ({
            reconcileIndexOnly: false,
            action: {
                from,
                to,
                kind: existsSync(join(root, to)) ? 'removed-duplicate' : 'moved',
            },
        })),
        ...pendingIndexMoves.map(({ from, to }) => ({
            reconcileIndexOnly: true,
            action: { from, to, kind: 'moved' },
        })),
    ];
    const actions = planned.map(({ action }) => action);
    if (dryRun)
        return actions;
    // Preflight every destination before the first filesystem mutation.
    for (const { action } of planned)
        assertBaselineTrackable(root, action.to);
    for (const { action, reconcileIndexOnly } of planned) {
        if (reconcileIndexOnly) {
            stageBaselineMigration(root, action.from, action.to);
            continue;
        }
        const legacy = join(root, action.from);
        const canonical = join(root, action.to);
        const currentLegacy = readExisting(legacy);
        const currentCanonical = readExisting(canonical);
        if (currentLegacy === null) {
            if (currentCanonical === null)
                stageBaseline(root, action.from);
            else
                stageBaselineMigration(root, action.from, action.to);
            continue;
        }
        if (currentCanonical !== null) {
            if (!sameBaselineDebt(currentLegacy, currentCanonical)) {
                throw new Error(`Devkit ratchet baseline migration stopped: both ${action.from} and ${action.to} exist with different debt ceilings.`);
            }
            rmSync(legacy, { force: true });
        }
        else {
            mkdirSync(dirname(canonical), { recursive: true });
            try {
                link(legacy, canonical);
            }
            catch (error) {
                const concurrentCanonical = readExisting(canonical);
                const concurrentLegacy = readExisting(legacy);
                if (concurrentCanonical === null && concurrentLegacy === null) {
                    stageBaseline(root, action.from);
                    continue;
                }
                // SAFETY: link() follows Node's filesystem contract and reports failures as ErrnoException.
                const linkFailure = error;
                if (concurrentCanonical === null &&
                    concurrentLegacy !== null &&
                    canCopyAfterLinkFailure(linkFailure)) {
                    try {
                        // Exclusive creation prevents a migration from overwriting a writer that won the race.
                        create(canonical, concurrentLegacy);
                    }
                    catch (createError) {
                        // SAFETY: create() follows Node's filesystem contract and reports failures as ErrnoException.
                        const createFailure = createError;
                        if (createFailure.code !== 'EEXIST' ||
                            !concurrentBaselineCreateSettled(canonical, legacy, concurrentLegacy)) {
                            throw createError;
                        }
                    }
                }
                else if (concurrentCanonical === null ||
                    (concurrentLegacy !== null && !sameBaselineDebt(concurrentLegacy, concurrentCanonical))) {
                    throw error;
                }
            }
            rmSync(legacy, { force: true });
        }
        stageBaselineMigration(root, action.from, action.to);
    }
    return actions;
}
/** Migrate and print the lifecycle action in the init/upgrade progress stream. */
export function reportRatchetBaselineMigration(root, dryRun) {
    const migrations = migrateRatchetBaselines(root, { dryRun });
    if (migrations.length === 0)
        return;
    console.log('0. devkit baseline storage');
    for (const migration of migrations) {
        const action = migration.kind === 'moved' ? 'move' : 'remove duplicate';
        console.log(`  ${dryRun ? '[dry-run] ' : '✓ '}${action} ${migration.from} → ${migration.to}`);
    }
    console.log('');
}
