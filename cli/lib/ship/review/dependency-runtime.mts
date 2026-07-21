/** Isolated, topology-preserving node_modules materialization for trusted review worktrees. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mts';
import { runDirectReviewCli } from './run-direct.mts';
import {
  canonicalReviewDirectory,
  canonicalReviewLeaf,
  reviewPathWithin,
} from './runtime-paths.mts';

const MANIFEST_VERSION = 2;
const NODE_MODULES = 'node_modules';

export type DependencyRuntimeMode = 'strict' | 'baseline';

type RuntimeEntry =
  | { path: string; type: 'directory' }
  | { path: string; type: 'file'; hash: string; executable: boolean }
  | { path: string; type: 'symlink'; target: string };

export interface DependencyRuntimeManifest {
  version: typeof MANIFEST_VERSION;
  sourceRoot: string;
  destinationRoot: string;
  surfaces: string[];
  entries: RuntimeEntry[];
  sourceFingerprint: string;
  fingerprint: string;
  destinationFingerprint: string;
}

export interface DependencyRuntimeHooks {
  afterSourceCapture?: () => void;
  beforeSourceVerification?: () => void;
}

interface Topology {
  surfaces: string[];
  entries: RuntimeEntry[];
  fingerprint: string;
}

function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

function validateRoots(sourceRoot: string, destinationRoot: string): [string, string] {
  const source = canonicalReviewDirectory(sourceRoot, 'dependency source root');
  const destination = canonicalReviewDirectory(destinationRoot, 'dependency destination root');
  if (reviewPathWithin(source, destination) || reviewPathWithin(destination, source)) {
    return fail('dependency source and destination roots must be separate, non-nested directories');
  }
  return [source, destination];
}

function validateManifestPath(path: string, sourceRoot: string, destinationRoot: string): string {
  const manifest = canonicalReviewLeaf(path, 'dependency manifest parent');
  if (reviewPathWithin(sourceRoot, manifest) || reviewPathWithin(destinationRoot, manifest)) {
    return fail('dependency manifest must live outside the source and destination roots');
  }
  return manifest;
}

function repoPath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return fail(`dependency link escapes the repository: ${absolutePath}`);
  }
  return rel === '' ? '.' : rel.split(sep).join('/');
}

function absoluteRepoPath(root: string, path: string): string {
  if (path === '.') return root;
  if (!path || isAbsolute(path) || path.split('/').includes('..')) {
    return fail(`unsafe dependency manifest path: ${JSON.stringify(path)}`);
  }
  const absolute = resolve(root, ...path.split('/'));
  if (!reviewPathWithin(root, absolute)) return fail(`dependency path escapes its root: ${path}`);
  return absolute;
}

function safeDestinationPath(root: string, path: string): string {
  const absolute = absoluteRepoPath(root, path);
  const parts = path === '.' ? [] : path.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return fail(`dependency runtime parent is missing: ${path}`);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return fail(`dependency runtime has an unsafe parent: ${path}`);
    }
  }
  return absolute;
}

function destinationDirectoryChainExists(root: string, parts: string[], path: string): boolean {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return fail(`dependency runtime has an unsafe parent: ${path}`);
    }
  }
  return true;
}

function destinationEntryExists(root: string, path: string): boolean {
  absoluteRepoPath(root, path);
  const parts = path === '.' ? [] : path.split('/');
  if (!destinationDirectoryChainExists(root, parts.slice(0, -1), path)) return false;
  if (parts.length === 0) return true;
  return lstatSync(join(root, ...parts), { throwIfNoEntry: false }) !== undefined;
}

function isGitPath(path: string): boolean {
  return path === '.git' || path.startsWith('.git/');
}

function mapLinkTarget(root: string, linkPath: string, rawTarget: string): string {
  const lexical = isAbsolute(rawTarget)
    ? resolve(rawTarget)
    : resolve(dirname(linkPath), rawTarget);
  let mapped: string;
  try {
    mapped = resolve(realpathSync(dirname(lexical)), basename(lexical));
  } catch {
    return fail(`dangling dependency link: ${repoPath(root, linkPath)}`);
  }
  const target = repoPath(root, mapped);
  if (isGitPath(target)) return fail(`dependency link targets .git: ${repoPath(root, linkPath)}`);
  if (lstatSync(mapped, { throwIfNoEntry: false }) === undefined) {
    return fail(`dangling dependency link: ${repoPath(root, linkPath)}`);
  }
  return target;
}

function validateLinkGraph(root: string, linkPath: string, seen = new Set<string>()): string {
  const linkRel = repoPath(root, linkPath);
  if (seen.has(linkRel)) return linkRel;
  seen.add(linkRel);
  const target = mapLinkTarget(root, linkPath, readlinkSync(linkPath));
  const targetPath = absoluteRepoPath(root, target);
  if (lstatSync(targetPath).isSymbolicLink()) validateLinkGraph(root, targetPath, seen);
  return target;
}

/** Find every repository node_modules surface without entering one, .git, or a symlink. */
export function discoverDependencySurfaces(sourceRoot: string): string[] {
  const root = canonicalReviewDirectory(sourceRoot, 'dependency source root');
  const surfaces: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === '.git') continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (name === NODE_MODULES) {
        surfaces.push(repoPath(root, path));
      } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
        visit(path);
      }
    }
  };
  visit(root);
  return surfaces.sort();
}

