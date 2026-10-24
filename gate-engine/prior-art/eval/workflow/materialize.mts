// prior-art workflow tier: pinned snapshots (git archive, tree OID verified, cached once) and per-run
// workspaces. An unreachable commit or a mismatched tree aborts before any spawn; never a head.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchAbort } from '../../../decisions/eval/bench.mts';
import { type Member, REFS_PATTERN, type Snapshot } from './families.mts';

export const DEFAULT_CACHE_ROOT = path.join(homedir(), '.devkit', 'research', 'prior-art-workflow');
const here = path.dirname(fileURLToPath(import.meta.url));

export interface MaterializeOptions {
  cacheRoot?: string;
  /** A local repository searched for the commit before any network fetch. */
  sourceRepo?: string;
}

export interface Workspace {
  root: string;
  consumer: string;
  refs: string;
  cleanup: () => void;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

function hasCommit(repo: string, sha: string): boolean {
  return git(repo, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

/** The repository holding `sha`: the local source first, else a shallow fetch into the cache. */
function repoWithCommit(snapshot: Snapshot, options: Required<MaterializeOptions>): string {
  if (options.sourceRepo && hasCommit(options.sourceRepo, snapshot.sha)) return options.sourceRepo;
  const cache = path.join(options.cacheRoot, 'objects.git');
  if (!existsSync(cache)) {
    mkdirSync(cache, { recursive: true });
    git(cache, ['init', '--bare', '-q']);
  }
  if (!hasCommit(cache, snapshot.sha))
    git(cache, ['fetch', '--depth', '1', '-q', snapshot.url, snapshot.sha]);
  if (!hasCommit(cache, snapshot.sha))
    throw new BenchAbort(
      2,
      `prior-art workflow: ${snapshot.name}@${snapshot.sha} is unreachable from ${snapshot.url}`,
    );
  return cache;
}

/** The verified, cached tree of one pinned snapshot. */
export function snapshotDir(snapshot: Snapshot, opts: MaterializeOptions = {}): string {
  const cacheRoot = opts.cacheRoot ?? DEFAULT_CACHE_ROOT;
  const dir = path.join(cacheRoot, 'trees', snapshot.tree);
  if (existsSync(dir)) return dir;
  const sourceRepo = opts.sourceRepo ?? git(here, ['rev-parse', '--show-toplevel'])?.trim() ?? '';
  const repo = repoWithCommit(snapshot, { cacheRoot, sourceRepo });
  const tree = git(repo, ['rev-parse', `${snapshot.sha}^{tree}`])?.trim();
  if (tree !== snapshot.tree)
    throw new BenchAbort(
      2,
      `prior-art workflow: ${snapshot.name}@${snapshot.sha} has tree ${tree}, pinned ${snapshot.tree}`,
    );
  const partial = `${dir}.partial-${process.pid}`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  const extract = spawnSync(
    'bash',
    [
      '-c',
      'set -o pipefail; git archive --format=tar "$1" | tar -x -C "$2"',
      'archive',
      snapshot.sha,
      partial,
    ],
    { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  if (extract.status !== 0) {
    rmSync(partial, { recursive: true, force: true });
    throw new BenchAbort(
      2,
      `prior-art workflow: archive of ${snapshot.name} failed: ${extract.stderr}`,
    );
  }
  renameSync(partial, dir);
  return dir;
}

/** Point the consumer's declared reference checkouts at the workspace's refs/ directory. */
function declareRefs(consumer: string): void {
  const file = path.join(consumer, 'guard.config.json');
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  config.research = { ...config.research, referenceCheckouts: [REFS_PATTERN] };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** A fresh workspace: `consumer/` (snapshot + one config edit) and `refs/` (empty for a broken tool).
 *  Copies, never links to the cache: `--restricted` confines the agent's file tools to cwd and --add-dir. */
export function materializeWorkspace(member: Member, opts: MaterializeOptions = {}): Workspace {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'prior-art-wf-')));
  const workspace = {
    root,
    consumer: path.join(root, 'consumer'),
    refs: path.join(root, 'refs'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  try {
    const copy = { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE };
    if (member.consumer) cpSync(snapshotDir(member.consumer, opts), workspace.consumer, copy);
    else mkdirSync(workspace.consumer);
    mkdirSync(workspace.refs);
    for (const ref of member.refs)
      cpSync(snapshotDir(ref, opts), path.join(workspace.refs, ref.name), copy);
    declareRefs(workspace.consumer);
    return workspace;
  } catch (error) {
    workspace.cleanup();
    throw error;
  }
}

/** The frozen file a span or citation names, read from the snapshot cache (null when absent). */
export function snapshotFile(
  member: Member,
  root: string,
  file: string,
  opts: MaterializeOptions = {},
): string | null {
  const snapshot = root === 'consumer' ? member.consumer : member.refs.find((r) => r.name === root);
  if (!snapshot) return null;
  const base = snapshotDir(snapshot, opts);
  const full = path.resolve(base, file);
  if (!full.startsWith(`${base}${path.sep}`) || !existsSync(full)) return null;
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}
