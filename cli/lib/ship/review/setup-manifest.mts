/** Stable, typed capture of the target-controlled setup that `devkit review` will execute. */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mts';
import type { ReviewProfile } from '../../components.mts';
import { detectGitRoot } from '../../detect-git-root.mts';
import { gitOut, sameDir } from '../../doctor/hooks-path.mts';
import { reviewHookDrift } from '../../husky/review-drift.mts';
import { captureOrigHooksPath, overlayHookScriptDir } from '../../overlay.mts';
import { runDirectReviewCli } from './run-direct.mts';
import { reviewRuntimeFingerprint } from './runtime-fingerprint.mts';
import {
  canonicalReviewDirectory,
  canonicalReviewLeaf,
  isSafeReviewRelativePath,
  reviewPathWithin,
} from './runtime-paths.mts';
import {
  OVERLAY_HOOKS_PATH,
  type OverlayHooksPathContext,
  overlayHooksPathRejection,
} from './setup/overlay-hooks-path.mts';
import { reviewSetupStat } from './setup/setup-runtime-copy.mts';
import {
  REVIEW_SETUP_ABSENT,
  REVIEW_SETUP_VERSION,
  reviewSetupHash,
} from './setup-manifest-format.mts';
import { parseReviewSetupManifest } from './setup-manifest-parse.mts';
import {
  REVIEW_SETUP_DOCTOR as DOCTOR,
  REVIEW_SETUP_OVERLAY_DOCTOR as OVERLAY_DOCTOR,
  parseReviewSetupProfile,
  type RawReviewConfig,
} from './setup-profile.mts';
import { errorMessage, fail } from './shared/common.mts';
import { type ReviewSourceResolution, resolveReviewSource } from './source-projection.mts';

const HUSKY_RUNNER_PATHS = [
  ['runner-source', '.husky/_', false],
  ['runner-pre-commit', '.husky/_/pre-commit', true],
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

function validateTree(path: string, relativePath: string): void {
  // `reviewSetupStat`, not a bare lstat: `throwIfNoEntry: false` silences only ENOENT, and a path
  // whose ANCESTOR is a file (a linked worktree's `.git` gitfile) raises ENOTDIR. Both mean absent.
  const stat = reviewSetupStat(path);
  if (stat === undefined) return;
  if (stat.isSymbolicLink()) fail(`unsafe nested symlink in review setup path: ${relativePath}`);
  if (stat.isFile()) return;
  if (!stat.isDirectory()) fail(`unsupported review setup path type: ${relativePath}`);
  for (const name of readdirSync(path).sort())
    validateTree(join(path, name), `${relativePath}/${name}`);
}

function setupPathFingerprint(source: ReviewSourceResolution): string {
  const runtime = reviewRuntimeFingerprint(source.physicalPath);
  return source.projection ? reviewSetupHash({ projection: source.projection, runtime }) : runtime;
}

function pathState(
  rootKind: ReviewSetupPath['root'],
  root: string,
  id: string,
  relativePath: string,
  required: boolean,
  executable: boolean,
): ReviewSetupPath {
  const safe = safeRelativePath(root, relativePath, `${id} path`);
  const source = resolveReviewSource(root, safe);
  validateTree(source.physicalPath, safe);
  const stat = reviewSetupStat(source.physicalPath);
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
    fingerprint: setupPathFingerprint(source),
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

/**
 * The hooksPath to FREEZE, after validating the live one.
 *
 * Package mode freezes what it reads — review-target.sh actually runs the gates with it. Overlay
 * mode always freezes the canonical `.devkit/hooks`, which is what review-target.sh hardcodes for
 * its private gate run, and validates the live value through the acceptance predicate instead.
 *
 * Canonicalizing is what keeps the frozen value STABLE. The live value is transient in overlay mode
 * — the `git ci` alias (overlay.mts) and `devkit doctor --fix` both re-point it — and the frozen
 * value is re-compared against the live one throughout a review (setup-runtime.mts verifySource,
 * re-run at several points in review-target.sh). Freezing the reclaimed `.husky/_` would let a
 * concurrent `git ci` in another terminal abort an in-flight review.
 */
function effectiveHooksPath(
  root: string,
  overlay: boolean,
  context: OverlayHooksPathContext,
): string {
  const value = readHooksPath(root);
  if (!overlay) {
    if (value !== '.husky/_')
      fail(
        `core.hooksPath is ${JSON.stringify(value || '(unset)')}, expected .husky/_ — ${
          isAbsolute(value)
            ? `run 'devkit doctor' for the ownership diagnosis, then 'devkit sync-hook-runner' to repair a proven sibling-worktree pin; otherwise repoint it explicitly: git config core.hooksPath .husky/_`
            : DOCTOR
        }`,
      );
    return value;
  }
  const rejection = overlayHooksPathRejection(value, context);
  if (rejection) fail(`${rejection} — ${OVERLAY_DOCTOR}`);
  return OVERLAY_HOOKS_PATH;
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
      : HUSKY_RUNNER_PATHS.map(([id, path, executable]) =>
          pathState('git', gitRoot, id, path, true, executable),
        )),
    pathState('git', gitRoot, 'effective-hook', hookPath, true, true),
    ...OPTIONAL_PATHS.map(([id, path]) => pathState('target', targetRoot, id, path, false, false)),
  ];
}

/** What `overlayHookScriptDir` returns when core.hooksPath is unset — git's own hooks directory. */
const GIT_HOOKS_DIR = '.git/hooks';

