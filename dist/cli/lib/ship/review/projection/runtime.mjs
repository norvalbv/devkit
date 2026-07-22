/** Private, manifest-backed gate-input projections for an isolated review worktree. */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runDirectReviewCli } from "../run-direct.mjs";
import { reviewRuntimeFingerprint } from "../runtime-fingerprint.mjs";
import { assertSymlinkFreeReviewTree, canonicalReviewDirectory, canonicalReviewLeaf, isSafeReviewRelativePath, reviewPathWithin, safeReviewDestination, } from "../runtime-paths.mjs";
import { resolveReviewSource } from "../source-projection.mjs";
const VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;
const SQLITE_SUFFIXES = ['', '-wal', '-shm', '-journal'];
// Ratchet/cache gates legitimately update their own ignored baseline/cache state during a run, so
// these roots are allowed to drift between the captured source and the private copy (verify checks
// only that they stay symlink-free); every other projected root is immutable and must match exactly.
const MUTABLE_ROOTS = ['.fallow', 'fallow-baselines', '.decisions', 'eslint/baselines'];
const PRESENT_STATE_TYPES = ['file', 'directory', 'link-file', 'link-directory'];
const LINK_STATE_FIELDS = ['linkTarget', 'linkPath', 'physicalPath'];
function fail(message) {
    throw new Error(`devkit review: ${message}`);
}
function manifestHash(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function safeRelativePath(path) {
    if (!isSafeReviewRelativePath(path) || path === '.git' || path.startsWith('.git/')) {
        return fail(`unsafe gate projection path: ${JSON.stringify(path)}`);
    }
    return path;
}
function absolutePath(root, path) {
    const safe = safeRelativePath(path);
    const absolute = resolve(root, ...safe.split('/'));
    if (!reviewPathWithin(root, absolute))
        fail(`gate projection escapes its root: ${path}`);
    return absolute;
}
function captureState(root, path, allowLinks) {
    const source = resolveReviewSource(root, safeRelativePath(path), {
        allowProjection: allowLinks,
    });
    const stat = lstatSync(source.physicalPath, { throwIfNoEntry: false });
    if (stat === undefined)
        return { type: 'absent' };
    assertSymlinkFreeReviewTree(source.physicalPath, 'gate projection', 'unsupported entry');
    if (source.projection) {
        return {
            type: stat.isDirectory() ? 'link-directory' : 'link-file',
            fingerprint: reviewRuntimeFingerprint(source.physicalPath),
            linkTarget: source.projection.linkTarget,
            linkPath: source.projection.linkPath,
            physicalPath: source.projection.physicalPath,
        };
    }
    return {
        type: stat.isDirectory() ? 'directory' : 'file',
        fingerprint: reviewRuntimeFingerprint(source.physicalPath),
    };
}
function stateMatches(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function copySafeTree(source, destination) {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink())
        fail(`gate projection contains a nested symlink: ${source}`);
    if (stat.isFile()) {
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination);
        const copiedMode = lstatSync(destination).mode;
        chmodSync(destination, (stat.mode & 0o111) === 0 ? copiedMode & ~0o111 : copiedMode | 0o111);
        return;
    }
    if (!stat.isDirectory())
        fail(`gate projection contains an unsupported entry: ${source}`);
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source).sort()) {
        copySafeTree(join(source, name), join(destination, name));
    }
}
function mutablePath(path, indexPath) {
    if (indexPath && SQLITE_SUFFIXES.some((suffix) => path === `${indexPath}${suffix}`))
        return true;
    return MUTABLE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}
