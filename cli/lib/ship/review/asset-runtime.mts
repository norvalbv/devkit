/** Coherent, private materialization of the packaged reviewer assets used by review mode. */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PACKAGED_REVIEW_ASSET_PATHS } from '../../../../gate-engine/review/runtime.mts';
import { runDirectReviewCli } from './run-direct.mts';
import {
  readPinnedReviewFile,
  reviewRuntimeFileFingerprint,
  reviewRuntimeFingerprint,
} from './runtime-fingerprint.mts';
import {
  canonicalReviewDirectory,
  canonicalReviewLeaf,
  isSafeReviewRelativePath,
  reviewPathWithin,
} from './runtime-paths.mts';

const SAFE_RUNTIME_PATH = /^[A-Za-z0-9_./-]+$/;

interface CapturedAsset {
  content: Buffer;
  mode: number;
  fingerprint: string;
}

export interface ReviewAssetRuntime {
  root: string;
  fingerprint: string;
  paths: readonly string[];
}

export interface ReviewAssetRuntimeHooks {
  beforeSourceVerification?: () => void;
}

function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

function validateAssetPath(path: string): void {
  if (!isSafeReviewRelativePath(path)) {
    fail(`unsafe packaged reviewer asset path: ${JSON.stringify(path)}`);
  }
}

function validateAssetPaths(): void {
  const collisions = new Set<string>();
  let previous = '';
  for (const path of PACKAGED_REVIEW_ASSET_PATHS) {
    validateAssetPath(path);
    if (previous && previous >= path)
      fail('packaged reviewer asset registry must be sorted and unique');
    previous = path;
    const collisionKey = path.toLowerCase();
    if (collisions.has(collisionKey))
      fail(`colliding packaged reviewer asset path: ${JSON.stringify(path)}`);
    collisions.add(collisionKey);
  }
}

function captureFile(path: string, label: string): CapturedAsset {
  try {
    const { content, mode } = readPinnedReviewFile(path);
    return { content, mode, fingerprint: reviewRuntimeFileFingerprint(content, mode) };
  } catch {
    return fail(`${label} is missing, unreadable, or not a regular file: ${path}`);
  }
}

function sourceAsset(packageRoot: string, assetPath: string): string {
  const requested = resolve(packageRoot, ...assetPath.split('/'));
  if (!reviewPathWithin(packageRoot, requested))
    return fail(`reviewer asset escapes package root: ${assetPath}`);
  let physical: string;
  try {
    physical = realpathSync(requested);
  } catch {
    return fail(`packaged reviewer asset is missing: ${assetPath}`);
  }
  if (!reviewPathWithin(packageRoot, physical))
    return fail(`reviewer asset escapes package root: ${assetPath}`);
  return physical;
}

function runtimeRoot(sourceRoot: string, destinationRoot: string): string {
  if (!isAbsolute(destinationRoot)) return fail('reviewer asset runtime path must be absolute');
  const requested = resolve(destinationRoot);
  if (!SAFE_RUNTIME_PATH.test(requested))
    return fail('reviewer asset runtime path is unsafe for the judge tool grammar');
  if (lstatSync(requested, { throwIfNoEntry: false }) !== undefined)
    return fail(`reviewer asset runtime already exists: ${requested}`);
  const runtime = canonicalReviewLeaf(requested, 'reviewer asset runtime parent');
  if (!SAFE_RUNTIME_PATH.test(runtime))
    return fail('physical reviewer asset runtime path is unsafe for the judge tool grammar');
  if (reviewPathWithin(sourceRoot, runtime) || reviewPathWithin(runtime, sourceRoot))
    return fail('reviewer package and asset runtime must be separate, non-nested directories');
  mkdirSync(runtime, { mode: 0o700 });
  return runtime;
}

function writeCapturedAsset(root: string, assetPath: string, asset: CapturedAsset): void {
  const destination = join(root, ...assetPath.split('/'));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, asset.content, { flag: 'wx', mode: 0o600 });
  chmodSync(destination, (asset.mode & 0o111) === 0 ? 0o600 : 0o700);
}

function runtimeFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`reviewer asset runtime contains a symlink: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(relative(root, path).split(sep).join('/'));
      else fail(`reviewer asset runtime contains an unsupported entry: ${path}`);
    }
  };
  visit(root);
  return files;
}

/** Copy the exact registered reviewer assets and return the private tree's integrity fingerprint. */
export function materializeReviewAssetRuntime(
  packageRoot: string,
  destinationRoot: string,
  hooks: ReviewAssetRuntimeHooks = {},
): ReviewAssetRuntime {
  validateAssetPaths();
  const sourceRoot = canonicalReviewDirectory(packageRoot, 'reviewer package root');
  const before = new Map<string, CapturedAsset>();
  for (const assetPath of PACKAGED_REVIEW_ASSET_PATHS) {
    before.set(
      assetPath,
      captureFile(sourceAsset(sourceRoot, assetPath), 'packaged reviewer asset'),
    );
  }

  let runtime: string | undefined;
  try {
    runtime = runtimeRoot(sourceRoot, destinationRoot);
    for (const assetPath of PACKAGED_REVIEW_ASSET_PATHS) {
      writeCapturedAsset(runtime, assetPath, before.get(assetPath) as CapturedAsset);
    }
    hooks.beforeSourceVerification?.();
    for (const assetPath of PACKAGED_REVIEW_ASSET_PATHS) {
      const expected = (before.get(assetPath) as CapturedAsset).fingerprint;
      const source = captureFile(sourceAsset(sourceRoot, assetPath), 'packaged reviewer asset');
      const copied = captureFile(join(runtime, ...assetPath.split('/')), 'copied reviewer asset');
      if (source.fingerprint !== expected || copied.fingerprint !== expected)
        fail('packaged reviewer assets changed during private runtime capture; retry');
    }
    if (JSON.stringify(runtimeFiles(runtime)) !== JSON.stringify(PACKAGED_REVIEW_ASSET_PATHS))
      fail('private reviewer asset runtime does not match the registered asset set');
    return {
      root: runtime,
      fingerprint: reviewRuntimeFingerprint(runtime),
      paths: PACKAGED_REVIEW_ASSET_PATHS,
    };
  } catch (cause) {
    if (runtime) rmSync(runtime, { recursive: true, force: true });
    throw cause;
  }
}

function runCli(args: string[]): void {
  if (args.length !== 2) fail('usage: asset-runtime <package-root> <destination-root>');
  const result = materializeReviewAssetRuntime(args[0] as string, args[1] as string);
  process.stdout.write(result.fingerprint);
}

runDirectReviewCli(import.meta.url, runCli);
