// sc-4157: `.devkit/` never reaches a linked worktree, so core.hooksPath is absolute and the hook
// links the home's overlay in on demand. Rationale: docs/decisions/overlay-self-heal.md.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, matchesGlob, relative, resolve } from 'node:path';
import {
  FIXED_GATE_INPUTS,
  type GateInput,
  readableGateInputs,
} from '../../../../gate-engine/deterministic/gate-inputs.mts';
import { overlayConfigured } from '../../../../gate-engine/overlay-mode.mts';
import { detectGitRoot } from '../../detect-git-root.mts';
import { gitOut, isInside, isInsideResolved, sameDir } from '../../doctor/hooks-path.mts';
import { DEVKIT_CACHE_IGNORES, LEGACY_GITIGNORE_LINES } from '../../install/gitignore-cache.mts';
import { shQuote } from '../../ship/redact-secrets.mts';
import { BIN_DIRS } from '../gate-policy/block-helpers.mts';

export const LOCAL_HOOKS = '.devkit/hooks';
const OURS_ABSOLUTE_RE = /\/\.devkit\/hooks\/?$/;

const pkgPath = (pkgRel: string, rel: string) => (pkgRel ? `${pkgRel}/${rel}` : rel);
const pkgDevkit = (pkgRel: string) => pkgPath(pkgRel, '.devkit');
const devkitDirs = (pkgRel: string) => [...new Set(['.devkit', pkgDevkit(pkgRel)])];
const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

// Per-checkout runtime state is never projected; the verdict caches it lists (and their
// `.generation` companions) are anchored to the main checkout, so no worktree reads a copy.
const RUNTIME_STATE = [...DEVKIT_CACHE_IGNORES, ...LEGACY_GITIGNORE_LINES]
  .filter((rule) => rule.startsWith('.devkit/'))
  .map((rule) => rule.slice('.devkit/'.length).replace(/\/$/, ''));
const isRuntimeState = (child: string) =>
  RUNTIME_STATE.some((glob) => matchesGlob(child.replace(/\.generation$/, ''), glob));

/** One path a linked worktree borrows from the home, git-root-relative: a branch-local copy or a link. */
interface Projected {
  rel: string;
  copy: boolean;
  dir: boolean;
}

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** What the home owes a linked worktree: each `.devkit` child the registry does not cover, then the
 * registry (a `branch` entry is copied, a `clone` one linked), limited to what the home holds. */
function projection(
  home: string,
  pkgRel: string,
  onConfigError?: (message: string) => void,
): Projected[] {
  const registry = readableGateInputs(join(home, pkgRel), onConfigError)
    .filter((input) => input.share !== 'checkout')
    .map((input) => ({ rel: pkgPath(pkgRel, input.path), copy: input.share === 'branch' }));
  const covered = (rel: string) =>
    registry.some((entry) => entry.rel === rel || entry.rel.startsWith(`${rel}/`));
  const children = devkitDirs(pkgRel).flatMap((dir) =>
    safeList(join(home, dir))
      .filter((child) => !isRuntimeState(child))
      .map((child) => ({ rel: `${dir}/${child}`, copy: false }))
      .filter((entry) => !covered(entry.rel)),
  );
  return [...children, ...registry]
    .filter((entry) => occupied(join(home, entry.rel)))
    .map((entry) => ({ ...entry, dir: isDir(join(home, entry.rel)) }));
}

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const isRealFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/** Is a directory above `rel` a link in `wt` (a legacy linked `.devkit`)? Nothing projects through it. */
const beyondLink = (wt: string, rel: string) => {
  for (let dir = dirname(rel); dir !== '.'; dir = dirname(dir))
    if (isLink(join(wt, dir))) return true;
  return false;
};

const CHECK_IGNORE_ANSWERED = new Set<number | null>([0, 1]);

/** Which of `owed` git ignores and does not track in `wt`, asked in one check-ignore; git refuses a
 * path beyond a link. A directory is also asked as `rel/`, the only form a `dir/` line matches. */
function ignoredIn(wt: string, owed: Projected[]): Set<string> {
  const asked = owed
    .filter(({ rel }) => !beyondLink(wt, rel))
    .flatMap(({ rel, dir }) => (dir && !isLink(join(wt, rel)) ? [rel, `${rel}/`] : [rel]));
  if (!asked.length) return new Set();
  const r = spawnSync('git', ['-C', wt, 'check-ignore', '-z', '--stdin'], {
    input: `${asked.join('\0')}\0`,
    encoding: 'utf8',
  });
  // 0 = some ignored, 1 = none; anything else (null when git never ran) is git refusing to answer.
  if (!CHECK_IGNORE_ANSWERED.has(r.status))
    throw new Error(
      `git check-ignore failed in ${wt}: ${[r.stderr, r.error].filter(Boolean).join(' ')}`,
    );
  return new Set(r.stdout.split('\0').filter(Boolean));
}

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

