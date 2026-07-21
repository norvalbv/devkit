import { constants as bufferConstants } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const failure = (message: string): Error => new Error(`immutable evidence: ${message}`);
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const SEPARATOR = /[/\\]/;
const PENDING_DIRECTORY = '.pending';
type DirectoryIdentity = { device: bigint; inode: bigint; realPath: string };

function assertDirectoryStat(directory: string, stat: BigIntStats): void {
  if (stat.isSymbolicLink()) throw failure(`symlink is not allowed: ${directory}`);
  if (!stat.isDirectory()) throw failure(`managed path is not a directory: ${directory}`);
}

function assertSameInode(
  directory: string,
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): void {
  if (left.dev !== right.dev || left.ino !== right.ino)
    throw failure(`managed directory changed during operation: ${directory}`);
}

function inspectDirectory(directory: string): DirectoryIdentity {
  const before = lstatSync(directory, { bigint: true });
  assertDirectoryStat(directory, before);
  const realPath = realpathSync(directory);
  const after = lstatSync(directory, { bigint: true });
  assertDirectoryStat(directory, after);
  assertSameInode(directory, before, after);
  const resolved = lstatSync(realPath, { bigint: true });
  assertDirectoryStat(realPath, resolved);
  assertSameInode(directory, after, resolved);
  return { device: after.dev, inode: after.ino, realPath };
}

function assertSameDirectory(directory: string, expected: DirectoryIdentity): DirectoryIdentity {
  const actual = inspectDirectory(directory);
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.realPath !== expected.realPath
  )
    throw failure(`managed directory changed during operation: ${directory}`);
  return actual;
}

function assertDirectoryPermissions(
  directory: string,
  identity: DirectoryIdentity,
  requirePrivate: boolean,
): void {
  const stat = lstatSync(directory, { bigint: true });
  if (stat.dev !== identity.device || stat.ino !== identity.inode)
    throw failure(`managed directory changed during operation: ${directory}`);
  if ((stat.mode & 0o022n) !== 0n)
    throw failure(`managed directory is writable by another user: ${directory}`);
  if (requirePrivate && (stat.mode & 0o777n) !== 0o700n)
    throw failure(`managed directory is not private: ${directory}`);
}

