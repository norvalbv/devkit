/** Private, manifest-backed gate-input projections for an isolated review worktree. */

import { createHash } from 'node:crypto';
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
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runDirectReviewCli } from '../run-direct.mts';
import { reviewRuntimeFingerprint } from '../runtime-fingerprint.mts';
import {
  assertSymlinkFreeReviewTree,
  canonicalReviewDirectory,
  canonicalReviewLeaf,
  isSafeReviewRelativePath,
  reviewPathWithin,
  safeReviewDestination,
} from '../runtime-paths.mts';
import { resolveReviewSource } from '../source-projection.mts';

const VERSION = 1 as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SQLITE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;
// Ratchet/cache gates legitimately update their own ignored baseline/cache state during a run, so
// these roots are allowed to drift between the captured source and the private copy (verify checks
// only that they stay symlink-free); every other projected root is immutable and must match exactly.
const MUTABLE_ROOTS = ['.fallow', 'fallow-baselines', '.decisions', 'eslint/baselines'] as const;
const PRESENT_STATE_TYPES = ['file', 'directory', 'link-file', 'link-directory'] as const;
const LINK_STATE_FIELDS = ['linkTarget', 'linkPath', 'physicalPath'] as const;

type ProjectionState =
  | { type: 'absent' }
  | {
      type: 'file' | 'directory' | 'link-file' | 'link-directory';
      fingerprint: string;
      linkTarget?: string;
      linkPath?: string;
      physicalPath?: string;
    };

interface ProjectionEntry {
  path: string;
  mutable: boolean;
  source: ProjectionState;
  destination: ProjectionState;
}

interface SelectedProjection {
  path: string;
  source: ProjectionState;
}

export interface ProjectionRuntimeManifest {
  version: typeof VERSION;
  sourceRoot: string;
  destinationRoot: string;
  entries: ProjectionEntry[];
  selfHash: string;
}

export interface ProjectionRuntimeHooks {
  beforePrivateCopy?: (path: string) => void;
  beforeSourceVerification?: () => void;
}

function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

function manifestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeRelativePath(path: string): string {
  if (!isSafeReviewRelativePath(path) || path === '.git' || path.startsWith('.git/')) {
    return fail(`unsafe gate projection path: ${JSON.stringify(path)}`);
  }
  return path;
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
  if (indexPath && SQLITE_SUFFIXES.some((suffix) => path === `${indexPath}${suffix}`)) return true;
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
    if (path === indexPath) result.push(...SQLITE_SUFFIXES.map((suffix) => `${path}${suffix}`));
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

function sqliteFamilyPath(path: string, indexPath: string): boolean {
  return Boolean(indexPath && SQLITE_SUFFIXES.some((suffix) => path === `${indexPath}${suffix}`));
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
    const sourceBefore = captureState(source, path, true);
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
  const sourceAfter = captureState(source, selected.path, true);
  if (!stateMatches(selected.source, sourceAfter)) {
    fail('gate projections changed during capture; retry');
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
    source: selected.source,
    destination: destinationAfter,
  };
}

function projectionManifest(
  sourceRoot: string,
  destinationRoot: string,
  entries: ProjectionEntry[],
): ProjectionRuntimeManifest {
  const unsigned = {
    version: VERSION,
    sourceRoot,
    destinationRoot,
    entries,
  };
  return { ...unsigned, selfHash: manifestHash(unsigned) };
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

function recordValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message);
  return value as Record<string, unknown>;
}

function isPresentStateType(value: unknown): value is (typeof PRESENT_STATE_TYPES)[number] {
  return PRESENT_STATE_TYPES.some((type) => value === type);
}

function requiredLinkString(
  state: Record<string, unknown>,
  field: (typeof LINK_STATE_FIELDS)[number],
): string {
  const value = state[field];
  if (typeof value !== 'string') fail('invalid projection link state');
  return value;
}

function validateLinkedState(state: Record<string, unknown>): void {
  requiredLinkString(state, 'linkTarget');
  const linkPath = requiredLinkString(state, 'linkPath');
  if (!isSafeReviewRelativePath(linkPath)) fail('invalid projection link state');
  const physicalPath = requiredLinkString(state, 'physicalPath');
  if (!isAbsolute(physicalPath)) fail('invalid projection link state');
}

function validateUnlinkedState(state: Record<string, unknown>): void {
  for (const field of LINK_STATE_FIELDS) {
    if (state[field] !== undefined) fail('invalid projection link state');
  }
}

function validateLinkState(state: Record<string, unknown>, linked: boolean): void {
  if (linked) validateLinkedState(state);
  else validateUnlinkedState(state);
}

function parseState(value: unknown): ProjectionState {
  const state = recordValue(value, 'invalid projection state');
  if (state.type === 'absent') {
    if (Object.keys(state).length !== 1) fail('invalid projection state');
    return { type: 'absent' };
  }
  if (
    !isPresentStateType(state.type) ||
    typeof state.fingerprint !== 'string' ||
    !SHA256.test(state.fingerprint)
  ) {
    fail('invalid projection state');
  }
  validateLinkState(state, state.type.startsWith('link-'));
  return state as unknown as ProjectionState;
}

interface ParsedManifestHeader {
  sourceRoot: string;
  destinationRoot: string;
  entries: unknown[];
  selfHash: string;
}

function readManifestJson(path: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail('could not read gate projection manifest');
  }
  return value;
}

function parseManifestHeader(value: unknown): ParsedManifestHeader {
  const raw = recordValue(value, 'invalid projection manifest');
  if (
    raw.version !== VERSION ||
    typeof raw.sourceRoot !== 'string' ||
    typeof raw.destinationRoot !== 'string' ||
    !Array.isArray(raw.entries) ||
    typeof raw.selfHash !== 'string'
  ) {
    fail('invalid projection manifest');
  }
  return raw as unknown as ParsedManifestHeader;
}

function parseEntry(value: unknown): ProjectionEntry {
  const candidate = recordValue(value, 'invalid projection entry');
  if (typeof candidate.path !== 'string' || typeof candidate.mutable !== 'boolean') {
    fail('invalid projection entry');
  }
  return {
    path: safeRelativePath(candidate.path),
    mutable: candidate.mutable,
    source: parseState(candidate.source),
    destination: parseState(candidate.destination),
  };
}

function readManifest(path: string): ProjectionRuntimeManifest {
  const raw = parseManifestHeader(readManifestJson(path));
  const entries = raw.entries.map(parseEntry);
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    fail('duplicate projection manifest path');
  }
  const unsigned = {
    version: VERSION,
    sourceRoot: raw.sourceRoot,
    destinationRoot: raw.destinationRoot,
    entries,
  };
  if (manifestHash(unsigned) !== raw.selfHash)
    fail('gate projection manifest self-hash is invalid');
  return { ...unsigned, selfHash: raw.selfHash };
}

/** Verify immutable copies and every source after target-controlled hook code has executed. */
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
    if (!stateMatches(captureState(source, entry.path, true), entry.source)) {
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
