/** Private, manifest-backed gate-input projections for an isolated review worktree. */

import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runDirectReviewCli } from '../run-direct.mts';
import { reviewRuntimeFingerprint } from '../runtime-fingerprint.mts';
import {
  assertSymlinkFreeReviewTree,
  canonicalReviewDirectory,
  canonicalReviewLeaf,
  reviewPathWithin,
  safeReviewDestination,
} from '../runtime-paths.mts';
import { fail } from '../shared/common.mts';
import { resolveReviewSource } from '../source-projection.mts';
import {
  type ProjectionEntry,
  type ProjectionRuntimeManifest,
  type ProjectionState,
  projectionManifest,
  readManifest,
  safeRelativePath,
} from './manifest.mts';
import { sqliteFamily, sqliteFamilyPath, sqliteWalIndexPath } from './sqlite-family.mts';

// Ratchet/cache gates legitimately update their own ignored baseline/cache state during a run, so
// these roots are allowed to drift between the captured source and the private copy (verify checks
// only that they stay symlink-free); every other projected root is immutable and must match exactly.
// The waiver store is here because the correctness gate's reconcile persists an env-channel override
// into it mid-run.
const MUTABLE_ROOTS = [
  '.fallow',
  'fallow-baselines',
  '.decisions',
  '.devkit/baselines',
  '.devkit/correctness-overrides.json',
] as const;
// Pure caches the gates only read through the private copy: their target source churns under live
// readers and indexers, so postflight skips its drift check. Ratchet freezes stay source-strict.
const SOURCE_VOLATILE_CACHES: readonly string[] = ['.fallow', '.decisions'];

interface SelectedProjection {
  path: string;
  source: ProjectionState;
}

export interface ProjectionRuntimeHooks {
  beforePrivateCopy?: (path: string) => void;
  beforeSourceVerification?: () => void;
}

function absolutePath(root: string, path: string): string {
  const safe = safeRelativePath(path);
  const absolute = resolve(root, ...safe.split('/'));
  if (!reviewPathWithin(root, absolute)) fail(`gate projection escapes its root: ${path}`);
  return absolute;
}

function captureState(root: string, path: string, allowLinks: boolean): ProjectionState {
  const source = resolveReviewSource(root, safeRelativePath(path), {
    allowProjection: allowLinks,
  });
  const stat = lstatSync(source.physicalPath, { throwIfNoEntry: false });
  if (stat === undefined) return { type: 'absent' };
  assertSymlinkFreeReviewTree(source.physicalPath, 'gate projection', 'unsupported entry');
  if (source.projection) {
    return {
      type: stat.isDirectory() ? 'link-directory' : 'link-file',
      fingerprint: reviewRuntimeFingerprint(source.physicalPath),
      linkTarget: source.projection.linkTarget,
      linkPath: source.projection.linkPath,
      physicalPath: source.projection.physicalPath,
    };
  }
  return {
    type: stat.isDirectory() ? 'directory' : 'file',
    fingerprint: reviewRuntimeFingerprint(source.physicalPath),
  };
}

function stateMatches(left: ProjectionState, right: ProjectionState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function copySafeTree(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) fail(`gate projection contains a nested symlink: ${source}`);
  if (stat.isFile()) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    const copiedMode = lstatSync(destination).mode;
    chmodSync(destination, (stat.mode & 0o111) === 0 ? copiedMode & ~0o111 : copiedMode | 0o111);
    return;
  }
  if (!stat.isDirectory()) fail(`gate projection contains an unsupported entry: ${source}`);
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source).sort()) {
    copySafeTree(join(source, name), join(destination, name));
  }
}

