import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, statSync, } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomic } from '../../../atomic-write.mjs';
import { runDirectReviewCli } from '../run-direct.mjs';
import { canonicalReviewDirectory, canonicalReviewLeaf, reviewPathWithin, } from '../runtime-paths.mjs';
import { errorMessage, fail } from '../shared/common.mjs';
import { gitFailure, gitLine, gitOptionalRaw, gitRaw, MAX_GIT_OUTPUT, spawnGit } from './git.mjs';
import { parseReviewRepositoryStateManifest, REVIEW_REPOSITORY_OBJECT_ID, REVIEW_REPOSITORY_STATE_VERSION, reviewRepositoryManifestHash, } from './manifest.mjs';
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
// git-worktree(1): only these namespaces are per-worktree; every other ref is shared with sibling
// sessions and cannot change the reviewed snapshot, which HEAD and the tree IDs already pin.
const WORKTREE_REF_NAMESPACES = ['refs/bisect', 'refs/worktree', 'refs/rewritten'];
function worktreeRefsState(root) {
    return gitRaw(root, [
        'for-each-ref',
        '--sort=refname',
        '--format=%(refname)%00%(objectname)%00%(symref)%00',
        ...WORKTREE_REF_NAMESPACES,
    ], 'read target worktree refs');
}
function effectiveConfigState(root, scope) {
    return gitRaw(root, ['config', scope, '--includes', '--null', '--show-origin', '--list'], `read target ${scope.slice(2)} config`);
}
/** Drops `branch.<other>.*` entries: sibling sessions write their own upstreams (`push -u`,
 *  `worktree add --track`) into the shared file, and those never shape this checkout (sc-4171). */
function withoutSiblingBranchConfig(effective, symrefBase64) {
    const symref = symrefBase64 === null ? '' : Buffer.from(symrefBase64, 'base64').toString('latin1');
    const ownBranch = symref.startsWith('refs/heads/') ? symref.slice('refs/heads/'.length) : null;
    const fields = effective.toString('latin1').split('\0'); // latin1 round-trips every byte
    const kept = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
        const origin = fields[index] ?? '';
        const entry = fields[index + 1] ?? '';
        const key = entry.split('\n', 1)[0] ?? '';
        const lastDot = key.lastIndexOf('.');
        const siblingBranch = key.startsWith('branch.') &&
            lastDot > 'branch.'.length &&
            key.slice('branch.'.length, lastDot) !== ownBranch;
        if (!siblingBranch)
            kept.push(origin, entry);
    }
    return Buffer.from(kept.map((field) => `${field}\0`).join(''), 'latin1');
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
/** Entry type and link target only: the shared file is rewritten by sibling sessions, so its
 *  bytes are judged through `git config --list` instead of read directly (sc-4171). */
function configEntryState(path, label) {
    const stat = inspectConfigFile(path, label);
    if (!stat)
        return { readable: false, parts: [Buffer.from('missing')] };
    const type = fileType(stat);
    if (type === 'file')
        return { readable: true, parts: [Buffer.from(type)] };
    if (type !== 'symlink')
        return { readable: false, parts: [Buffer.from(type)] };
    try {
        return {
            readable: true,
            parts: [Buffer.from(type), readlinkSync(path, { encoding: 'buffer' })],
        };
    }
    catch (cause) {
        return fail(`could not read target ${label} link (${errorMessage(cause)}).`);
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
/** `exact` hashes shared config bytes (prove-regression: did a command touch the caller?);
 *  `review` hashes only entries that can shape this checkout (sc-4171). */
function configFingerprint(context, mode) {
    const commonConfig = join(context.gitCommonDir, 'config');
    const worktreeConfig = join(context.gitDir, 'config.worktree');
    const shared = mode === 'exact'
        ? configFileState(commonConfig, 'shared repository config')
        : configEntryState(commonConfig, 'shared repository config');
    const selectedWorktree = configFileState(worktreeConfig, 'worktree repository config');
    const localEffective = shared.readable
        ? effectiveConfigState(context.gitRoot, '--local')
        : Buffer.alloc(0);
    const sharedEffective = mode === 'exact' || !shared.readable
        ? localEffective
        : withoutSiblingBranchConfig(localEffective, headSymref(context.gitRoot));
    const worktreeEffective = selectedWorktree.readable && worktreeConfigEnabled(context.gitRoot)
        ? effectiveConfigState(context.gitRoot, '--worktree')
        : Buffer.alloc(0);
    return framedHash(mode === 'exact' ? 'review-repository-config-v2' : 'review-repository-config-v3', [
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
    return configFingerprint(repositoryContext(targetRoot), 'exact');
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
/** Per-label evidence closing worktree-ref/config ABA gaps (sc-2166); shared ref storage is left
 *  out so sibling sessions' commits and fetches cannot abort a review (sc-4159). */
function repositoryMutationEvidence(context) {
    const evidence = new Map();
    const record = (label, path, recursive) => evidence.set(label, framedHash(label, pathMutationEvidence(path, label, recursive)));
    record('common:admin', context.gitCommonDir, false);
    if (context.gitDir !== context.gitCommonDir) {
        record('worktree:admin', context.gitDir, false);
        record('worktree:refs', join(context.gitDir, 'refs'), true);
        record('worktree:reftable', join(context.gitDir, 'reftable'), true);
    }
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
        refsSha256: framedHash('review-repository-worktree-refs-v1', [worktreeRefsState(root)]),
        configSha256: configFingerprint(context, 'review'),
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
