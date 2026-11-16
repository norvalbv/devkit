import { createHash } from 'node:crypto';
import { diffCacheIdentity, filePathOf, splitDiffByFile } from '../../judge/diff-focus.mts';

/** One packed slice of a large diff: whole files only, sorted path order preserved. */
export interface ChunkPlan {
  /** Each chunk is a list of staged paths; files never split across chunks. */
  chunks: string[][];
  /** Identity bytes per path (the cache/evidence unit), for cost estimates and telemetry. */
  bytesByPath: Map<string, number>;
}

/** Per-file normalized diff identity, keyed by filePathOf's post-image path (renames land
 * under the new name — the staged name callers pass in). Chunk boundaries inherit
 * diffCacheIdentity's normalization rules; a change there re-homes files, which the boundary test
 * pins. */
export function identityByPath(diffText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const seg of splitDiffByFile(diffText)) {
    const path = filePathOf(seg);
    if (!path) continue;
    out.set(path, (out.get(path) ?? '') + diffCacheIdentity(seg));
  }
  return out;
}

/** Per-file identity bytes of a unified diff — the same normalized unit the verdict cache keys on. */
export function identityBytesByPath(diffText: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [path, identity] of identityByPath(diffText))
    out.set(path, Buffer.byteLength(identity, 'utf8'));
  return out;
}

/**
 * Next-fit pack in sorted-path order (siblings stay together; a closed chunk is never revisited): each chunk holds whole files up to
 * `capBytes` of identity bytes; a single file over the cap gets its own chunk. Deterministic for a
 * given (files, diff) pair, so re-runs and checkpoints agree on chunk indexes.
 */
export function packDiffIntoChunks(files: string[], diffText: string, capBytes: number): ChunkPlan {
  const bytesByPath = identityBytesByPath(diffText);
  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const file of [...files].sort()) {
    const size = bytesByPath.get(file) ?? 0;
    if (current.length > 0 && used + size > capBytes) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(file);
    used += size;
  }
  if (current.length > 0) chunks.push(current);
  return { chunks, bytesByPath };
}

/** Plan-level facts the chunk-telemetry wire format carries (sc-1999): how a reviewer's diff was
 * packed. `planHash` is sha256-12 over the ordered per-chunk membership hashes, so any re-homing
 * of files across chunks — including a packing-algorithm change — reads as a different plan. */
export interface ChunkPlanFacts {
  count: number;
  capBytes: number;
  planHash: string;
}

/** One judge task's chunk assignment. `filesSha` is sha256-12 of the chunk's file membership
 * (paths joined on '\0', the same separator the bench's checkpoint keys use) — carried alongside
 * the index because a bare index is unstable identity across packing changes (the PR #439 review
 * rejected index-only keying for exactly that reason). Absent on every un-chunked task; production
 * chunking (sc-1907) is what starts assigning it. */
export interface ChunkAssignment extends ChunkPlanFacts {
  index: number;
  filesSha: string;
}

/** sha256-12 of a chunk's file membership (paths joined on '\0'): the identity half of every
 * chunk key and telemetry row — a bare index is unstable across packing changes (see
 * ChunkAssignment). */
export function chunkFilesSha(files: readonly string[]): string {
  return createHash('sha256').update(files.join('\0')).digest('hex').slice(0, 12);
}

/** sha256-12 over the ordered per-chunk membership hashes — the whole plan's identity: any
 * re-homing of files across chunks reads as a different plan. */
export function chunkPlanHash(chunks: readonly (readonly string[])[]): string {
  return createHash('sha256')
    .update(chunks.map((c) => chunkFilesSha(c)).join('\0'))
    .digest('hex')
    .slice(0, 12);
}

/** The sub-diff a chunk's judges receive: only the segments whose post-image path is in the
 * chunk. Resolution MUST be filePathOf — the same rule that packed the chunk — or a file would
 * pack into a chunk whose sub-diff then omits it, judging silence. */
export function chunkDiffText(diffText: string, files: readonly string[]): string {
  const wanted = new Set(files);
  return splitDiffByFile(diffText)
    .filter((seg) => wanted.has(filePathOf(seg) ?? ''))
    .join('');
}