function mutablePath(path: string, indexPath: string): boolean {
  if (sqliteFamilyPath(path, indexPath)) return true;
  return MUTABLE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

function pathDepth(path: string): number {
  return path.split('/').length;
}

function candidatePaths(candidates: string[], indexPath: string): string[] {
  const unique = new Set<string>();
  for (const candidate of candidates) unique.add(safeRelativePath(candidate));
  const ordered = [...unique].sort(
    (left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right),
  );
  const result: string[] = [];
  for (const path of ordered) {
    if (result.some((parent) => path.startsWith(`${parent}/`))) continue;
    if (path === indexPath) result.push(...sqliteFamily(path));
    else result.push(path);
  }
  return result;
}

function validateRoots(sourceRoot: string, destinationRoot: string): [string, string] {
  const source = canonicalReviewDirectory(sourceRoot, 'gate projection source');
  const destination = canonicalReviewDirectory(destinationRoot, 'gate projection destination');
  if (reviewPathWithin(source, destination) || reviewPathWithin(destination, source)) {
    fail('gate projection source and destination must be separate, non-nested directories');
  }
  return [source, destination];
}

function validateManifestPath(path: string, source: string, destination: string): string {
  const manifest = canonicalReviewLeaf(path, 'gate projection manifest parent');
  if (reviewPathWithin(source, manifest) || reviewPathWithin(destination, manifest)) {
    fail('gate projection manifest must live outside source and destination roots');
  }
  if (lstatSync(manifest, { throwIfNoEntry: false }) !== undefined) {
    fail('gate projection manifest already exists');
  }
  return manifest;
}

function privateDestination(root: string, path: string): string {
  return safeReviewDestination(
    root,
    path,
    'gate projection escapes its root',
    'gate projection has an unsafe destination parent',
  );
}

function projectedSourceState(root: string, path: string, indexPath: string): ProjectionState {
  return sqliteWalIndexPath(path, indexPath) ? { type: 'absent' } : captureState(root, path, true);
}

function selectProjections(
  source: string,
  destination: string,
  candidates: string[],
  indexPath: string,
): SelectedProjection[] {
  const selected: SelectedProjection[] = [];
  for (const path of candidatePaths(candidates, indexPath)) {
    if (lstatSync(privateDestination(destination, path), { throwIfNoEntry: false }) !== undefined) {
      continue;
    }
    const sourceBefore = projectedSourceState(source, path, indexPath);
    if (sourceBefore.type === 'absent' && !sqliteFamilyPath(path, indexPath)) continue;
    selected.push({ path, source: sourceBefore });
  }
  return selected;
}

function selectedSourcePath(source: string, selected: SelectedProjection): string {
  if (selected.source.type === 'link-file' || selected.source.type === 'link-directory') {
    return selected.source.physicalPath as string;
  }
  return absolutePath(source, selected.path);
}

function copySelectedProjections(
  source: string,
  destination: string,
  selected: SelectedProjection[],
  created: string[],
  hooks: ProjectionRuntimeHooks,
): void {
  for (const entry of selected) {
    if (entry.source.type === 'absent') continue;
    const target = privateDestination(destination, entry.path);
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
      fail(`private gate projection destination changed during capture: ${entry.path}; retry`);
    }
    created.push(target);
    hooks.beforePrivateCopy?.(entry.path);
    copySafeTree(selectedSourcePath(source, entry), target);
  }
}

function verifySelectedProjection(
  source: string,
  destination: string,
  selected: SelectedProjection,
  indexPath: string,
): ProjectionEntry {
  const sourceAfter = projectedSourceState(source, selected.path, indexPath);
  if (!stateMatches(selected.source, sourceAfter)) {
    throw new CaptureDrift(selected.path);
  }
  const destinationAfter = captureState(destination, selected.path, false);
  if (
    selected.source.type !== 'absent' &&
    (destinationAfter.type === 'absent' ||
      selected.source.fingerprint !== destinationAfter.fingerprint)
  ) {
    fail('private gate projection does not match its captured source');
  }
  return {
    path: selected.path,
    mutable: mutablePath(selected.path, indexPath),
    sourceVolatile:
      sqliteFamilyPath(selected.path, indexPath) || SOURCE_VOLATILE_CACHES.includes(selected.path),
    source: selected.source,
    destination: destinationAfter,
  };
}

// A source that moved between its first read and the post-copy recheck may have torn the copy, so
// the whole capture rolls back and is redone once the writer (an indexer, a build) goes quiet.
class CaptureDrift extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`gate projections changed during capture: ${path}`);
    this.path = path;
  }
}

