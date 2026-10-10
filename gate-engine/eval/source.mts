import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { matchesRepoGlob } from '../../skills/_devkit/review-roots.mjs';
import { explainStagedAbsence, probe } from './snapshot/absence.mts';
import {
  assertBlobMatches,
  GIT_MAX_BUFFER,
  indexIdentity,
  spawnGit,
  splitNul,
} from './snapshot/integrity.mts';
import type { HashSet, TrackerMode } from './types.mts';

// A submodule's index/tree entry. Not a blob: `git show :<gitlink>` is `fatal: bad object`, so it
// must never enter a listing whose contract is "these paths can be read".
const GITLINK_MODE = '160000';

/**
 * Where a failed git invocation actually ran. A tracker gate that cannot run git must say so rather
 * than report a content verdict: sc-1959 lost a fully-gated ship to `Missing
 * docs/benchmarks/catalog.json`, a sentence that was equally true of an absent file, a cwd outside a
 * work tree, and a spawn that never forked. Resolved best-effort and only on an already-failing
 * path, so a second unusable git degrades the message instead of replacing the original fault.
 */
function gitFailureContext(cwd: string, mode: string, result: SpawnSyncReturns<string>): string {
  const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  // SAFETY: node types spawnSync's `error` as plain Error, but every error it actually sets here is
  // a libuv failure carrying a `code` (ENOENT when git is not on PATH, EAGAIN/EMFILE when the
  // process could not fork). The optional chain below tolerates the absent-`code` case regardless,
  // so the widening can only add detail, never assume it.
  const cause = result.error as NodeJS.ErrnoException | undefined;
  const lines = [
    `  root: ${cwd} (mode=${mode}, gitdir=${gitDir.status === 0 ? gitDir.stdout.trim() : '<unresolved>'})`,
    `  status=${result.status ?? '<none>'} signal=${result.signal ?? '<none>'} error=${cause?.code ?? cause?.message ?? '<none>'}`,
  ];
  const stderr = (result.stderr ?? '').trim();
  if (stderr) lines.push(`  stderr: ${stderr}`);
  return lines.join('\n');
}

function git(
  cwd: string,
  args: string[],
  allowFailure = false,
  mode: TrackerMode | 'raw' = 'raw',
): string {
  const result = spawnGit(cwd, args);
  if (result.status === 0) return result.stdout.toString('utf8');
  if (allowFailure) return '';
  throw gitFailure(cwd, args, mode, result);
}

// NOT `result.stderr.trim()`: a spawn that failed to fork leaves stderr null, so the old form
// replaced the real fault with a bare TypeError.
function gitFailure(
  cwd: string,
  args: string[],
  mode: TrackerMode | 'raw',
  result: SpawnSyncReturns<Buffer>,
) {
  const failed = { ...result, stdout: '', stderr: result.stderr?.toString() ?? '', output: [] };
  return new Error(`git ${args.join(' ')} failed\n${gitFailureContext(cwd, mode, failed)}`);
}

function gitBytes(cwd: string, args: string[], mode: TrackerMode): Buffer {
  const result = spawnGit(cwd, args);
  if (result.status === 0) return result.stdout;
  throw gitFailure(cwd, args, mode, result);
}

function gitListing(cwd: string, args: string[], mode: TrackerMode): string[] {
  return splitNul(git(cwd, args, false, mode));
}

function listingBlobs(records: string[], keep: (metadata: string) => boolean, oidColumn: number) {
  const blobs = new Map<string, string>();
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0 || !keep(record.slice(0, tab))) continue;
    blobs.set(record.slice(tab + 1), record.slice(0, tab).split(' ')[oidColumn]);
  }
  return blobs;
}

/**
 * Turn one NUL-delimited `<metadata>\t<path>` listing into the readable paths it names.
 *
 * Two shapes force the filter. A GITLINK is listed by both `ls-files` and `ls-tree` but is a commit
 * id, not a blob — reading it fails, and a repo with a submodule is an ordinary repo, not an error.
 * An UNMERGED path is listed once PER STAGE, so a conflicted file would otherwise be hashed twice;
 * it stays in the listing (deduped) precisely so a later read fails loudly rather than letting the
 * checker hash a short set and pass on an index nobody could commit.
 */
function listingPaths(records: string[], keep: (metadata: string) => boolean): string[] {
  const paths = new Set<string>();
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    if (keep(record.slice(0, tab))) paths.add(record.slice(tab + 1));
  }
  return [...paths].sort();
}

export interface RepositorySource {
  mode: TrackerMode;
  // The resolved repository root this source reads through. Carried on the source itself so a
  // diagnostic can name WHERE a path was looked for without re-deriving it from an ambient cwd.
  root: string;
  ref?: string;
  listFiles(): string[];
  read(path: string): string | null;
  // Diagnostic lines for a path read() answered null for. Never throws; never changes a verdict.
  explainAbsence?(path: string): string;
}

