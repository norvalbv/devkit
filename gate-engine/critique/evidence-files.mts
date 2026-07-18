import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { atomicWrite, withFileLock } from './immutable-file.mts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BLOB_PATH = /^blobs\/[0-9a-f]{64}\.[A-Za-z0-9_-]+$/;
const BLOB_EXTENSION = /^[A-Za-z0-9_-]+$/;

export function evidenceRoot(): string {
  return (
    process.env.DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR ??
    join(homedir(), '.devkit', 'evidence', 'plan-critiques', 'v1')
  );
}

/** Serialize reference-sensitive blob/record operations across local hook processes. */
export function withEvidenceLock<T>(operation: () => T): T {
  return withFileLock(join(`${evidenceRoot()}.locks`, 'operation'), operation);
}

export const sha256Text = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export const isPlanCritiqueId = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
export const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && SHA256.test(value);
export const isPlanCritiqueBlobPath = (value: unknown): value is string =>
  typeof value === 'string' && BLOB_PATH.test(value);

function safeEvidencePath(relativePath: string): string {
  const root = resolve(evidenceRoot());
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`)) throw new Error('evidence path escapes the evidence root');
  return path;
}

export function persistImmutableJson(relativePath: string, value: unknown): string {
  return withEvidenceLock(() => {
    const path = safeEvidencePath(relativePath);
    atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  });
}

export function writeContentBlob(content: string, extension = 'txt'): string {
  return withEvidenceLock(() => {
    if (!BLOB_EXTENSION.test(extension)) throw new Error('invalid evidence blob extension');
    const hash = sha256Text(content);
    const relativePath = `blobs/${hash}.${extension}`;
    const path = safeEvidencePath(relativePath);
    if (existsSync(path)) return relativePath;
    try {
      atomicWrite(path, content);
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
    return relativePath;
  });
}
