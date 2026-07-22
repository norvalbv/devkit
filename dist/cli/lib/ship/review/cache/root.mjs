/** Stable, checkout-external convergence storage for `devkit review`. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runDirectReviewCli } from "../run-direct.mjs";
import { reviewPathWithin } from "../runtime-paths.mjs";
const REVIEW_CACHE_NAMESPACE = 'devkit-review-cache-v1';
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function fail(message) {
    throw new Error(`devkit review: ${message}`);
}
function errorMessage(cause) {
    return cause instanceof Error ? cause.message : String(cause);
}
function assertPhysicalDirectory(path, label) {
    const requested = resolve(path);
    try {
        const stat = lstatSync(requested);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(requested) !== requested) {
            fail(`${label} must be a physical directory: ${requested}`);
        }
    }
    catch (cause) {
        if (cause instanceof Error && cause.message.startsWith('devkit review:'))
            throw cause;
        fail(`${label} is not an available physical directory: ${requested}`);
    }
    return requested;
}
/** Create only missing descendants of one already-physical ancestor, checking after every mkdir. */
function ensurePhysicalDirectory(path, label) {
    const requested = resolve(path);
    const missing = [];
    let cursor = requested;
    while (lstatSync(cursor, { throwIfNoEntry: false }) === undefined) {
        const parent = dirname(cursor);
        if (parent === cursor)
            fail(`${label} has no available physical ancestor: ${requested}`);
        missing.unshift(basename(cursor));
        cursor = parent;
    }
    assertPhysicalDirectory(cursor, label);
    for (const segment of missing) {
        cursor = join(cursor, segment);
        try {
            mkdirSync(cursor, { mode: 0o700 });
        }
        catch (cause) {
            if (cause.code !== 'EEXIST') {
                fail(`could not create ${label} (${errorMessage(cause)}).`);
            }
        }
        assertPhysicalDirectory(cursor, label);
    }
    return assertPhysicalDirectory(requested, label);
}
function gitEnvironment() {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if (name.startsWith('GIT_'))
            delete env[name];
    }
    return {
        ...env,
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
    };
}
function gitOutput(targetRoot, args, label) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', targetRoot, ...args], {
        env: gitEnvironment(),
        maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) {
        const detail = result.stderr.toString().trim();
        fail(`could not ${label}${detail ? ` (${detail})` : ''}.`);
    }
    return result.stdout;
}
function gitPath(targetRoot, args, label) {
    const output = gitOutput(targetRoot, args, label);
    if (output.length < 2 ||
        output[output.length - 1] !== 0x0a ||
        output.subarray(0, -1).includes(0)) {
        fail(`${label} returned malformed output.`);
    }
    return output.subarray(0, -1).toString();
}
function historyIdentity(targetRoot) {
    const bytes = gitOutput(targetRoot, ['rev-list', '--max-parents=0', 'HEAD'], 'read repository history roots');
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a || bytes.includes(0)) {
        fail('repository history roots returned malformed output.');
    }
    const roots = bytes.subarray(0, -1).toString().split('\n');
    if (roots.length === 0 ||
        new Set(roots).size !== roots.length ||
        roots.some((root) => !OBJECT_ID.test(root))) {
        fail('repository history roots returned malformed output.');
    }
    return roots.sort().join('\n');
}
function absoluteEnvironmentPath(environment, name) {
    const value = environment[name];
    if (value === undefined)
        return undefined;
    if (!value)
        fail(`${name} must be an absolute path when set.`);
    if (value.includes('\0'))
        fail(`${name} must be an absolute path when set.`);
    if (!isAbsolute(value))
        fail(`${name} must be an absolute path when set.`);
    return value;
}
function platformCacheBase(platform, home, environment) {
    if (platform === 'darwin')
        return join(home, 'Library', 'Caches');
    if (platform !== 'win32')
        return join(home, '.cache');
    return absoluteEnvironmentPath(environment, 'LOCALAPPDATA') ?? join(home, 'AppData', 'Local');
}
function defaultCacheBase(options) {
    const environment = options.environment ?? process.env;
    const configured = absoluteEnvironmentPath(environment, 'XDG_CACHE_HOME');
    if (configured !== undefined)
        return configured;
    const home = assertPhysicalDirectory(options.homeDirectory ?? homedir(), 'user home directory');
    return platformCacheBase(options.platform ?? process.platform, home, environment);
}
function cacheIdentity(commonDirectory, repositoryHistory, targetRelativePath) {
    const commonStat = lstatSync(commonDirectory, { bigint: true });
    const hash = createHash('sha256');
    for (const value of [
        REVIEW_CACHE_NAMESPACE,
        commonDirectory,
        commonStat.dev.toString(),
        commonStat.ino.toString(),
        repositoryHistory,
        targetRelativePath,
    ]) {
        const bytes = Buffer.from(value);
        hash.update(`${bytes.length}:`);
        hash.update(bytes);
    }
    return hash.digest('hex');
}
function pathsOverlap(first, second) {
    return reviewPathWithin(first, second) || reviewPathWithin(second, first);
}
function overlapsAny(path, excludedRoots) {
    return excludedRoots.some((root) => pathsOverlap(root, path));
}
/** Resolve and create one stable cache namespace for a physical repo + package target. */
export function reviewCacheRoot(requestedTarget, requestedTempRoot, options = {}) {
    const targetRoot = assertPhysicalDirectory(requestedTarget, 'review target checkout');
    const tempRoot = assertPhysicalDirectory(requestedTempRoot, 'private review runtime');
    const gitRoot = assertPhysicalDirectory(gitPath(targetRoot, ['rev-parse', '--path-format=absolute', '--show-toplevel'], 'locate Git root'), 'target Git root');
    if (!reviewPathWithin(gitRoot, targetRoot))
        fail('review target escapes its Git worktree.');
    const commonDirectory = assertPhysicalDirectory(gitPath(targetRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'locate Git common directory'), 'Git common directory');
    const repositoryRoots = [gitRoot, commonDirectory];
    if (overlapsAny(tempRoot, repositoryRoots)) {
        fail('private review runtime must live outside the target Git worktree and Git common directory.');
    }
    const relativeTarget = relative(gitRoot, targetRoot).split(sep).join('/') || '.';
    const cacheBase = options.cacheBase ?? defaultCacheBase(options);
    if (!cacheBase || cacheBase.includes('\0') || !isAbsolute(cacheBase)) {
        fail('review cache base must be an absolute path.');
    }
    const requestedRoot = resolve(cacheBase, 'devkit', 'review', cacheIdentity(commonDirectory, historyIdentity(targetRoot), relativeTarget));
    const excludedRoots = [...repositoryRoots, tempRoot];
    if (overlapsAny(requestedRoot, excludedRoots)) {
        fail('persistent review cache must live outside the target Git worktree, Git common directory, and private runtime.');
    }
    const root = ensurePhysicalDirectory(requestedRoot, 'persistent review cache');
    if (overlapsAny(root, excludedRoots)) {
        fail('persistent review cache resolved inside the target Git worktree, Git common directory, or private runtime.');
    }
    return root;
}
function runCli(args) {
    if (args.length < 2 || args.length > 3) {
        throw new Error('usage: review/cache/root <target-root> <private-temp-root> [cache-base]');
    }
    process.stdout.write(`${reviewCacheRoot(args[0], args[1], {
        ...(args[2] === undefined ? {} : { cacheBase: args[2] }),
    })}\0`);
}
runDirectReviewCli(import.meta.url, runCli);
