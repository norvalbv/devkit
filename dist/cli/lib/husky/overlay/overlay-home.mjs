// sc-4157: `.devkit/` never reaches a linked worktree, so core.hooksPath is absolute and the hook
// links the home's overlay in on demand. Rationale: docs/decisions/overlay-self-heal.md.
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { detectGitRoot } from '../../detect-git-root.mjs';
import { gitOut, isInside, isInsideResolved, sameDir } from '../../doctor/hooks-path.mjs';
import { ANTI_SLOP_BASELINE_REL } from '../../install/anti-slop/constants.mjs';
import { shQuote } from '../../ship/redact-secrets.mjs';
import { chainWord } from '../husky-block.mjs';
export const LOCAL_HOOKS = '.devkit/hooks';
const OURS_ABSOLUTE_RE = /\/\.devkit\/hooks\/?$/;
// The overlay-owned, git-excluded package entries a gate reads; caches and agent assets stay per-checkout.
const PACKAGE_ENTRIES = [
    '.devkit',
    'guard.config.json',
    'biome.devkit.jsonc',
    'eslint.config.devkit.mjs',
    'oxlint.devkit.json',
    ANTI_SLOP_BASELINE_REL,
    'fallow-baselines',
];
// COPIED, never linked: Node imports a linked eslint.config.devkit.mjs's siblings from the HOME, and a
// ratchet baseline lowered on one branch must not move every other branch's ceiling.
const COPIED = new Set(['eslint.config.devkit.mjs', ANTI_SLOP_BASELINE_REL, 'fallow-baselines']);
const COPIED_DEVKIT_CHILD = 'baselines';
const pkgDevkit = (pkgRel) => (pkgRel ? `${pkgRel}/.devkit` : '.devkit');
const baseName = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const isCopied = (rel) => COPIED.has(baseName(rel));
/** Every branch-local copy a projection owes a worktree, git-root-relative. */
const copyRels = (pkgRel) => [
    ...projectionEntries(pkgRel).filter(isCopied),
    `${pkgDevkit(pkgRel)}/${COPIED_DEVKIT_CHILD}`,
];
/** Did devkit's overlay write `value`? The legacy relative form, or exactly one of this repo's
 * worktrees' `.devkit/hooks` — a same-named dir elsewhere is somebody else's. */
export function isOverlayHooksValue(value, gitRoot) {
    if (value === LOCAL_HOOKS)
        return true;
    if (!isAbsolute(value) || !OURS_ABSOLUTE_RE.test(value))
        return false;
    return worktrees(gitRoot).some((wt) => sameDir(join(wt.path, LOCAL_HOOKS), value));
}
/** The absolute core.hooksPath for an overlay installed at `gitRoot`. */
export function overlayHooksPath(gitRoot) {
    return join(resolve(gitRoot), LOCAL_HOOKS);
}
/** Git-root-relative entries a linked worktree borrows from the home, `.devkit` (hooks) first. */
export function projectionEntries(pkgRel) {
    if (!pkgRel)
        return PACKAGE_ENTRIES;
    return ['.devkit', ...PACKAGE_ENTRIES.map((entry) => `${pkgRel}/${entry}`)];
}
/** Every registered worktree, main first; a bare repository's own entry is flagged. */
export function worktrees(gitRoot) {
    const out = [];
    for (const field of gitOut(gitRoot, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
        if (field.startsWith('worktree '))
            out.push({ path: field.slice('worktree '.length), bare: false });
        else if (field === 'bare' && out.length)
            out[out.length - 1].bare = true;
    }
    return out;
}
/** Does `root` hold a real overlay of its own — a hook inside it, not one reached through a link? */
export function hasOwnOverlay(root) {
    try {
        if (!lstatSync(join(root, '.devkit')).isDirectory())
            return false;
        return isInsideResolved(realpathSync(root), realpathSync(join(root, LOCAL_HOOKS, 'pre-commit')));
    }
    catch {
        return false;
    }
}
/** The worktree whose `.devkit/hooks` the overlay runs: named by an absolute hooksPath, else found. */
export function overlayHome(gitRoot) {
    const value = gitOut(gitRoot, ['config', '--get', 'core.hooksPath']);
    if (isAbsolute(value) && isOverlayHooksValue(value, gitRoot)) {
        const home = dirname(dirname(value.replace(/\/+$/, '')));
        if (hasOwnOverlay(home))
            return home;
    }
    return worktrees(gitRoot).find((wt) => !wt.bare && hasOwnOverlay(wt.path))?.path ?? null;
}
const isIgnored = (wt, rel) => {
    try {
        execFileSync('git', ['-C', wt, 'check-ignore', '-q', '--no-index', '--', rel], {
            stdio: 'ignore',
        });
        return true;
    }
    catch {
        return false;
    }
};
// A concurrent repair may have linked it first: that link is the one we wanted, not a failure.
const link = (src, dst) => {
    try {
        symlinkSync(src, dst);
        return true;
    }
    catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'EEXIST')
            return false;
        throw e;
    }
};
const occupied = (path) => {
    try {
        lstatSync(path);
        return true;
    }
    catch {
        return false;
    }
};
/** Project the home's overlay into `wt`: links, except the branch-local COPIED entries. The package
 * `.devkit` is always a real directory, so its `baselines` can be a copy beside linked siblings. */
