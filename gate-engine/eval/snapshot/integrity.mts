import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node's 1 MiB default reports overflow as ENOBUFS with a NULL status, indistinguishable from a
// git that refused to run; the append-only history.jsonl crosses that line on its own.
export const GIT_MAX_BUFFER = 128 * 1024 * 1024;

// `-z` because git QUOTES non-ASCII paths in its default output (`"docs/\303\251.md"`), which could
// then never be read back.
export function splitNul(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

/** Content identity of a `ls-files --stage -z` listing. */
export function indexIdentity(listing: string): string {
  return `sha256:${createHash('sha256').update(listing).digest('hex')}`;
}

/** Git's object id for a blob: sha1 or sha256 (chosen by the id length) over `blob <len>\0<bytes>`. */
export function gitObjectId(bytes: Buffer, hexLength: number): string {
  return createHash(hexLength === 64 ? 'sha256' : 'sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

// sc-3215: bun's spawnSync returned git stdout cut at 32,768 bytes with exit 0. The listed blob id
// makes a short read provable, so it throws as a fault instead of reading as missing content.
export function assertBlobMatches(spec: string, bytes: Buffer, oid: string): void {
  if (gitObjectId(bytes, oid.length) === oid) return;
  throw new Error(
    `git show ${spec} returned ${bytes.length} bytes that do not hash to ${oid} — truncated subprocess output, not repository content`,
  );
}

let scratch: string | undefined;

// sc-3215: bun truncated git's PIPED stdout (32,768 bytes, exit 0) under load. A file has no reader
// to race: git writes it fully before exiting, and it is read afterwards.
export function spawnGit(cwd: string, args: string[]): SpawnSyncReturns<Buffer> {
  if (!scratch) {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-git-stdout-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    scratch = dir;
  }
  const file = join(scratch, 'stdout');
  const fd = openSync(file, 'w');
  try {
    const result = spawnSync('git', args, {
      cwd,
      stdio: ['ignore', fd, 'pipe'],
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { ...result, stdout: readFileSync(file) };
  } finally {
    closeSync(fd);
  }
}
