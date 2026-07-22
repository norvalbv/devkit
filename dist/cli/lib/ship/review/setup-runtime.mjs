/** Manifest-only materialization of target-controlled setup into a private review worktree. */
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { runDirectReviewCli } from "./run-direct.mjs";
import { reviewRuntimeFingerprint } from "./runtime-fingerprint.mjs";
import { assertSymlinkFreeReviewTree, canonicalReviewDirectory, canonicalReviewLeaf, isSafeReviewRelativePath, reviewPathWithin, } from "./runtime-paths.mjs";
import { copyMergedReviewSetup, reviewSetupStat, safeReviewSetupDestination, } from "./setup/setup-runtime-copy.mjs";
import { REVIEW_SETUP_ABSENT, reviewSetupHash } from "./setup-manifest-format.mjs";
import { parseReviewSetupManifest } from "./setup-manifest-parse.mjs";
import { encodeReviewSetupRuntimeFields, parseReviewSetupRuntimeManifest, reviewSetupRuntimeHash, REVIEW_SETUP_RUNTIME_VERSION as VERSION, } from "./setup-runtime-format.mjs";
import { resolveReviewSource } from "./source-projection.mjs";
const CHAIN_MIRROR = '.devkit/review-chain-root';
export { encodeReviewSetupRuntimeFields } from "./setup-runtime-format.mjs";
function fail(message) {
    throw new Error(`devkit review: ${message}`);
}
function canonicalManifestRoot(path, label) {
    const canonical = canonicalReviewDirectory(path, label);
    if (canonical !== path)
        fail(`${label} no longer resolves to its captured location.`);
    return canonical;
}
function repositoryRelative(gitRoot, targetRoot) {
    const value = relative(gitRoot, targetRoot);
    if (isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`)) {
        return fail('frozen target root escapes its Git root.');
    }
    const normalized = value.split(sep).join('/');
    if (normalized && !isSafeReviewRelativePath(normalized)) {
        return fail('frozen target root has an unsafe repository-relative path.');
    }
    return normalized || '.';
}
function sourceRoot(context, entry) {
    return entry.root === 'target' ? context.targetRoot : context.gitRoot;
}
function setupContext(manifest) {
    const gitRoot = canonicalManifestRoot(manifest.gitRoot, 'frozen target Git root');
    const targetRoot = canonicalManifestRoot(manifest.targetRoot, 'frozen target root');
    if (!reviewPathWithin(gitRoot, targetRoot))
        fail('frozen target root escapes its Git root.');
    return {
        manifest,
        targetRoot,
        gitRoot,
        targetRelativePath: repositoryRelative(gitRoot, targetRoot),
    };
}
function authenticatedFingerprint(projection, runtime) {
    if (runtime === REVIEW_SETUP_ABSENT)
        return runtime;
    return projection ? reviewSetupHash({ projection, runtime }) : runtime;
}
function inspectSource(context, entry) {
    const source = resolveReviewSource(sourceRoot(context, entry), entry.relativePath);
    const stat = reviewSetupStat(source.physicalPath);
    if (stat === undefined) {
        return {
            physicalPath: source.physicalPath,
            projection: source.projection,
            fingerprint: REVIEW_SETUP_ABSENT,
        };
    }
    assertSymlinkFreeReviewTree(source.physicalPath, 'frozen setup');
    if (entry.executable && (!stat.isFile() || (stat.mode & 0o111) === 0)) {
        fail(`frozen executable setup path is no longer executable: ${entry.relativePath}`);
    }
    const runtime = reviewRuntimeFingerprint(source.physicalPath);
    return {
        physicalPath: source.physicalPath,
        projection: source.projection,
        fingerprint: authenticatedFingerprint(source.projection, runtime),
    };
}
function readHooksPath(gitRoot) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const result = spawnSync('git', ['-C', gitRoot, 'config', '--null', '--get', 'core.hooksPath'], {
        env,
    });
    if (result.error || result.status !== 0 || result.stdout.at(-1) !== 0) {
        fail('could not verify the frozen core.hooksPath; retry.');
    }
    return result.stdout.subarray(0, -1).toString();
}
function verifySource(context) {
    if (readHooksPath(context.gitRoot) !== context.manifest.setup.hooksPath) {
        fail('target core.hooksPath changed after setup capture; retry.');
    }
    return context.manifest.setup.paths.map((entry) => {
        const current = inspectSource(context, entry);
        if (entry.required && current.fingerprint === REVIEW_SETUP_ABSENT) {
            fail(`required frozen setup path disappeared: ${entry.relativePath}`);
        }
        if (current.fingerprint !== entry.fingerprint) {
            fail(`target setup changed after capture: ${entry.relativePath}; retry.`);
        }
        return current;
    });
}
/** Validate frozen source setup before a clean review can return success without a worktree. */
export function verifyReviewSetupSource(setupManifestPath, targetRoot) {
    const setup = parseReviewSetupManifest(setupManifestPath);
    const requested = canonicalReviewDirectory(targetRoot, 'review target root');
    if (requested !== setup.targetRoot)
        fail('review setup manifest belongs to a different target.');
    verifySource(setupContext(setup));
    return setup;
}
function mappedRelative(context, entry) {
    let path = entry.relativePath;
    if (entry.root === 'target' && context.targetRelativePath !== '.') {
        path = posix.join(context.targetRelativePath, path);
    }
    else if (entry.root === 'git' && path.startsWith('.git/')) {
        path = posix.join(CHAIN_MIRROR, path);
    }
    if (!isSafeReviewRelativePath(path))
        fail(`unsafe private setup path: ${path}`);
    return path;
}
function assertGitChainPath(entry, expectedPath, message) {
    if (entry === undefined)
        fail(message);
    if (entry.root !== 'git')
        fail(message);
    if (entry.relativePath !== expectedPath)
        fail(message);
}
function verifyChainSource(entry, source, expectedPath) {
    const message = 'frozen overlay chain source is inconsistent.';
    if (entry.fingerprint === REVIEW_SETUP_ABSENT) {
        if (source !== undefined)
            fail(message);
        return;
    }
    assertGitChainPath(source, expectedPath, message);
}
function chainEntry(context) {
    const chain = context.manifest.setup.chain;
    if (!chain)
        return null;
    const paths = context.manifest.setup.paths;
    const entry = paths.find((path) => path.id === 'overlay-chain');
    assertGitChainPath(entry, chain.path, 'frozen overlay chain path is inconsistent.');
    verifyChainSource(entry, paths.find((path) => path.id === 'overlay-chain-source'), chain.sourcePath);
    return entry;
}
function runtimeFields(context, destination) {
    const chain = chainEntry(context);
    return {
        targetRelativePath: context.targetRelativePath,
        hooksPath: context.manifest.setup.hooksPath,
        overlay: context.manifest.setup.overlay,
        enabled: context.manifest.setup.profile.enabled,
        decisionsDir: context.manifest.setup.profile.decisionsDir,
        chainHook: chain && chain.fingerprint !== REVIEW_SETUP_ABSENT
            ? resolve(destination, ...mappedRelative(context, chain).split('/'))
            : '',
        guards: [...context.manifest.setup.profile.guards],
    };
}
function privateFingerprint(root, path, expectedAbsent) {
    const destination = safeReviewSetupDestination(root, path);
    const stat = reviewSetupStat(destination);
    if (stat === undefined)
        return REVIEW_SETUP_ABSENT;
    if (expectedAbsent)
        fail(`private setup conflicts with snapshot entry: ${path}`);
    assertSymlinkFreeReviewTree(destination, 'private setup');
    return reviewRuntimeFingerprint(destination);
}
function validateRuntimeManifestPath(path, context, destination) {
    const manifest = canonicalReviewLeaf(path, 'setup runtime manifest parent');
    if (reviewPathWithin(context.gitRoot, manifest) ||
        reviewPathWithin(destination, manifest) ||
        reviewSetupStat(manifest) !== undefined) {
        fail('setup runtime manifest must be a new path outside source and destination worktrees.');
    }
    return manifest;
}
function validateRuntimeSeparation(context, destination, manifest, sources) {
    for (const [index, entry] of context.manifest.setup.paths.entries()) {
        if (entry.fingerprint === REVIEW_SETUP_ABSENT)
            continue;
        const source = sources[index]?.physicalPath;
        if (!source)
            fail('frozen setup source capture is incomplete.');
        if (reviewPathWithin(source, destination) ||
            reviewPathWithin(destination, source) ||
            reviewPathWithin(source, manifest)) {
            fail('private setup worktree and manifest must be separate from every frozen setup source.');
        }
    }
}
/** Copy every authenticated setup input without allowing snapshot content to be overwritten. */
export function materializeReviewSetupRuntime(setupManifestPath, destinationGitRoot, runtimeManifestPath, hooks = {}) {
    const setup = parseReviewSetupManifest(setupManifestPath);
    const context = setupContext(setup);
    const destination = canonicalReviewDirectory(destinationGitRoot, 'private setup worktree');
    if (reviewPathWithin(context.gitRoot, destination) ||
        reviewPathWithin(destination, context.gitRoot)) {
        fail('target and private setup worktrees must be separate, non-nested directories.');
    }
    const manifestPath = validateRuntimeManifestPath(runtimeManifestPath, context, destination);
    const verifiedSources = verifySource(context);
    validateRuntimeSeparation(context, destination, manifestPath, verifiedSources);
    const mapped = setup.setup.paths.map((entry, index) => ({
        entry,
        path: mappedRelative(context, entry),
        source: verifiedSources[index],
    }));
    if (new Set(mapped.map(({ path }) => path)).size !== mapped.length) {
        fail('frozen setup paths collide in the private worktree.');
    }
    const created = [];
    try {
        hooks.beforePrivateMaterialization?.();
        for (const { entry, path, source } of mapped) {
            if (entry.fingerprint === REVIEW_SETUP_ABSENT) {
                privateFingerprint(destination, path, true);
            }
            else {
                copyMergedReviewSetup(source.physicalPath, safeReviewSetupDestination(destination, path), destination, created);
            }
        }
        hooks.beforeSourceVerification?.();
        verifySource(context);
        const entries = mapped.map(({ entry, path, source }) => {
            const privateRuntimeFingerprint = privateFingerprint(destination, path, entry.fingerprint === REVIEW_SETUP_ABSENT);
            const authenticatedPrivateFingerprint = authenticatedFingerprint(source.projection, privateRuntimeFingerprint);
            if (authenticatedPrivateFingerprint !== entry.fingerprint) {
                fail(`private setup does not match its captured source: ${entry.relativePath}`);
            }
            return {
                id: entry.id,
                destinationRelativePath: path,
                sourceFingerprint: entry.fingerprint,
                privateFingerprint: privateRuntimeFingerprint,
            };
        });
        const unsigned = {
            version: VERSION,
            setupHash: setup.selfHash,
            destinationGitRoot: destination,
            fields: runtimeFields(context, destination),
            entries,
        };
        const runtime = { ...unsigned, selfHash: reviewSetupRuntimeHash(unsigned) };
        writeFileSync(manifestPath, `${JSON.stringify(runtime, null, 2)}\n`, { flag: 'wx' });
        return runtime;
    }
    catch (cause) {
        for (const path of created.reverse())
            rmSync(path, { recursive: true, force: true });
        throw cause;
    }
}
/** Recheck both target sources and immutable private setup after target-controlled hooks execute. */
export function verifyReviewSetupRuntime(setupManifestPath, runtimeManifestPath) {
    const setup = parseReviewSetupManifest(setupManifestPath);
    const context = setupContext(setup);
    const runtime = parseReviewSetupRuntimeManifest(runtimeManifestPath);
    const destination = canonicalReviewDirectory(runtime.destinationGitRoot, 'private setup worktree');
    if (runtime.setupHash !== setup.selfHash)
        fail('setup runtime belongs to another frozen setup.');
    const expectedFields = runtimeFields(context, destination);
    if (JSON.stringify(runtime.fields) !== JSON.stringify(expectedFields)) {
        fail('setup runtime fields do not match the frozen setup.');
    }
    const expectedEntries = setup.setup.paths.map((entry) => ({
        id: entry.id,
        destinationRelativePath: mappedRelative(context, entry),
        sourceFingerprint: entry.fingerprint,
    }));
    const runtimeEntries = runtime.entries.map(({ privateFingerprint: _private, ...entry }) => entry);
    if (JSON.stringify(runtimeEntries) !== JSON.stringify(expectedEntries)) {
        fail('setup runtime entries do not match the frozen setup.');
    }
    verifySource(context);
    for (const entry of runtime.entries) {
        const current = privateFingerprint(destination, entry.destinationRelativePath, entry.privateFingerprint === REVIEW_SETUP_ABSENT);
        if (current !== entry.privateFingerprint) {
            fail(`private immutable setup changed while review was running: ${entry.destinationRelativePath}`);
        }
    }
    return runtime;
}
function usage() {
    return fail('usage: setup-runtime source <setup-manifest> <target-root> | materialize <setup-manifest> <destination-git-root> <runtime-manifest> | verify <setup-manifest> <runtime-manifest>');
}
function runCli(args) {
    if (args[0] === 'source' && args.length === 3) {
        verifyReviewSetupSource(args[1], args[2]);
        return;
    }
    if (args[0] === 'materialize' && args.length === 4) {
        const runtime = materializeReviewSetupRuntime(args[1], args[2], args[3]);
        process.stdout.write(encodeReviewSetupRuntimeFields(runtime.fields));
        return;
    }
    if (args[0] === 'verify' && args.length === 3) {
        verifyReviewSetupRuntime(args[1], args[2]);
        return;
    }
    usage();
}
runDirectReviewCli(import.meta.url, runCli);
