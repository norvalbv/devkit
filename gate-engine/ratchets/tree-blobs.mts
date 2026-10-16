// Batched byte-exact blob reads from one git tree (sc-2759); git-index.mts holds the per-path readers.

import { execFileSync } from 'node:child_process';
import { commitIndexEnv } from './commit-index.mts';

// Fatal: a lossy decode maps distinct non-UTF-8 paths to one `\uFFFD` key, so one blob overwrites another.
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const MAX_BATCH_OUTPUT = 512 * 1024 * 1024;

/** One blob by object name. Argv carries any path byte, including the newline the batch protocol
 * cannot. Null when the name does not resolve to a blob. */
function catBlob(root: string, name: string): Buffer | null {
  try {
    return execFileSync('git', ['cat-file', 'blob', name], {
      cwd: root,
      env: commitIndexEnv(root),
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_BATCH_OUTPUT,
    });
  } catch {
    return null;
  }
}

/** Blobs for git object `names` (oids or `<rev>:<path>`), aligned to the input: missing or non-blob
 * names map to null, and the whole result is null when git cannot answer. */
export function catBlobs(root: string, names: readonly string[]): (Buffer | null)[] | null {
  const sent = names.filter((name) => !name.includes('\n'));
  let out = Buffer.alloc(0);
  if (sent.length) {
    try {
      out = execFileSync('git', ['cat-file', '--batch'], {
        cwd: root,
        env: commitIndexEnv(root),
        input: `${sent.join('\n')}\n`,
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: MAX_BATCH_OUTPUT,
      });
    } catch {
      return null;
    }
  }
  const read = new Map<string, Buffer | null>();
  let at = 0;
  for (const name of sent) {
    const eol = out.indexOf(0x0a, at);
    if (eol === -1) return null;
    const header = out.subarray(at, eol).toString('utf8');
    at = eol + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      read.set(name, null);
      continue;
    }
    const [, type, size] = header.split(' ');
    const end = at + Number(size);
    read.set(name, type === 'blob' ? Buffer.from(out.subarray(at, end)) : null);
    at = end + 1;
  }
  // A newline would split the batch line, so those rare names each take their own spawn.
  return names.map((name) =>
    name.includes('\n') ? catBlob(root, name) : (read.get(name) ?? null),
  );
}

/** Regular blobs under `pathspecs` in `tree`, byte-exact, in two spawns; symlinks → null, gitlinks
 * skipped. Null when git cannot answer or a path is not UTF-8, so the caller stands down. */
export function treeBlobsAtRef(
  root: string,
  tree: string,
  pathspecs: readonly string[],
): Map<string, Buffer | null> | null {
  try {
    const listing = execFileSync('git', ['ls-tree', '-r', '-z', tree, '--', ...pathspecs], {
      cwd: root,
      env: commitIndexEnv(root),
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const blobs = new Map<string, Buffer | null>();
    const oids: [string, string][] = [];
    for (let at = 0; at < listing.length;) {
      const end = listing.indexOf(0, at);
      const entry = listing.subarray(at, end === -1 ? listing.length : end);
      at = end === -1 ? listing.length : end + 1;
      const tab = entry.indexOf(0x09);
      const [mode, type, oid] = entry.subarray(0, tab).toString('ascii').split(' ');
      const path = UTF8.decode(entry.subarray(tab + 1));
      if (type !== 'blob') continue;
      if (mode === '120000') blobs.set(path, null);
      else oids.push([path, oid]);
    }
    if (!oids.length) return blobs;
    const read = catBlobs(
      root,
      oids.map(([, oid]) => oid),
    );
    if (!read || read.includes(null)) return null;
    oids.forEach(([path], index) => blobs.set(path, read[index]));
    return blobs;
  } catch {
    return null;
  }
}
