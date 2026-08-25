/** Coherent, private materialization of the packaged reviewer assets used by review mode. */
import { chmodSync, closeSync, constants, cpSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PACKAGED_REVIEW_ASSET_PATHS, PACKAGED_REVIEW_RUNTIME_ENTRYPOINT, PACKAGED_REVIEW_RUNTIME_MODULE_STEMS, } from '../../../../gate-engine/review/runtime.mjs';
import { readAgentAssetManifest } from '../../install/agent-asset-manifest/reader.mjs';
import { runDirectReviewCli } from './run-direct.mjs';
import { readPinnedReviewFile, reviewRuntimeFileFingerprint, reviewRuntimeFingerprint, } from './runtime-fingerprint.mjs';
import { canonicalReviewDirectory, canonicalReviewLeaf, isSafeReviewRelativePath, reviewPathWithin, } from './runtime-paths.mjs';
import { fail } from './shared/common.mjs';
const SAFE_RUNTIME_PATH = /^[A-Za-z0-9_./-]+$/;
const RUNTIME_MODULE_EXTENSIONS = ['.mjs', '.mts'];
function validateAssetPath(path) {
    if (!isSafeReviewRelativePath(path)) {
        fail(`unsafe packaged reviewer asset path: ${JSON.stringify(path)}`);
    }
}
function validateAssetPaths(paths) {
    const collisions = new Set();
    let previous = '';
    for (const path of paths) {
        validateAssetPath(path);
        if (previous && previous >= path)
            fail('packaged reviewer asset registry must be sorted and unique');
        previous = path;
        const collisionKey = path.toLowerCase();
        if (collisions.has(collisionKey))
            fail(`colliding packaged reviewer asset path: ${JSON.stringify(path)}`);
        collisions.add(collisionKey);
    }
}
function runtimeEntrypointExists(sourceRoot, extension) {
    const candidate = resolve(sourceRoot, `${PACKAGED_REVIEW_RUNTIME_ENTRYPOINT}${extension}`);
    if (!reviewPathWithin(sourceRoot, candidate)) {
        return fail('packaged review runtime entrypoint escapes its package root');
    }
    return lstatSync(candidate, { throwIfNoEntry: false }) !== undefined;
}
/** Resolve exactly the extension the generated hook will select: built `.mjs`, then source `.mts`. */
function packageRuntimePaths(sourceRoot) {
    if (!PACKAGED_REVIEW_RUNTIME_MODULE_STEMS.includes(PACKAGED_REVIEW_RUNTIME_ENTRYPOINT)) {
        return fail('packaged review runtime registry does not contain its entrypoint');
    }
    const extension = RUNTIME_MODULE_EXTENSIONS.find((candidate) => runtimeEntrypointExists(sourceRoot, candidate));
    if (!extension) {
        return fail(`packaged reviewer asset is missing: ${PACKAGED_REVIEW_RUNTIME_ENTRYPOINT}.{mjs,mts}`);
    }
    const paths = Object.freeze([
        ...PACKAGED_REVIEW_ASSET_PATHS,
        ...PACKAGED_REVIEW_RUNTIME_MODULE_STEMS.map((stem) => `${stem}${extension}`),
    ].sort());
    validateAssetPaths(paths);
    return paths;
}
function captureFile(path, label) {
    try {
        const { content, mode } = readPinnedReviewFile(path);
        return { content, mode, fingerprint: reviewRuntimeFileFingerprint(content, mode) };
    }
    catch {
        return fail(`${label} is missing, unreadable, or not a regular file: ${path}`);
    }
}
function sourceAsset(packageRoot, assetPath) {
    const requested = resolve(packageRoot, ...assetPath.split('/'));
    if (!reviewPathWithin(packageRoot, requested))
        return fail(`reviewer asset escapes package root: ${assetPath}`);
    let physical;
    try {
        physical = realpathSync(requested);
    }
    catch {
        return fail(`packaged reviewer asset is missing: ${assetPath}`);
    }
    if (!reviewPathWithin(packageRoot, physical))
        return fail(`reviewer asset escapes package root: ${assetPath}`);
    return physical;
}
function runtimeRoot(sourceRoot, destinationRoot) {
    if (!isAbsolute(destinationRoot))
        return fail('reviewer asset runtime path must be absolute');
    const requested = resolve(destinationRoot);
    if (!SAFE_RUNTIME_PATH.test(requested))
        return fail('reviewer asset runtime path is unsafe for the judge tool grammar');
    if (lstatSync(requested, { throwIfNoEntry: false }) !== undefined)
        return fail(`reviewer asset runtime already exists: ${requested}`);
    const runtime = canonicalReviewLeaf(requested, 'reviewer asset runtime parent');
    if (!SAFE_RUNTIME_PATH.test(runtime))
        return fail('physical reviewer asset runtime path is unsafe for the judge tool grammar');
    if (reviewPathWithin(sourceRoot, runtime) || reviewPathWithin(runtime, sourceRoot))
        return fail('reviewer package and asset runtime must be separate, non-nested directories');
    mkdirSync(runtime, { mode: 0o700 });
    return runtime;
}
function writeCapturedAsset(root, assetPath, asset) {
    const destination = join(root, ...assetPath.split('/'));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, asset.content, { flag: 'wx', mode: 0o600 });
    chmodSync(destination, (asset.mode & 0o111) === 0 ? 0o600 : 0o700);
}
function runtimeFiles(root) {
    const files = [];
    const visit = (directory) => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const stat = lstatSync(path);
            if (stat.isSymbolicLink())
                fail(`reviewer asset runtime contains a symlink: ${path}`);
            if (stat.isDirectory())
                visit(path);
            else if (stat.isFile())
                files.push(relative(root, path).split(sep).join('/'));
            else
                fail(`reviewer asset runtime contains an unsupported entry: ${path}`);
        }
    };
    visit(root);
    return files;
}
function packageShipAssetPaths(sourceRoot) {
    for (const assetPath of packageRuntimePaths(sourceRoot)) {
        captureFile(sourceAsset(sourceRoot, assetPath), 'packaged reviewer asset');
    }
    const paths = ['agents', 'skills']
        .flatMap((directory) => runtimeFiles(join(sourceRoot, directory)).map((path) => `${directory}/${path}`))
        .sort();
    validateAssetPaths(paths);
    return paths;
}
function materializeAssetRuntime(packageRoot, destinationRoot, assetPathsForPackage, expectedSet, hooks) {
    const sourceRoot = canonicalReviewDirectory(packageRoot, 'reviewer package root');
    const assetPaths = assetPathsForPackage(sourceRoot);
    const before = new Map();
    for (const assetPath of assetPaths) {
        before.set(assetPath, captureFile(sourceAsset(sourceRoot, assetPath), 'packaged reviewer asset'));
    }
    let runtime;
    try {
        runtime = runtimeRoot(sourceRoot, destinationRoot);
        for (const assetPath of assetPaths) {
            writeCapturedAsset(runtime, assetPath, before.get(assetPath));
        }
        hooks.beforeSourceVerification?.();
        if (JSON.stringify(assetPathsForPackage(sourceRoot)) !== JSON.stringify(assetPaths)) {
            fail('packaged reviewer assets changed during private runtime capture; retry');
        }
        for (const assetPath of assetPaths) {
            const expected = before.get(assetPath).fingerprint;
            const source = captureFile(sourceAsset(sourceRoot, assetPath), 'packaged reviewer asset');
            const copied = captureFile(join(runtime, ...assetPath.split('/')), 'copied reviewer asset');
            if (source.fingerprint !== expected || copied.fingerprint !== expected)
                fail('packaged reviewer assets changed during private runtime capture; retry');
        }
        if (JSON.stringify(runtimeFiles(runtime)) !== JSON.stringify(assetPaths))
            fail(`private reviewer asset runtime does not match the ${expectedSet}`);
        return {
            root: runtime,
            fingerprint: reviewRuntimeFingerprint(runtime),
            paths: assetPaths,
        };
    }
    catch (cause) {
        if (runtime)
            rmSync(runtime, { recursive: true, force: true });
        throw cause;
    }
}
/** Copy the exact registered reviewer assets and return the private tree's integrity fingerprint. */
export function materializeReviewAssetRuntime(packageRoot, destinationRoot, hooks = {}) {
    return materializeAssetRuntime(packageRoot, destinationRoot, packageRuntimePaths, 'registered asset set', hooks);
}
/** Copy every packaged agent and skill for a ship/reship worktree projection. */
export function materializeShipAssetRuntime(packageRoot, destinationRoot) {
    return materializeAssetRuntime(packageRoot, destinationRoot, packageShipAssetPaths, 'packaged agent/skill set', {});
}
function claudeManifestOwnedNames(root, kind) {
    const sourceRoot = canonicalReviewDirectory(root, 'ship source root');
    let decoded;
    try {
        decoded = readAgentAssetManifest(join(sourceRoot, '.devkit', `${kind}-manifest.json`), kind);
    }
    catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return fail(`could not read ${kind} ownership manifest: ${message}`);
    }
    if (!decoded)
        return [];
    const files = decoded.version === 1
        ? decoded.manifest.targets.includes('claude')
            ? decoded.manifest.files
            : {}
        : (decoded.manifest.providers.claude?.files ?? {});
    return [
        ...new Set(Object.keys(files)
            .map((path) => path.split('/')[0])
            .filter(Boolean)),
    ].sort();
}
function shipAssetName(name, kind, source) {
    if (!isSafeReviewRelativePath(name) || name.includes('/')) {
        return fail(`unsafe ${source} ${kind} name: ${JSON.stringify(name)}`);
    }
    return name;
}
function manifestOwnedNames(path, kind) {
    const content = readFileSync(path);
    if (content.length === 0)
        return [];
    if (content[content.length - 1] !== 0) {
        return fail(`${kind} ownership list is not NUL terminated`);
    }
    return content
        .subarray(0, -1)
        .toString('utf8')
        .split('\0')
        .map((name) => shipAssetName(name, kind, 'manifest-owned'));
}
function enterPinnedDirectory(path, label) {
    let descriptor;
    try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    }
    catch {
        return fail(`${label} must be a real directory and must not change during projection`);
    }
    try {
        const opened = fstatSync(descriptor, { bigint: true });
        process.chdir(path);
        const entered = statSync('.', { bigint: true });
        if (!opened.isDirectory() ||
            !entered.isDirectory() ||
            opened.dev !== entered.dev ||
            opened.ino !== entered.ino) {
            fail(`${label} changed during projection`);
        }
        return descriptor;
    }
    catch (cause) {
        closeSync(descriptor);
        throw cause;
    }
}
export function projectShipAssetKind(worktree, runtimeRootPath, ownedNamesPath, kind, rename = renameSync) {
    const runtime = canonicalReviewDirectory(runtimeRootPath, `ship reviewer ${kind} runtime`);
    runtimeFiles(runtime);
    const packaged = readdirSync(runtime)
        .sort()
        .map((name) => shipAssetName(name, kind, 'packaged'));
    const owned = manifestOwnedNames(ownedNamesPath, kind);
    const replacements = [...new Set([...owned, ...packaged])].sort();
    const descriptors = [];
    const quarantined = [];
    const installed = [];
    const originalCwd = process.cwd();
    let staging;
    let cleanStaging = true;
    try {
        try {
            descriptors.push(enterPinnedDirectory(worktree, 'ship reviewer worktree'));
            descriptors.push(enterPinnedDirectory('.claude', 'ship reviewer .claude root'));
            descriptors.push(enterPinnedDirectory(kind, `ship reviewer ${kind} root`));
            staging = realpathSync(mkdtempSync('.devkit-review-assets-'));
            const quarantine = join(staging, '.quarantine');
            mkdirSync(quarantine);
            for (const name of packaged) {
                cpSync(join(runtime, name), join(staging, name), {
                    recursive: true,
                    errorOnExist: true,
                    force: false,
                });
            }
            for (const [index, name] of replacements.entries()) {
                if (lstatSync(name, { throwIfNoEntry: false }) !== undefined) {
                    const path = join(quarantine, String(index));
                    rename(name, path);
                    quarantined.push({ name, path });
                }
            }
            for (const name of packaged) {
                rename(join(staging, name), name);
                installed.push(name);
            }
        }
        catch (cause) {
            const rollbackFailures = [];
            for (const name of installed.reverse()) {
                try {
                    rmSync(name, { recursive: true, force: true });
                }
                catch (rollbackCause) {
                    rollbackFailures.push(rollbackCause);
                }
            }
            for (const entry of quarantined.reverse()) {
                try {
                    if (lstatSync(entry.name, { throwIfNoEntry: false }) !== undefined) {
                        throw new Error(`cannot restore occupied reviewer asset: ${entry.name}`);
                    }
                    rename(entry.path, entry.name);
                }
                catch (rollbackCause) {
                    rollbackFailures.push(rollbackCause);
                }
            }
            if (rollbackFailures.length > 0) {
                cleanStaging = false;
                throw new AggregateError([cause, ...rollbackFailures], `ship reviewer ${kind} projection failed; recovery assets retained in ${staging}`);
            }
            throw cause;
        }
        finally {
            if (staging && cleanStaging)
                rmSync(staging, { recursive: true, force: true });
            for (const descriptor of descriptors.reverse())
                closeSync(descriptor);
        }
    }
    finally {
        process.chdir(originalCwd);
    }
}
/** Recheck both the packaged source and its immutable private copy after target hooks run. */
export function verifyReviewAssetRuntime(packageRoot, runtimeRootPath, expectedFingerprint) {
    const sourceRoot = canonicalReviewDirectory(packageRoot, 'reviewer package root');
    const assetPaths = packageRuntimePaths(sourceRoot);
    const runtime = canonicalReviewDirectory(runtimeRootPath, 'reviewer asset runtime');
    if (reviewPathWithin(sourceRoot, runtime) || reviewPathWithin(runtime, sourceRoot)) {
        fail('reviewer package and asset runtime must be separate, non-nested directories');
    }
    if (JSON.stringify(runtimeFiles(runtime)) !== JSON.stringify(assetPaths)) {
        fail('private reviewer asset runtime does not match the registered asset set');
    }
    if (reviewRuntimeFingerprint(runtime) !== expectedFingerprint) {
        fail('private reviewer asset runtime changed while review was running');
    }
    for (const assetPath of assetPaths) {
        const source = captureFile(sourceAsset(sourceRoot, assetPath), 'packaged reviewer asset');
        const copied = captureFile(join(runtime, ...assetPath.split('/')), 'copied reviewer asset');
        if (source.fingerprint !== copied.fingerprint) {
            fail(`packaged reviewer asset changed while review was running: ${assetPath}`);
        }
    }
}
function runCli(args) {
    if (args[0] === 'materialize' && args.length === 3) {
        const result = materializeReviewAssetRuntime(args[1], args[2]);
        process.stdout.write(result.fingerprint);
        return;
    }
    if (args[0] === 'materialize-ship' && args.length === 3) {
        const packageRoot = args[1];
        const destinationRoot = args[2];
        if (packageRoot === undefined || destinationRoot === undefined) {
            fail('materialize-ship requires package and destination roots');
        }
        const result = materializeShipAssetRuntime(packageRoot, destinationRoot);
        process.stdout.write(result.fingerprint);
        return;
    }
    if (args[0] === 'manifest-owned' && args.length === 3) {
        const root = args[1];
        const kind = args[2];
        if (root === undefined || (kind !== 'agents' && kind !== 'skills')) {
            fail('manifest-owned requires a root and agents or skills');
        }
        for (const name of claudeManifestOwnedNames(root, kind))
            process.stdout.write(`${name}\0`);
        return;
    }
    if (args[0] === 'project-ship-kind' && args.length === 5) {
        const [worktree, runtimeRootPath, ownedNamesPath, kind] = args.slice(1);
        if (worktree === undefined ||
            runtimeRootPath === undefined ||
            ownedNamesPath === undefined ||
            (kind !== 'agents' && kind !== 'skills')) {
            fail('project-ship-kind requires worktree, runtime, ownership list, and agents or skills');
        }
        projectShipAssetKind(worktree, runtimeRootPath, ownedNamesPath, kind);
        return;
    }
    if (args[0] === 'verify' && args.length === 4) {
        verifyReviewAssetRuntime(args[1], args[2], args[3]);
        return;
    }
    // Backward-compatible private CLI used by the runtime-safety slice's focused tests.
    if (args.length === 2) {
        const result = materializeReviewAssetRuntime(args[0], args[1]);
        process.stdout.write(result.fingerprint);
        return;
    }
    fail('usage: asset-runtime materialize[-ship] <package-root> <destination-root> | manifest-owned <root> <agents|skills> | project-ship-kind <worktree> <runtime-root> <owned-names> <agents|skills> | verify <package-root> <runtime-root> <fingerprint>');
}
runDirectReviewCli(import.meta.url, runCli);