function fileEntry(root: string, path: string): RuntimeEntry {
  const stat = lstatSync(path);
  return {
    path: repoPath(root, path),
    type: 'file',
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    executable: (stat.mode & 0o111) !== 0,
  };
}

function captureEntry(root: string, path: string, entries: RuntimeEntry[]): void {
  const stat = lstatSync(path);
  const relativePath = repoPath(root, path);
  if (isGitPath(relativePath)) return;
  if (stat.isSymbolicLink()) {
    entries.push({ path: relativePath, type: 'symlink', target: validateLinkGraph(root, path) });
    return;
  }
  if (stat.isFile()) {
    entries.push(fileEntry(root, path));
    return;
  }
  if (!stat.isDirectory()) fail(`unsupported dependency entry type: ${relativePath}`);
  entries.push({ path: relativePath, type: 'directory' });
  for (const name of readdirSync(path).sort()) {
    if (name !== '.git') captureEntry(root, join(path, name), entries);
  }
}

function topologyFingerprint(surfaces: string[], entries: RuntimeEntry[]): string {
  return createHash('sha256').update(JSON.stringify({ surfaces, entries })).digest('hex');
}

function captureSource(root: string): Topology {
  const surfaces = discoverDependencySurfaces(root);
  const entries: RuntimeEntry[] = [];
  for (const surface of surfaces) captureEntry(root, absoluteRepoPath(root, surface), entries);
  entries.sort((left, right) => (left.path === right.path ? 0 : left.path < right.path ? -1 : 1));
  return { surfaces, entries, fingerprint: topologyFingerprint(surfaces, entries) };
}

function entryWithinSurface(path: string, surface: string): boolean {
  return path === surface || path.startsWith(`${surface}/`);
}

function baselineTopology(source: Topology, destinationRoot: string): Topology {
  const surfaces = source.surfaces.filter((surface) =>
    destinationDirectoryChainExists(destinationRoot, surface.split('/').slice(0, -1), surface),
  );
  let entries = source.entries.filter((entry) =>
    surfaces.some((surface) => entryWithinSurface(entry.path, surface)),
  );

  // A root dependency surface can link to a workspace whose repository parent is absent at the
  // merge-base. Do not recreate that source-only workspace (or a dangling link to it) in the
  // baseline. Link cycles wholly inside the selected dependency topology remain valid.
  while (true) {
    const selectedPaths = new Set(entries.map((entry) => entry.path));
    const filtered = entries.filter(
      (entry) =>
        entry.type !== 'symlink' ||
        selectedPaths.has(entry.target) ||
        destinationEntryExists(destinationRoot, entry.target),
    );
    if (filtered.length === entries.length) break;
    entries = filtered;
  }

  return { surfaces, entries, fingerprint: topologyFingerprint(surfaces, entries) };
}