export function projectOverlayIntoWorktree(wt, home, pkgRel) {
    const linked = [];
    const devkit = join(wt, pkgDevkit(pkgRel));
    // Temp + rename: a crash never leaves a partial copy that reads as done, and a concurrent
    // projector's finished copy wins rather than being removed.
    const copy = (src, dst) => {
        const own = occupied(devkit) && !lstatSync(devkit).isSymbolicLink();
        const tmp = own
            ? join(devkit, `.copy-${process.pid}-${baseName(dst)}`)
            : `${dst}.copy-${process.pid}`;
        try {
            cpSync(src, tmp, { recursive: true });
            renameSync(tmp, dst);
            return true;
        }
        catch (e) {
            if (occupied(dst))
                return false;
            throw e;
        }
        finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    };
    for (const rel of projectionEntries(pkgRel)) {
        const src = join(home, rel);
        const dst = join(wt, rel);
        if (!occupied(src))
            continue;
        if (rel === pkgDevkit(pkgRel) && !occupied(dst) && isIgnored(wt, `${rel}/config.json`))
            mkdirSync(dst, { recursive: true });
        if (occupied(dst) && lstatSync(dst).isDirectory()) {
            for (const child of readdirSync(src)) {
                const childRel = `${rel}/${child}`;
                if (occupied(join(dst, child)) || !isIgnored(wt, childRel))
                    continue;
                const branchLocal = rel === pkgDevkit(pkgRel) && child === COPIED_DEVKIT_CHILD;
                if ((branchLocal ? copy : link)(join(src, child), join(dst, child)))
                    linked.push(childRel);
            }
            continue;
        }
        if (occupied(dst) || !isIgnored(wt, rel))
            continue;
        if ((isCopied(rel) ? copy : link)(src, dst))
            linked.push(rel);
    }
    return linked;
}
/** What a worktree's projection still owes it: a linked package `.devkit` or copy entry (the first
 * sc-4157 projection linked everything), or a copy that is simply missing. */
