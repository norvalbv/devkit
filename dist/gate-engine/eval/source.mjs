import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
const DOUBLE_STAR_TOKEN = '___DEVKIT_DOUBLE_STAR___';
const DOUBLE_STAR_DIRECTORY_TOKEN = '___DEVKIT_DOUBLE_STAR_DIRECTORY___';
// node caps spawnSync stdout at 1 MiB by default and reports the overflow as ENOBUFS with a NULL
// status — indistinguishable, without this, from a git that refused to run. docs/benchmarks/
// history.jsonl is append-only by ruling, so it crosses that line on its own schedule and would
// take every mode of the checker down with it.
const GIT_MAX_BUFFER = 128 * 1024 * 1024;
// A submodule's index/tree entry. Not a blob: `git show :<gitlink>` is `fatal: bad object`, so it
// must never enter a listing whose contract is "these paths can be read".
const GITLINK_MODE = '160000';
/**
 * Where a failed git invocation actually ran. A tracker gate that cannot run git must say so rather
 * than report a content verdict: sc-1959 lost a fully-gated ship to `Missing
 * docs/benchmarks/catalog.json`, a sentence that was equally true of an absent file, a cwd outside a
 * work tree, and a spawn that never forked. Resolved best-effort and only on an already-failing
 * path, so a second unusable git degrades the message instead of replacing the original fault.
 */
function gitFailureContext(cwd, mode, result) {
    const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
        cwd,
        encoding: 'utf8',
        maxBuffer: GIT_MAX_BUFFER,
    });
    // SAFETY: node types spawnSync's `error` as plain Error, but every error it actually sets here is
    // a libuv failure carrying a `code` (ENOENT when git is not on PATH, EAGAIN/EMFILE when the
    // process could not fork). The optional chain below tolerates the absent-`code` case regardless,
    // so the widening can only add detail, never assume it.
    const cause = result.error;
    const lines = [
        `  root: ${cwd} (mode=${mode}, gitdir=${gitDir.status === 0 ? gitDir.stdout.trim() : '<unresolved>'})`,
        `  status=${result.status ?? '<none>'} signal=${result.signal ?? '<none>'} error=${cause?.code ?? cause?.message ?? '<none>'}`,
    ];
    const stderr = (result.stderr ?? '').trim();
    if (stderr)
        lines.push(`  stderr: ${stderr}`);
    return lines.join('\n');
}
function git(cwd, args, allowFailure = false, mode = 'raw') {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
    if (result.status === 0)
        return result.stdout;
    if (allowFailure)
        return '';
    // NOT `result.stderr.trim()`: a spawn that failed to fork leaves stderr null, so the old form
    // replaced the real fault with a bare TypeError.
    throw new Error(`git ${args.join(' ')} failed\n${gitFailureContext(cwd, mode, result)}`);
}
// `-z` rather than newline-splitting: git QUOTES any path outside the printable-ASCII set in its
// default output, so a non-ASCII tracked file used to enter the file list as `"docs/\303\251.md"`
// and could never be read back.
function splitNul(output) {
    return output.split('\0').filter(Boolean);
}
/**
 * Turn one NUL-delimited `<metadata>\t<path>` listing into the readable paths it names.
 *
 * Two shapes force the filter. A GITLINK is listed by both `ls-files` and `ls-tree` but is a commit
 * id, not a blob — reading it fails, and a repo with a submodule is an ordinary repo, not an error.
 * An UNMERGED path is listed once PER STAGE, so a conflicted file would otherwise be hashed twice;
 * it stays in the listing (deduped) precisely so a later read fails loudly rather than letting the
 * checker hash a short set and pass on an index nobody could commit.
 */
