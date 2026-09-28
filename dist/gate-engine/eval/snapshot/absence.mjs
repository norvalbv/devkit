import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GIT_MAX_BUFFER, indexIdentity, splitNul } from './integrity.mjs';
// sc-3215: one line per probe of why a snapshot lacks a path. A failing probe degrades to
// `<unavailable: …>` so a broken git never replaces the fault being explained.
export function probe(label, run) {
    try {
        return `    ${label}: ${run()}`;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `    ${label}: <unavailable: ${message.split('\n')[0]}>`;
    }
}
function gitProbe(root, args, env = process.env) {
    const result = spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env,
        maxBuffer: GIT_MAX_BUFFER,
    });
    if (result.status === null || result.error)
        throw new Error(result.error?.message ?? `git ${args[0]} killed by ${result.signal}`);
    return result;
}
function gitProbeOk(root, args, env) {
    const result = gitProbe(root, args, env);
    if (result.status !== 0)
        throw new Error((result.stderr || `git ${args[0]} failed`).trim());
    return result.stdout;
}
// `:(literal)` so a path holding `*`, `?` or `[` can never be answered by a sibling it globs onto.
const literal = (repoPath) => `:(literal)${repoPath}`;
/** HEAD's commit id, or null ONLY when HEAD names a branch that does not exist yet (unborn). */
function resolveHead(root) {
    const head = gitProbe(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (head.status === 0)
        return head.stdout.trim();
    const branch = gitProbeOk(root, ['symbolic-ref', '-q', 'HEAD']).trim();
    if (gitProbeOk(root, ['for-each-ref', '--format=%(objectname)', branch]).trim())
        throw new Error(`HEAD names ${branch}, which exists but does not resolve`);
    return null;
}
/** Exact-name lookup: ls-tree exits 0 with no entry for an absent path and fails on a broken tree. */
function treeHasPath(root, commit, repoPath) {
    const out = gitProbeOk(root, ['ls-tree', '-z', '--full-tree', commit, '--', literal(repoPath)]);
    return splitNul(out).some((record) => record.slice(record.indexOf('\t') + 1) === repoPath);
}
export function explainStagedAbsence(root, repoPath, listFiles) {
    // Every index probe reads ONE private copy, so a concurrent writer cannot make them disagree.
    let scratch = '';
    try {
        scratch = mkdtempSync(join(tmpdir(), 'devkit-absence-'));
    }
    catch {
        // Left empty: the index-copy probes below then report <unavailable> instead.
    }
    const copy = scratch ? join(scratch, 'index') : '';
    let copied = false;
    const fromCopy = (args) => {
        if (!copied)
            throw new Error('no private copy of the index');
        return gitProbeOk(root, args, { ...process.env, GIT_INDEX_FILE: copy });
    };
    let head;
    try {
        return [
            `  absence of ${repoPath} (staged):`,
            probe('listing', () => `${listFiles().length} entries`),
            probe('index', () => {
                const index = resolve(root, gitProbeOk(root, ['rev-parse', '--git-path', 'index']).trim());
                const stat = statSync(index);
                const lock = existsSync(`${index}.lock`) ? 'present' : 'absent';
                if (copy) {
                    copyFileSync(index, copy);
                    copied = true;
                }
                return `${index} size=${stat.size} bytes mtime=${stat.mtime.toISOString()} index.lock ${lock}`;
            }),
            probe('re-probe', () => fromCopy(['ls-files', '--stage', '-z', '--', literal(repoPath)]) ? 'present' : 'absent'),
            probe('HEAD', () => {
                head = resolveHead(root);
                if (head === null)
                    return 'unborn';
                return treeHasPath(root, head, repoPath) ? 'tracked' : 'untracked';
            }),
            probe('staged vs HEAD', () => {
                if (head === null)
                    return 'HEAD unborn';
                if (head === undefined)
                    throw new Error('HEAD did not resolve');
                const out = fromCopy([
                    'diff',
                    '--cached',
                    '--name-status',
                    '-z',
                    head,
                    '--',
                    literal(repoPath),
                ]);
                return splitNul(out)[0] ?? 'none';
            }),
            probe('toplevel', () => {
                const toplevel = realpathSync(gitProbeOk(root, ['rev-parse', '--show-toplevel']).trim());
                return toplevel === root ? 'matches root' : `MISMATCH ${toplevel} (root ${root})`;
            }),
            probe('identity', () => indexIdentity(fromCopy(['ls-files', '--stage', '-z']))),
        ].join('\n');
    }
    finally {
        if (scratch)
            rmSync(scratch, { recursive: true, force: true });
    }
}
