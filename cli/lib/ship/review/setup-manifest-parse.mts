/** Fail-closed parser for the private setup manifest consumed by the review runner. */

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { REVIEWABLE_GUARD_IDS, type ReviewProfile } from '../../components.mts';
import {
  hasExactManifestKeys as exactKeys,
  hasValidManifestRoots,
} from './manifest/validation.mts';
import { isSafeReviewRelativePath } from './runtime-paths.mts';
import type { ReviewSetupManifest, ReviewSetupPath, ReviewSetupState } from './setup-manifest.mts';
import {
  isReviewSetupHash,
  REVIEW_SETUP_ABSENT,
  REVIEW_SETUP_VERSION,
  reviewSetupHash,
} from './setup-manifest-format.mts';

function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function manifestString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    fail(`review setup manifest ${label} is invalid.`);
  return value;
}

function manifestRelativePath(value: unknown, label: string): string {
  const path = manifestString(value, label);
  if (!isSafeReviewRelativePath(path)) {
    fail(`review setup manifest ${label} is not a safe relative path.`);
  }
  return path;
}

function parseProfile(value: unknown): ReviewProfile {
  const profile = objectValue(value, 'review setup manifest profile');
  if (
    !exactKeys(profile, ['enabled', 'guards', 'decisionsDir']) ||
    typeof profile.enabled !== 'boolean' ||
    !Array.isArray(profile.guards)
  ) {
    return fail('review setup manifest profile has an invalid shape.');
  }
  const guards = profile.guards;
  if (
    !guards.every((guard) => typeof guard === 'string' && REVIEWABLE_GUARD_IDS.includes(guard)) ||
    new Set(guards).size !== guards.length
  ) {
    return fail('review setup manifest profile has invalid guards.');
  }
  return {
    enabled: profile.enabled,
    guards: guards as string[],
    decisionsDir: manifestRelativePath(profile.decisionsDir, 'profile decisionsDir'),
  };
}

function parseChain(value: unknown): ReviewSetupState['chain'] {
  if (value === null) return null;
  const chain = objectValue(value, 'review setup manifest chain');
  if (!exactKeys(chain, ['path', 'sourcePath']))
    return fail('review setup manifest chain has an invalid shape.');
  const path = manifestRelativePath(chain.path, 'chain path');
  const sourcePath = manifestRelativePath(chain.sourcePath, 'chain sourcePath');
  if (sourcePath === '.' || sourcePath !== posix.dirname(path))
    fail('review setup manifest chain has an unsafe source directory.');
  return { path, sourcePath };
}

function parsePath(value: unknown, index: number): ReviewSetupPath {
  const path = objectValue(value, `review setup manifest path ${index}`);
  if (
    !exactKeys(path, ['id', 'root', 'relativePath', 'fingerprint', 'required', 'executable']) ||
    (path.root !== 'target' && path.root !== 'git') ||
    typeof path.required !== 'boolean' ||
    typeof path.executable !== 'boolean'
  ) {
    return fail(`review setup manifest path ${index} has an invalid shape.`);
  }
  const fingerprint = manifestString(path.fingerprint, `path ${index} fingerprint`);
  if (fingerprint !== REVIEW_SETUP_ABSENT && !isReviewSetupHash(fingerprint))
    fail(`review setup manifest path ${index} has an invalid fingerprint.`);
  return {
    id: manifestString(path.id, `path ${index} id`),
    root: path.root,
    relativePath: manifestRelativePath(path.relativePath, `path ${index} relativePath`),
    fingerprint,
    required: path.required,
    executable: path.executable,
  };
}

function parseSetup(value: unknown): ReviewSetupState {
  const setup = objectValue(value, 'review setup manifest setup');
  if (
    !exactKeys(setup, ['overlay', 'hooksPath', 'profile', 'chain', 'paths']) ||
    typeof setup.overlay !== 'boolean' ||
    !Array.isArray(setup.paths)
  ) {
    return fail('review setup manifest has an invalid setup shape.');
  }
  const hooksPath = manifestRelativePath(setup.hooksPath, 'hooksPath');
  const expectedHooksPath = setup.overlay ? '.devkit/hooks' : '.husky/_';
  if (hooksPath !== expectedHooksPath) fail('review setup manifest has an inconsistent hooksPath.');
  const chain = parseChain(setup.chain);
  if (setup.overlay !== (chain !== null))
    fail('review setup manifest has an inconsistent overlay chain.');
  const paths = setup.paths.map(parsePath);
  if (
    new Set(paths.map((path) => path.id)).size !== paths.length ||
    new Set(paths.map((path) => `${path.root}\0${path.relativePath}`)).size !== paths.length
  ) {
    fail('review setup manifest has duplicate setup paths.');
  }
  return { overlay: setup.overlay, hooksPath, profile: parseProfile(setup.profile), chain, paths };
}

/** Read, authenticate, and deeply validate a setup manifest before any field is consumed. */
export function parseReviewSetupManifest(path: string): ReviewSetupManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return fail(`could not read review setup manifest (${message}).`);
  }
  const manifest = objectValue(value, 'review setup manifest');
  if (
    !hasValidManifestRoots(
      manifest,
      ['version', 'targetRoot', 'gitRoot', 'setup', 'selfHash'],
      REVIEW_SETUP_VERSION,
    ) ||
    !isReviewSetupHash(manifest.selfHash)
  ) {
    return fail('review setup manifest has an invalid shape.');
  }
  const unsigned = {
    version: REVIEW_SETUP_VERSION,
    targetRoot: manifest.targetRoot,
    gitRoot: manifest.gitRoot,
    setup: manifest.setup,
  } as const;
  if (manifest.selfHash !== reviewSetupHash(unsigned))
    fail('review setup manifest self-hash does not match.');
  return { ...unsigned, setup: parseSetup(manifest.setup), selfHash: manifest.selfHash };
}