function listingPaths(records, keep) {
    const paths = new Set();
    for (const record of records) {
        const tab = record.indexOf('\t');
        if (tab < 0)
            continue;
        if (keep(record.slice(0, tab)))
            paths.add(record.slice(tab + 1));
    }
    return [...paths].sort();
}
function repositoryPath(root, path) {
    const absolute = resolve(root, path);
    const repoPath = relative(root, absolute).replaceAll('\\', '/');
    if (!repoPath || repoPath === '..' || repoPath.startsWith('../'))
        throw new Error(`Path escapes repository: ${path}`);
    return { absolute, relative: repoPath };
}
/**
 * Answer "is this path present?" from the memoised file list instead of a second git probe.
 *
 * `git cat-file -e <spec>` exits 128 for a path the index does not have AND for every other fatal —
 * not a work tree, an unreadable index, a process that could not fork — so an exit-status test
 * reports a broken git as an absent file, silently, at every call site (each of which treats null as
 * legitimately absent). Deciding from `listFiles()` removes that conflation entirely: absence is
 * proven from the authoritative listing, and once a path IS listed any `git show` failure is a real
 * fault that must throw. It also drops one subprocess per read — the check performs hundreds, and
 * fork pressure is itself a candidate cause of the original incident.
 */
function gitReader(root, mode, listFiles) {
    let present;
    return (path, spec) => {
        const repoPath = repositoryPath(root, path).relative;
        present ??= new Set(listFiles());
        if (!present.has(repoPath))
            return null;
        return git(root, ['show', spec(repoPath)], false, mode);
    };
}
export function repositorySource(cwd, mode, ref) {
    const root = realpathSync(resolve(cwd));
    if (mode === 'working') {
        let files;
        return {
            mode,
            root,
            listFiles: () => {
                files ??= splitNul(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], false, mode)).sort();
                return files;
            },
            read: (path) => {
                const { absolute } = repositoryPath(root, path);
                if (!existsSync(absolute))
                    return null;
                const real = repositoryPath(root, realpathSync(absolute)).absolute;
                // A submodule checkout is listed as a path but is a DIRECTORY on disk; reading it throws
                // EISDIR. Absent content, not a fault — the same answer its gitlink gets in the other modes.
                if (!statSync(real).isFile())
                    return null;
                return readFileSync(real, 'utf8');
            },
        };
    }
    if (mode === 'staged') {
        let files;
        const listFiles = () => {
            // `--stage` over `--cached`: the mode column is what separates a blob from a gitlink.
            files ??= listingPaths(splitNul(git(root, ['ls-files', '--stage', '-z'], false, mode)), (metadata) => !metadata.startsWith(`${GITLINK_MODE} `));
            return files;
        };
        const read = gitReader(root, mode, listFiles);
        return { mode, root, listFiles, read: (path) => read(path, (repoPath) => `:${repoPath}`) };
    }
    const tree = ref ?? 'HEAD';
    let files;
    const listFiles = () => {
        // Without `--name-only` the type column arrives too; `-r` yields only blobs and gitlinks, so
        // keeping `blob` is exactly the readable set.
        files ??= listingPaths(splitNul(git(root, ['ls-tree', '-r', '-z', tree], false, mode)), (metadata) => metadata.split(' ')[1] === 'blob');
        return files;
    };
    const read = gitReader(root, mode, listFiles);
    return {
        mode,
        root,
        ref: tree,
        listFiles,
        read: (path) => read(path, (repoPath) => `${tree}:${repoPath}`),
    };
}
function matchGlob(path, glob) {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, DOUBLE_STAR_DIRECTORY_TOKEN)
        .replace(/\*\*/g, DOUBLE_STAR_TOKEN)
        .replace(/\*/g, '[^/]*')
        .replaceAll(DOUBLE_STAR_DIRECTORY_TOKEN, '(?:.*/)?')
        .replaceAll(DOUBLE_STAR_TOKEN, '.*');
    return new RegExp(`^${escaped}$`).test(path);
}
export function hashPaths(source, globs) {
    const paths = source
        .listFiles()
        .filter((path) => globs.some((glob) => matchGlob(path, glob)))
        .sort();
    const hash = createHash('sha256');
    for (const path of paths) {
        const content = source.read(path);
        if (content === null)
            continue;
        hash.update(path);
        hash.update('\0');
        hash.update(content);
        hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
}
export function suiteHashes(source, hashes) {
    return {
        implementation: hashPaths(source, hashes.implementation),
        corpus: hashPaths(source, hashes.corpus),
        scorer: hashPaths(source, hashes.scorer),
        runner: hashPaths(source, hashes.runner),
    };
}
export function repoRelative(cwd, path) {
    return relative(resolve(cwd), resolve(cwd, path)).replaceAll('\\', '/');
}
export function gitOutput(cwd, args, allowFailure = false) {
    return git(cwd, args, allowFailure);
}
