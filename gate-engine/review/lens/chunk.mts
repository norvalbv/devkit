import { diffCacheIdentity, filePathOf, splitDiffByFile } from '../../judge/diff-focus.mts';

/** One packed slice of a large diff: whole files only, sorted path order preserved. */
export interface ChunkPlan {
  /** Each chunk is a list of staged paths; files never split across chunks. */
  chunks: string[][];
  /** Identity bytes per path (the cache/evidence unit), for cost estimates and telemetry. */
  bytesByPath: Map<string, number>;
}

/** Per-file normalized diff identity, keyed by filePathOf's POST-image path (renames land under
 * the new name — the staged name callers pass in). Chunk boundaries inherit diffCacheIdentity's
 * normalization rules; a change there re-homes files, which the boundary test pins. */
export function identityByPath(diffText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const seg of splitDiffByFile(diffText)) {
    // A hunkless rename-only segment has no '+++' line, so filePathOf falls back to the
    // pre-image 'a/' path — prefer the explicit 'rename to' post-image name in that case.
    const path = seg.match(/^rename to (.+)$/m)?.[1] ?? filePathOf(seg);
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
