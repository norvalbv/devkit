import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { firstDuplicateJsonKey } from '../../../../gate-engine/critique/json-duplicate-keys.mts';
import type { AgentAssetKind } from '../agent-providers.mts';
import { type DecodedSyncManifest, decodeSyncManifest } from './codec.mts';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

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

function readBoundedRegularFile(path: string): Buffer | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error('agent asset manifest is not a regular file');
    if (before.size > BigInt(MAX_MANIFEST_BYTES))
      throw new Error('agent asset manifest exceeds the 1 MiB limit');

    const buffer = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
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
      throw new Error('agent asset manifest changed while it was read');
    }
    if (
      !after.isFile() ||
      !leaf.isFile() ||
      !sameFile(before, after) ||
      after.dev !== leaf.dev ||
      after.ino !== leaf.ino ||
      BigInt(length) !== after.size
    )
      throw new Error('agent asset manifest changed while it was read');
    if (length > MAX_MANIFEST_BYTES)
      throw new Error('agent asset manifest exceeds the 1 MiB limit');
    return buffer.subarray(0, length);
  } catch (error) {
    if (descriptor === undefined && codeOf(error) === 'ENOENT') return null;
    if (codeOf(error) === 'ELOOP') throw new Error('agent asset manifest cannot be a symlink');
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Strictly read one optional agent-asset manifest without following its leaf path. */
export function readAgentAssetManifest(
  path: string,
  kind: AgentAssetKind,
): DecodedSyncManifest | null {
  const bytes = readBoundedRegularFile(path);
  if (bytes === null) return null;

  let raw: string;
  try {
    raw = UTF8.decode(bytes);
  } catch {
    throw new Error('agent asset manifest is not valid UTF-8');
  }
  const duplicate = firstDuplicateJsonKey(raw);
  if (duplicate !== null)
    throw new Error(`agent asset manifest has duplicate object field ${JSON.stringify(duplicate)}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('agent asset manifest is not valid JSON');
  }
  return decodeSyncManifest(parsed, kind);
}
