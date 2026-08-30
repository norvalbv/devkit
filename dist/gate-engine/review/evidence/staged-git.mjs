/**
 * Staged-tree git plumbing for the review gate (extracted from run-review.mts, sc-1442).
 *
 * argv-based on purpose: staged FILENAMES ride these calls, and a shell string (even
 * JSON.stringify-quoted) lets a crafted path like `$(cmd).ts` expand before git runs.
 */
import { execFileSync } from 'node:child_process';
import { normalizeRepositoryFile } from '../../../skills/_devkit/review-roots.mjs';
export function gitCached(cwd, args, files) {
    const pathspecs = files.map((file) => `:(top,literal)${normalizeRepositoryFile(file, 'review evidence file')}`);
    return execFileSync('git', ['diff', '--cached', ...args, '--', ...pathspecs], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
}
function snapshotFile(cwd, spec) {
    return execFileSync('git', ['show', spec], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
}
const literalPathspec = (file) => `:(top,literal)${file}`;
function indexHasStageZero(cwd, file) {
    // stderr ignored, as in snapshotFile: callers probe paths that may not be in a repo at all.
    const entries = execFileSync('git', ['ls-files', '--stage', '-z', '--', literalPathspec(file)], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0');
    return entries.some((entry) => /^\d+ [0-9a-f]+ 0\t/.test(entry));
}
/** Read one file from HEAD without trusting the staged/worktree copy. Missing/unborn → null. */
export function headFile(cwd, file) {
    const normalized = normalizeRepositoryFile(file, 'HEAD file');
    const head = headHash(cwd);
    if (head === null)
        throw new Error('cannot read HEAD while resolving review policy');
    if (head.startsWith('unborn:'))
        return null;
    const entry = execFileSync('git', ['ls-tree', '-z', '--name-only', 'HEAD', '--', literalPathspec(normalized)], { cwd, encoding: 'utf8' });
    if (entry === '')
        return null;
    return snapshotFile(cwd, `HEAD:${normalized}`);
}
/** Stage-0 paths whose basename matches, or null when git cannot answer (no repo, no git).
 * Index names are exact, so this is case-sensitive on every filesystem. */
export function indexPathsNamed(cwd, basename) {
    let out;
    try {
        out = execFileSync('git', ['ls-files', '--stage', '-z', '--', `:(top,glob)**/${basename}`, literalPathspec(basename)], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    }
    catch {
        return null;
    }
    const paths = new Set();
    for (const entry of out.split('\0')) {
        // Split on the tab rather than matching the path: git paths may contain newlines, which `-z`
        // preserves intact but a regex `.` would refuse.
        const tab = entry.indexOf('\t');
        if (tab < 0 || !/^\d+ [0-9a-f]+ 0$/.test(entry.slice(0, tab)))
            continue;
        paths.add(entry.slice(tab + 1));
    }
    return paths;
}
/** Read one stage-0 file from Git's index. Missing/deleted/unmerged → null. */
export function indexFile(cwd, file) {
    const normalized = normalizeRepositoryFile(file, 'index file');
    if (!indexHasStageZero(cwd, normalized))
        return null;
    return snapshotFile(cwd, `:0:${normalized}`);
}
export function stagedFiles(cwd) {
    // -z: NUL-separated RAW names. Without it git C-quotes paths containing tabs/unicode/quotes,
    // and every byte-keyed consumer (chunk packing, evidence budgeting) silently misses them.
    return execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
}
/**
 * Content hash of the staged INDEX (`git write-tree`), or null when the index cannot form a tree
 * (unmerged paths) — callers must treat null as "cannot verify", never as "verified". sc-2054:
 * codex judges run workspace-write (the checklist state file needs cwd writes and codex cannot
 * confine cwd), so the gate snapshots the staged tree before the judge wave and refuses to pass
 * if ANY judge changed what would be committed — tamper DETECTION where prevention is impossible.
 */
export function stagedTreeHash(cwd) {
    try {
        return execFileSync('git', ['write-tree'], { cwd, encoding: 'utf8' }).trim() || null;
    }
    catch {
        return null;
    }
}
/** HEAD identity, `unborn:<ref>` before the first commit (a determinate state carrying the
 * symbolic target, so even switching unborn branches reads as movement), or null when HEAD is
 * UNREADABLE — callers must fail closed on null, never fold it into a determinate state, or two
 * broken reads would compare equal and wave tampering through. Paired with stagedTreeHash: a
 * nested `git commit` moves HEAD while leaving `git write-tree` identical. */
export function headHash(cwd) {
    const read = (args) => {
        try {
            return execFileSync('git', args, {
                cwd,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
        }
        catch {
            return null;
        }
    };
    const sha = read(['rev-parse', '--verify', 'HEAD']);
    if (sha !== null)
        return sha;
    const ref = read(['symbolic-ref', '-q', 'HEAD']);
    return ref !== null ? `unborn:${ref}` : null;
}