const CAPTURE_ATTEMPTS = 5;
const CAPTURE_BACKOFF_MS = 150;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Copy absent gate inputs into a private worktree and authenticate their source state. */
export function materializeProjectionRuntime(
  sourceRoot: string,
  destinationRoot: string,
  manifestPath: string,
  candidates: string[],
  indexPath = '',
  hooks: ProjectionRuntimeHooks = {},
): ProjectionRuntimeManifest {
  const [source, destination] = validateRoots(sourceRoot, destinationRoot);
  const manifestDestination = validateManifestPath(manifestPath, source, destination);
  let drifted = '';
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
    pause(CAPTURE_BACKOFF_MS * attempt);
    try {
      return captureOnce(source, destination, manifestDestination, candidates, indexPath, hooks);
    } catch (cause) {
      drifted = driftedPath(cause);
    }
  }
  return fail(
    `gate projections changed during capture; retry — ${drifted} was still being written after ${CAPTURE_ATTEMPTS} attempts`,
  );
}

function driftedPath(cause: unknown): string {
  if (cause instanceof CaptureDrift) return cause.path;
  throw cause;
}

function captureOnce(
  source: string,
  destination: string,
  manifestDestination: string,
  candidates: string[],
  indexPath: string,
  hooks: ProjectionRuntimeHooks,
): ProjectionRuntimeManifest {
  const created: string[] = [];
  try {
    const selected = selectProjections(source, destination, candidates, indexPath);
    copySelectedProjections(source, destination, selected, created, hooks);
    hooks.beforeSourceVerification?.();
    const entries = selected.map((entry) =>
      verifySelectedProjection(source, destination, entry, indexPath),
    );
    const manifest = projectionManifest(source, destination, entries);
    writeFileSync(manifestDestination, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return manifest;
  } catch (cause) {
    for (const path of created.reverse()) rmSync(path, { recursive: true, force: true });
    throw cause;
  }
}

/** Verify copies and non-volatile sources after target hooks; volatile caches were frozen privately. */
export function verifyProjectionRuntime(
  sourceRoot: string,
  destinationRoot: string,
  manifestPath: string,
): ProjectionRuntimeManifest {
  const [source, destination] = validateRoots(sourceRoot, destinationRoot);
  const manifest = readManifest(manifestPath);
  if (manifest.sourceRoot !== source || manifest.destinationRoot !== destination) {
    fail('gate projection manifest belongs to different roots');
  }
  for (const entry of manifest.entries) {
    const live = entry.sourceVolatile ? entry.source : captureState(source, entry.path, true);
    if (!stateMatches(live, entry.source)) {
      fail(`target gate projection changed while review was running: ${entry.path}`);
    }
    const current = captureState(destination, entry.path, false);
    if (!entry.mutable && !stateMatches(current, entry.destination)) {
      fail(`private immutable gate projection changed while review was running: ${entry.path}`);
    }
  }
  return manifest;
}

export function mutableProjectionRoots(manifestPath: string): string[] {
  const paths = readManifest(manifestPath)
    .entries.filter((entry) => entry.mutable)
    .map((entry) => entry.path);
  return paths.filter(
    (path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)),
  );
}

function stdinCandidates(): string[] {
  const input = readFileSync(0);
  if (input.length === 0) return [];
  if (input[input.length - 1] !== 0) fail('gate projection candidate input is not NUL terminated');
  return input.subarray(0, -1).toString('utf8').split('\0').filter(Boolean);
}

function runCli(args: string[]): void {
  if (args[0] === 'materialize' && args.length === 5) {
    materializeProjectionRuntime(
      args[1] as string,
      args[2] as string,
      args[3] as string,
      stdinCandidates(),
      args[4],
    );
    return;
  }
  if (args[0] === 'verify' && args.length === 4) {
    verifyProjectionRuntime(args[1] as string, args[2] as string, args[3] as string);
    return;
  }
  if (args[0] === 'mutable' && args.length === 2) {
    for (const path of mutableProjectionRoots(args[1] as string)) process.stdout.write(`${path}\0`);
    return;
  }
  fail(
    'usage: projection-runtime materialize <source> <destination> <manifest> <index-path> | verify <source> <destination> <manifest> | mutable <manifest>',
  );
}

runDirectReviewCli(import.meta.url, runCli);
