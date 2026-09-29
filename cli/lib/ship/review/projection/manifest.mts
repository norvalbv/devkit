/** The self-hashed manifest a review gate projection writes at capture and re-reads at verify. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isSafeReviewRelativePath } from '../runtime-paths.mts';
import { fail } from '../shared/common.mts';

const VERSION = 1 as const;
const SHA256 = /^[a-f0-9]{64}$/;
const PRESENT_STATE_TYPES = ['file', 'directory', 'link-file', 'link-directory'] as const;
const LINK_STATE_FIELDS = ['linkTarget', 'linkPath', 'physicalPath'] as const;

export type ProjectionState =
  | { type: 'absent' }
  | {
      type: 'file' | 'directory' | 'link-file' | 'link-directory';
      fingerprint: string;
      linkTarget?: string;
      linkPath?: string;
      physicalPath?: string;
    };

export interface ProjectionEntry {
  path: string;
  mutable: boolean;
  sourceVolatile: boolean;
  source: ProjectionState;
  destination: ProjectionState;
}

export interface ProjectionRuntimeManifest {
  version: typeof VERSION;
  sourceRoot: string;
  destinationRoot: string;
  entries: ProjectionEntry[];
  selfHash: string;
}

function manifestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function safeRelativePath(path: string): string {
  if (!isSafeReviewRelativePath(path) || path === '.git' || path.startsWith('.git/')) {
    return fail(`unsafe gate projection path: ${JSON.stringify(path)}`);
  }
  return path;
}

export function projectionManifest(
  sourceRoot: string,
  destinationRoot: string,
  entries: ProjectionEntry[],
): ProjectionRuntimeManifest {
  const unsigned = {
    version: VERSION,
    sourceRoot,
    destinationRoot,
    entries,
  };
  return { ...unsigned, selfHash: manifestHash(unsigned) };
}

function recordValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message);
  return value as Record<string, unknown>;
}

function isPresentStateType(value: unknown): value is (typeof PRESENT_STATE_TYPES)[number] {
  return PRESENT_STATE_TYPES.some((type) => value === type);
}

function requiredLinkString(
  state: Record<string, unknown>,
  field: (typeof LINK_STATE_FIELDS)[number],
): string {
  const value = state[field];
  if (typeof value !== 'string') fail('invalid projection link state');
  return value;
}

function validateLinkedState(state: Record<string, unknown>): void {
  requiredLinkString(state, 'linkTarget');
  const linkPath = requiredLinkString(state, 'linkPath');
  if (!isSafeReviewRelativePath(linkPath)) fail('invalid projection link state');
  const physicalPath = requiredLinkString(state, 'physicalPath');
  if (!isAbsolute(physicalPath)) fail('invalid projection link state');
}

function validateUnlinkedState(state: Record<string, unknown>): void {
  for (const field of LINK_STATE_FIELDS) {
    if (state[field] !== undefined) fail('invalid projection link state');
  }
}

function validateLinkState(state: Record<string, unknown>, linked: boolean): void {
  if (linked) validateLinkedState(state);
  else validateUnlinkedState(state);
}

function parseState(value: unknown): ProjectionState {
  const state = recordValue(value, 'invalid projection state');
  if (state.type === 'absent') {
    if (Object.keys(state).length !== 1) fail('invalid projection state');
    return { type: 'absent' };
  }
  if (
    !isPresentStateType(state.type) ||
    typeof state.fingerprint !== 'string' ||
    !SHA256.test(state.fingerprint)
  ) {
    fail('invalid projection state');
  }
  validateLinkState(state, state.type.startsWith('link-'));
  return state as unknown as ProjectionState;
}

interface ParsedManifestHeader {
  sourceRoot: string;
  destinationRoot: string;
  entries: unknown[];
  selfHash: string;
}

function readManifestJson(path: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail('could not read gate projection manifest');
  }
  return value;
}

function parseManifestHeader(value: unknown): ParsedManifestHeader {
  const raw = recordValue(value, 'invalid projection manifest');
  if (
    raw.version !== VERSION ||
    typeof raw.sourceRoot !== 'string' ||
    typeof raw.destinationRoot !== 'string' ||
    !Array.isArray(raw.entries) ||
    typeof raw.selfHash !== 'string'
  ) {
    fail('invalid projection manifest');
  }
  return raw as unknown as ParsedManifestHeader;
}

function parseEntry(value: unknown): ProjectionEntry {
  const candidate = recordValue(value, 'invalid projection entry');
  if (typeof candidate.path !== 'string' || typeof candidate.mutable !== 'boolean') {
    fail('invalid projection entry');
  }
  return {
    path: safeRelativePath(candidate.path),
    mutable: candidate.mutable,
    sourceVolatile: candidate.sourceVolatile === true,
    source: parseState(candidate.source),
    destination: parseState(candidate.destination),
  };
}

export function readManifest(path: string): ProjectionRuntimeManifest {
  const raw = parseManifestHeader(readManifestJson(path));
  const entries = raw.entries.map(parseEntry);
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    fail('duplicate projection manifest path');
  }
  const unsigned = {
    version: VERSION,
    sourceRoot: raw.sourceRoot,
    destinationRoot: raw.destinationRoot,
    entries,
  };
  if (manifestHash(unsigned) !== raw.selfHash)
    fail('gate projection manifest self-hash is invalid');
  return { ...unsigned, selfHash: raw.selfHash };
}
