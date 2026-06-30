#!/usr/bin/env node
/**
 * Records what a `devkit ship` commit sent to its PR, so `devkit reconcile` can later replace the
 * now-stale local copies with the merged-upstream version (no stash/pull pain).
 *
 * Invoked by ship-branch.sh the instant `git push` succeeds — independent of `gh pr create` — so a PR-create
 * hiccup can't orphan the pushed branch from reconcile (a create failure records pr:null, which reconcile
 * self-heals once a PR exists + merges via its `gh pr view --head <branch>` lookup). Also invoked by reship.sh
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
 *     --repo <owner/repo> --base-ref <ref> --base-sha <40hex> --pr <number|""> -- <path...>
 * --git-root (default --root) is where blobs are hashed; ship-branch passes the ephemeral commit
 * worktree so the manifest records what the PR committed, not a later edit to the shared tree.
 *
 * Best-effort: ship-branch.sh ignores a non-zero exit — the PR already exists, so a manifest
 * miss only costs a manual reconcile later; it must never unwind a shipped PR.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../atomic-write.mjs';

const LOCK_STALE_MS = 60_000; // a lock dir older than this is a dead writer/reader — reap it
const LOCK_WAIT_MS = 5_000; // total time to retry a contended lock before throwing (never write unlocked)
const WS_SPLIT = /\s+/; // split a `git ls-tree` line into its mode/type/sha/path columns
const PR_DIGITS = /^\d+$/; // a non-empty --pr is an integer; anything else → null

/** Run git in <root>, return trimmed stdout, or null if the command fails (missing path, etc.). */
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Parse `--flag value` pairs (plus the valueless boolean `--merge`) and a trailing `-- <path...>`. */
export function parseArgs(argv) {
  const flags = {};
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') {
      paths.push(...argv.slice(i + 1));
      break;
    }
    if (argv[i] === '--merge')
      flags.merge = true; // boolean — must NOT consume the next token (e.g. the `--`)
    else if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  }
  return { flags, paths };
}

/** git tree mode for a path that EXISTS in the working tree (symlink / executable / regular). */
function worktreeMode(abs) {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return '120000';
  return st.mode & 0o111 ? '100755' : '100644';
}

/**
 * Classify one shipped path against the pinned BASE into a manifest entry.
 * Present in the worktree → add (absent at base) or modify; gone → delete (records the
 * PRE-deletion committed blob so reconcile can prove still-deleted-as-shipped vs re-created).
 * Returns null only if a deleted path has no base blob either (never shipped anything real).
 */
function classify(gitRoot, baseSha, p) {
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

/**
 * Atomic-mkdir mutex (flock is absent on macOS — verified). The dir IS the lock; mkdir is
 * atomic create-or-fail on every POSIX fs. We only guard a sub-ms read→write→rename, so on
 * contention we retry up to LOCK_WAIT_MS; if still unheld we THROW rather than write unlocked
 * (an unlocked read-modify-write would lose a parallel ship's branch entry). A lock older than
 * 60s is a crashed holder — reap it.
 */
function withLock(lockDir, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (Date.now() <= deadline) {
    try {
      mkdirSync(lockDir);
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - lstatSync(lockDir).mtimeMs > LOCK_STALE_MS)
          rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* lock vanished under us — loop retries the mkdir */
      }
    }
  }
  if (!held) throw new Error(`timed out acquiring manifest lock: ${lockDir}`);
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** A well-formed v1 manifest: version 1 with a plain (non-array) branches object. */
const isValidV1 = (m) =>
  m &&
  m.version === 1 &&
  m.branches &&
  typeof m.branches === 'object' &&
  !Array.isArray(m.branches);

/**
 * Read the manifest. Absent or torn → a fresh v1 (never trusted). A parsed-but-incompatible
 * NEWER version THROWS rather than being clobbered (that would erase a newer schema's branches).
 * Exported so the version-gate is directly unit-testable.
 */
