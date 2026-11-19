#!/usr/bin/env node
/** `ship --pr` append staging: merge what reached the PR branch since the caller's copy was taken.
 *  Usage: anchor.mjs --root --wt --branch --tip --head [--pr-base] --out <f> -- <path...>. */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { envFlag } from '../../../../gate-engine/config.mts';
import { loadManifest } from '../../reconcile.mts';
import { literalPathspecEnv, parseArgs } from '../reconcile-manifest-write.mts';

/** One side of a path: its blob and, where known, its tree mode. `null` is "absent on this side". */
export interface Entry {
  blob: string;
  mode: string;
}
type Side = Entry | null;
/** An anchor, plus the commit it came from when that is known outright (the fork-point fallback). */
interface Anchor {
  entry: Side;
  since?: string;
  /** "<op>:<mode>:<blob>" of the manifest record read, or "-": the writer's compare-and-swap token. */
  token: string;
  /** The base commit the anchoring record's blob holds unstripped (an earlier override ship). */
  held?: string;
}
export type Action = 'copy' | 'keep' | 'merge' | 'refuse';

const PLAIN_PATH = /^[\w./@+-]+$/;
const LITERAL_GIT_ENV = literalPathspecEnv();
/** Past any local plumbing call on a loaded machine; a reship must never hold its ship slot forever. */
const GIT_TIMEOUT_MS = 60_000;

/** Run git in <root> with literal pathspecs; stdout bytes, or null on a non-zero exit. */
function git(root: string, args: string[]): Buffer | null {
  const r = spawnSync('git', ['-C', root, '--literal-pathspecs', ...args], {
    env: LITERAL_GIT_ENV,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 1 << 30,
    timeout: GIT_TIMEOUT_MS,
  });
  // A killed git answered nothing: a null here would read as "absent" or "conflict" to the caller.
  if (r.error || r.signal)
    throw new Error(`git ${args[0]} did not finish (${r.error?.message ?? r.signal})`);
  return r.status === 0 ? r.stdout : null;
}