export function projectionGaps(wt, home, pkgRel) {
    const devkit = pkgDevkit(pkgRel);
    const linked = linksInto(home, join(wt, devkit)) ? [devkit] : [];
    return linked.concat(copyRels(pkgRel).filter((rel) => linksInto(home, join(wt, rel)) ||
        (occupied(join(home, rel)) && !occupied(join(wt, rel)) && isIgnored(wt, rel))));
}
/** Close `projectionGaps`: drop the links (never the home's files), then project what is missing. */
export function repairProjection(wt, home, pkgRel) {
    const gaps = projectionGaps(wt, home, pkgRel);
    for (const rel of gaps.filter((r) => linksInto(home, join(wt, r)))) {
        try {
            unlinkSync(join(wt, rel));
        }
        catch (e) {
            if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT'))
                throw e; // a racing repair
        }
    }
    if (gaps.length)
        projectOverlayIntoWorktree(wt, home, pkgRel);
    return gaps;
}
const linksInto = (home, path) => {
    try {
        if (!lstatSync(path).isSymbolicLink())
            return false;
        return isInsideResolved(home, resolve(dirname(path), readlinkSync(path)));
    }
    catch {
        return false;
    }
};
/** Is `path` a real file or directory of `wt` itself — not a link, and not reached through one? */
const ownedBy = (wt, path) => {
    try {
        return !lstatSync(path).isSymbolicLink() && isInside(realpathSync(wt), realpathSync(path));
    }
    catch {
        return false;
    }
};
/** Same bytes, recursively: a copy still identical to the home's is devkit's own and safe to drop. */
const sameTree = (a, b) => {
    try {
        const [sa, sb] = [lstatSync(a), lstatSync(b)];
        if (sa.isFile() && sb.isFile())
            return readFileSync(a).equals(readFileSync(b));
        if (!sa.isDirectory() || !sb.isDirectory())
            return false;
        const [ea, eb] = [readdirSync(a).sort(), readdirSync(b).sort()];
        return ea.join('\0') === eb.join('\0') && ea.every((n) => sameTree(join(a, n), join(b, n)));
    }
    catch {
        return false;
    }
};
/** Remove every link a worktree holds into `home`'s overlay, before the home's own state goes. A copy
 * is removed only while identical to the home's; one the branch changed (or owns) is kept and listed. */
export function unprojectOverlay(home, pkgRel) {
    const unlinked = [];
    const kept = [];
    const intoHome = (path) => linksInto(home, path);
    for (const wt of worktrees(home)) {
        if (wt.bare || sameDir(home, wt.path))
            continue; // a worktree NESTED in the home still counts
        for (const rel of copyRels(pkgRel)) {
            const path = join(wt.path, rel);
            if (!ownedBy(wt.path, path))
                continue; // a link, or reached through one (a legacy linked .devkit)
            if (sameTree(path, join(home, rel)))
                rmSync(path, { recursive: true, force: true });
            else
                kept.push(path);
        }
        for (const rel of projectionEntries(pkgRel)) {
            const dst = join(wt.path, rel);
            const children = intoHome(dst) ? [] : safeList(dst);
            for (const child of children.map((c) => join(dst, c)).filter(intoHome))
                unlinkSync(child);
            // The real .devkit a projection created goes with it; one still holding ship logs stays.
            if (baseName(rel) === '.devkit' && children.length && !safeList(dst).length)
                rmdirSync(dst);
            if (!intoHome(dst))
                continue;
            unlinkSync(dst);
            unlinked.push(dst);
        }
    }
    return { unlinked, kept };
}
const safeList = (dir) => {
    try {
        return lstatSync(dir).isDirectory() ? readdirSync(dir) : [];
    }
    catch {
        return [];
    }
};
/**
 * The pre-commit prelude: link the home's overlay into a linked worktree that cannot reach its config.
 * Home is the hook's own `../..`; review runs a private copy, so it never projects.
 */