function pathDepth(path) {
    return path.split('/').length;
}
function candidatePaths(candidates, indexPath) {
    const unique = new Set();
    for (const candidate of candidates)
        unique.add(safeRelativePath(candidate));
    const ordered = [...unique].sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right));
    const result = [];
    for (const path of ordered) {
        if (result.some((parent) => path.startsWith(`${parent}/`)))
            continue;
        if (path === indexPath)
            result.push(...SQLITE_SUFFIXES.map((suffix) => `${path}${suffix}`));
        else
            result.push(path);
    }
    return result;
}
function validateRoots(sourceRoot, destinationRoot) {
    const source = canonicalReviewDirectory(sourceRoot, 'gate projection source');
    const destination = canonicalReviewDirectory(destinationRoot, 'gate projection destination');
    if (reviewPathWithin(source, destination) || reviewPathWithin(destination, source)) {
        fail('gate projection source and destination must be separate, non-nested directories');
    }
    return [source, destination];
}
function validateManifestPath(path, source, destination) {
    const manifest = canonicalReviewLeaf(path, 'gate projection manifest parent');
    if (reviewPathWithin(source, manifest) || reviewPathWithin(destination, manifest)) {
        fail('gate projection manifest must live outside source and destination roots');
    }
    if (lstatSync(manifest, { throwIfNoEntry: false }) !== undefined) {
        fail('gate projection manifest already exists');
    }
    return manifest;
}
function privateDestination(root, path) {
    return safeReviewDestination(root, path, 'gate projection escapes its root', 'gate projection has an unsafe destination parent');
}
function sqliteFamilyPath(path, indexPath) {
    return Boolean(indexPath && SQLITE_SUFFIXES.some((suffix) => path === `${indexPath}${suffix}`));
}
function selectProjections(source, destination, candidates, indexPath) {
    const selected = [];
    for (const path of candidatePaths(candidates, indexPath)) {
        if (lstatSync(privateDestination(destination, path), { throwIfNoEntry: false }) !== undefined) {
            continue;
        }
        const sourceBefore = captureState(source, path, true);
        if (sourceBefore.type === 'absent' && !sqliteFamilyPath(path, indexPath))
            continue;
        selected.push({ path, source: sourceBefore });
    }
    return selected;
}
function selectedSourcePath(source, selected) {
    if (selected.source.type === 'link-file' || selected.source.type === 'link-directory') {
        return selected.source.physicalPath;
    }
    return absolutePath(source, selected.path);
}
function copySelectedProjections(source, destination, selected, created, hooks) {
    for (const entry of selected) {
        if (entry.source.type === 'absent')
            continue;
        const target = privateDestination(destination, entry.path);
        if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
            fail(`private gate projection destination changed during capture: ${entry.path}; retry`);
        }
        created.push(target);
        hooks.beforePrivateCopy?.(entry.path);
        copySafeTree(selectedSourcePath(source, entry), target);
    }
}
function verifySelectedProjection(source, destination, selected, indexPath) {
    const sourceAfter = captureState(source, selected.path, true);
    if (!stateMatches(selected.source, sourceAfter)) {
        fail('gate projections changed during capture; retry');
    }
    const destinationAfter = captureState(destination, selected.path, false);
    if (selected.source.type !== 'absent' &&
        (destinationAfter.type === 'absent' ||
            selected.source.fingerprint !== destinationAfter.fingerprint)) {
        fail('private gate projection does not match its captured source');
    }
    return {
        path: selected.path,
        mutable: mutablePath(selected.path, indexPath),
        source: selected.source,
        destination: destinationAfter,
    };
}
function projectionManifest(sourceRoot, destinationRoot, entries) {
    const unsigned = {
        version: VERSION,
        sourceRoot,
        destinationRoot,
        entries,
    };
    return { ...unsigned, selfHash: manifestHash(unsigned) };
}
/** Copy absent gate inputs into a private worktree and authenticate their source state. */
export function materializeProjectionRuntime(sourceRoot, destinationRoot, manifestPath, candidates, indexPath = '', hooks = {}) {
    const [source, destination] = validateRoots(sourceRoot, destinationRoot);
    const manifestDestination = validateManifestPath(manifestPath, source, destination);
    const created = [];
    try {
        const selected = selectProjections(source, destination, candidates, indexPath);
        copySelectedProjections(source, destination, selected, created, hooks);
        hooks.beforeSourceVerification?.();
        const entries = selected.map((entry) => verifySelectedProjection(source, destination, entry, indexPath));
        const manifest = projectionManifest(source, destination, entries);
        writeFileSync(manifestDestination, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
        return manifest;
    }
    catch (cause) {
        for (const path of created.reverse())
            rmSync(path, { recursive: true, force: true });
        throw cause;
    }
}
function recordValue(value, message) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(message);
    return value;
}
function isPresentStateType(value) {
    return PRESENT_STATE_TYPES.some((type) => value === type);
}
function requiredLinkString(state, field) {
    const value = state[field];
    if (typeof value !== 'string')
        fail('invalid projection link state');
    return value;
}
function validateLinkedState(state) {
    requiredLinkString(state, 'linkTarget');
    const linkPath = requiredLinkString(state, 'linkPath');
    if (!isSafeReviewRelativePath(linkPath))
        fail('invalid projection link state');
    const physicalPath = requiredLinkString(state, 'physicalPath');
    if (!isAbsolute(physicalPath))
        fail('invalid projection link state');
}
function validateUnlinkedState(state) {
    for (const field of LINK_STATE_FIELDS) {
        if (state[field] !== undefined)
            fail('invalid projection link state');
    }
}
function validateLinkState(state, linked) {
    if (linked)
        validateLinkedState(state);
    else
        validateUnlinkedState(state);
}
function parseState(value) {
    const state = recordValue(value, 'invalid projection state');
    if (state.type === 'absent') {
        if (Object.keys(state).length !== 1)
            fail('invalid projection state');
        return { type: 'absent' };
    }
    if (!isPresentStateType(state.type) ||
        typeof state.fingerprint !== 'string' ||
        !SHA256.test(state.fingerprint)) {
        fail('invalid projection state');
    }
    validateLinkState(state, state.type.startsWith('link-'));
    return state;
}
function readManifestJson(path) {
    let value;
    try {
        value = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return fail('could not read gate projection manifest');
    }
    return value;
}
function parseManifestHeader(value) {
    const raw = recordValue(value, 'invalid projection manifest');
    if (raw.version !== VERSION ||
        typeof raw.sourceRoot !== 'string' ||
        typeof raw.destinationRoot !== 'string' ||
        !Array.isArray(raw.entries) ||
        typeof raw.selfHash !== 'string') {
        fail('invalid projection manifest');
    }
    return raw;
}
function parseEntry(value) {
    const candidate = recordValue(value, 'invalid projection entry');
    if (typeof candidate.path !== 'string' || typeof candidate.mutable !== 'boolean') {
        fail('invalid projection entry');
    }
    return {
        path: safeRelativePath(candidate.path),
        mutable: candidate.mutable,
        source: parseState(candidate.source),
        destination: parseState(candidate.destination),
    };
}
function readManifest(path) {
    const raw = parseManifestHeader(readManifestJson(path));
    const entries = raw.entries.map(parseEntry);
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
        fail('duplicate projection manifest path');
    }
    const unsigned = {
        version: VERSION,
        sourceRoot: raw.sourceRoot,
        destinationRoot: raw.destinationRoot,
        entries,
    };
    if (manifestHash(unsigned) !== raw.selfHash)
        fail('gate projection manifest self-hash is invalid');
    return { ...unsigned, selfHash: raw.selfHash };
}
/** Verify immutable copies and every source after target-controlled hook code has executed. */
export function verifyProjectionRuntime(sourceRoot, destinationRoot, manifestPath) {
    const [source, destination] = validateRoots(sourceRoot, destinationRoot);
    const manifest = readManifest(manifestPath);
    if (manifest.sourceRoot !== source || manifest.destinationRoot !== destination) {
        fail('gate projection manifest belongs to different roots');
    }
    for (const entry of manifest.entries) {
        if (!stateMatches(captureState(source, entry.path, true), entry.source)) {
            fail(`target gate projection changed while review was running: ${entry.path}`);
        }
        const current = captureState(destination, entry.path, false);
        if (!entry.mutable && !stateMatches(current, entry.destination)) {
            fail(`private immutable gate projection changed while review was running: ${entry.path}`);
        }
    }
    return manifest;
}
export function mutableProjectionRoots(manifestPath) {
    const paths = readManifest(manifestPath)
        .entries.filter((entry) => entry.mutable)
        .map((entry) => entry.path);
    return paths.filter((path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)));
}
function stdinCandidates() {
    const input = readFileSync(0);
    if (input.length === 0)
        return [];
    if (input[input.length - 1] !== 0)
        fail('gate projection candidate input is not NUL terminated');
    return input.subarray(0, -1).toString('utf8').split('\0').filter(Boolean);
}
function runCli(args) {
    if (args[0] === 'materialize' && args.length === 5) {
        materializeProjectionRuntime(args[1], args[2], args[3], stdinCandidates(), args[4]);
        return;
    }
    if (args[0] === 'verify' && args.length === 4) {
        verifyProjectionRuntime(args[1], args[2], args[3]);
        return;
    }
    if (args[0] === 'mutable' && args.length === 2) {
        for (const path of mutableProjectionRoots(args[1]))
            process.stdout.write(`${path}\0`);
        return;
    }
    fail('usage: projection-runtime materialize <source> <destination> <manifest> <index-path> | verify <source> <destination> <manifest> | mutable <manifest>');
}
runDirectReviewCli(import.meta.url, runCli);