/** Does `root` declare an overlay install of its own — a real `.devkit/config.json`, hook or not? A
 * config that does not parse throws, so ship fails closed rather than gating as package mode. */
const declaresOverlay = (root: string) =>
  !isLink(join(root, '.devkit')) &&
  isRealFile(join(root, '.devkit', 'config.json')) &&
  overlayConfigured(root);

/** Is `wt` an install of its own rather than a borrower? Only a config.json inside it says so: a
 * hook copied into a real `.devkit` (worktree tooling does this) still borrows the home's inputs. */
export const ownsOverlayConfig = (wt: string, pkgRel: string) => {
  const config = join(wt, pkgDevkit(pkgRel), 'config.json');
  return isRealFile(config) && isInsideResolved(realpathSync(wt), realpathSync(config));
};

/** The one home resolver (ship's via overlay-root.mts): the worktree an absolute hooksPath names,
 * else the first non-bare worktree that `owns` an overlay. */
export function overlayHome(gitRoot: string, owns = hasOwnOverlay): string | null {
  const value = gitOut(gitRoot, ['config', '--get', 'core.hooksPath']);
  if (isAbsolute(value) && isOverlayHooksValue(value, gitRoot)) {
    const home = dirname(dirname(value.replace(/\/+$/, '')));
    if (owns(home)) return home;
  }
  return worktrees(gitRoot).find((wt) => !wt.bare && owns(wt.path))?.path ?? null;
}

/** overlayHome's worktree scan as a shell command, for the husky shim, which runs in every husky repo
 * and so never starts node. Its hooksPath step never applies there: husky's runner owns hooksPath. */
export const OVERLAY_HOME_SH = `git worktree list --porcelain 2>/dev/null |
    awk '/^worktree /{w=substr($0,10)} /^bare$/{w=""} /^$/{if(w!="")print w; w=""}' |
    while IFS= read -r __dk_w; do [ -x "$__dk_w/${LOCAL_HOOKS}/pre-commit" ] && { printf '%s\\n' "$__dk_w"; break; }; done`;

/** Ship's overlay root: `root` itself when it declares its own overlay, else the home. Found by config,
 * not hook, so ship fails closed on a missing hook instead of gating as package mode. */
export function shipOverlayRoot(root: string): string | null {
  return declaresOverlay(root) ? root : overlayHome(root, declaresOverlay);
}