/** <run> in a fresh temp directory, removed afterwards. */
function inTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'reship-anchor-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** <run>, with any error it throws prefixed by <path>. */
function named<T>(path: string, run: () => T): T {
  try {
    return run();
  } catch (e: unknown) {
    throw new Error(`${shown(path)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const lines = (out: Buffer | null): string[] =>
  out ? out.toString('utf8').split('\n').filter(Boolean) : [];

/** A path as one stderr token: a name holding a space or a newline cannot forge a second line. */
const shown = (path: string): string => (PLAIN_PATH.test(path) ? path : JSON.stringify(path));

/** The entry for <path> in commit <rev>, or null when the commit has no such path. */
export function treeEntry(root: string, rev: string, path: string): Side {
  const [meta] = (git(root, ['ls-tree', '-z', rev, '--', path])?.toString('utf8') ?? '').split(
    '\t',
  );
  const [mode, , blob] = meta.split(' ');
  return blob ? { mode, blob } : null;
}

/** The caller's file read through one descriptor, so its mode and bytes come from the same inode. */
function readHere(abs: string): { bytes: Buffer; mode: string } | null {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e: unknown) {
    const code = e instanceof Error && 'code' in e ? e.code : undefined;
    if (code === 'ENOENT') return null;
    if (code !== 'ELOOP') throw e;
    return { bytes: Buffer.from(readlinkSync(abs)), mode: '120000' }; // a symlink; readlink fails if it changed
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    return { bytes: readFileSync(fd), mode: st.mode & 0o111 ? '100755' : '100644' };
  } finally {
    closeSync(fd);
  }
}

/** The caller's file as a tree entry, read ONCE so the bytes hashed are the bytes merged. */
export function hereEntry(root: string, path: string): Side {
  const here = readHere(join(root, path));
  if (!here) return null;
  // A symlink's target is stored as-is; a file is cleaned as if it sat at <path>.
  const as = here.mode === '120000' ? ['--no-filters'] : ['--path', path];
  const blob = inTempDir((dir) => {
    const file = join(dir, 'here');
    writeFileSync(file, here.bytes);
    return git(root, ['hash-object', '-w', ...as, file])
      ?.toString('utf8')
      .trim();
  });
  if (!blob) throw new Error('could not hash the copy');
  return { blob, mode: here.mode };
}

const mergeBase = (root: string, a: string, b: string): string =>
  git(root, ['merge-base', a, b])?.toString('utf8').trim() ?? '';

/** What this checkout's copy of <path> was taken from. */
export function anchorEntry(
  root: string,
  branch: string,
  tip: string,
  head: string,
  path: string,
): Anchor {
  const shipped = loadManifest(root).branches[branch]?.paths.find((e) => e.path === path);
  const token = shipped ? `${shipped.op}:${shipped.mode}:${shipped.blobSha}` : '-';
  // No mode (a chmod on the tip is invisible) or a pruned blob (a merged path's is in no commit):
  // the record cannot be merged from, so it anchors like no record.
  if (shipped?.mode && shipped.op === 'delete') return { entry: null, token };
  if (shipped?.mode && git(root, ['cat-file', '-e', shipped.blobSha])) {
    return { entry: { blob: shipped.blobSha, mode: shipped.mode }, token, held: shipped.heldBase };
  }
  const fork = head ? mergeBase(root, tip, head) : '';
  // Unrelated histories: nothing to anchor on, so the tip stands in and the path is copied as before.
  return fork
    ? { entry: treeEntry(root, fork, path), since: fork, token }
    : { entry: treeEntry(root, tip, path), token };
}

const sameEntry = (a: Side, b: Side): boolean =>
  a === null || b === null ? a === b : a.blob === b.blob && a.mode === b.mode;
const regular = (e: Side): e is Entry => !!e && e.mode !== '120000' && e.mode !== '160000';

/** copy: tip unmoved or equal to the caller. keep: caller unchanged. merge: both changed a file. */
export function decide(here: Side, tip: Side, anchor: Side): Action {
  if (sameEntry(tip, anchor) || sameEntry(here, tip)) return 'copy';
  if (sameEntry(here, anchor)) return 'keep';
  if (!here || !tip || !anchor) return 'refuse';
  return regular(here) && regular(tip) && regular(anchor) ? 'merge' : 'refuse';
}

/** Three-way merge of three blobs; the merged blob, or null on a conflict or a binary file. */
export function mergeBlobs(root: string, here: Entry, anchor: Entry, tip: Entry): string | null {
  return inTempDir((dir) => {
    const files = [here, anchor, tip].map((e, i) => {
      const bytes = git(root, ['cat-file', 'blob', e.blob]);
      if (!bytes) throw new Error(`could not read blob ${e.blob}`);
      const file = join(dir, String(i));
      writeFileSync(file, bytes);
      return file;
    });
    // In place: the merge lands in the first file, hashed unfiltered like the blobs it came from.
    if (!git(root, ['merge-file', ...files])) return null;
    return (
      git(root, ['hash-object', '-w', '--no-filters', files[0]])?.toString('utf8').trim() ?? null
    );
  });
}

/** Up to three commits that changed <path> on the tip after the anchor, newest first. */
export function foreignCommits(
  root: string,
  tip: string,
  path: string,
  anchor: Side,
  since?: string,
): string[] {
  const from =
    since ??
    (anchor &&
      lines(git(root, ['log', '-50', '--format=%H', tip, '--', path])).find(
        (rev) => treeEntry(root, rev, path)?.blob === anchor.blob,
      ));
  const range = from ? `${from}..${tip}` : tip;
  return lines(git(root, ['log', '-3', '--no-renames', '--format=%h %s', range, '--', path]));
}

/** The caller's copy without base content the PR lacks; `commits` brought it, `refuse` if inseparable. */
interface Strip {
  here: Side;
  commits: string[];
  refuse: boolean;
  /** M, when the copy ships holding it unstripped: the tip already holds it, or the override. */
  held?: string;
}

/** The tip already holds the base change <f>→<m> (a cherry-pick, an earlier override ship). */
function tipCarries(root: string, tip: Side, f: Side, m: Side): boolean {
  if (sameEntry(tip, m)) return true;
  if (!regular(tip) || !regular(f) || !regular(m)) return false;
  if (f.mode !== m.mode && tip.mode !== m.mode) return false;
  return mergeBlobs(root, tip, f, m) === tip.blob;
}

/** <here> with the base change <m>→<f> reverted, or null when it cannot be separated. */
function withoutBase(root: string, here: Entry, f: Side, m: Side): Side | undefined {
  if (sameEntry(here, m)) return f;
  const blob = regular(here) && regular(f) && regular(m) ? mergeBlobs(root, here, m, f) : null;
  return blob && f ? { blob, mode: here.mode === m?.mode ? f.mode : here.mode } : undefined;
}

/** The tip already holds every base hunk in <here>, as after an override ship: nothing to leave out. */
function tipHoldsCopy(root: string, here: Entry, m: Side, tip: Side): boolean {
  if (!regular(here) || !regular(m) || !regular(tip)) return false;
  if (here.mode === m.mode && tip.mode !== here.mode) return false;
  return mergeBlobs(root, here, m, tip) === here.blob;
}

/** origin/<PR base>: gh's name, else the base this checkout recorded shipping <branch> onto; '' skips. */
export function resolveBaseRef(root: string, branch: string, prBase: string): string {
  const name = prBase || loadManifest(root).branches[branch]?.baseRef || '';
  const keep = 'so base changes your checkout holds are not left out';
  if (!name) {
    const why = `gh did not name the PR's base and this checkout has no record of shipping ${branch}`;
    console.error(`ship --pr: ${why}, ${keep}`);
    return '';
  }
  const ref = `origin/${name}`;
  if (git(root, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])) return ref;
  console.error(`ship --pr: could not compare with ${ref}, ${keep}`);
  return '';
}