export function readManifest(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { version: 1, branches: {} }; // absent → fresh
    throw e; // a real read error — surface it, never overwrite blindly
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return { version: 1, branches: {} }; // torn / half-written → start fresh
  }
  if (isValidV1(m)) return m;
  throw new Error(`refusing to overwrite an incompatible manifest (version ${m?.version})`);
}

/** Print an error + return the failure code (consolidates the usage-validation exits). */
function fail(msg) {
  console.error(`reconcile-manifest-write: ${msg}`);
  return 1;
}

/**
 * Record one branch's shipped paths into the manifest (atomic, locked). Exported so the core is
 * directly unit-testable, not only via the CLI subprocess. Returns 0 on success, 1 on a usage error.
 *
 * `root` is where the manifest lives (the persistent shared checkout). `gitRoot` (default `root`)
 * is where blobs are hashed — ship-branch passes the EPHEMERAL commit worktree so the manifest
 * records what the PR actually committed, not a parallel agent's later edit to the shared tree.
 */
export function recordShip(
  { root, gitRoot = root, branch, repo, baseRef, baseSha, pr, merge = false },
  paths,
) {
  // baseSha is always required (it drives classify); repo/baseRef only when writing a FRESH entry —
  // in --merge mode they are kept from the existing branch entry (a re-push to an open PR, same metadata).
  if (!root || !branch || !baseSha) return fail('missing one of --root/--branch/--base-sha');
  if (!merge && (!repo || !baseRef)) {
    return fail('missing one of --root/--branch/--repo/--base-ref/--base-sha');
  }
  if (paths.length === 0) return fail('no paths given');
  const entries = paths.map((p) => classify(gitRoot, baseSha, p)).filter(Boolean);
  // Before the lock (and before the no-entry throw below): an all-unresolvable merge is a benign no-op.
  if (entries.length === 0) return fail('no recordable paths (all empty/unresolvable)');

  const prNumber = pr && PR_DIGITS.test(pr) ? Number(pr) : null;
  const file = join(root, '.devkit', 'reconcile-manifest.json');
  mkdirSync(dirname(file), { recursive: true });
  try {
    withLock(`${file}.lock`, () => {
      const manifest = readManifest(file);
      const existing = manifest.branches[branch];
      if (merge) {
        // A --pr re-push extends the SAME PR's entry: overlay this commit's paths by path (replace a
        // re-shipped path with its branch-tip blob, add new paths, supersede a renamed-away path's stale
        // `modify` with its `delete`), keep the PR metadata, refresh shippedAt.
        if (!existing) throw new Error(`no manifest entry for ${branch} to merge into`);
        const byPath = new Map(existing.paths.map((e) => [e.path, e]));
        for (const e of entries) byPath.set(e.path, e);
        manifest.branches[branch] = {
          ...existing,
          shippedAt: new Date().toISOString(),
          paths: [...byPath.values()],
        };
      } else {
        manifest.branches[branch] = {
          prNumber,
          repo,
          baseRef,
          baseSha,
          shippedAt: new Date().toISOString(),
          paths: entries,
        };
      }
      writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`); // temp+rename: a crash leaves the prior valid manifest intact
    });
  } catch (e) {
    return fail(e.message); // lock-timeout / incompatible-version / no-entry-to-merge → best-effort: record nothing, never corrupt
  }
  return 0;
}

function main() {
  const { flags, paths } = parseArgs(process.argv.slice(2));
  return recordShip(
    {
      root: flags.root,
      gitRoot: flags['git-root'], // optional — defaults to root; ship-branch passes the commit worktree
      branch: flags.branch,
      repo: flags.repo,
      baseRef: flags['base-ref'],
      baseSha: flags['base-sha'],
      pr: flags.pr,
      merge: flags.merge === true, // reship's --pr re-push extends the existing entry instead of overwriting
    },
    paths,
  );
}

// Run only as a CLI entrypoint — importing the module (e.g. a test importing recordShip) must not exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
