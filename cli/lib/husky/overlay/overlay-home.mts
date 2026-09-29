// sc-4157: `.devkit/` never reaches a linked worktree, so core.hooksPath is absolute and the hook
// links the home's overlay in on demand. Rationale: docs/decisions/overlay-self-heal.md.

import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { detectGitRoot } from '../../detect-git-root.mts';
import { gitOut, isInsideResolved, sameDir } from '../../doctor/hooks-path.mts';
import { ANTI_SLOP_BASELINE_REL } from '../../install/anti-slop/constants.mts';
import { shQuote } from '../../ship/redact-secrets.mts';

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

/** Did devkit's overlay write `value`? The legacy relative form, or exactly one of this repo's
 * worktrees' `.devkit/hooks` — a same-named dir elsewhere is somebody else's. */
export function isOverlayHooksValue(value: string, gitRoot: string): boolean {
  if (value === LOCAL_HOOKS) return true;
  if (!isAbsolute(value) || !OURS_ABSOLUTE_RE.test(value)) return false;
  return worktrees(gitRoot).some((wt) => sameDir(join(wt.path, LOCAL_HOOKS), value));
}

/** The absolute core.hooksPath for an overlay installed at `gitRoot`. */
export function overlayHooksPath(gitRoot: string): string {
  return join(resolve(gitRoot), LOCAL_HOOKS);
}

/** Git-root-relative entries a linked worktree borrows from the home, `.devkit` (hooks) first. */
export function projectionEntries(pkgRel: string): string[] {
  if (!pkgRel) return PACKAGE_ENTRIES;
  return ['.devkit', ...PACKAGE_ENTRIES.map((entry) => `${pkgRel}/${entry}`)];
}

interface Worktree {
  path: string;
  bare: boolean;
}