function projectedEntry(root: string, expected: RuntimeEntry): RuntimeEntry {
  const path = safeDestinationPath(root, expected.path);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return fail(`dependency runtime entry disappeared: ${expected.path}`);
  if (expected.type === 'directory' && stat.isDirectory() && !stat.isSymbolicLink())
    return expected;
  if (expected.type === 'file' && stat.isFile()) return fileEntry(root, path);
  if (expected.type === 'symlink' && stat.isSymbolicLink()) {
    return { path: expected.path, type: 'symlink', target: validateLinkGraph(root, path) };
  }
  return fail(`dependency runtime conflicts with snapshot entry: ${expected.path}`);
}

function sameEntry(left: RuntimeEntry, right: RuntimeEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function destinationLinkTarget(root: string, linkPath: string, target: string): string {
  return relative(dirname(linkPath), safeDestinationPath(root, target)) || '.';
}

function mergeMaterializedEntry(
  sourceRoot: string,
  destinationRoot: string,
  entry: Exclude<RuntimeEntry, { type: 'symlink' }>,
  created: string[],
): void {
  const source = absoluteRepoPath(sourceRoot, entry.path);
  const destination = safeDestinationPath(destinationRoot, entry.path);
  if (lstatSync(destination, { throwIfNoEntry: false }) !== undefined) {
    if (!sameEntry(projectedEntry(destinationRoot, entry), entry)) {
      fail(`dependency runtime differs from snapshot entry: ${entry.path}`);
    }
    return;
  }
  if (entry.type === 'directory') mkdirSync(destination);
  else {
    copyFileSync(source, destination, constants.COPYFILE_FICLONE);
    const mode = lstatSync(destination).mode;
    chmodSync(destination, entry.executable ? mode | 0o111 : mode & ~0o111);
  }
  created.push(destination);
}

function createMissingLink(
  destinationRoot: string,
  entry: Extract<RuntimeEntry, { type: 'symlink' }>,
  created: string[],
): void {
  const destination = safeDestinationPath(destinationRoot, entry.path);
  if (lstatSync(destination, { throwIfNoEntry: false }) !== undefined) return;
  symlinkSync(destinationLinkTarget(destinationRoot, destination, entry.target), destination);
  created.push(destination);
}

function assertProjectedEntry(destinationRoot: string, entry: RuntimeEntry): void {
  if (!sameEntry(projectedEntry(destinationRoot, entry), entry)) {
    fail(`dependency runtime differs from snapshot entry: ${entry.path}`);
  }
}

function mergeTopology(
  sourceRoot: string,
  destinationRoot: string,
  topology: Topology,
  created: string[],
): void {
  const materialized = topology.entries.filter(
    (entry): entry is Exclude<RuntimeEntry, { type: 'symlink' }> => entry.type !== 'symlink',
  );
  const links = topology.entries.filter(
    (entry): entry is Extract<RuntimeEntry, { type: 'symlink' }> => entry.type === 'symlink',
  );
  for (const entry of materialized) {
    mergeMaterializedEntry(sourceRoot, destinationRoot, entry, created);
  }
  // Create every missing link before comparing any existing link, so cyclic workspace graphs and
  // a pre-existing half of such a graph are never mistaken for dangling input.
  for (const entry of links) createMissingLink(destinationRoot, entry, created);
  for (const entry of links) assertProjectedEntry(destinationRoot, entry);
}

function captureDestination(root: string, expected: Topology): Topology {
  const entries = expected.entries.map((entry) => projectedEntry(root, entry));
  return {
    surfaces: expected.surfaces,
    entries,
    fingerprint: topologyFingerprint(expected.surfaces, entries),
  };
}

function rollback(root: string, paths: string[]): void {
  for (const path of paths.reverse()) {
    const rel = repoPath(root, path);
    try {
      rmSync(safeDestinationPath(root, rel), { recursive: true, force: true });
    } catch {
      // A concurrent ancestor replacement must never redirect cleanup outside the private root.
    }
  }
}

/** Materialize all dependency surfaces and atomically record the captured source topology. */
export function materializeDependencyRuntime(
  sourceRoot: string,
  destinationRoot: string,
  manifestPath: string,
  hooks: DependencyRuntimeHooks = {},
  mode: DependencyRuntimeMode = 'strict',
): DependencyRuntimeManifest {
  const [source, destination] = validateRoots(sourceRoot, destinationRoot);
  const manifestDestination = validateManifestPath(manifestPath, source, destination);
  const sourceBefore = captureSource(source);
  hooks.afterSourceCapture?.();
  const created: string[] = [];
  try {
    const before = mode === 'baseline' ? baselineTopology(sourceBefore, destination) : sourceBefore;
    mergeTopology(source, destination, before, created);
    hooks.beforeSourceVerification?.();
    const after = captureSource(source);
    if (after.fingerprint !== sourceBefore.fingerprint)
      fail('dependencies changed during capture; retry');
    const destinationTopology = captureDestination(destination, before);
    if (destinationTopology.fingerprint !== before.fingerprint) {
      fail('private dependency runtime does not match its captured source');
    }
    const manifest: DependencyRuntimeManifest = {
      version: MANIFEST_VERSION,
      sourceRoot: source,
      destinationRoot: destination,
      surfaces: before.surfaces,
      entries: before.entries,
      sourceFingerprint: sourceBefore.fingerprint,
      fingerprint: before.fingerprint,
      destinationFingerprint: destinationTopology.fingerprint,
    };
    writeFileAtomic(manifestDestination, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (cause) {
    rollback(destination, created);
    throw cause;
  }
}

function readManifest(path: string): DependencyRuntimeManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') return fail('dependency runtime manifest is invalid');
  const manifest = parsed as DependencyRuntimeManifest;
  const validShape = [
    manifest.version === MANIFEST_VERSION,
    typeof manifest.sourceRoot === 'string',
    typeof manifest.destinationRoot === 'string',
    Array.isArray(manifest.surfaces),
    Array.isArray(manifest.entries),
    typeof manifest.sourceFingerprint === 'string',
    typeof manifest.fingerprint === 'string',
    typeof manifest.destinationFingerprint === 'string',
  ].every(Boolean);
  if (!validShape) {
    return fail('dependency runtime manifest is invalid');
  }
  if (
    topologyFingerprint(manifest.surfaces, manifest.entries) !== manifest.fingerprint ||
    manifest.destinationFingerprint !== manifest.fingerprint
  ) {
    return fail('dependency runtime manifest fingerprint is invalid');
  }
  return manifest;
}

/** Stable source-topology salt for review caches; validates the complete private manifest first. */
export function dependencyRuntimeSourceFingerprint(manifestPath: string): string {
  return readManifest(manifestPath).sourceFingerprint;
}

/** Verify after hooks that the target checkout's dependency topology stayed frozen. */
export function verifyDependencyRuntime(
  sourceRoot: string,
  manifestPath: string,
): DependencyRuntimeManifest {
  const source = canonicalReviewDirectory(sourceRoot, 'dependency source root');
  const manifest = readManifest(manifestPath);
  if (source !== manifest.sourceRoot)
    return fail('dependency runtime manifest belongs to another root');
  if (captureSource(source).fingerprint !== manifest.sourceFingerprint) {
    return fail('target dependencies changed while review was running; retry');
  }
  const [, destination] = validateRoots(source, manifest.destinationRoot);
  if (destination !== manifest.destinationRoot) {
    return fail('private dependency runtime root changed while review was running; retry');
  }
  const expected: Topology = {
    surfaces: manifest.surfaces,
    entries: manifest.entries,
    fingerprint: manifest.destinationFingerprint,
  };
  if (captureDestination(destination, expected).fingerprint !== manifest.destinationFingerprint) {
    return fail('private dependency runtime changed while review was running; retry');
  }
  return manifest;
}

function usage(): never {
  return fail(
    'usage: dependency-runtime materialize <source-root> <destination-root> <manifest-path> [baseline] | verify <source-root> <manifest-path> | fingerprint <manifest-path>',
  );
}

function runCli(args: string[]): void {
  if (
    args[0] === 'materialize' &&
    (args.length === 4 || (args.length === 5 && args[4] === 'baseline'))
  ) {
    materializeDependencyRuntime(
      args[1] as string,
      args[2] as string,
      args[3] as string,
      {},
      args[4] === 'baseline' ? 'baseline' : 'strict',
    );
  } else if (args[0] === 'verify' && args.length === 3) {
    verifyDependencyRuntime(args[1] as string, args[2] as string);
  } else if (args[0] === 'fingerprint' && args.length === 2) {
    process.stdout.write(dependencyRuntimeSourceFingerprint(args[1] as string));
  } else usage();
}

runDirectReviewCli(import.meta.url, runCli);
