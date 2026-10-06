#!/usr/bin/env node
/** `ship --pr` append staging: merge what reached the PR branch since the caller's copy was taken.
 *  Usage: anchor.mjs --root --wt --branch --tip --head --out <f> -- <path...>; <f> feeds --anchors. */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { envFlag } from '../../../../gate-engine/config.mjs';
import { loadManifest } from '../../reconcile.mjs';
import { literalPathspecEnv, parseArgs } from '../reconcile-manifest-write.mjs';
const PLAIN_PATH = /^[\w./@+-]+$/;
const LITERAL_GIT_ENV = literalPathspecEnv();
/** Run git in <root> with literal pathspecs; stdout bytes, or null on a non-zero exit. */
function git(root, args, input) {
    const r = spawnSync('git', ['-C', root, '--literal-pathspecs', ...args], {
        input,
        env: LITERAL_GIT_ENV,
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 1 << 30,
    });
    return r.status === 0 ? r.stdout : null;
}
const lines = (out) => out ? out.toString('utf8').split('\n').filter(Boolean) : [];
/** A path as one stderr token: a name holding a space or a newline cannot forge a second line. */
const shown = (path) => (PLAIN_PATH.test(path) ? path : JSON.stringify(path));
/** The entry for <path> in commit <rev>, or null when the commit has no such path. */
export function treeEntry(root, rev, path) {
    const [meta] = (git(root, ['ls-tree', '-z', rev, '--', path])?.toString('utf8') ?? '').split('\t');
    const [mode, , blob] = meta.split(' ');
    return blob ? { mode, blob } : null;
}
/** The caller's file read through one descriptor, so its mode and bytes come from the same inode. */
function readHere(abs) {
    let fd;
    try {
        fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (e) {
        const code = e instanceof Error && 'code' in e ? e.code : undefined;
        if (code === 'ENOENT')
            return null;
        if (code !== 'ELOOP')
            throw e;
        return { bytes: Buffer.from(readlinkSync(abs)), mode: '120000' }; // a symlink; readlink fails if it changed
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile())
            throw new Error('not a regular file');
        return { bytes: readFileSync(fd), mode: st.mode & 0o111 ? '100755' : '100644' };
    }
    finally {
        closeSync(fd);
    }
}
/** The caller's file as a tree entry, read ONCE so the bytes hashed are the bytes merged. */
export function hereEntry(root, path) {
    const here = readHere(join(root, path));
    if (!here)
        return null;
    const args = [
        'hash-object',
        '-w',
        '--stdin',
        ...(here.mode === '120000' ? [] : ['--path', path]),
    ];
    const blob = git(root, args, here.bytes)?.toString('utf8').trim();
    if (!blob)
        throw new Error(`could not hash ${shown(path)}`);
    return { blob, mode: here.mode };
}
/** What this checkout's copy of <path> was taken from. */
export function anchorEntry(root, branch, tip, head, path) {
    const shipped = loadManifest(root).branches[branch]?.paths.find((e) => e.path === path);
    const token = shipped ? `${shipped.op}:${shipped.blobSha}` : '-';
    // No mode (a chmod on the tip is invisible) or a pruned blob (a merged path's is in no commit):
    // the record cannot be merged from, so it anchors like no record.
    if (shipped?.mode && shipped.op === 'delete')
        return { entry: null, token };
    if (shipped?.mode && git(root, ['cat-file', '-e', shipped.blobSha])) {
        return { entry: { blob: shipped.blobSha, mode: shipped.mode }, token };
    }
    const fork = head ? git(root, ['merge-base', tip, head])?.toString('utf8').trim() : '';
    // Unrelated histories: nothing to anchor on, so the tip stands in and the path is copied as before.
    return fork
        ? { entry: treeEntry(root, fork, path), since: fork, token }
        : { entry: treeEntry(root, tip, path), token };
}
const sameEntry = (a, b) => a === null || b === null ? a === b : a.blob === b.blob && a.mode === b.mode;
/** copy: tip unmoved or equal to the caller. keep: caller unchanged. merge: both changed a file. */
export function decide(here, tip, anchor) {
    if (sameEntry(tip, anchor) || sameEntry(here, tip))
        return 'copy';
    if (sameEntry(here, anchor))
        return 'keep';
    if (!here || !tip || !anchor)
        return 'refuse';
    const regular = (e) => e.mode !== '120000' && e.mode !== '160000';
    return regular(here) && regular(tip) && regular(anchor) ? 'merge' : 'refuse';
}
/** Three-way merge of three blobs; the merged blob, or null on a conflict or a binary file. */
export function mergeBlobs(root, here, anchor, tip) {
    const dir = mkdtempSync(join(tmpdir(), 'reship-anchor-'));
    try {
        const files = [here, anchor, tip].map((e, i) => {
            const bytes = git(root, ['cat-file', 'blob', e.blob]);
            if (!bytes)
                throw new Error(`could not read blob ${e.blob}`);
            const file = join(dir, String(i));
            writeFileSync(file, bytes);
            return file;
        });
        const merged = git(root, ['merge-file', '-p', ...files]);
        return (merged &&
            (git(root, ['hash-object', '-w', '--stdin'], merged)?.toString('utf8').trim() ?? null));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** Up to three commits that changed <path> on the tip after the anchor, newest first. */
export function foreignCommits(root, tip, path, anchor, since) {
    const from = since ??
        (anchor &&
            lines(git(root, ['log', '-50', '--format=%H', tip, '--', path])).find((rev) => treeEntry(root, rev, path)?.blob === anchor.blob));
    const range = from ? `${from}..${tip}` : tip;
    return lines(git(root, ['log', '-3', '--no-renames', '--format=%h %s', range, '--', path]));
}
/** Plan one briefed path. A `merge` that conflicts comes back as `refuse`. */
export function planPath(root, branch, tip, head, path) {
    const here = hereEntry(root, path);
    const tipEntry = treeEntry(root, tip, path);
    const { entry: anchor, since, token } = anchorEntry(root, branch, tip, head, path);
    let action = decide(here, tipEntry, anchor);
    if (action === 'copy')
        return { path, action, here, tip: tipEntry, commits: [], token };
    let merged;
    if (action === 'merge' && here && tipEntry && anchor) {
        const blob = mergeBlobs(root, here, anchor, tipEntry);
        if (blob)
            merged = { blob, mode: here.mode === anchor.mode ? tipEntry.mode : here.mode };
        else
            action = 'refuse';
    }
    const commits = foreignCommits(root, tip, path, anchor, since);
    return { path, action, here, tip: tipEntry, merged, commits, token };
}
function report(branch, heading, plans) {
    console.error(heading);
    for (const p of plans) {
        console.error(`  ${shown(p.path)}`);
        for (const c of p.commits)
            console.error(`      ${c}`);
    }
    if (plans.every((p) => p.commits.length === 0))
        console.error(`      (see git log origin/${branch})`);
}
/** Stage <entry> at <path> in the worktree's index and files; null removes it. */
function stageEntry(wt, path, entry) {
    const name = posix.normalize(path); // the index takes a tree path, not a pathspec: no `./`
    const ok = entry
        ? git(wt, ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blob},${name}`]) &&
            git(wt, ['checkout-index', '-f', '--', name])
        : git(wt, ['update-index', '--force-remove', '--', name]);
    if (!ok)
        throw new Error(`could not stage ${shown(path)}`);
    if (!entry)
        rmSync(join(wt, name), { force: true });
}
/** Plan every path, then stage each from the bytes it was judged on. Returns the exit code. */
export function stageAppend({ root, wt, branch, tip, head, out }, paths) {
    const plans = paths.map((p) => planPath(root, branch, tip, head, p));
    const blocked = plans.filter((p) => p.action === 'refuse');
    const replace = envFlag('SHIP_REPLACE_OK');
    if (blocked.length > 0 && !replace) {
        report(branch, `ship --pr: origin/${branch} changed these path(s) after the copy you are shipping was taken:`, blocked);
        console.error('  They cannot be merged with your copy (the same lines changed on both sides, or the');
        console.error('  path is binary, a symlink, a submodule, or deleted on one side), so shipping would');
        console.error('  revert the commit(s) above.');
        console.error(`  Fetch origin/${branch}, merge its version of the path(s) into yours, and re-run;`);
        console.error('  or, if your copy is meant to replace it, re-run with GUARD_SHIP_REPLACE_OK=1.');
        return 1;
    }
    if (blocked.length > 0) {
        report(branch, `⚠️  GUARD_SHIP_REPLACE_OK: replacing origin/${branch}'s version of these path(s) with yours:`, blocked);
    }
    const guards = [];
    for (const p of plans) {
        if (p.action !== 'keep')
            stageEntry(wt, p.path, p.merged ?? p.here);
        const record = p.action === 'keep' ? '' : p.merged && p.here ? `${p.here.mode} ${p.here.blob}` : '=';
        guards.push(p.token, record, p.path);
    }
    const merged = plans.filter((p) => p.action === 'merge');
    if (merged.length > 0) {
        report(branch, `ship --pr: merged origin/${branch}'s changes to these path(s) with yours:`, merged);
        console.error('  Your checkout still holds the older copy; the commit carries both sides.');
    }
    writeFileSync(out, guards.map((s) => `${s}\0`).join(''));
    return 0;
}
function main() {
    const { flags, paths } = parseArgs(process.argv.slice(2));
    const str = (k) => {
        const v = flags[k];
        return v === undefined || v === true || v === false ? '' : v;
    };
    const opts = {
        root: str('root'),
        wt: str('wt'),
        branch: str('branch'),
        tip: str('tip'),
        head: str('head'),
        out: str('out'),
    };
    if (!opts.root || !opts.wt || !opts.branch || !opts.tip || !opts.out || paths.length === 0) {
        console.error('reship-anchor: missing one of --root/--wt/--branch/--tip/--out or the paths');
        return 1;
    }
    try {
        return stageAppend(opts, paths);
    }
    catch (e) {
        console.error(`ship --pr: could not compare your paths with origin/${opts.branch}: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    process.exit(main());
