import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';

interface BoundedFileReadOptions {
  label: string;
  maxBytes: number;
  limitLabel: string;
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Read one optional bounded regular file without following or racing its leaf path. */
export function readBoundedRegularFile(
  path: string,
  options: BoundedFileReadOptions,
): Buffer | null {
  const { label, maxBytes, limitLabel } = options;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    if (before.size > BigInt(maxBytes)) throw new Error(`${label} exceeds the ${limitLabel} limit`);

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }

    const after = fstatSync(descriptor, { bigint: true });
    let leaf: BigIntStats;
    try {
      leaf = lstatSync(path, { bigint: true });
    } catch {
      throw new Error(`${label} changed while it was read`);
    }
    if (
      !after.isFile() ||
      !leaf.isFile() ||
      !sameFile(before, after) ||
      after.dev !== leaf.dev ||
      after.ino !== leaf.ino ||
      BigInt(length) !== after.size
    )
      throw new Error(`${label} changed while it was read`);
    if (length > maxBytes) throw new Error(`${label} exceeds the ${limitLabel} limit`);
    return buffer.subarray(0, length);
  } catch (error) {
    if (descriptor === undefined && codeOf(error) === 'ENOENT') return null;
    if (codeOf(error) === 'ELOOP') throw new Error(`${label} cannot be a symlink`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