function repositoryPath(root: string, path: string): { absolute: string; relative: string } {
  const absolute = resolve(root, path);
  const repoPath = relative(root, absolute).replaceAll('\\', '/');
  if (!repoPath || repoPath === '..' || repoPath.startsWith('../'))
    throw new Error(`Path escapes repository: ${path}`);
  return { absolute, relative: repoPath };
}

/**
 * Answer "is this path present?" from the memoised file list instead of a second git probe.
 *
 * `git cat-file -e <spec>` exits 128 for a path the index does not have AND for every other fatal —
 * not a work tree, an unreadable index, a process that could not fork — so an exit-status test
 * reports a broken git as an absent file, silently, at every call site (each of which treats null as
 * legitimately absent). Deciding from `listFiles()` removes that conflation entirely: absence is
 * proven from the authoritative listing, and once a path IS listed any `git show` failure is a real
 * fault that must throw. It also drops one subprocess per read — the check performs hundreds, and
 * fork pressure is itself a candidate cause of the original incident.
 */
function gitReader(root: string, mode: TrackerMode, blobs: () => Map<string, string>) {
  return (path: string, spec: (repoPath: string) => string): string | null => {
    const repoPath = repositoryPath(root, path).relative;
    const oid = blobs().get(repoPath);
    if (!oid) return null;
    const bytes = gitBytes(root, ['show', spec(repoPath)], mode);
    assertBlobMatches(spec(repoPath), bytes, oid);
    return bytes.toString('utf8');
  };
}

export function repositorySource(cwd: string, mode: TrackerMode, ref?: string): RepositorySource {
  const root = realpathSync(resolve(cwd));
  if (mode === 'working') {
    let files: string[] | undefined;
    return {
      mode,
      root,
      listFiles: () => {
        files ??= splitNul(
          git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], false, mode),
        ).sort();
        return files;
      },
      read: (path) => {
        const { absolute } = repositoryPath(root, path);
        if (!existsSync(absolute)) return null;
        const real = repositoryPath(root, realpathSync(absolute)).absolute;
        // A submodule checkout is listed as a path but is a DIRECTORY on disk; reading it throws
        // EISDIR. Absent content, not a fault — the same answer its gitlink gets in the other modes.
        if (!statSync(real).isFile()) return null;
        return readFileSync(real, 'utf8');
      },
    };
  }

  if (mode === 'staged') {
    let blobs: Map<string, string> | undefined;
    // `--stage` over `--cached`: the mode column is what separates a blob from a gitlink.
    const staged = () =>
      (blobs ??= listingBlobs(
        gitListing(root, ['ls-files', '--stage', '-z'], mode),
        (metadata) => !metadata.startsWith(`${GITLINK_MODE} `),
        1,
      ));
    const listFiles = () => [...staged().keys()].sort();
    const read = gitReader(root, mode, staged);
    return {
      mode,
      root,
      listFiles,
      read: (path) => read(path, (repoPath) => `:${repoPath}`),
      explainAbsence: (path) =>
        explainStagedAbsence(root, repositoryPath(root, path).relative, listFiles),
    };
  }

  const tree = ref ?? 'HEAD';
  let blobs: Map<string, string> | undefined;
  // Without `--name-only` the type column arrives too; `-r` yields only blobs and gitlinks, so
  // keeping `blob` is exactly the readable set.
  const listed = () =>
    (blobs ??= listingBlobs(
      gitListing(root, ['ls-tree', '-r', '-z', tree], mode),
      (metadata) => metadata.split(' ')[1] === 'blob',
      2,
    ));
  const listFiles = () => [...listed().keys()].sort();
  const read = gitReader(root, mode, listed);
  return {
    mode,
    root,
    ref: tree,
    listFiles,
    read: (path) => read(path, (repoPath) => `${tree}:${repoPath}`),
    explainAbsence: (path) =>
      [
        `  absence of ${repositoryPath(root, path).relative} (tree):`,
        probe('listing', () => `${listFiles().length} entries at ${tree}`),
      ].join('\n'),
  };
}

