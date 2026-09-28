import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, statSync, } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomic } from '../../../atomic-write.mjs';
import { runDirectReviewCli } from '../run-direct.mjs';
import { canonicalReviewDirectory, canonicalReviewLeaf, reviewPathWithin, } from '../runtime-paths.mjs';
import { errorMessage, fail, gitEnvironment } from '../shared/common.mjs';
import { parseReviewRepositoryStateManifest, REVIEW_REPOSITORY_OBJECT_ID, REVIEW_REPOSITORY_STATE_VERSION, reviewRepositoryManifestHash, } from './manifest.mjs';
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
function spawnGit(root, args) {
    return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
        env: gitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT,
    });
}
function gitFailure(label, result) {
    if (result.error)
        fail(`could not ${label} (${errorMessage(result.error)}).`);
    const detail = result.stderr.toString().trim();
    fail(`could not ${label} (git exited ${String(result.status)}${detail ? `: ${detail}` : ''}).`);
}
function gitRaw(root, args, label) {
    const result = spawnGit(root, args);
    if (result.status !== 0)
        gitFailure(label, result);
    return result.stdout;
}
function gitOptionalRaw(root, args, label) {
    const result = spawnGit(root, args);
    if (result.status === 0)
        return result.stdout;
    if (result.status === 1 && result.stdout.length === 0 && result.stderr.length === 0)
        return Buffer.alloc(0);
    return gitFailure(label, result);
}
function gitLine(root, args, label) {
    const raw = gitRaw(root, args, label);
    if (raw.length === 0 || raw[raw.length - 1] !== 0x0a)
        fail(`${label} returned malformed output.`);
    return raw.subarray(0, -1);
}
function repositoryContext(requestedTarget) {
    const targetRoot = canonicalReviewDirectory(requestedTarget, 'review target checkout');
    const rawGitRoot = gitLine(targetRoot, ['rev-parse', '--path-format=absolute', '--show-toplevel'], 'locate the target Git root');
    if (rawGitRoot.includes(0))
        fail('target Git root contains an invalid NUL byte.');
    const gitRoot = canonicalReviewDirectory(rawGitRoot.toString(), 'target Git root');
    if (!reviewPathWithin(gitRoot, targetRoot))
        fail('target checkout is not contained by its detected Git root.');
    const gitCommonDir = gitDirectory(targetRoot, '--git-common-dir', 'common Git directory');
    const gitDir = gitDirectory(targetRoot, '--git-dir', 'worktree Git directory');
    return { targetRoot, gitRoot, gitCommonDir, gitDir };
}
function manifestDestination(path, context) {
    const destination = canonicalReviewLeaf(path, 'repository state manifest parent');
    if (reviewPathWithin(context.gitRoot, destination) ||
        reviewPathWithin(context.gitCommonDir, destination) ||
        reviewPathWithin(context.gitDir, destination)) {
        fail('repository state manifest must live outside the target Git root and Git admin trees.');
    }
    return destination;
}
function framedHash(label, parts) {
    const hash = createHash('sha256');
    hash.update(`${Buffer.byteLength(label)}:${label}`);
    for (const part of parts) {
        hash.update(`${part.length}:`);
        hash.update(part);
    }
    return hash.digest('hex');
}
function headSymref(root) {
    const result = spawnGit(root, ['symbolic-ref', '--quiet', 'HEAD']);
    if (result.status === 1 && result.stdout.length === 0 && result.stderr.length === 0)
        return null;
    if (result.status !== 0)
        gitFailure('read target symbolic HEAD', result);
    const raw = result.stdout;
    if (raw.length <= 1 || raw[raw.length - 1] !== 0x0a || raw.subarray(0, -1).includes(0))
        fail('target symbolic HEAD returned malformed output.');
    return raw.subarray(0, -1).toString('base64');
}
function refsState(root) {
    return gitRaw(root, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(symref)%00'], 'read target refs');
}
function effectiveConfigState(root, scope) {
    return gitRaw(root, ['config', scope, '--includes', '--null', '--show-origin', '--list'], `read target ${scope.slice(2)} config`);
}
function worktreeConfigEnabled(root) {
    const enabled = gitOptionalRaw(root, ['config', '--local', '--includes', '--type=bool', '--get', 'extensions.worktreeConfig'], 'read target worktree-config extension');
    if (enabled.length === 0 || enabled.equals(Buffer.from('false\n')))
        return false;
    if (enabled.equals(Buffer.from('true\n')))
        return true;
    return fail('target worktree-config extension returned malformed output.');
}
function fileType(stat) {
    if (stat.isFile())
        return 'file';
    if (stat.isSymbolicLink())
        return 'symlink';
    if (stat.isDirectory())
        return 'directory';
    if (stat.isBlockDevice())
        return 'block-device';
    if (stat.isCharacterDevice())
        return 'character-device';
    if (stat.isFIFO())
        return 'fifo';
    if (stat.isSocket())
        return 'socket';
    return 'unknown';
}
function missingPath(cause) {
    return (cause instanceof Error &&
        'code' in cause &&
        (cause.code === 'ENOENT' || cause.code === 'ENOTDIR'));
}
function inspectConfigFile(path, label) {
    try {
        return lstatSync(path);
    }
    catch (cause) {
        if (missingPath(cause))
            return undefined;
        return fail(`could not inspect target ${label} (${errorMessage(cause)}).`);
    }
}
function readConfigFile(path, label, type) {
    let descriptor;
    try {
        const linkTarget = type === 'symlink' ? readlinkSync(path, { encoding: 'buffer' }) : Buffer.alloc(0);
        descriptor = openSync(path, 'r');
        const stat = fstatSync(descriptor);
        if (!stat.isFile())
            fail(`target ${label} does not resolve to a regular file.`);
        if (stat.size > MAX_GIT_OUTPUT)
            fail(`target ${label} is too large.`);
        const contents = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < contents.length) {
            const bytesRead = readSync(descriptor, contents, offset, contents.length - offset, null);
            if (bytesRead === 0)
                break;
            offset += bytesRead;
        }
        const extra = Buffer.allocUnsafe(1);
        if (readSync(descriptor, extra, 0, 1, null) !== 0) {
            fail(`target ${label} changed size while it was read.`);
        }
        return [Buffer.from(type), linkTarget, contents.subarray(0, offset)];
    }
    catch (cause) {
        if (cause instanceof Error && cause.message.startsWith('devkit review:'))
            throw cause;
        return fail(`could not read target ${label} (${errorMessage(cause)}).`);
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
}
/** Exact path entry state. Regular files hash raw bytes; symlinks hash link and resolved bytes. */
function configFileState(path, label) {
    const stat = inspectConfigFile(path, label);
    if (!stat)
        return { readable: false, parts: [Buffer.from('missing')] };
    const type = fileType(stat);
    if (type !== 'file' && type !== 'symlink') {
        return { readable: false, parts: [Buffer.from(type)] };
    }
    return { readable: true, parts: readConfigFile(path, label, type) };
}
function gitDirectory(root, flag, label) {
    const raw = gitLine(root, ['rev-parse', '--path-format=absolute', flag], `locate the target ${label}`);
    if (raw.includes(0))
        fail(`target ${label} contains an invalid NUL byte.`);
    const path = raw.toString();
    if (!isAbsolute(path))
        fail(`target ${label} is not an absolute path.`);
    return canonicalReviewDirectory(path, `target ${label}`);
}
function configFingerprint(context) {
    const commonConfig = join(context.gitCommonDir, 'config');
    const worktreeConfig = join(context.gitDir, 'config.worktree');
    const shared = configFileState(commonConfig, 'shared repository config');
    const selectedWorktree = configFileState(worktreeConfig, 'worktree repository config');
    const sharedEffective = shared.readable
        ? effectiveConfigState(context.gitRoot, '--local')
        : Buffer.alloc(0);
    const worktreeEffective = selectedWorktree.readable && worktreeConfigEnabled(context.gitRoot)
        ? effectiveConfigState(context.gitRoot, '--worktree')
        : Buffer.alloc(0);
    return framedHash('review-repository-config-v2', [
        Buffer.from(commonConfig),
        ...shared.parts,
        sharedEffective,
        Buffer.from(worktreeConfig),
        ...selectedWorktree.parts,
        worktreeEffective,
    ]);
}
/** Fingerprint repository-owned common/worktree config bytes plus their effective includes. */
export function reviewRepositoryConfigFingerprint(targetRoot) {
    return configFingerprint(repositoryContext(targetRoot));
}
function metadataBuffer(stat) {
    return Buffer.from([fileType(stat), stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'));
}
function pathMutationEvidence(path, label, recursive) {
    let stat;
    try {
        stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    }
    catch (cause) {
        return fail(`could not inspect target metadata storage (${errorMessage(cause)}).`);
    }
    if (stat === undefined)
        return [Buffer.from(label), Buffer.from('missing')];
    const parts = [Buffer.from(label), metadataBuffer(stat)];
    if (stat.isSymbolicLink()) {
        try {
            parts.push(readlinkSync(path, { encoding: 'buffer' }), metadataBuffer(statSync(path, { bigint: true })));
        }
        catch (cause) {
            return fail(`could not read target metadata storage link (${errorMessage(cause)}).`);
        }
    }
    if (!recursive || !stat.isDirectory())
        return parts;
    let names;
    try {
        names = readdirSync(path).sort();
    }
    catch (cause) {
        return fail(`could not enumerate target metadata storage (${errorMessage(cause)}).`);
    }
    parts.push(Buffer.from(`entries:${names.length}`));
    for (const name of names)
        parts.push(...pathMutationEvidence(join(path, name), `${label}/${name}`, true));
    return parts;
}
/** Per-label filesystem evidence closing ref/config ABA gaps; per label so a failure names what
 *  moved (sc-2166). A non-linked checkout's worktree admin tree is the common one, recorded once. */
function repositoryMutationEvidence(context) {
    const evidence = new Map();
    const record = (label, path, recursive) => evidence.set(label, framedHash(label, pathMutationEvidence(path, label, recursive)));
    const adminTrees = [['common', context.gitCommonDir]];
    if (context.gitDir !== context.gitCommonDir)
        adminTrees.push(['worktree', context.gitDir]);
    for (const [label, directory] of adminTrees) {
        record(`${label}:admin`, directory, false);
        record(`${label}:refs`, join(directory, 'refs'), true);
        record(`${label}:reftable`, join(directory, 'reftable'), true);
        record(`${label}:packed-refs`, join(directory, 'packed-refs'), false);
    }
    record('common:config', join(context.gitCommonDir, 'config'), false);
    record('worktree:config', join(context.gitDir, 'config.worktree'), false);
    record('worktree:HEAD', join(context.gitDir, 'HEAD'), false);
    return evidence;
}
function captureState(context) {
    const root = context.gitRoot;
    const headOid = gitLine(root, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], 'resolve target HEAD').toString();
    if (!REVIEW_REPOSITORY_OBJECT_ID.test(headOid))
        fail('target HEAD is not a valid commit object ID.');
    return {
        headOid,
        headSymrefBase64: headSymref(root),
        refsSha256: framedHash('review-repository-refs-v1', [refsState(root)]),
        configSha256: configFingerprint(context),
    };
}
/** Every logical-state field and evidence label that differs between two capture passes. */
function changedLabels(before, after, evidenceBefore, evidenceAfter) {
    const afterFields = new Map(Object.entries(after));
    const changed = Object.entries(before)
        .filter(([field, value]) => afterFields.get(field) !== value)
        .map(([field]) => field);
    for (const label of new Set([...evidenceBefore.keys(), ...evidenceAfter.keys()]))
        if (evidenceBefore.get(label) !== evidenceAfter.get(label))
            changed.push(label);
    return changed;
}
// Only admin-dir churn (a concurrent git's index.lock) is retried, and each retry re-runs the WHOLE
// before/after pair, so a pass whose evidence differs is never accepted.
const STABLE_CAPTURE_ATTEMPTS = 3;
const STABLE_CAPTURE_BACKOFF_MS = [100, 250];
const isAdminChurn = (label) => label.endsWith(':admin');
function stableState(context, options = {}) {
    for (let attempt = 1;; attempt += 1) {
        const evidenceBefore = repositoryMutationEvidence(context);
        const before = captureState(context);
        options.afterFirstCapture?.();
        const after = captureState(context);
        const evidenceAfter = repositoryMutationEvidence(context);
        const changed = changedLabels(before, after, evidenceBefore, evidenceAfter);
        if (changed.length === 0)
            return after;
        const churnOnly = changed.every(isAdminChurn);
        if (churnOnly && attempt < STABLE_CAPTURE_ATTEMPTS) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STABLE_CAPTURE_BACKOFF_MS[attempt - 1] ?? 250);
            continue;
        }
        const hint = churnOnly
            ? ' — another git process (an editor or agent host polling `git status`) kept writing the' +
                ' Git admin directory; stop it or retry once it is idle'
            : '';
        fail(`target repository metadata changed during capture (${changed.join(', ')})${hint}; retry.`);
    }
}
/** Capture a stable repository state and atomically write its private manifest. */
export function captureReviewRepositoryState(targetRoot, manifestPath, options = {}) {
    const context = repositoryContext(targetRoot);
    const destination = manifestDestination(manifestPath, context);
    const state = stableState(context, options);
    const unsigned = {
        version: REVIEW_REPOSITORY_STATE_VERSION,
        ...context,
        state,
    };
    const manifest = { ...unsigned, selfHash: reviewRepositoryManifestHash(unsigned) };
    writeFileAtomic(destination, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}
/** Re-authenticate a manifest and require the target repository metadata to remain unchanged. */
export function verifyReviewRepositoryState(targetRoot, manifestPath) {
    const context = repositoryContext(targetRoot);
    const destination = manifestDestination(manifestPath, context);
    const manifest = parseReviewRepositoryStateManifest(destination);
    if (manifest.targetRoot !== context.targetRoot)
        fail('repository state manifest belongs to a different target checkout.');
    if (manifest.gitRoot !== context.gitRoot)
        fail('repository state manifest belongs to a different target Git root.');
    if (manifest.gitCommonDir !== context.gitCommonDir)
        fail('repository state manifest belongs to a different target common Git directory.');
    if (manifest.gitDir !== context.gitDir)
        fail('repository state manifest belongs to a different target worktree Git directory.');
    if (JSON.stringify(stableState(context)) !== JSON.stringify(manifest.state))
        fail('target repository metadata changed after capture; retry.');
    return manifest;
}
function runCli(args) {
    if (args[0] === 'capture' && args.length === 3) {
        captureReviewRepositoryState(args[1], args[2]);
        return;
    }
    if (args[0] === 'verify' && args.length === 3) {
        verifyReviewRepositoryState(args[1], args[2]);
        return;
    }
    fail('usage: repository-state capture <target> <manifest> | verify <target> <manifest>');
}
runDirectReviewCli(import.meta.url, runCli);
