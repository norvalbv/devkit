/** Stable, typed capture of the target-controlled setup that `devkit review` will execute. */

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mts';
import type { ReviewProfile } from '../../components.mts';
import { detectGitRoot } from '../../detect-git-root.mts';
import { reviewHookDrift } from '../../husky/review-drift.mts';
import { captureOrigHooksPath, overlayHookScriptDir } from '../../overlay.mts';
import { reviewRuntimeFingerprint } from './runtime-fingerprint.mts';
import {
  canonicalReviewDirectory,
  canonicalReviewLeaf,
  isSafeReviewRelativePath,
  reviewPathWithin,
} from './runtime-paths.mts';
import {
  REVIEW_SETUP_ABSENT,
  REVIEW_SETUP_VERSION,
  reviewSetupHash,
} from './setup-manifest-format.mts';
import { parseReviewSetupManifest } from './setup-manifest-parse.mts';
import {
  REVIEW_SETUP_DOCTOR as DOCTOR,
  parseReviewSetupProfile,
  type RawReviewConfig,
} from './setup-profile.mts';

const HUSKY_RUNNER_PATHS = [
  ['runner-source', '.husky/_', false, true],
  ['runner-pre-commit', '.husky/_/pre-commit', true, false],
] as const;
const OPTIONAL_PATHS = [
  ['correctness-overrides', '.devkit/correctness-overrides.json'],
  ['biome-runtime', '.devkit/biome'],
  ['tsconfig-runtime', '.devkit/tsconfig'],
] as const;
const LOCAL_GIT_ENVIRONMENT = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_LITERAL_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
] as const;

export interface ReviewSetupPath {
  id: string;
  root: 'target' | 'git';
  relativePath: string;
  fingerprint: string;
  required: boolean;
  executable: boolean;
}

export interface ReviewSetupState {
  overlay: boolean;
  hooksPath: string;
  profile: ReviewProfile;
  chain: { path: string; sourcePath: string } | null;
  paths: ReviewSetupPath[];
}

export interface ReviewSetupManifest {
  version: typeof REVIEW_SETUP_VERSION;
  targetRoot: string;
  gitRoot: string;
  setup: ReviewSetupState;
  selfHash: string;
}

export interface CaptureReviewSetupOptions {
  /** Deterministic mutation seam for integration tests and callers coordinating a frozen target. */
  afterFirstCapture?: () => void;
}

function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function manifestDestination(path: string, gitRoot: string): string {
  const destination = canonicalReviewLeaf(path, 'setup manifest parent');
  if (reviewPathWithin(gitRoot, destination))
    fail('setup manifest must live outside the target checkout.');
  return destination;
}

function validateManifestSourceSeparation(
  destination: string,
  targetRoot: string,
  gitRoot: string,
  setup: ReviewSetupState,
): void {
  for (const entry of setup.paths) {
    if (entry.fingerprint === REVIEW_SETUP_ABSENT) continue;
    const root = entry.root === 'target' ? targetRoot : gitRoot;
    const lexical = resolve(root, ...entry.relativePath.split('/'));
    let physical: string;
    try {
      physical = realpathSync(lexical);
    } catch {
      fail(`could not resolve frozen setup source: ${entry.relativePath}`);
    }
    if (reviewPathWithin(physical, destination)) {
      fail('setup manifest must live outside every frozen setup source.');
    }
  }
}

function withoutLocalGitEnvironment<T>(operation: () => T): T {
  const saved = new Map<string, string>();
  for (const name of LOCAL_GIT_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) saved.set(name, value);
    delete process.env[name];
  }
  try {
    return operation();
  } finally {
    for (const name of LOCAL_GIT_ENVIRONMENT) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function targetGitRoot(targetRoot: string): string {
  const detected = withoutLocalGitEnvironment(() => detectGitRoot(targetRoot).gitRoot);
  const gitRoot = canonicalReviewDirectory(detected, 'target Git root');
  if (!reviewPathWithin(gitRoot, targetRoot))
    fail('target checkout is not contained by its detected Git root.');
  return gitRoot;
}

function safeRelativePath(root: string, path: string, label: string): string {
  if (!path || path.includes('\0')) fail(`${label} is invalid — ${DOCTOR}`);
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (!rel || !reviewPathWithin(root, candidate))
    fail(`${label} escapes the target repository: ${JSON.stringify(path)}.`);
  const normalized = rel.split(sep).join('/');
  if (!isSafeReviewRelativePath(normalized))
    fail(`${label} is not a safe repository-relative path: ${JSON.stringify(path)}.`);
  return normalized;
}

function validateTree(path: string, relativePath: string, allowRootDirectoryLink = false): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.isSymbolicLink()) {
    if (!allowRootDirectoryLink) fail(`unsafe symlink in review setup path: ${relativePath}`);
    let physical: string;
    try {
      physical = realpathSync(path);
    } catch {
      fail(`broken symlink in review setup path: ${relativePath}`);
    }
    if (!lstatSync(physical).isDirectory())
      fail(`review setup link is not a directory: ${relativePath}`);
    validateTree(physical, relativePath);
    return;
  }
  if (stat.isFile()) return;
  if (!stat.isDirectory()) fail(`unsupported review setup path type: ${relativePath}`);
  for (const name of readdirSync(path).sort())
    validateTree(join(path, name), `${relativePath}/${name}`);
}