/** [F, M]: M is the base the caller's HEAD holds, F what of M the PR tip has; F..M is what the PR lacks. */
function baseRange(
  root: string,
  { tip, head, baseRef }: { tip: string; head: string; baseRef: string },
): string[] {
  const to = baseRef && head ? mergeBase(root, head, baseRef) : '';
  const from = to ? mergeBase(root, tip, to) : '';
  return from ? [from, to] : ['', ''];
}

/** [F, M] for one path, from M's base against the tip and the base its anchoring record holds. */
function pathRange(root: string, tip: string, [f, m]: string[], held?: string): string[] {
  if (!held || !m) return [f, m];
  // Only <held> itself may replace F: the record's blob holds no other base, and a tie goes to it.
  const bases = lines(git(root, ['merge-base', '--all', m, tip, held]));
  return [bases.includes(held) ? held : f, m];
}

/** Leave out <baseRef> changes the caller's HEAD holds and the PR tip does not (a local base merge). */
export function stripBase(
  root: string,
  here: Side,
  tipEntry: Side,
  opts: { tip: string; head: string; baseRef: string; range?: string[] },
  path: string,
): Strip {
  const none = { here, commits: [], refuse: false };
  const [from, to] = opts.range ?? baseRange(root, opts);
  if (!to || !here || sameEntry(here, tipEntry)) return none;
  const [f, m] = [treeEntry(root, from, path), treeEntry(root, to, path)];
  if (sameEntry(f, m) || tipCarries(root, tipEntry, f, m)) return none;
  const commits = lines(
    git(root, ['log', '-3', '--no-renames', '--format=%h %s', `${from}..${to}`, '--', path]),
  );
  const stripped = withoutBase(root, here, f, m);
  if (stripped === undefined)
    return tipHoldsCopy(root, here, m, tipEntry)
      ? { ...none, held: to }
      : { here, commits, refuse: true, held: to };
  return sameEntry(stripped, here) ? none : { here: stripped, commits, refuse: false };
}

interface Plan {
  path: string;
  action: Action;
  here: Side;
  tip: Side;
  /** Merged blob and mode, when the action is `merge` and the merge was clean. */
  merged?: Entry;
  commits: string[];
  token: string;
  /** Base commits whose changes were left out of the caller's copy, or block it when `refuse`. */
  base?: Strip;
  /** The manifest record's heldBase for this ship. */
  held?: string;
}

/** Plan one briefed path. A `merge` that conflicts comes back as `refuse`. */
export function planPath(
  root: string,
  branch: string,
  tip: string,
  head: string,
  path: string,
  range = ['', ''],
): Plan {
  const tipEntry = treeEntry(root, tip, path);
  const { entry: anchor, since, token, held: kept } = anchorEntry(root, branch, tip, head, path);
  const own = pathRange(root, tip, range, kept);
  const copy = hereEntry(root, path);
  const strip = stripBase(root, copy, tipEntry, { tip, head, baseRef: '', range: own }, path);
  const here = strip.here;
  const base = strip.commits.length > 0 || strip.refuse ? strip : undefined;
  const carried = own[0] !== range[0] ? own[0] : range[1] ? undefined : kept;
  const held = copy ? (strip.held ?? carried) : undefined;
  let action = decide(here, tipEntry, anchor);
  if (action === 'copy')
    return { path, action, here, tip: tipEntry, commits: [], token, base, held };
  let merged: Entry | undefined;
  if (action === 'merge' && here && tipEntry && anchor) {
    const blob = mergeBlobs(root, here, anchor, tipEntry);
    if (blob) merged = { blob, mode: here.mode === anchor.mode ? tipEntry.mode : here.mode };
    else action = 'refuse';
  }
  const commits = foreignCommits(root, tip, path, anchor, since);
  return { path, action, here, tip: tipEntry, merged, commits, token, base, held };
}

/** The commits a report names for <p>: the base's when <base>, else the PR branch's. */
const listed = (p: Plan, base: boolean): string[] => (base ? p.base?.commits : p.commits) ?? [];

function report(branch: string, heading: string, plans: Plan[], base = false): void {
  console.error(heading);
  for (const p of plans) {
    console.error(`  ${shown(p.path)}`);
    for (const c of listed(p, base)) console.error(`      ${c}`);
  }
  if (plans.every((p) => listed(p, base).length === 0))
    console.error(`      (see git log origin/${branch})`);
}