/**
 * Would git actually run a hook at `path`?
 *
 * FOLLOWS symlinks, unlike every other stat in this module. git executes a symlinked hook exactly
 * like a regular one — and symlinked hooks are how dotfiles setups and hook managers install them,
 * devkit's own ship worktrees included — so judging by `lstat` here would report "not a file" and
 * wave through the very checkout this guard exists to refuse.
 */
function gitWouldExecute(path: string): boolean {
  try {
    // `throwIfNoEntry` covers the missing-file and broken-symlink cases; ENOTDIR and ELOOP throw.
    // All of them mean the same thing: nothing here that git could execute.
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat?.isFile() === true && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Refuse a target whose NATIVE hooks directory lives outside the checkout.
 *
 * `.git/hooks` names the real hooks directory only when `.git` is a directory. In a linked worktree,
 * a submodule, or a `--separate-git-dir` checkout, `.git` is a gitfile and the hooks live in the
 * common dir — which has no repository-relative spelling, so review cannot freeze it. The segment
 * walk now resolves that path to ABSENT instead of aborting, so without this check a repo that
 * really owns a native pre-commit would be reviewed green without it ever running — and review is
 * the SAME in-chain pre-commit authority (docs/decisions/review-gate-in-chain.md).
 *
 * Compared by SAME DIRECTORY rather than containment: `git init --separate-git-dir=<gitRoot>/mygit`
 * produces a gitfile whose common dir is INSIDE gitRoot, which a containment test waves through.
 */
function assertNativeHooksAreInTree(gitRoot: string): void {
  // Stripped of the ambient git environment for the reason LOCAL_GIT_ENVIRONMENT exists: an
  // inherited GIT_DIR/GIT_COMMON_DIR steers this answer at a different repository, and `devkit
  // review` is routinely spawned from inside git (a hook, a `rebase --exec`).
  const common = withoutLocalGitEnvironment(() =>
    gitOut(gitRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  // gitOut reports EVERY failure as '', and join('', 'hooks') is the cwd-relative 'hooks' — which
  // reads as in-tree or out-of-tree depending on the caller's cwd. An unprovable answer is fatal,
  // never a fall-through: falling through is exactly the silent skip this function prevents.
  if (!common || !isAbsolute(common))
    fail('could not resolve the target Git common directory; retry.');
  const realHooks = join(common, 'hooks');
  if (sameDir(realHooks, join(gitRoot, '.git', 'hooks'))) return;
  const hook = join(realHooks, 'pre-commit');
  if (!gitWouldExecute(hook)) return;
  fail(
    `${gitRoot} is a linked worktree, submodule, or separate-git-dir checkout whose native pre-commit lives outside it (${hook}). devkit review cannot freeze a hook outside the target root — review a full clone of this repository instead.`,
  );
}

function captureOverlayChain(
  gitRoot: string,
  targetRoot: string,
  config: RawReviewConfig,
): {
  chain: NonNullable<ReviewSetupState['chain']>;
  paths: ReviewSetupPath[];
  /** The chain hook exists and is executable — the acceptance predicate's proof, not a re-stat. */
  present: boolean;
} {
  const origHooksPath =
    typeof config.origHooksPath === 'string'
      ? config.origHooksPath
      : captureOrigHooksPath(gitRoot, targetRoot);
  const configured = join(overlayHookScriptDir(origHooksPath), 'pre-commit');
  const path = safeRelativePath(gitRoot, configured, 'overlay pre-commit chain');
  const sourcePath = dirname(path);
  if (sourcePath === '.')
    fail('root-level overlay pre-commit chains are not supported by devkit review.');
  // Only the native-hooks case can name a directory outside the checkout. A husky or custom
  // hooksPath is an ordinary in-tree path, and in husky mode git's own hooks dir is never executed —
  // so a stray `.git/hooks/pre-commit` there must NOT fail the review closed.
  //
  // Decided on the NORMALIZED sourcePath rather than the raw recorded value: devkit records
  // core.hooksPath verbatim, so a hand-written `.git/hooks/` produces the identical chain path while
  // slipping past a literal match — one character silently disabling the refusal below.
  if (sourcePath === GIT_HOOKS_DIR) assertNativeHooksAreInTree(gitRoot);
  const chainState = pathState('git', gitRoot, 'overlay-chain', path, false, true);
  const present = chainState.fingerprint !== REVIEW_SETUP_ABSENT;
  const paths = [chainState];
  if (present)
    paths.push(pathState('git', gitRoot, 'overlay-chain-source', sourcePath, false, false));
  return { chain: { path, sourcePath }, paths, present };
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
  // The chain is captured BEFORE the hooksPath so the acceptance predicate can reuse its verdict:
  // whether the repo's committed hook exists and where it lives are two of the preconditions for
  // accepting a husky-reclaimed hooksPath, and re-stat'ing them here would let the manifest and the
  // acceptance disagree.
  const overlay = parsed.overlay ? captureOverlayChain(gitRoot, targetRoot, parsed.raw) : null;
  const hooksPath = effectiveHooksPath(gitRoot, parsed.overlay, {
    gitRoot,
    chain: overlay?.chain ?? null,
    chainPresent: overlay?.present ?? false,
  });
  const paths = captureSetupPaths(targetRoot, gitRoot, parsed.overlay);
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

function runCli(args: string[]): void {
  if (args[0] === 'capture' && args.length === 3) {
    captureReviewSetup(args[1] as string, args[2] as string);
    return;
  }
  if (args[0] === 'verify' && args.length === 3) {
    verifyReviewSetup(args[1] as string, args[2] as string);
    return;
  }
  fail('usage: setup-manifest capture <target-root> <manifest> | verify <target-root> <manifest>');
}

runDirectReviewCli(import.meta.url, runCli);