function setupPathFingerprint(path: string): string {
  const runtime = reviewRuntimeFingerprint(path);
  const stat = lstatSync(path);
  return stat.isSymbolicLink()
    ? reviewSetupHash({ linkTarget: readlinkSync(path), runtime })
    : runtime;
}

function pathState(
  rootKind: ReviewSetupPath['root'],
  root: string,
  id: string,
  relativePath: string,
  required: boolean,
  executable: boolean,
  allowRootDirectoryLink = false,
): ReviewSetupPath {
  const safe = safeRelativePath(root, relativePath, `${id} path`);
  const absolute = resolve(root, safe);
  validateTree(absolute, safe, allowRootDirectoryLink);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined) {
    if (required) fail(`missing ${safe} — ${DOCTOR}`);
    return {
      id,
      root: rootKind,
      relativePath: safe,
      fingerprint: REVIEW_SETUP_ABSENT,
      required,
      executable,
    };
  }
  if (executable && (!stat.isFile() || (stat.mode & 0o111) === 0)) {
    fail(`${safe} is missing or non-executable — ${DOCTOR}`);
  }
  return {
    id,
    root: rootKind,
    relativePath: safe,
    fingerprint: setupPathFingerprint(absolute),
    required,
    executable,
  };
}

function decodeHooksPath(status: number | null, raw: Buffer): string {
  if (status === 1 && raw.length === 0)
    fail(`core.hooksPath is ${JSON.stringify('(unset)')} — ${DOCTOR}`);
  if (status !== 0)
    fail(`could not read core.hooksPath (git exited ${String(status)}) — ${DOCTOR}`);
  if (raw.length === 0 || raw[raw.length - 1] !== 0)
    fail(`core.hooksPath returned malformed output — ${DOCTOR}`);
  return raw.subarray(0, raw.length - 1).toString();
}

function readHooksPath(root: string): string {
  const result = withoutLocalGitEnvironment(() =>
    spawnSync('git', ['-C', root, 'config', '--null', '--get', 'core.hooksPath']),
  );
  if (result.error)
    fail(`could not read core.hooksPath (${errorMessage(result.error)}) — ${DOCTOR}`);
  return decodeHooksPath(result.status, result.stdout);
}

function effectiveHooksPath(root: string, overlay: boolean): string {
  const value = readHooksPath(root);
  const expected = overlay ? '.devkit/hooks' : '.husky/_';
  if (value !== expected)
    fail(
      `core.hooksPath is ${JSON.stringify(value || '(unset)')}, expected ${expected} — ${DOCTOR}`,
    );
  return value;
}

function captureSetupPaths(
  targetRoot: string,
  gitRoot: string,
  overlay: boolean,
): ReviewSetupPath[] {
  const hookPath = overlay ? '.devkit/hooks/pre-commit' : '.husky/pre-commit';
  return [
    pathState('target', targetRoot, 'config', '.devkit/config.json', true, false),
    ...(overlay
      ? []
      : HUSKY_RUNNER_PATHS.map(([id, path, executable, allowRootDirectoryLink]) =>
          pathState('git', gitRoot, id, path, true, executable, allowRootDirectoryLink),
        )),
    pathState('git', gitRoot, 'effective-hook', hookPath, true, true),
    ...OPTIONAL_PATHS.map(([id, path]) => pathState('target', targetRoot, id, path, false, false)),
  ];
}