export function hashPaths(source: RepositorySource, globs: string[]): string {
  const paths = source
    .listFiles()
    .filter((path) => globs.some((glob) => matchesRepoGlob(path, glob)))
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    const content = source.read(path);
    if (content === null) continue;
    hash.update(path);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function suiteHashes(
  source: RepositorySource,
  hashes: { implementation: string[]; corpus: string[]; scorer: string[]; runner: string[] },
): HashSet {
  return {
    implementation: hashPaths(source, hashes.implementation),
    corpus: hashPaths(source, hashes.corpus),
    scorer: hashPaths(source, hashes.scorer),
    runner: hashPaths(source, hashes.runner),
  };
}

export function repoRelative(cwd: string, path: string): string {
  return relative(resolve(cwd), resolve(cwd, path)).replaceAll('\\', '/');
}

export function gitOutput(cwd: string, args: string[], allowFailure = false): string {
  return git(cwd, args, allowFailure);
}

// `:/` anchors both pathspecs at the repository root, so the refusals below cannot silently match
// nothing when the publisher is invoked from a subdirectory.
const LEDGER_PATHSPECS = [':/docs/benchmarks/history.jsonl', ':/docs/benchmarks/checkpoints'];

/** The commit an index is staged over. `rev-parse HEAD` on an unborn branch is a fatal that would
 * otherwise reach the caller as raw git noise. */
export function headCommit(root: string): string {
  const head = git(root, ['rev-parse', 'HEAD'], true).trim();
  if (!head) throw new Error('Publication requires at least one commit: HEAD is unborn');
  return head;
}

export function commitDate(root: string, commit: string): string {
  return git(root, ['show', '-s', '--format=%cI', commit]).trim();
}

/** Content identity of the whole index: mode, object, stage and path per entry. Read-only, unlike
 * `write-tree`, which mints objects no publication ever commits. */
export function stagedIndexIdentity(root: string): string {
  return indexIdentity(git(root, ['ls-files', '--stage', '-z'], false, 'staged'));
}

/** Refuse an index a publication cannot read honestly, naming the remedy for each case. */
export function assertPublishableIndex(root: string): void {
  // An unmerged path is listed once per stage and `git show :<path>` cannot resolve it, so without
  // this the publisher dies inside a git fatal instead of naming the conflict.
  const unmerged = listingPaths(
    splitNul(git(root, ['ls-files', '--unmerged', '-z'], false, 'staged')),
    () => true,
  );
  if (unmerged.length) {
    throw new Error(
      `STAGED publication requires a resolved index; unmerged paths:\n${unmerged.join('\n')}`,
    );
  }
  if (!splitNul(git(root, ['diff', '--cached', '--name-only', '-z'], false, 'staged')).length) {
    throw new Error(
      'Nothing is staged: --tree STAGED publishes the Git index, which currently matches HEAD',
    );
  }
  // Load-bearing: appendPublishedEventUnlocked reads and writes history.jsonl in the WORKTREE, so an
  // index that disagrees with those bytes would append onto a ledger it never measured.
  const ledger = splitNul(
    git(root, ['diff', '--name-only', '-z', '--', ...LEDGER_PATHSPECS], false, 'staged'),
  );
  if (ledger.length) {
    throw new Error(
      `STAGED publication requires the ledger to match the index; unstaged:\n${ledger.join('\n')}`,
    );
  }
}

/** The publish lock does not serialize a concurrent `git add`, so a torn read would otherwise mint a
 * permanently wrong immutable event. */
export function assertIndexUnchanged(root: string, identity: string): void {
  if (identity && identity !== stagedIndexIdentity(root))
    throw new Error('The Git index changed during publication; re-stage and re-run publish');
}

const UNTRACKED_PUBLISH_LOCK_STATUS = '?? docs/benchmarks/.publish.lock';

export function assertCleanPublishWorktree(root: string): void {
  const dirty = gitOutput(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .filter((line) => line && line !== UNTRACKED_PUBLISH_LOCK_STATUS);
  if (dirty.length) {
    throw new Error(
      `WORKTREE publication requires a completely clean working tree:\n${dirty.join('\n')}`,
    );
  }
}

/** Read the baseline a publication measures, refusing with the remedy that fits the snapshot. A
 * gitignored file can never be staged, so `git add` is the wrong advice to hand back for one. */
export function readPublishBaseline(
  source: RepositorySource,
  root: string,
  tree: string,
  path: string,
): string {
  const raw = source.read(path);
  if (raw) return raw;
  if (tree !== 'STAGED') throw new Error(`Missing baseline ${path} at ${tree}`);
  const ignored = git(root, ['check-ignore', '--', path], true).trim();
  throw new Error(
    ignored
      ? `Missing baseline ${path} at the index; it is gitignored, so publish it with --tree WORKTREE`
      : `Missing baseline ${path} at the index; stage it with: git add ${path}`,
  );
}

/** Map publish's `--tree` vocabulary onto a snapshot, so one place owns which token reads what. The
 * identity is empty outside STAGED, where it pins the index the event is computed from. */
export function publishSnapshot(cwd: string, tree: string) {
  if (tree === 'WORKTREE') {
    assertCleanPublishWorktree(cwd);
    return { source: repositorySource(cwd, 'working'), identity: '' };
  }
  if (tree !== 'STAGED') return { source: repositorySource(cwd, 'tree', tree), identity: '' };
  assertPublishableIndex(cwd);
  return { source: repositorySource(cwd, 'staged'), identity: stagedIndexIdentity(cwd) };
}
