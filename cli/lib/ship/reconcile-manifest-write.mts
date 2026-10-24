#!/usr/bin/env node
/**
 * Records what a `devkit ship` commit sent to its PR, so `devkit reconcile` can later replace the
 * now-stale local copies with the merged-upstream version (no stash/pull pain).
 *
 * Invoked by ship-branch.sh the instant `git push` succeeds — independent of `gh pr create` — so a PR-create
 * hiccup can't orphan the pushed branch from reconcile (a create failure records pr:null, which reconcile
 * self-heals once a PR exists + merges via its `gh pr view <branch>` lookup). Also invoked by reship.sh
 * with --merge after a `devkit ship --pr` re-push (extends the SAME branch's entry so a multi-commit PR records
 * ALL its paths, not just the first commit's). Kept as its own script — not inlined in the shell — so the real
 * blob/op classification is unit-testable WITHOUT gh or a network (the dry-run path skips gh).
 *
 * Write side of the ship↔reconcile contract. The READ side is `devkit reconcile` (../reconcile.mjs).
 * The contract is the manifest JSON below + the rule that BOTH sides id a file by
 * `git -C <root> hash-object -- <path>` (so a future .gitattributes/LFS filter can never desync
 * them). Schema is version-gated; a future shape change bumps `version` and a reader treats an
 * unknown version as no-debt. Fixture: reconcile-manifest.v1.json (sibling).
 *
 *   .devkit/reconcile-manifest.json  (gitignored, per-branch keyed — N parallel PRs, one tree)
 *   { "version": 1, "branches": { "<branch>": {
 *       prNumber, repo, baseRef, baseSha, shippedAt, paths:[{path, blobSha, mode, op}] } } }
 *
 * op ∈ add|modify|delete. A rename ships as its two explicit paths (old delete + new add) —
 * git's -M rename detection is unneeded here because ship-branch passes explicit file paths,
 * and add+delete reconciles identically (the spec's own "sub-threshold rename" path). A path added
 * AND deleted within one commit (so it never lands on the branch tip) classifies to null → dropped:
 * an intentional no-op, since nothing of it actually shipped.
 *
 * Usage (paths after `--`; --pr and --git-root optional):
 *   reconcile-manifest-write.mjs --root <manifest-root> [--git-root <hash-root>] --branch <br> \
 *     --repo <owner/repo> --base-ref <ref> --base-sha <40hex> [--tip-sha <40hex>] \
 *     --pr <number|""> -- <path...>
 * --git-root (default --root) is where blobs are hashed; ship-branch passes the ephemeral commit
 * worktree so the manifest records what the PR committed, not a later edit to the shared tree.
 *
 * Best-effort: ship-branch.sh ignores a non-zero exit — the PR already exists, so a manifest
 * miss only costs a manual reconcile later; it must never unwind a shipped PR.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withLock, writeFileAtomic } from '../atomic-write.mts';
import type { BranchEntry, ReconcileManifest, ReconcilePath } from '../reconcile.mts';

const WS_SPLIT = /\s+/; // split a `git ls-tree` line into its mode/type/sha/path columns
const PR_DIGITS = /^\d+$/; // a non-empty --pr is an integer; anything else → null
/** process.env minus git's global pathspec modes, which misread or reject `:(literal)` selectors. */
export function literalPathspecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'GIT_LITERAL_PATHSPECS',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
  ])
    delete env[key];
  return env;
}
const LITERAL_GIT_ENV = literalPathspecEnv();

/** Run git in <root>, return trimmed stdout, or null on failure. Shipped paths are concrete
 *  filenames (sc-2425), so pathspecs are literal; the scrubbed env avoids inherited glob modes. */
function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, '--literal-pathspecs', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: LITERAL_GIT_ENV,
    }).trim();
  } catch {
    return null;
  }
}

/** Parsed CLI flags: `--flag value` pairs land as string keys; the valueless `--merge` as a boolean. */
interface ParsedFlags {
  merge?: boolean;
  'literal-paths'?: boolean;
  [key: string]: string | boolean | undefined;
}

/** Parse `--flag value` pairs (plus valueless booleans) and a trailing `-- <path...>`. */
export function parseArgs(argv: string[]) {
  const flags: ParsedFlags = {};
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') {
      paths.push(...argv.slice(i + 1).map((p) => posix.normalize(p))); // `./a.ts` records as `a.ts`
      break;
    }
    if (argv[i] === '--merge' || argv[i] === '--literal-paths')
      flags[argv[i].slice(2)] = true; // booleans — must NOT consume the next token (e.g. the `--`)
    else if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  }
  return { flags, paths };
}