function captureOverlayChain(
  gitRoot: string,
  targetRoot: string,
  config: RawReviewConfig,
): { chain: NonNullable<ReviewSetupState['chain']>; paths: ReviewSetupPath[] } {
  const origHooksPath =
    typeof config.origHooksPath === 'string'
      ? config.origHooksPath
      : captureOrigHooksPath(gitRoot, targetRoot);
  const configured = join(overlayHookScriptDir(origHooksPath), 'pre-commit');
  const path = safeRelativePath(gitRoot, configured, 'overlay pre-commit chain');
  const sourcePath = dirname(path);
  if (sourcePath === '.')
    fail('root-level overlay pre-commit chains are not supported by devkit review.');
  const chainState = pathState('git', gitRoot, 'overlay-chain', path, false, true);
  const paths = [chainState];
  if (chainState.fingerprint !== REVIEW_SETUP_ABSENT)
    paths.push(pathState('git', gitRoot, 'overlay-chain-source', sourcePath, false, false));
  return { chain: { path, sourcePath }, paths };
}

function captureState(targetRoot: string, gitRoot: string): ReviewSetupState {
  const configPath = resolve(targetRoot, '.devkit/config.json');
  let parsed: ReturnType<typeof parseReviewSetupProfile>;
  try {
    parsed = parseReviewSetupProfile(readFileSync(configPath));
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('devkit review:')) throw cause;
    return fail(`could not read .devkit/config.json (${errorMessage(cause)}) — ${DOCTOR}`);
  }
  const hooksPath = effectiveHooksPath(gitRoot, parsed.overlay);
  const paths = captureSetupPaths(targetRoot, gitRoot, parsed.overlay);
  const overlay = parsed.overlay ? captureOverlayChain(gitRoot, targetRoot, parsed.raw) : null;
  return {
    overlay: parsed.overlay,
    hooksPath,
    profile: parsed.profile,
    chain: overlay?.chain ?? null,
    paths: [...paths, ...(overlay?.paths ?? [])],
  };
}

function validateGenerator(root: string): void {
  try {
    const drift = withoutLocalGitEnvironment(() => reviewHookDrift(root));
    if (drift) fail(`${drift} — ${DOCTOR}`);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('devkit review:')) throw cause;
    fail(`could not validate devkit setup (${errorMessage(cause)}) — ${DOCTOR}`);
  }
}

function stableState(
  targetRoot: string,
  gitRoot: string,
  options: CaptureReviewSetupOptions = {},
): ReviewSetupState {
  const before = captureState(targetRoot, gitRoot);
  options.afterFirstCapture?.();
  validateGenerator(targetRoot);
  const after = captureState(targetRoot, gitRoot);
  if (JSON.stringify(before) !== JSON.stringify(after))
    fail('target devkit setup changed during validation; retry.');
  return after;
}

/** Validate and atomically record a stable target setup before any no-diff success is possible. */
export function captureReviewSetup(
  targetRoot: string,
  manifestPath: string,
  options: CaptureReviewSetupOptions = {},
): ReviewSetupManifest {
  const root = canonicalReviewDirectory(targetRoot, 'target checkout');
  const gitRoot = targetGitRoot(root);
  const destination = manifestDestination(manifestPath, gitRoot);
  const setup = stableState(root, gitRoot, options);
  validateManifestSourceSeparation(destination, root, gitRoot, setup);
  const unsigned = {
    version: REVIEW_SETUP_VERSION,
    targetRoot: root,
    gitRoot,
    setup,
  } as const;
  const manifest: ReviewSetupManifest = { ...unsigned, selfHash: reviewSetupHash(unsigned) };
  writeFileAtomic(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Revalidate the manifest and require the target's current setup to be byte-identical. */
export function verifyReviewSetup(targetRoot: string, manifestPath: string): ReviewSetupManifest {
  const root = canonicalReviewDirectory(targetRoot, 'target checkout');
  const gitRoot = targetGitRoot(root);
  const destination = manifestDestination(manifestPath, gitRoot);
  const manifest = parseReviewSetupManifest(destination);
  if (manifest.targetRoot !== root)
    fail('review setup manifest belongs to a different target checkout.');
  if (manifest.gitRoot !== gitRoot)
    fail('review setup manifest belongs to a different target Git root.');
  const current = stableState(root, gitRoot);
  validateManifestSourceSeparation(destination, root, gitRoot, current);
  if (JSON.stringify(current) !== JSON.stringify(manifest.setup))
    fail('target devkit setup changed after capture; retry.');
  return manifest;
}
