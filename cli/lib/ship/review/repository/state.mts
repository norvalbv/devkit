import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  type Stats,
  statSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomic } from '../../../atomic-write.mts';
import { runDirectReviewCli } from '../run-direct.mts';
import {
  canonicalReviewDirectory,
  canonicalReviewLeaf,
  reviewPathWithin,
} from '../runtime-paths.mts';
import {
  parseReviewRepositoryStateManifest,
  REVIEW_REPOSITORY_OBJECT_ID,
  REVIEW_REPOSITORY_STATE_VERSION,
  type ReviewRepositoryState,
  type ReviewRepositoryStateManifest,
  reviewRepositoryManifestHash,
} from './manifest.mts';

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export interface CaptureReviewRepositoryStateOptions {
  afterFirstCapture?: () => void;
}

interface RepositoryContext {
  targetRoot: string;
  gitRoot: string;
  gitCommonDir: string;
  gitDir: string;
}

interface ConfigFileState {
  readable: boolean;
  parts: Buffer[];
}

function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  // These commands are read-only; forbid opportunistic lock-taking such as index refreshes too.
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function spawnGit(root: string, args: string[]): SpawnSyncReturns<Buffer> {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    env: gitEnvironment(),
    maxBuffer: MAX_GIT_OUTPUT,
  });
}

function gitFailure(label: string, result: SpawnSyncReturns<Buffer>): never {
  if (result.error) fail(`could not ${label} (${errorMessage(result.error)}).`);
  const detail = result.stderr.toString().trim();
  fail(`could not ${label} (git exited ${String(result.status)}${detail ? `: ${detail}` : ''}).`);
}

function gitRaw(root: string, args: string[], label: string): Buffer {
  const result = spawnGit(root, args);
  if (result.status !== 0) gitFailure(label, result);
  return result.stdout;
}

function gitOptionalRaw(root: string, args: string[], label: string): Buffer {
  const result = spawnGit(root, args);
  if (result.status === 0) return result.stdout;
  if (result.status === 1 && result.stdout.length === 0 && result.stderr.length === 0)
    return Buffer.alloc(0);
  return gitFailure(label, result);
}

function gitLine(root: string, args: string[], label: string): Buffer {
  const raw = gitRaw(root, args, label);
  if (raw.length === 0 || raw[raw.length - 1] !== 0x0a) fail(`${label} returned malformed output.`);
  return raw.subarray(0, -1);
}

function repositoryContext(requestedTarget: string): RepositoryContext {
  const targetRoot = canonicalReviewDirectory(requestedTarget, 'review target checkout');
  const rawGitRoot = gitLine(
    targetRoot,
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    'locate the target Git root',
  );
  if (rawGitRoot.includes(0)) fail('target Git root contains an invalid NUL byte.');
  const gitRoot = canonicalReviewDirectory(rawGitRoot.toString(), 'target Git root');
  if (!reviewPathWithin(gitRoot, targetRoot))
    fail('target checkout is not contained by its detected Git root.');
  const gitCommonDir = gitDirectory(targetRoot, '--git-common-dir', 'common Git directory');
  const gitDir = gitDirectory(targetRoot, '--git-dir', 'worktree Git directory');
  return { targetRoot, gitRoot, gitCommonDir, gitDir };
}

function manifestDestination(path: string, context: RepositoryContext): string {
  const destination = canonicalReviewLeaf(path, 'repository state manifest parent');
  if (
    reviewPathWithin(context.gitRoot, destination) ||
    reviewPathWithin(context.gitCommonDir, destination) ||
    reviewPathWithin(context.gitDir, destination)
  ) {
    fail('repository state manifest must live outside the target Git root and Git admin trees.');
  }
  return destination;
}

function framedHash(label: string, parts: readonly Buffer[]): string {
  const hash = createHash('sha256');
  hash.update(`${Buffer.byteLength(label)}:${label}`);
  for (const part of parts) {
    hash.update(`${part.length}:`);
    hash.update(part);
  }
  return hash.digest('hex');
}

function headSymref(root: string): string | null {
  const result = spawnGit(root, ['symbolic-ref', '--quiet', 'HEAD']);
  if (result.status === 1 && result.stdout.length === 0 && result.stderr.length === 0) return null;
  if (result.status !== 0) gitFailure('read target symbolic HEAD', result);
  const raw = result.stdout;
  if (raw.length <= 1 || raw[raw.length - 1] !== 0x0a || raw.subarray(0, -1).includes(0))
    fail('target symbolic HEAD returned malformed output.');
  return raw.subarray(0, -1).toString('base64');
}

function refsState(root: string): Buffer {
  return gitRaw(
    root,
    ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(symref)%00'],
    'read target refs',
  );
}