/** Every registered worktree, main first; a bare repository's own entry is flagged. */
export function worktrees(gitRoot: string): Worktree[] {
  const out: Worktree[] = [];
  for (const field of gitOut(gitRoot, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    if (field.startsWith('worktree '))
      out.push({ path: field.slice('worktree '.length), bare: false });
    else if (field === 'bare' && out.length) out[out.length - 1].bare = true;
  }
  return out;
}

/** Does `root` hold a real overlay of its own — a hook inside it, not one reached through a link? */
export function hasOwnOverlay(root: string): boolean {
  try {
    if (!lstatSync(join(root, '.devkit')).isDirectory()) return false;
    return isInsideResolved(
      realpathSync(root),
      realpathSync(join(root, LOCAL_HOOKS, 'pre-commit')),
    );
  } catch {
    return false;
  }
}

/** The worktree whose `.devkit/hooks` the overlay runs: named by an absolute hooksPath, else found. */
export function overlayHome(gitRoot: string): string | null {
  const value = gitOut(gitRoot, ['config', '--get', 'core.hooksPath']);
  if (isAbsolute(value) && isOverlayHooksValue(value, gitRoot)) {
    const home = dirname(dirname(value.replace(/\/+$/, '')));
    if (hasOwnOverlay(home)) return home;
  }
  return worktrees(gitRoot).find((wt) => !wt.bare && hasOwnOverlay(wt.path))?.path ?? null;
}

const isIgnored = (wt: string, rel: string) => {
  try {
    execFileSync('git', ['-C', wt, 'check-ignore', '-q', '--no-index', '--', rel], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

// A concurrent repair may have linked it first: that link is the one we wanted, not a failure.
const link = (src: string, dst: string) => {
  try {
    symlinkSync(src, dst);
    return true;
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'EEXIST') return false;
    throw e;
  }
};

const occupied = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Link the home's overlay entries into `wt`; a real directory gets its missing children linked. */
export function projectOverlayIntoWorktree(wt: string, home: string, pkgRel: string): string[] {
  const linked: string[] = [];
  for (const rel of projectionEntries(pkgRel)) {
    const src = join(home, rel);
    const dst = join(wt, rel);
    if (!occupied(src)) continue;
    if (occupied(dst) && lstatSync(dst).isDirectory()) {
      for (const child of readdirSync(src)) {
        const childRel = `${rel}/${child}`;
        if (occupied(join(dst, child)) || !isIgnored(wt, childRel)) continue;
        if (link(join(src, child), join(dst, child))) linked.push(childRel);
      }
      continue;
    }
    if (occupied(dst) || !isIgnored(wt, rel)) continue;
    if (link(src, dst)) linked.push(rel);
  }
  return linked;
}

/** Remove every link a worktree holds into `home`'s overlay, before the home's own state goes. */
export function unprojectOverlay(home: string, pkgRel: string): string[] {
  const removed: string[] = [];
  const intoHome = (path: string) => {
    try {
      if (!lstatSync(path).isSymbolicLink()) return false;
      return isInsideResolved(home, resolve(dirname(path), readlinkSync(path)));
    } catch {
      return false;
    }
  };
  for (const wt of worktrees(home)) {
    if (wt.bare || sameDir(home, wt.path)) continue; // a worktree NESTED in the home still counts
    for (const rel of projectionEntries(pkgRel)) {
      const dst = join(wt.path, rel);
      const children = intoHome(dst) ? [] : safeList(dst);
      for (const child of children.map((c) => join(dst, c)).filter(intoHome)) unlinkSync(child);
      if (!intoHome(dst)) continue;
      unlinkSync(dst);
      removed.push(dst);
    }
  }
  return removed;
}

const safeList = (dir: string) => {
  try {
    return lstatSync(dir).isDirectory() ? readdirSync(dir) : [];
  } catch {
    return [];
  }
};

/**
 * The pre-commit prelude: link the home's overlay into a linked worktree that cannot reach its config.
 * Home is the hook's own `../..`; review runs a private copy, so it never projects.
 */
export function projectionPrelude(pkgRel: string, chainTarget: string): string {
  const marker = shQuote(`${pkgRel ? `${pkgRel}/` : ''}.devkit/config.json`);
  const entries = projectionEntries(pkgRel).map(shQuote).join(' ');
  const chain = chainTarget
    ? `[ -f ${shQuote(chainTarget)} ] && exec sh ${shQuote(chainTarget)} "$@"`
    : ':';
  return `# sc-4157: a linked worktree never gets the git-excluded overlay, so borrow the home's before any gate.
if [ "\${DEVKIT_RUN_MODE:-}" != "review" ] && [ ! -f ${marker} ]; then
    __dk_home=$(cd "$(dirname -- "$0")/../.." 2>/dev/null && pwd -P) || __dk_home=''
    if [ -n "$__dk_home" ] && [ "$__dk_home" != "$(pwd -P)" ]; then
        for __dk_e in ${entries}; do
            [ -e "$__dk_home/$__dk_e" ] || continue
            if [ -d "$__dk_e" ] && [ ! -L "$__dk_e" ]; then
                for __dk_c in "$__dk_home/$__dk_e"/* "$__dk_home/$__dk_e"/.[!.]*; do
                    [ -e "$__dk_c" ] || continue
                    __dk_n="$__dk_e/\${__dk_c##*/}"
                    { [ -e "$__dk_n" ] || [ -L "$__dk_n" ]; } && continue
                    git check-ignore -q --no-index -- "$__dk_n" && ln -s "$__dk_c" "$__dk_n"
                done
                continue
            fi
            { [ -e "$__dk_e" ] || [ -L "$__dk_e" ]; } && continue
            if git check-ignore -q --no-index -- "$__dk_e"; then ln -s "$__dk_home/$__dk_e" "$__dk_e"
            else echo "devkit: $__dk_e is not git-ignored here, so it was not linked" >&2; fi
        done
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
export function overlayCommandCwd(cwd: string): string {
  try {
    // Own only when config.json itself is real: a real dir can hold a LINKED config (merged in).
    const own = !lstatSync(join(cwd, '.devkit')).isSymbolicLink();
    if (own && lstatSync(join(cwd, '.devkit', 'config.json')).isFile()) return cwd;
  } catch {
    // no own .devkit — fall through to the home
  }
  const { gitRoot } = detectGitRoot(cwd);
  const home = overlayHome(gitRoot);
  if (!home || sameDir(home, gitRoot)) return cwd;
  console.error(`devkit: this worktree borrows the overlay at ${home} — running there`);
  return join(home, relative(gitRoot, cwd));
}