export function projectionPrelude(pkgRel, chainTarget) {
    const marker = shQuote(`${pkgRel ? `${pkgRel}/` : ''}.devkit/config.json`);
    const entries = projectionEntries(pkgRel).map(shQuote).join(' ');
    const copied = projectionEntries(pkgRel).filter(isCopied).map(shQuote).join('|');
    const chain = chainTarget
        ? `[ -f ${chainWord(chainTarget)} ] && exec sh ${chainWord(chainTarget)} "$@"`
        : ':';
    const devkit = shQuote(pkgDevkit(pkgRel));
    // Mirrors projectOverlayIntoWorktree: COPIED entries and .devkit/baselines are copies, the rest links.
    return `# sc-4157: a linked worktree never gets the git-excluded overlay, so borrow the home's before any gate.
if [ "\${DEVKIT_RUN_MODE:-}" != "review" ] && [ ! -f ${marker} ]; then
    __dk_failed=''
    __dk_copy() {
        __dk_t="$2.copy-$$"
        [ -d ${devkit} ] && [ ! -L ${devkit} ] && __dk_t=${devkit}/".copy-$$-\${2##*/}"
        if cp -R "$1" "$__dk_t" 2>/dev/null && { [ -e "$2" ] || [ -L "$2" ] || mv "$__dk_t" "$2"; }; then
            rm -rf "$__dk_t"; return 0
        fi
        rm -rf "$__dk_t"
        { [ -e "$2" ] || [ -L "$2" ]; } && return 0
        __dk_failed=1; echo "devkit: could not copy $2 into this worktree" >&2
    }
    __dk_home=$(cd "$(dirname -- "$0")/../.." 2>/dev/null && pwd -P) || __dk_home=''
    if [ -n "$__dk_home" ] && [ "$__dk_home" != "$(pwd -P)" ]; then
        for __dk_e in ${entries}; do
            [ -e "$__dk_home/$__dk_e" ] || continue
            if [ "$__dk_e" = ${devkit} ] && [ ! -e "$__dk_e" ] && [ ! -L "$__dk_e" ] \
                && git check-ignore -q --no-index -- "$__dk_e/config.json"; then mkdir -p "$__dk_e"; fi
            if [ -d "$__dk_e" ] && [ ! -L "$__dk_e" ]; then
                for __dk_c in "$__dk_home/$__dk_e"/* "$__dk_home/$__dk_e"/.[!.]*; do
                    [ -e "$__dk_c" ] || continue
                    __dk_n="$__dk_e/\${__dk_c##*/}"
                    { [ -e "$__dk_n" ] || [ -L "$__dk_n" ]; } && continue
                    git check-ignore -q --no-index -- "$__dk_n" || continue
                    if [ "$__dk_e" = ${devkit} ] && [ "\${__dk_c##*/}" = ${COPIED_DEVKIT_CHILD} ]; then __dk_copy "$__dk_c" "$__dk_n"
                    else ln -s "$__dk_c" "$__dk_n"; fi
                done
                continue
            fi
            { [ -e "$__dk_e" ] || [ -L "$__dk_e" ]; } && continue
            if ! git check-ignore -q --no-index -- "$__dk_e"; then
                echo "devkit: $__dk_e is not git-ignored here, so it was not linked" >&2
            else
                case "$__dk_e" in
                    ${copied}) __dk_copy "$__dk_home/$__dk_e" "$__dk_e" ;;
                    *) ln -s "$__dk_home/$__dk_e" "$__dk_e" ;;
                esac
            fi
        done
        # A failed copy leaves the worktree unprojected, so the next commit retries rather than trusts it.
        [ -n "$__dk_failed" ] && [ -L ${marker} ] && rm -f ${marker}
        if [ -f ${marker} ]; then echo "devkit: linked this worktree to the overlay at $__dk_home" >&2
        else
            echo "devkit: overlay not reachable here, gates skipped. Run devkit doctor --fix" >&2
            [ -n "\${DEVKIT_SHIP:-}" ] && exit 1
            ${chain}
            exit 0
        fi
    fi
fi`;
}
/** Where an overlay-owning command runs: the home, when `cwd` only borrows its overlay through links. */
export function overlayCommandCwd(cwd) {
    try {
        // Own only when config.json itself is real: a real dir can hold a LINKED config (merged in).
        const own = !lstatSync(join(cwd, '.devkit')).isSymbolicLink();
        if (own && lstatSync(join(cwd, '.devkit', 'config.json')).isFile())
            return cwd;
    }
    catch {
        // no own .devkit — fall through to the home
    }
    const { gitRoot } = detectGitRoot(cwd);
    const home = overlayHome(gitRoot);
    if (!home || sameDir(home, gitRoot))
        return cwd;
    console.error(`devkit: this worktree borrows the overlay at ${home} — running there`);
    return join(home, relative(gitRoot, cwd));
}