function effectiveConfigState(root: string, scope: '--local' | '--worktree'): Buffer {
  return gitRaw(
    root,
    ['config', scope, '--includes', '--null', '--show-origin', '--list'],
    `read target ${scope.slice(2)} config`,
  );
}

function worktreeConfigEnabled(root: string): boolean {
  const enabled = gitOptionalRaw(
    root,
    ['config', '--local', '--includes', '--type=bool', '--get', 'extensions.worktreeConfig'],
    'read target worktree-config extension',
  );
  if (enabled.length === 0 || enabled.equals(Buffer.from('false\n'))) return false;
  if (enabled.equals(Buffer.from('true\n'))) return true;
  return fail('target worktree-config extension returned malformed output.');
}

function fileType(stat: Stats | BigIntStats): string {
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  return 'unknown';
}

function missingPath(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    'code' in cause &&
    (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
  );
}

function inspectConfigFile(path: string, label: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (cause) {
    if (missingPath(cause)) return undefined;
    return fail(`could not inspect target ${label} (${errorMessage(cause)}).`);
  }
}

function readConfigFile(path: string, label: string, type: 'file' | 'symlink'): Buffer[] {
  try {
    const linkTarget =
      type === 'symlink' ? readlinkSync(path, { encoding: 'buffer' }) : Buffer.alloc(0);
    const contents = readFileSync(path);
    if (contents.length > MAX_GIT_OUTPUT) fail(`target ${label} is too large.`);
    return [Buffer.from(type), linkTarget, contents];
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('devkit review:')) throw cause;
    return fail(`could not read target ${label} (${errorMessage(cause)}).`);
  }
}

/** Exact path entry state. Regular files hash raw bytes; symlinks hash link and resolved bytes. */
function configFileState(path: string, label: string): ConfigFileState {
  const stat = inspectConfigFile(path, label);
  if (!stat) return { readable: false, parts: [Buffer.from('missing')] };
  const type = fileType(stat);
  if (type !== 'file' && type !== 'symlink') {
    return { readable: false, parts: [Buffer.from(type)] };
  }
  return { readable: true, parts: readConfigFile(path, label, type) };
}

function gitDirectory(root: string, flag: '--git-common-dir' | '--git-dir', label: string): string {
  const raw = gitLine(
    root,
    ['rev-parse', '--path-format=absolute', flag],
    `locate the target ${label}`,
  );
  if (raw.includes(0)) fail(`target ${label} contains an invalid NUL byte.`);
  const path = raw.toString();
  if (!isAbsolute(path)) fail(`target ${label} is not an absolute path.`);
  return canonicalReviewDirectory(path, `target ${label}`);
}

function configFingerprint(context: RepositoryContext): string {
  const commonConfig = join(context.gitCommonDir, 'config');
  const worktreeConfig = join(context.gitDir, 'config.worktree');
  const shared = configFileState(commonConfig, 'shared repository config');
  const selectedWorktree = configFileState(worktreeConfig, 'worktree repository config');
  const sharedEffective = shared.readable
    ? effectiveConfigState(context.gitRoot, '--local')
    : Buffer.alloc(0);
  const worktreeEffective =
    selectedWorktree.readable && worktreeConfigEnabled(context.gitRoot)
      ? effectiveConfigState(context.gitRoot, '--worktree')
      : Buffer.alloc(0);
  return framedHash('review-repository-config-v2', [
    Buffer.from(commonConfig),
    ...shared.parts,
    sharedEffective,
    Buffer.from(worktreeConfig),
    ...selectedWorktree.parts,
    worktreeEffective,
  ]);
}

