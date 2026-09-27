// The gate's staged list for a checklist script: inline (DEVKIT_REVIEW_STAGED_FILES), or by file
// (DEVKIT_REVIEW_STAGED_FILES_PATH) when too large for the env. Read by _devkit/review-roots.mjs.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasChecklist, type Reviewer } from '../reviewers.mts';

// Past this many BYTES the list rides a file: argv+env share one OS limit (ARG_MAX).
const INLINE_STAGED_LIST_MAX = 100_000;

/** Content-addressed, so concurrent reviewers share one file; tmp+rename, so no reader sees a
 * partial write. */
function persistStagedList(serialized: string): string {
  const digest = createHash('sha256').update(serialized).digest('hex').slice(0, 24);
  const file = path.join(tmpdir(), `devkit-staged-files-${digest}.json`);
  // Trust an existing file only when its bytes ARE this list; anything else is rewritten.
  if (existsSync(file) && readFileSync(file, 'utf8') === serialized) return file;
  const partial = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(partial, serialized);
    renameSync(partial, file);
    return file;
  } finally {
    rmSync(partial, { force: true });
  }
}

/** Checklist reviewers get the gate's own file list (sc-1439), never a script re-resolution
 * (sc-3400). Inherited channels are cleared first, so a nested run cannot read a stale list. */
export function withStagedFiles(
  env: NodeJS.ProcessEnv,
  reviewer: Reviewer,
  files: string[],
): NodeJS.ProcessEnv {
  if (!hasChecklist(reviewer)) return env;
  const {
    DEVKIT_REVIEW_STAGED_FILES: _inline,
    DEVKIT_REVIEW_STAGED_FILES_PATH: _file,
    ...rest
  } = env;
  const serialized = JSON.stringify(files);
  // BYTES, not UTF-16 units: the spawn limit is byte-counted, and non-ASCII paths are multi-byte.
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= INLINE_STAGED_LIST_MAX) return { ...rest, DEVKIT_REVIEW_STAGED_FILES: serialized };
  try {
    return { ...rest, DEVKIT_REVIEW_STAGED_FILES_PATH: persistStagedList(serialized) };
  } catch (cause) {
    // A script-side fallback would review a DIFFERENT file set — the bug sc-3400 fixed. Fail loud.
    throw new Error(
      `${reviewer.name} staged list (${bytes}B) could not be written to the temp dir: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