/** git tree mode for a path that EXISTS in the working tree (symlink / executable / regular). */
function worktreeMode(abs: string): string {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return '120000';
  return st.mode & 0o111 ? '100755' : '100644';
}

interface TreeBlob {
  mode: string;
  blobSha: string;
}

/** Read all concrete branch-source identities from one tree in a single Git subprocess. */
function treeBlobs(gitRoot: string, tree: string, paths: string[]): Map<string, TreeBlob> | null {
  const blobs = new Map<string, TreeBlob>();
  let raw: Buffer;
  try {
    raw = execFileSync(
      'git',
      ['-C', gitRoot, '--literal-pathspecs', 'ls-tree', '-z', tree, '--', ...paths],
      { env: LITERAL_GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
  for (const record of raw.toString('utf8').split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    if (separator < 0) continue;
    const [mode, type, blobSha] = record.slice(0, separator).split(' ');
    if (mode && type === 'blob' && blobSha)
      blobs.set(record.slice(separator + 1), { mode, blobSha });
  }
  return blobs;
}

/** Classify a frozen branch path from two batched tree snapshots. */
function classifyLiteral(
  p: string,
  tip: Map<string, TreeBlob>,
  base: Map<string, TreeBlob>,
): ReconcilePath | null {
  if (p.startsWith('/') || p.split('/').includes('..')) return null;
  const tipBlob = tip.get(p);
  const baseBlob = base.get(p);
  if (tipBlob) {
    if (baseBlob && tipBlob.blobSha === baseBlob.blobSha && tipBlob.mode === baseBlob.mode)
      return null;
    return { path: p, ...tipBlob, op: baseBlob ? 'modify' : 'add' };
  }
  return baseBlob ? { path: p, ...baseBlob, op: 'delete' } : null;
}

/**
 * Classify one shipped path against the pinned BASE into a manifest entry.
 * Present in the worktree → add (absent at base) or modify; gone → delete (records the
 * PRE-deletion committed blob so reconcile can prove still-deleted-as-shipped vs re-created).
 * Returns null only if a deleted path has no base blob either (never shipped anything real).
 */
function classify(gitRoot: string, baseSha: string, p: string): ReconcilePath | null {
  if (p.startsWith('/') || p.split('/').includes('..')) return null; // repo-relative paths only (defense-in-depth)
  const abs = join(gitRoot, p);
  if (existsSync(abs)) {
    const blobSha = git(gitRoot, ['hash-object', '--', p]);
    if (!blobSha) return null;
    const existedAtBase = git(gitRoot, ['cat-file', '-e', `${baseSha}:${p}`]) !== null;
    return { path: p, blobSha, mode: worktreeMode(abs), op: existedAtBase ? 'modify' : 'add' };
  }
  // Deleted: the pre-deletion blob + its tree mode come from BASE.
  const lsTree = git(gitRoot, ['ls-tree', baseSha, '--', p]); // "<mode> blob <sha>\t<path>"
  if (!lsTree) return null;
  const [mode] = lsTree.split(WS_SPLIT);
  const blobSha = git(gitRoot, ['rev-parse', `${baseSha}:${p}`]);
  if (!blobSha) return null;
  return { path: p, blobSha, mode, op: 'delete' };
}

/** A well-formed v1 manifest: version 1 with a plain (non-array) branches object. */
const isValidV1 = (m: unknown): m is ReconcileManifest =>
  typeof m === 'object' &&
  m !== null &&
  'version' in m &&
  m.version === 1 &&
  'branches' in m &&
  typeof m.branches === 'object' &&
  m.branches !== null &&
  !Array.isArray(m.branches);

/**
 * Read the manifest. Absent or torn → a fresh v1 (never trusted). A parsed-but-incompatible
 * NEWER version THROWS rather than being clobbered (that would erase a newer schema's branches).
 * Exported so the version-gate is directly unit-testable.
 */
export function readManifest(file: string): ReconcileManifest {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT')
      return { version: 1, branches: {} }; // absent → fresh
    throw e; // a real read error — surface it, never overwrite blindly
  }
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return { version: 1, branches: {} }; // torn / half-written → start fresh
  }
  if (isValidV1(m)) return m;
  const version: unknown =
    typeof m === 'object' && m !== null && 'version' in m ? m.version : undefined;
  throw new Error(`refusing to overwrite an incompatible manifest (version ${String(version)})`);
}

/** Print an error + return the failure code (consolidates the usage-validation exits). */
function fail(msg: string): number {
  console.error(`reconcile-manifest-write: ${msg}`);
  return 1;
}

/** Options for {@link recordShip}. Fields are optional so the CLI boundary can pass unvalidated flags — recordShip validates and returns a failure code for a missing required one. */
interface RecordShipOptions {
  root?: string;
  gitRoot?: string;
  branch?: string;
  repo?: string;
  baseRef?: string;
  baseSha?: string;
  tipSha?: string;
  pr?: string | null;
  merge?: boolean;
  literalPaths?: boolean;
  anchors?: string;
}

/** One path's write guard from ship/reship/anchor.mts: the record it anchored on, and what to record. */
interface AnchorGuard {
  /** "<op>:<mode>:<blob>" of the record the anchor read, or "-" for none. */
  expect: string;
  /** "" leaves the record untouched, "=" records the path as classified, "<mode> <blob>" the caller's. */
  record: string;
}

/** `--anchors`: "<expect>\0<record>\0<path>\0" triples; a path is written only while its record is unchanged. */
function readAnchors(file: string | undefined): Map<string, AnchorGuard> {
  const guards = new Map<string, AnchorGuard>();
  const fields = file ? readFileSync(file, 'utf8').split('\0') : [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    guards.set(fields[i + 2], { expect: fields[i], record: fields[i + 1] });
  }
  return guards;
}

/**
 * Record one branch's shipped paths into the manifest (atomic, locked). Exported so the core is
 * directly unit-testable, not only via the CLI subprocess. Returns 0 on success, 1 on a usage error.
 *
 * `root` is where the manifest lives (the persistent shared checkout). `gitRoot` (default `root`)
 * is where blobs are hashed — ship-branch passes the EPHEMERAL commit worktree so the manifest
 * records what the PR actually committed, not a parallel agent's later edit to the shared tree.
 */
export function recordShip(options: RecordShipOptions, paths: string[]): number {
  const checked = checkOptions(options);
  if (!checked.ok) return fail(checked.error);
  const o = checked.options;
  if (paths.length === 0) return fail('no paths given');
  const hashRoot = o.gitRoot ?? o.root; // default to root; ship-branch passes the ephemeral commit worktree
  const classified = classifyPaths(hashRoot, o, paths);
  if (!classified) return fail('could not read the pinned tip/base trees');
  const guards = readAnchors(o.anchors);
  const entries = applyAnchorGuards(classified, guards);
  // Absent at the pinned base and the worktree, and not merely kept at the tip: the caller deleted it too.
  const gone =
    o.merge && !o.literalPaths
      ? paths.filter(
          (p, i) =>
            !classified[i] && guards.get(p)?.record !== '' && !existsSync(join(hashRoot, p)),
        )
      : [];
  // Before the lock (and before the no-entry throw below): an all-unresolvable merge is a benign no-op.
  if (entries.length === 0 && gone.length === 0)
    return fail('no recordable paths (all empty/unresolvable)');
  return writeRecord(o, entries, gone, guards);
}

/** {@link RecordShipOptions} once {@link checkOptions} has proven the always-required flags present. */
type CheckedOptions = RecordShipOptions & { root: string; branch: string; baseSha: string };

/** The options narrowed to {@link CheckedOptions}, or the usage error for a missing required flag. */
type CheckResult = { ok: true; options: CheckedOptions } | { ok: false; error: string };

function checkOptions(o: RecordShipOptions): CheckResult {
  // baseSha is always required (it drives classify); repo/baseRef only when writing a FRESH entry —
  // in --merge mode they are kept from the existing branch entry (a re-push to an open PR, same metadata).
  if (!o.root || !o.branch || !o.baseSha) {
    return { ok: false, error: 'missing one of --root/--branch/--base-sha' };
  }
  if (!o.merge && (!o.repo || !o.baseRef)) {
    return { ok: false, error: 'missing one of --root/--branch/--repo/--base-ref/--base-sha' };
  }
  if (o.literalPaths && !o.tipSha)
    return { ok: false, error: '--literal-paths requires --tip-sha' };
  return { ok: true, options: { ...o, root: o.root, branch: o.branch, baseSha: o.baseSha } };
}

/** Classify each path against the base; null when a pinned `--literal-paths` tree is unreadable. */
function classifyPaths(
  hashRoot: string,
  o: CheckedOptions,
  paths: string[],
): (ReconcilePath | null)[] | null {
  if (!o.literalPaths) return paths.map((p) => classify(hashRoot, o.baseSha, p));
  const tip = treeBlobs(hashRoot, o.tipSha!, paths);
  const base = treeBlobs(hashRoot, o.baseSha, paths);
  if (!tip || !base) return null;
  return paths.map((p) => classifyLiteral(p, tip, base));
}

/** Drop the paths an anchor keeps untouched (`record` ""), and record a "<mode> <blob>" override. */
function applyAnchorGuards(
  classified: (ReconcilePath | null)[],
  guards: Map<string, AnchorGuard>,
): ReconcilePath[] {
  return classified
    .filter((e): e is ReconcilePath => e !== null && guards.get(e.path)?.record !== '')
    .map((e) => {
      const [mode, blobSha] = guards.get(e.path)?.record.split(' ') ?? [];
      return blobSha ? { ...e, mode, blobSha } : e;
    });
}

/** A concurrent ship that already replaced the record this one anchored on wins. */
function isFresh(
  byPath: Map<string, ReconcilePath>,
  guards: Map<string, AnchorGuard>,
  p: string,
): boolean {
  const cur = byPath.get(p);
  const token = cur ? `${cur.op}:${cur.mode}:${cur.blobSha}` : '-';
  return (guards.get(p)?.expect ?? token) === token;
}

/** A --pr re-push overlays this commit's paths onto the SAME PR's entry by path: a re-shipped path takes
 * its branch-tip blob, a new path is added, a renamed-away path's `modify` becomes its `delete`. */
function mergeEntry(
  existing: BranchEntry | undefined,
  branch: string,
  entries: ReconcilePath[],
  gone: string[],
  guards: Map<string, AnchorGuard>,
): BranchEntry {
  if (!existing) throw new Error(`no manifest entry for ${branch} to merge into`);
  const byPath = new Map(existing.paths.map((e): [string, ReconcilePath] => [e.path, e]));
  let changed = 0;
  for (const e of entries.filter((e) => isFresh(byPath, guards, e.path))) {
    byPath.set(e.path, e);
    changed++;
  }
  for (const p of gone) {
    const prev = byPath.get(p);
    if (!prev || prev.op === 'delete' || !isFresh(byPath, guards, p)) continue;
    byPath.set(p, { ...prev, op: 'delete' });
    changed++;
  }
  if (changed === 0) throw new Error('no recordable paths');
  return { ...existing, shippedAt: new Date().toISOString(), paths: [...byPath.values()] };
}

/** Write the branch entry under the manifest lock; 1 (recording nothing) when the locked write fails. */
function writeRecord(
  o: CheckedOptions,
  entries: ReconcilePath[],
  gone: string[],
  guards: Map<string, AnchorGuard>,
): number {
  const prNumber = o.pr && PR_DIGITS.test(o.pr) ? Number(o.pr) : null;
  const file = join(o.root, '.devkit', 'reconcile-manifest.json');
  mkdirSync(dirname(file), { recursive: true });
  try {
    withLock(`${file}.lock`, () => {
      const manifest = readManifest(file);
      const existing = manifest.branches[o.branch];
      if (o.merge)
        manifest.branches[o.branch] = mergeEntry(existing, o.branch, entries, gone, guards);
      else if (o.repo && o.baseRef) {
        // repo/baseRef are guaranteed defined here (checkOptions requires them when !merge); the guard also narrows the optionals to string.
        manifest.branches[o.branch] = {
          prNumber,
          repo: o.repo,
          baseRef: o.baseRef,
          baseSha: o.baseSha,
          shippedAt: new Date().toISOString(),
          paths: entries,
        };
      }
      writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`); // temp+rename: a crash leaves the prior valid manifest intact
    });
  } catch (e: unknown) {
    return fail(e instanceof Error ? e.message : String(e)); // lock-timeout / incompatible-version / no-entry-to-merge → best-effort: record nothing, never corrupt
  }
  return 0;
}

/** A string-valued flag: the parser only stores strings under named keys (`merge` is the lone boolean), so a non-string reads as absent. */
const strFlag = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

function main(): number {
  const { flags, paths } = parseArgs(process.argv.slice(2));
  return recordShip(
    {
      root: strFlag(flags.root),
      gitRoot: strFlag(flags['git-root']), // optional — defaults to root; ship-branch passes the commit worktree
      branch: strFlag(flags.branch),
      repo: strFlag(flags.repo),
      baseRef: strFlag(flags['base-ref']),
      baseSha: strFlag(flags['base-sha']),
      tipSha: strFlag(flags['tip-sha']),
      pr: strFlag(flags.pr),
      merge: flags.merge === true, // reship's --pr re-push extends the existing entry instead of overwriting
      literalPaths: flags['literal-paths'] === true, // branch-source paths are concrete identities
      anchors: strFlag(flags.anchors),
    },
    paths,
  );
}

// Run only as a CLI entrypoint — importing the module (e.g. a test importing recordShip) must not
// exit. Realpath argv[1] so the guard also fires through a symlink (ship-branch.sh resolves a real
// path today, but a symlinked module dir would silently no-op) — see staged-filter.mts for the class.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exit(main());