// A concurrent repair may have linked it first: that link is the one we wanted, not a failure.
const link = (src: string, dst: string) => {
  try {
    symlinkSync(src, dst);
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
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

// In the worktree's own `.devkit` when it has one, so git never sees the temp.
const copyTemp = (devkit: string, dst: string) =>
  occupied(devkit) && !lstatSync(devkit).isSymbolicLink()
    ? join(devkit, `.copy-${process.pid}-${baseName(dst)}`)
    : `${dst}.copy-${process.pid}`;

// Temp + rename: a crash never leaves a partial copy that reads as done, and a concurrent
// projector's finished copy wins rather than being removed.
function copyInto(devkit: string, src: string, dst: string): void {
  const tmp = copyTemp(devkit, dst);
  try {
    cpSync(src, tmp, { recursive: true });
    renameSync(tmp, dst);
  } catch (e) {
    if (!occupied(dst)) throw e;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Project the home's overlay into `wt`: every ignored, unoccupied entry the home holds, so a path the
 * worktree already has (its own file, or a hand-made link) is never replaced. */
function projectOverlayIntoWorktree(wt: string, home: string, pkgRel: string): void {
  const devkit = join(wt, pkgDevkit(pkgRel));
  const owed = projection(home, pkgRel);
  const ignored = ignoredIn(wt, owed);
  const missing = owed.filter((e) => placeable(ignored, e) && !occupied(join(wt, e.rel)));
  for (const { rel, copy } of missing) {
    const dst = join(wt, rel);
    mkdirSync(dirname(dst), { recursive: true });
    if (copy) copyInto(devkit, join(home, rel), dst);
    else link(join(home, rel), dst);
  }
}

/** Would what projection places for `entry` be ignored: a link reads as a file, a copy as its type. */
const placeable = (ignored: Set<string>, { rel, dir, copy }: Projected) =>
  ignored.has(rel) || (dir && copy && ignored.has(`${rel}/`));

export interface ProjectionGaps {
  /** Ignored here and missing, a copy linked into the home, or a legacy linked `.devkit`. */
  owed: string[];
  /** Missing linked directories ignored only by a `dir/` line, which never matches a link. */
  unlinkable: string[];
}

export function projectionGaps(wt: string, home: string, pkgRel: string): ProjectionGaps {
  const legacy = devkitDirs(pkgRel).filter((dir) => linksInto(home, join(wt, dir)));
  const owed = projection(home, pkgRel);
  const ignored = ignoredIn(wt, owed);
  const absent = (e: Projected) => !occupied(join(wt, e.rel));
  const wrong = (e: Projected) => e.copy && linksInto(home, join(wt, e.rel));
  return {
    owed: legacy.concat(
      owed.filter((e) => placeable(ignored, e) && (absent(e) || wrong(e))).map((e) => e.rel),
    ),
    unlinkable: owed
      .filter((e) => absent(e) && e.dir && !e.copy && !placeable(ignored, e))
      .filter((e) => ignored.has(`${e.rel}/`))
      .map((e) => e.rel),
  };
}

/** Close the owed gaps: drop the links (never the home's files), then project what is missing. */
export function repairProjection(wt: string, home: string, pkgRel: string): ProjectionGaps {
  const gaps = projectionGaps(wt, home, pkgRel);
  for (const rel of gaps.owed.filter((r) => linksInto(home, join(wt, r)))) {
    try {
      unlinkSync(join(wt, rel));
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e; // a racing repair
    }
  }
  if (gaps.owed.length) projectOverlayIntoWorktree(wt, home, pkgRel);
  return gaps;
}

const linksInto = (home: string, path: string) => {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    return isInsideResolved(home, resolve(dirname(path), readlinkSync(path)));
  } catch {
    return false;
  }
};

/** Is `path` a real file or directory of `wt` itself — not a link, and not reached through one? */
const ownedBy = (wt: string, path: string) => {
  try {
    return !lstatSync(path).isSymbolicLink() && isInside(realpathSync(wt), realpathSync(path));
  } catch {
    return false;
  }
};

/** Same bytes, recursively: a copy still identical to the home's is devkit's own and safe to drop. */
const sameTree = (a: string, b: string): boolean => {
  try {
    const [sa, sb] = [lstatSync(a), lstatSync(b)];
    if (sa.isFile() && sb.isFile()) return readFileSync(a).equals(readFileSync(b));
    if (!sa.isDirectory() || !sb.isDirectory()) return false;
    const [ea, eb] = [readdirSync(a).sort(), readdirSync(b).sort()];
    return ea.join('\0') === eb.join('\0') && ea.every((n) => sameTree(join(a, n), join(b, n)));
  } catch {
    return false;
  }
};

/** What clean did to linked worktrees: links removed, branch-changed copies left for the user, and
 * why the configured entries went unread (an unparseable guard.config.json). */
export interface UnprojectResult {
  unlinked: string[];
  kept: string[];
  unread?: string;
}

/** Remove every link a worktree holds into `home`'s overlay, before the home's own state goes. A copy
 * is removed only while identical to the home's; one the branch changed (or owns) is kept and listed. */
export function unprojectOverlay(home: string, pkgRel: string): UnprojectResult {
  const unlinked: string[] = [];
  const kept: string[] = [];
  let unread: string | undefined;
  const intoHome = (path: string) => linksInto(home, path);
  const owed = projection(home, pkgRel, (message) => {
    unread = message;
  });
  for (const wt of worktrees(home)) {
    // A worktree NESTED in the home still counts; a pruned one's path is gone.
    if (wt.bare || sameDir(home, wt.path) || !occupied(wt.path)) continue;
    // Only what projection could have placed: ignored, untracked, not beyond a link (a legacy linked
    // .devkit is itself dropped by the devkitDirs loop below).
    const ignored = ignoredIn(wt.path, owed);
    const removed: string[] = [];
    const drop = (path: string) => {
      unlinkSync(path);
      unlinked.push(path);
      removed.push(path);
    };
    for (const { rel, copy } of owed.filter((entry) => placeable(ignored, entry))) {
      const path = join(wt.path, rel);
      if (!copy || !ownedBy(wt.path, path)) {
        if (intoHome(path)) drop(path);
      } else if (sameTree(path, join(home, rel))) {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      } else kept.push(path);
    }
    // What an older projection linked beyond today's entries (ship logs), or a legacy linked .devkit.
    for (const dir of devkitDirs(pkgRel).map((rel) => join(wt.path, rel))) {
      if (intoHome(dir)) drop(dir);
      else
        for (const child of safeList(dir)
          .map((c) => join(dir, c))
          .filter(intoHome))
          drop(child);
    }
    for (const path of removed) pruneEmptyParents(wt.path, path);
  }
  return { unlinked, kept, unread };
}

/** Drop the directories a projection created above `path` once empty; one holding anything stays. */
function pruneEmptyParents(wt: string, path: string) {
  for (let dir = dirname(path); dir !== wt && isInside(wt, dir); dir = dirname(dir)) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

const safeList = (dir: string) => {
  try {
    return lstatSync(dir).isDirectory() ? readdirSync(dir) : [];
  } catch {
    return [];
  }
};

const shGlob = (glob: string) =>
  glob
    .split('*')
    .map((part) => part && shQuote(part))
    .join('*');
const shWords = (paths: string[]) => paths.map(shQuote).join(' ');

/** Passes only when a linked worktree owes nothing to the registry as rendered from `root`'s config;
 * it may fail a complete one. A later config path change is hook drift until doctor --fix. */
function projectedTest(root: string, pkgRel: string): string {
  const inputs = readableGateInputs(join(root, pkgRel)).filter(
    (input) => input.share !== 'checkout' && !input.eachFile,
  );
  const perFile = FIXED_GATE_INPUTS.filter((input) => input.eachFile && input.share !== 'checkout');
  const rels = (share: GateInput['share']) =>
    shWords(inputs.filter((i) => i.share === share).map((i) => pkgPath(pkgRel, i.path)));
  const all = [...inputs, ...perFile].map((input) => pkgPath(pkgRel, input.path));
  const runtime = RUNTIME_STATE.flatMap((glob) => [glob, `${glob}.generation`]).map(shGlob);
  const globs = perFile.map((input) => {
    const dir = shQuote(pkgPath(pkgRel, input.path));
    return `    for __dk_p in "$__dk_home"/${dir}/*${shQuote(input.eachFile ?? '')}; do __dk_owed ${dir}/"\${__dk_p##*/}"${input.share === 'branch' ? ' 1' : ''} && return 1; done`;
  });
  const children = devkitDirs(pkgRel).map((dir) => {
    const covered = all
      .filter((rel) => rel.startsWith(`${dir}/`))
      .map((rel) => rel.slice(dir.length + 1).split('/')[0]);
    const d = shQuote(dir);
    return `    for __dk_p in "$__dk_home"/${d}/* "$__dk_home"/${d}/.[!.]* "$__dk_home"/${d}/..?*; do
        case "\${__dk_p##*/}" in ${[...new Set(covered)].map(shQuote).concat(runtime).join('|')}) continue ;; esac
        __dk_owed ${d}/"\${__dk_p##*/}" && return 1
    done`;
  });
  return `__dk_has() { [ -e "$1" ] || [ -L "$1" ]; }
# Owed: the home holds $1 and this worktree lacks it, or holds a link where a branch copy belongs ($2).
__dk_owed() { __dk_has "$__dk_home/$1" && { ! __dk_has "$1" || { [ -n "\${2:-}" ] && [ -L "$1" ]; }; }; }
__dk_projected() {
    for __dk_p in ${shWords(devkitDirs(pkgRel))}; do [ -L "$__dk_p" ] && return 1; done
    for __dk_p in ${rels('clone')}; do __dk_owed "$__dk_p" && return 1; done
    for __dk_p in ${rels('branch')}; do __dk_owed "$__dk_p" 1 && return 1; done
${[...globs, ...children].join('\n')}
    return 0
}`;
}

/** Fail without devkit on PATH; in a linked worktree (the hook's `../..` is not this checkout) project
 * the home's overlay via the one TS projector, or fail. Under the husky shim `../..` is physical. */
export function projectionPrelude(root: string, pkgRel: string): string {
  const pkg = pkgRel ? ` --pkg ${shQuote(pkgRel)}` : '';
  return `${BIN_DIRS.global.open}
__dk_home=$(cd \${DEVKIT_VIA_HUSKY_INIT:+-P} "$(dirname -- "$0")/../.." && pwd -P) || exit 1
if [ "$__dk_home" != "$(pwd -P)" ]; then
${projectedTest(root, pkgRel).replace(/^(?=.)/gm, '    ')}
    __dk_projected || "$__dk_package_bin_dir/devkit" sync-worktree --home "$__dk_home"${pkg} || exit 1
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
