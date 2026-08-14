/**
 * Reading `core.hooksPath` at the right scope, and resolving it the way git does.
 *
 * Split out of `hook-checks.mts` (which is at its line budget) because getting this right takes more
 * care than the checks that consume it. Two traps in particular:
 *
 *  - `git config --worktree` is only per-checkout when `extensions.worktreeConfig` is enabled.
 *    Otherwise it silently reads — and `--unset` silently DELETES — the repo-wide value, while
 *    every symptom says "worktree scope". Scope has to be established structurally, from the
 *    extension plus the file the value actually lives in.
 *  - a relative `core.hooksPath` must be resolved LEXICALLY. devkit's own ship gate worktrees are
 *    handed a `.husky/_` that is a symlink into the main checkout, so following one through its
 *    link target would call every `devkit ship` a defect.
 *
 * `rev-parse --git-path hooks` looks like the obvious way to ask "where do hooks come from" and is
 * not usable here: it HONOURS core.hooksPath, so it echoes the pin back instead of resolving it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
/** Trimmed stdout of a git command run against `gitRoot`; '' when git fails for any reason. */
export function gitOut(gitRoot, args) {
    try {
        return execFileSync('git', ['-C', gitRoot, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    }
    catch {
        return '';
    }
}
/** The repo-wide `core.hooksPath` — the one `git worktree add` hands to every new checkout, and the
 * one this checkout falls back to if its own pin is cleared. '' when unset. Read at `--local` and
 * never at `--worktree`, for the reason in this module's header. */
export function sharedHooksPath(gitRoot) {
    return gitOut(gitRoot, ['config', '--local', '--get', 'core.hooksPath']);
}
/** The worktree-owned value parsed by git itself. Includes and duplicates are deliberately
 * non-repairable: scope decides whether sync-hook-runner may write, so a plausible value is not
 * enough. Reading `git config --worktree` is unsafe here because it aliases `--local` while the
 * extension is disabled. */
export function worktreeHooksPathState(gitRoot) {
    const enabled = gitOut(gitRoot, [
        'config',
        '--local',
        '--type=bool',
        '--get',
        'extensions.worktreeConfig',
    ]);
    if (enabled !== 'true')
        return { status: 'none' };
    const gitDir = gitOut(gitRoot, ['rev-parse', '--absolute-git-dir']);
    if (!gitDir)
        return { status: 'unreadable', detail: 'git directory is unreadable' };
    const file = join(gitDir, 'config.worktree');
    if (!existsSync(file))
        return { status: 'none' };
    const result = spawnSync('git', [
        '-C',
        gitRoot,
        'config',
        '--file',
        file,
        '--includes',
        '--show-origin',
        '--null',
        '--get-all',
        'core.hooksPath',
    ], { encoding: 'utf8' });
    if (result.status === 1)
        return { status: 'none' };
    if (result.status !== 0)
        return { status: 'unreadable', detail: 'config.worktree could not be parsed by git' };
    const fields = (result.stdout ?? '').split('\0');
    if (fields.at(-1) === '')
        fields.pop();
    if (fields.length !== 2)
        return {
            status: 'ambiguous',
            detail: `${fields.length / 2 || 0} worktree-scoped core.hooksPath values`,
        };
    const [origin, value] = fields;
    const originFile = origin.startsWith('file:') ? origin.slice('file:'.length) : '';
    if (!originFile || !sameDir(originFile, file))
        return {
            status: 'ambiguous',
            detail: `core.hooksPath comes from an included config (${origin || 'unknown origin'})`,
        };
    return { status: 'single', value, file };
}
/** The single unambiguous value recorded for THIS checkout, or ''. */
export function worktreeScopedPin(gitRoot) {
    const state = worktreeHooksPathState(gitRoot);
    return state.status === 'single' ? state.value : '';
}
/** Is `target` `root` itself, or inside it? Compares path SEGMENTS, so `/a/bc` is not inside `/a/b`. */
export function isInside(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** Where git will look for hooks: a relative value resolved against the working tree root. Lexical
 * by design — `resolve`, never `realpathSync` (see the header). */
export function hooksDir(gitRoot, value) {
    return isAbsolute(value) ? value : resolve(gitRoot, value);
}
/** `isInside` that also survives macOS's `/tmp`→`/private/tmp` and `/var`→`/private/var` symlinks,
 * which would otherwise make a checkout's own ABSOLUTE path look foreign. Only reached after the
 * lexical test has already said "outside". */
export function isInsideResolved(root, target) {
    if (isInside(root, target))
        return true;
    // macOS reports registered worktrees through /private even after the checkout disappears, when
    // realpath can no longer normalize the configured /tmp or /var spelling for us.
    const alias = (path) => path.startsWith('/tmp/') || path.startsWith('/var/') ? `/private${path}` : path;
    if (isInside(alias(root), alias(target)))
        return true;
    try {
        return isInside(realpathSync(root), realpathSync(target));
    }
    catch {
        return false;
    }
}
/** Same directory, tolerant of the `/private` aliasing. Load-bearing: git reports absolute paths
 * realpath'd (`/private/var/…`) while a configured value keeps whatever form it was written in
 * (`/var/…`), so a purely lexical comparison calls a pin that restates its own fallback a shadow. */
function sameDir(a, b) {
    return isInsideResolved(a, b) && isInsideResolved(b, a);
}
/** Every checkout of this repo, main worktree included. */
function checkouts(gitRoot) {
    const result = spawnSync('git', ['-C', gitRoot, 'worktree', 'list', '--porcelain', '-z'], {
        encoding: 'utf8',
    });
    if (result.status !== 0)
        return [];
    return (result.stdout ?? '')
        .split('\0')
        .filter((field) => field.startsWith('worktree '))
        .map((field) => field.slice('worktree '.length));
}
/**
 * The hooks directory THIS checkout will actually use, when it belongs to somebody else.
 *
 * A per-checkout `core.hooksPath` pinned at a sibling checkout's runner is how a commit made in
 * worktree A comes to be gated by checkout B's hook — B's version of the gates, from B's branch,
 * with no error and nothing in the usual `git config --get` output to suggest it. Tooling writes it
 * when a fresh worktree has no runner of its own, back when husky gitignored the one it pins; once
 * the runner is tracked and reaches every checkout, the pin only shadows a working local one.
 *
 * Three deliberate silences, each a working configuration this must not turn red:
 *  - a value resolving INSIDE this checkout, however it was spelled (relative, or absolute through
 *    a `/private` symlink);
 *  - a value that merely restates what this checkout would use anyway — a pin naming the very
 *    fallback it shadows changes nothing;
 *  - any value landing outside every checkout of this repo, e.g. an org-shared
 *    `/opt/company/githooks`. Scope expresses precedence, not ownership intent, so external and
 *    already-pruned targets are diagnostic-only. Only Git's own worktree registry is positive
 *    provenance for the borrowed-runner defect.
 */
export function foreignPin(gitRoot) {
    const scoped = worktreeScopedPin(gitRoot);
    const shared = sharedHooksPath(gitRoot);
    const value = scoped || shared;
    // Unset → git's own hooks dir, which every linked worktree shares via the common dir.
    if (!value)
        return null;
    const dir = hooksDir(gitRoot, value);
    if (isInsideResolved(gitRoot, dir))
        return null;
    // What this checkout would fall back to if the value vanished.
    const common = gitOut(gitRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const fallback = scoped && shared ? hooksDir(gitRoot, shared) : join(common, 'hooks');
    if (sameDir(dir, fallback))
        return null;
    const scope = scoped ? '--worktree' : '--local';
    const siblingRoot = checkouts(gitRoot).find((wt) => !sameDir(gitRoot, wt) && isInsideResolved(wt, dir));
    if (!siblingRoot)
        return null;
    return { value, dir, scope, exists: existsSync(dir), siblingRoot };
}
