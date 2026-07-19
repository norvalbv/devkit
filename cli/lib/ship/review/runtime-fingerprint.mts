/** Stable content + executable-mode fingerprints for paths frozen into a review runtime. */
import { createHash, type Hash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runDirectReviewCli } from './run-direct.mts';

const ABSENT_FINGERPRINT = 'absent';

function updateField(hash: Hash, value: string | Uint8Array): void {
  const size = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
  hash.update(`${size}:`);
  hash.update(value);
}

function executableMode(mode: number): string {
  return (mode & 0o111) === 0 ? 'regular' : 'executable';
}

function updateFile(hash: Hash, relativePath: string, content: Uint8Array, mode: number): void {
  updateField(hash, 'file');
  updateField(hash, relativePath);
  updateField(hash, executableMode(mode));
  updateField(hash, content);
}

/** Read bytes and executable mode from one open descriptor, immune to pathname replacement. */
export function readPinnedReviewFile(path: string): { content: Buffer; mode: number } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`unsupported review runtime path type: ${path}`);
    return { content: readFileSync(descriptor), mode: stat.mode };
  } finally {
    closeSync(descriptor);
  }
}

function visitDirectory(
  absolutePath: string,
  relativePath: string,
  hash: Hash,
  ancestors: ReadonlySet<string>,
): void {
  const realPath = realpathSync(absolutePath);
  if (ancestors.has(realPath)) throw new Error(`cyclic review runtime path: ${absolutePath}`);

  updateField(hash, 'directory');
  updateField(hash, relativePath);
  const descendants = new Set(ancestors).add(realPath);
  for (const entry of readdirSync(absolutePath).sort()) {
    const childRelativePath = relativePath === '.' ? entry : `${relativePath}/${entry}`;
    visitPath(join(absolutePath, entry), childRelativePath, hash, descendants);
  }
}

function visitPath(
  absolutePath: string,
  relativePath: string,
  hash: Hash,
  ancestors: ReadonlySet<string>,
): void {
  const stat = statSync(absolutePath);
  if (stat.isFile()) {
    const file = readPinnedReviewFile(absolutePath);
    updateFile(hash, relativePath, file.content, file.mode);
    return;
  }
  if (stat.isDirectory()) {
    visitDirectory(absolutePath, relativePath, hash, ancestors);
    return;
  }
  throw new Error(`unsupported review runtime path type: ${absolutePath}`);
}

/** Fingerprint already-read file bytes with the executable mode used by the runtime. */
export function reviewRuntimeFileFingerprint(content: Uint8Array, mode: number): string {
  const hash = createHash('sha256');
  updateFile(hash, '.', content, mode);
  return hash.digest('hex');
}

/** Fingerprint a file or directory, dereferencing symlinks and sorting directory entries. */
export function reviewRuntimeFingerprint(path: string): string {
  const hash = createHash('sha256');
  visitPath(path, '.', hash, new Set());
  return hash.digest('hex');
}

function runtimeFingerprintState(path: string): string {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  return entry === undefined ? ABSENT_FINGERPRINT : reviewRuntimeFingerprint(path);
}

function verifyPairs(pairs: string[]): void {
  if (pairs.length === 0 || pairs.length % 2 !== 0) {
    throw new Error('usage: runtime-fingerprint --verify <expected> <path> [...]');
  }
  for (let index = 0; index < pairs.length; index += 2) {
    const expected = pairs[index] as string;
    const target = pairs[index + 1] as string;
    if (runtimeFingerprintState(target) !== expected) {
      console.error(target);
      process.exitCode = 1;
    }
  }
}

/** Copy one descriptor-pinned regular file into a new private runtime path. */
export function pinReviewRuntimeFile(source: string, destination: string): string {
  const pinned = readPinnedReviewFile(source);
  const mode = (pinned.mode & 0o111) === 0 ? 0o600 : 0o700;
  writeFileSync(destination, pinned.content, { flag: 'wx', mode });
  return reviewRuntimeFileFingerprint(pinned.content, pinned.mode);
}

function runCli(args: string[]): void {
  if (args[0] === '--pin') {
    if (args.length !== 3)
      throw new Error('usage: runtime-fingerprint --pin <source> <destination>');
    process.stdout.write(pinReviewRuntimeFile(args[1] as string, args[2] as string));
    return;
  }
  if (args[0] === '--verify') {
    verifyPairs(args.slice(1));
    return;
  }
  const target = args[0];
  if (!target || args.length !== 1) throw new Error('usage: runtime-fingerprint <path>');
  process.stdout.write(reviewRuntimeFingerprint(target));
}

runDirectReviewCli(import.meta.url, runCli);