function metadataBuffer(stat: BigIntStats): Buffer {
  return Buffer.from(
    [fileType(stat), stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(
      ':',
    ),
  );
}

function pathMutationEvidence(path: string, label: string, recursive: boolean): Buffer[] {
  let stat: BigIntStats | undefined;
  try {
    stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  } catch (cause) {
    return fail(`could not inspect target metadata storage (${errorMessage(cause)}).`);
  }
  if (stat === undefined) return [Buffer.from(label), Buffer.from('missing')];
  const parts = [Buffer.from(label), metadataBuffer(stat)];
  if (stat.isSymbolicLink()) {
    try {
      parts.push(
        readlinkSync(path, { encoding: 'buffer' }),
        metadataBuffer(statSync(path, { bigint: true })),
      );
    } catch (cause) {
      return fail(`could not read target metadata storage link (${errorMessage(cause)}).`);
    }
  }
  if (!recursive || !stat.isDirectory()) return parts;
  let names: string[];
  try {
    names = readdirSync(path).sort();
  } catch (cause) {
    return fail(`could not enumerate target metadata storage (${errorMessage(cause)}).`);
  }
  parts.push(Buffer.from(`entries:${names.length}`));
  for (const name of names)
    parts.push(...pathMutationEvidence(join(path, name), `${label}/${name}`, true));
  return parts;
}

/** Filesystem evidence closes ref/config ABA gaps between equal logical metadata snapshots. */
function repositoryMutationEvidence(context: RepositoryContext): string {
  const parts: Buffer[] = [];
  for (const [label, directory] of [
    ['common', context.gitCommonDir],
    ['worktree', context.gitDir],
  ] as const) {
    parts.push(...pathMutationEvidence(directory, `${label}:admin`, false));
    parts.push(...pathMutationEvidence(join(directory, 'refs'), `${label}:refs`, true));
    parts.push(...pathMutationEvidence(join(directory, 'reftable'), `${label}:reftable`, true));
    parts.push(
      ...pathMutationEvidence(join(directory, 'packed-refs'), `${label}:packed-refs`, false),
    );
  }
  parts.push(...pathMutationEvidence(join(context.gitCommonDir, 'config'), 'common:config', false));
  parts.push(
    ...pathMutationEvidence(join(context.gitDir, 'config.worktree'), 'worktree:config', false),
  );
  parts.push(...pathMutationEvidence(join(context.gitDir, 'HEAD'), 'worktree:HEAD', false));
  return framedHash('review-repository-mutation-evidence-v2', parts);
}

function captureState(context: RepositoryContext): ReviewRepositoryState {
  const root = context.gitRoot;
  const headOid = gitLine(
    root,
    ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
    'resolve target HEAD',
  ).toString();
  if (!REVIEW_REPOSITORY_OBJECT_ID.test(headOid))
    fail('target HEAD is not a valid commit object ID.');
  return {
    headOid,
    headSymrefBase64: headSymref(root),
    refsSha256: framedHash('review-repository-refs-v1', [refsState(root)]),
    configSha256: configFingerprint(context),
  };
}

function stableState(
  context: RepositoryContext,
  options: CaptureReviewRepositoryStateOptions = {},
): ReviewRepositoryState {
  const evidenceBefore = repositoryMutationEvidence(context);
  const before = captureState(context);
  options.afterFirstCapture?.();
  const after = captureState(context);
  const evidenceAfter = repositoryMutationEvidence(context);
  if (JSON.stringify(before) !== JSON.stringify(after) || evidenceBefore !== evidenceAfter)
    fail('target repository metadata changed during capture; retry.');
  return after;
}

/** Capture a stable repository state and atomically write its private manifest. */
export function captureReviewRepositoryState(
  targetRoot: string,
  manifestPath: string,
  options: CaptureReviewRepositoryStateOptions = {},
): ReviewRepositoryStateManifest {
  const context = repositoryContext(targetRoot);
  const destination = manifestDestination(manifestPath, context);
  const state = stableState(context, options);
  const unsigned = {
    version: REVIEW_REPOSITORY_STATE_VERSION,
    ...context,
    state,
  } as const;
  const manifest = { ...unsigned, selfHash: reviewRepositoryManifestHash(unsigned) };
  writeFileAtomic(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Re-authenticate a manifest and require the target repository metadata to remain unchanged. */
export function verifyReviewRepositoryState(
  targetRoot: string,
  manifestPath: string,
): ReviewRepositoryStateManifest {
  const context = repositoryContext(targetRoot);
  const destination = manifestDestination(manifestPath, context);
  const manifest = parseReviewRepositoryStateManifest(destination);
  if (manifest.targetRoot !== context.targetRoot)
    fail('repository state manifest belongs to a different target checkout.');
  if (manifest.gitRoot !== context.gitRoot)
    fail('repository state manifest belongs to a different target Git root.');
  if (manifest.gitCommonDir !== context.gitCommonDir)
    fail('repository state manifest belongs to a different target common Git directory.');
  if (manifest.gitDir !== context.gitDir)
    fail('repository state manifest belongs to a different target worktree Git directory.');
  if (JSON.stringify(stableState(context)) !== JSON.stringify(manifest.state))
    fail('target repository metadata changed after capture; retry.');
  return manifest;
}

function runCli(args: string[]): void {
  if (args[0] === 'capture' && args.length === 3) {
    captureReviewRepositoryState(args[1] as string, args[2] as string);
    return;
  }
  if (args[0] === 'verify' && args.length === 3) {
    verifyReviewRepositoryState(args[1] as string, args[2] as string);
    return;
  }
  fail('usage: repository-state capture <target> <manifest> | verify <target> <manifest>');
}

runDirectReviewCli(import.meta.url, runCli);