function assertConfined(anchor: string, candidate: string): void {
  const relative = path.relative(anchor, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw failure(`managed path escaped anchor: ${candidate}`);
}

function childPath(parent: string, segment: string, create: boolean): string {
  if (!segment || segment === '.' || segment === '..' || SEPARATOR.test(segment))
    throw failure(`unsafe managed segment: ${segment}`);
  const child = path.join(parent, segment);
  if (!create) return child;
  try {
    mkdirSync(child, { mode: 0o700 });
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
  }
  return child;
}

function inspectChild(
  child: string,
  confinedRoot: string,
  requirePrivate: boolean,
  create: boolean,
): DirectoryIdentity | null {
  try {
    const identity = inspectDirectory(child);
    assertConfined(confinedRoot, identity.realPath);
    assertDirectoryPermissions(child, identity, requirePrivate);
    return identity;
  } catch (error) {
    if (!create && codeOf(error) === 'ENOENT') return null;
    throw error;
  }
}

function resolveManagedPath(
  anchor: string,
  segments: readonly string[],
  create: boolean,
  privateLeaf: boolean,
): string | null {
  const anchorIdentity = inspectDirectory(anchor);
  assertDirectoryPermissions(anchor, anchorIdentity, false);
  const confinedRoot = anchorIdentity.realPath;
  let current = confinedRoot;
  let currentIdentity = inspectDirectory(current);
  if (
    currentIdentity.device !== anchorIdentity.device ||
    currentIdentity.inode !== anchorIdentity.inode
  )
    throw failure(`managed directory changed during operation: ${anchor}`);
  for (const [index, segment] of segments.entries()) {
    assertSameDirectory(current, currentIdentity);
    const child = childPath(current, segment, create);
    const childIdentity = inspectChild(
      child,
      confinedRoot,
      privateLeaf && index === segments.length - 1,
      create,
    );
    if (!childIdentity) return null;
    assertSameDirectory(current, currentIdentity);
    current = childIdentity.realPath;
    currentIdentity = assertSameDirectory(current, childIdentity);
  }
  assertConfined(confinedRoot, currentIdentity.realPath);
  assertSameDirectory(current, currentIdentity);
  return current;
}

/**
 * Resolve/create private children below a trusted existing directory without following symlinks.
 *
 * Node does not expose openat/linkat. Pre/post inode and realpath checks therefore fail closed when
 * replacement is observed, while non-writable ancestry prevents other-user races. A malicious
 * process running as the same uid can still race an individual path syscall between those checks.
 */
export function managedPath(
  anchor: string,
  segments: readonly string[],
  create: boolean,
): string | null {
  return resolveManagedPath(anchor, segments, create, true);
}

/** Resolve/create non-writable ancestry whose final directory need not have private-leaf mode. */
export function managedParentPath(
  anchor: string,
  segments: readonly string[],
  create: boolean,
): string | null {
  return resolveManagedPath(anchor, segments, create, false);
}

function filePath(directory: string, name: string): { directory: DirectoryIdentity; file: string } {
  if (!name || name === '.' || name === '..' || path.basename(name) !== name)
    throw failure(`unsafe file name: ${name}`);
  const identity = inspectDirectory(directory);
  return { directory: identity, file: path.join(identity.realPath, name) };
}

/** Read a regular file with O_NOFOLLOW; null is reserved for absence. */
export function readPrivateFile(directory: string, name: string): Buffer | null {
  const managed = filePath(directory, name);
  const { file } = managed;
  let descriptor: number | undefined;
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw failure(`symlink is not allowed: ${file}`);
    if (!stat.isFile()) throw failure(`managed entry is not a file: ${file}`);
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) throw failure(`managed entry is not a file: ${file}`);
    const value = readFileSync(descriptor);
    assertSameDirectory(directory, managed.directory);
    return value;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      assertSameDirectory(directory, managed.directory);
      return null;
    }
    if (codeOf(error) === 'ELOOP') throw failure(`symlink is not allowed: ${file}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertSameFile(file: string, left: BigIntStats, right: BigIntStats): void {
  if (left.dev !== right.dev || left.ino !== right.ino)
    throw failure(`managed file changed during operation: ${file}`);
  if (
    left.size !== right.size ||
    left.mode !== right.mode ||
    left.ctimeNs !== right.ctimeNs ||
    left.mtimeNs !== right.mtimeNs
  )
    throw failure(`managed file changed during operation: ${file}`);
}

function assertPrivateFile(file: string, stat: BigIntStats): void {
  if (!stat.isFile()) throw failure(`managed entry is not a file: ${file}`);
  if ((stat.mode & 0o777n) !== 0o600n) throw failure(`managed file is not private: ${file}`);
}

function readBounded(
  descriptor: number,
  file: string,
  expectedBytes: bigint,
  maxBytes: number,
): Buffer {
  const expected = Number(expectedBytes);
  const buffer = Buffer.allocUnsafe(expected + 1);
  let total = 0;
  while (total < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, total, buffer.length - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) throw failure(`managed file exceeds ${maxBytes} bytes: ${file}`);
  if (total !== expected) throw failure(`managed file changed during operation: ${file}`);
  return Buffer.from(buffer.subarray(0, total));
}

/** Read a stable private regular file without consuming more than maxBytes plus one sentinel byte. */
export function readPrivateFileBounded(
  directory: string,
  name: string,
  maxBytes: number,
): Buffer | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= bufferConstants.MAX_LENGTH)
    throw failure(`invalid maximum read size: ${maxBytes}`);

  const managed = filePath(directory, name);
  const { file } = managed;
  let descriptor: number | undefined;
  let observedPath = false;
  try {
    const pathBefore = lstatSync(file, { bigint: true });
    observedPath = true;
    if (pathBefore.isSymbolicLink()) throw failure(`symlink is not allowed: ${file}`);
    if (!pathBefore.isFile()) throw failure(`managed entry is not a file: ${file}`);

    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    assertPrivateFile(file, descriptorBefore);
    assertSameFile(file, pathBefore, descriptorBefore);
    if (descriptorBefore.size > BigInt(maxBytes))
      throw failure(`managed file exceeds ${maxBytes} bytes: ${file}`);

    const value = readBounded(descriptor, file, descriptorBefore.size, maxBytes);
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    assertPrivateFile(file, descriptorAfter);
    assertSameFile(file, descriptorBefore, descriptorAfter);

    const pathAfter = lstatSync(file, { bigint: true });
    assertPrivateFile(file, pathAfter);
    assertSameFile(file, descriptorAfter, pathAfter);
    assertSameDirectory(directory, managed.directory);
    return value;
  } catch (error) {
    if (codeOf(error) === 'ENOENT' && !observedPath && descriptor === undefined) {
      assertSameDirectory(directory, managed.directory);
      return null;
    }
    if (codeOf(error) === 'ELOOP') throw failure(`symlink is not allowed: ${file}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Publish via a same-directory hard link. Identical bytes are idempotent; all others fail. */
export function publishImmutable(
  directory: string,
  name: string,
  content: Uint8Array,
): 'created' | 'existing' {
  const managed = filePath(directory, name);
  const destination = managed.file;
  const existing = readPrivateFile(directory, name);
  if (existing) {
    if (!existing.equals(content)) throw failure(`immutable conflict: ${name}`);
    assertSameDirectory(directory, managed.directory);
    if ((lstatSync(destination).mode & 0o777) !== 0o600)
      throw failure(`managed file is not private: ${name}`);
    assertSameDirectory(directory, managed.directory);
    return 'existing';
  }
  assertSameDirectory(directory, managed.directory);
  const pendingDirectory = managedPath(directory, [PENDING_DIRECTORY], true) as string;
  const pendingIdentity = inspectDirectory(pendingDirectory);
  const temporary = path.join(
    pendingIdentity.realPath,
    `.${name}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content);
    const temporaryStat = fstatSync(descriptor, { bigint: true });
    assertPrivateFile(temporary, temporaryStat);
    closeSync(descriptor);
    descriptor = undefined;
    assertSameDirectory(directory, managed.directory);
    assertSameDirectory(pendingDirectory, pendingIdentity);
    try {
      linkSync(temporary, destination);
      assertSameDirectory(directory, managed.directory);
      assertSameDirectory(pendingDirectory, pendingIdentity);
      return 'created';
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
      const raced = readPrivateFile(directory, name);
      if (raced?.equals(content)) {
        if ((lstatSync(destination).mode & 0o777) !== 0o600)
          throw failure(`managed file is not private: ${name}`);
        return 'existing';
      }
      throw failure(`immutable conflict: ${name}`);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      assertSameDirectory(directory, managed.directory);
      assertSameDirectory(pendingDirectory, pendingIdentity);
      unlinkSync(temporary);
    } catch {
      // The temporary may not have been created, or another cleanup may have removed it.
    }
  }
}

export function listPrivateFiles(directory: string): string[] {
  const identity = inspectDirectory(directory);
  const names = readdirSync(identity.realPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  assertSameDirectory(directory, identity);
  return names;
}