interface StageOptions {
  root: string;
  wt: string;
  branch: string;
  tip: string;
  head: string;
  out: string;
  baseRef?: string;
}

/** Stage <entry> at <path> in the worktree's index and files; null removes it. */
function stageEntry(wt: string, path: string, entry: Side): void {
  const ok = entry
    ? git(wt, ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blob},${path}`]) &&
      git(wt, ['checkout-index', '-f', '--', path])
    : git(wt, ['update-index', '--force-remove', '--', path]);
  if (!ok) throw new Error('could not stage it');
  if (!entry) rmSync(join(wt, path), { force: true });
}

/** Plan every path, then stage each from the bytes it was judged on. Returns the exit code. */
export function stageAppend(
  { root, wt, branch, tip, head, out, baseRef = '' }: StageOptions,
  paths: string[],
): number {
  const range = baseRange(root, { tip, head, baseRef }); // one F/M for every path in the run
  const plans = paths.map((p) => named(p, () => planPath(root, branch, tip, head, p, range)));
  const blocked = plans.filter((p) => p.action === 'refuse');
  const replace = envFlag('SHIP_REPLACE_OK');
  const inseparable = plans.filter((p) => p.base?.refuse);
  if (inseparable.length > 0 && !replace) {
    report(
      branch,
      `ship --pr: your copy of these path(s) holds ${baseRef} changes that origin/${branch} does not:`,
      inseparable,
      true,
    );
    console.error(
      '  They cannot be left out of this commit (your edits overlap them, or the path is',
    );
    console.error(`  binary, a symlink or a submodule). Bring ${baseRef} into the PR branch first`);
    console.error(`  (gh pr update-branch ${branch}, or merge it there and push), then re-run;`);
    console.error('  or, to ship your whole copy, re-run with GUARD_SHIP_REPLACE_OK=1.');
    return 1;
  }
  if (blocked.length > 0 && !replace) {
    report(
      branch,
      `ship --pr: origin/${branch} changed these path(s) after the copy you are shipping was taken:`,
      blocked,
    );
    console.error(
      '  They cannot be merged with your copy (the same lines changed on both sides, or the',
    );
    console.error(
      '  path is binary, a symlink, a submodule, or deleted on one side), so shipping would',
    );
    console.error('  revert the commit(s) above.');
    console.error(
      `  Fetch origin/${branch}, merge its version of the path(s) into yours, and re-run;`,
    );
    console.error(
      '  or, if your copy is meant to replace it, re-run with GUARD_SHIP_REPLACE_OK=1.',
    );
    return 1;
  }
  if (blocked.length > 0) {
    report(
      branch,
      `⚠️  GUARD_SHIP_REPLACE_OK: replacing origin/${branch}'s version of these path(s) with yours:`,
      blocked,
    );
  }
  const guards: string[] = [];
  for (const p of plans) {
    if (p.action !== 'keep') named(p.path, () => stageEntry(wt, p.path, p.merged ?? p.here));
    const own = p.merged && p.here ? `${p.here.mode} ${p.here.blob}` : '=';
    const record = p.action === 'keep' ? '' : p.held ? `${own} ${p.held}` : own;
    guards.push(p.token, record, p.path);
  }
  const left = plans.filter((p) => p.base && !p.base.refuse);
  if (left.length > 0) {
    report(
      branch,
      `ship --pr: left ${baseRef} changes origin/${branch} does not have out of these path(s):`,
      left,
      true,
    );
    console.error(
      `  To ship them, bring ${baseRef} into the PR branch (gh pr update-branch ${branch}).`,
    );
  }
  const replaced = plans.filter((p) => p.base?.refuse);
  if (replaced.length > 0)
    report(
      branch,
      `⚠️  GUARD_SHIP_REPLACE_OK: shipping ${baseRef} changes with your copy of:`,
      replaced,
      true,
    );
  const merged = plans.filter((p) => p.action === 'merge');
  if (merged.length > 0) {
    report(
      branch,
      `ship --pr: merged origin/${branch}'s changes to these path(s) with yours:`,
      merged,
    );
    console.error('  Your checkout still holds the older copy; the commit carries both sides.');
  }
  writeFileSync(out, guards.map((s) => `${s}\0`).join(''));
  return 0;
}

function main(): number {
  const { flags, paths } = parseArgs(process.argv.slice(2));
  const str = (k: string): string => {
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
    return stageAppend(
      { ...opts, baseRef: resolveBaseRef(opts.root, opts.branch, str('pr-base')) },
      paths,
    );
  } catch (e: unknown) {
    console.error(
      `ship --pr: could not compare your paths with origin/${opts.branch}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exit(main());
