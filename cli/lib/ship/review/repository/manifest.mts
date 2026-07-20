/** Authentication and fail-closed parsing for private repository-state manifests. */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import {
  hasExactManifestKeys,
  hasValidManifestRoots,
  isSafeManifestAbsolutePath,
} from '../manifest/validation.mts';

export const REVIEW_REPOSITORY_STATE_VERSION = 1 as const;
export const REVIEW_REPOSITORY_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_SIZE = 1024 * 1024;
const MANIFEST_KEYS = [
  'version',
  'targetRoot',
  'gitRoot',
  'gitCommonDir',
  'gitDir',
  'state',
  'selfHash',
] as const;
const STATE_KEYS = ['headOid', 'headSymrefBase64', 'refsSha256', 'configSha256'] as const;

export interface ReviewRepositoryState {
  headOid: string;
  headSymrefBase64: string | null;
  refsSha256: string;
  configSha256: string;
}

export interface ReviewRepositoryStateManifest {
  version: typeof REVIEW_REPOSITORY_STATE_VERSION;
  targetRoot: string;
  gitRoot: string;
  gitCommonDir: string;
  gitDir: string;
  state: ReviewRepositoryState;
  selfHash: string;
}

function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`repository state manifest ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.includes(0)) return false;
  return decoded.toString('base64') === value;
}

function validState(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ReviewRepositoryState {
  if (!hasExactManifestKeys(value, STATE_KEYS)) return false;
  if (typeof value.headOid !== 'string' || !REVIEW_REPOSITORY_OBJECT_ID.test(value.headOid)) {
    return false;
  }
  if (value.headSymrefBase64 !== null && !canonicalBase64(value.headSymrefBase64)) return false;
  if (typeof value.refsSha256 !== 'string' || !SHA256.test(value.refsSha256)) return false;
  return typeof value.configSha256 === 'string' && SHA256.test(value.configSha256);
}

function readManifestValue(path: string): unknown {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_SIZE) {
      fail('repository state manifest is not a bounded regular file.');
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('devkit review:')) throw cause;
    return fail(`could not read repository state manifest (${errorMessage(cause)}).`);
  }
}

export function reviewRepositoryManifestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Read, authenticate, and deeply validate a repository-state manifest. */
export function parseReviewRepositoryStateManifest(path: string): ReviewRepositoryStateManifest {
  const manifest = objectValue(readManifestValue(path), 'shape');
  const state = objectValue(manifest.state, 'state');
  if (!hasValidManifestRoots(manifest, MANIFEST_KEYS, REVIEW_REPOSITORY_STATE_VERSION)) {
    fail('repository state manifest has an invalid shape.');
  }
  if (!isSafeManifestAbsolutePath(manifest.gitCommonDir)) {
    fail('repository state manifest has an invalid shape.');
  }
  if (!isSafeManifestAbsolutePath(manifest.gitDir)) {
    fail('repository state manifest has an invalid shape.');
  }
  if (
    !validState(state) ||
    typeof manifest.selfHash !== 'string' ||
    !SHA256.test(manifest.selfHash)
  ) {
    fail('repository state manifest has an invalid shape.');
  }
  const unsigned = {
    version: REVIEW_REPOSITORY_STATE_VERSION,
    targetRoot: manifest.targetRoot,
    gitRoot: manifest.gitRoot,
    gitCommonDir: manifest.gitCommonDir,
    gitDir: manifest.gitDir,
    state: {
      headOid: state.headOid,
      headSymrefBase64: state.headSymrefBase64,
      refsSha256: state.refsSha256,
      configSha256: state.configSha256,
    },
  } as const;
  if (manifest.selfHash !== reviewRepositoryManifestHash(unsigned)) {
    fail('repository state manifest authentication failed.');
  }
  return { ...unsigned, selfHash: manifest.selfHash };
}
