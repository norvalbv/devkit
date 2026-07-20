/** Typed parsing of the installed devkit components and review profile. */

import { isAbsolute } from 'node:path';
import {
  DEFAULT_REVIEW_DECISIONS_DIR,
  GUARD_IDS,
  normalizeReviewProfile,
  normalizeSelection,
  REVIEWABLE_GUARD_IDS,
  type ReviewProfile,
  type Selection,
} from '../../components.mts';
import { reviewGuardIssues } from '../../install/review-profile.mts';
import { normalizeSafeReviewRelativePath } from './runtime-paths.mts';

export const REVIEW_SETUP_DOCTOR = "run 'devkit doctor --fix'.";

export interface RawReviewConfig {
  overlay?: unknown;
  standalone?: unknown;
  origHooksPath?: unknown;
  components?: unknown;
  review?: unknown;
}

export interface ParsedReviewSetupProfile {
  raw: RawReviewConfig;
  overlay: boolean;
  profile: ReviewProfile;
}

function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${label} must be a JSON object — ${REVIEW_SETUP_DOCTOR}`);
  }
  return value as Record<string, unknown>;
}

function booleanField(value: unknown, label: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean')
    fail(`${label} must be a boolean — ${REVIEW_SETUP_DOCTOR}`);
  return value as boolean | undefined;
}

function stringField(value: unknown, label: string): string | undefined {
  if (value !== undefined && typeof value !== 'string')
    fail(`${label} must be a string — ${REVIEW_SETUP_DOCTOR}`);
  if (typeof value === 'string' && value.includes('\0'))
    fail(`${label} contains a NUL byte — ${REVIEW_SETUP_DOCTOR}`);
  return value as string | undefined;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return fail(`${label} must be an array of strings — ${REVIEW_SETUP_DOCTOR}`);
  }
  if (value.some((entry) => entry.includes('\0')) || new Set(value).size !== value.length) {
    return fail(`${label} contains an invalid or duplicate value — ${REVIEW_SETUP_DOCTOR}`);
  }
  return value;
}

function parseConfigJson(raw: Buffer): RawReviewConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return fail(`could not parse .devkit/config.json (${message}) — ${REVIEW_SETUP_DOCTOR}`);
  }
  return objectValue(parsed, '.devkit/config.json') as RawReviewConfig;
}

function parseOverlayMode(config: RawReviewConfig): boolean {
  const overlay = booleanField(config.overlay, '.devkit/config.json overlay') === true;
  const standalone = booleanField(config.standalone, '.devkit/config.json standalone') === true;
  if (overlay && standalone)
    fail(`.devkit/config.json cannot enable overlay and standalone — ${REVIEW_SETUP_DOCTOR}`);
  const origHooksPath = stringField(config.origHooksPath, '.devkit/config.json origHooksPath');
  if (origHooksPath && isAbsolute(origHooksPath))
    fail(`.devkit/config.json origHooksPath must be repository-relative — ${REVIEW_SETUP_DOCTOR}`);
  return overlay;
}

function parseInstalledSelection(config: RawReviewConfig): Selection {
  const components =
    config.components === undefined
      ? {}
      : objectValue(config.components, '.devkit/config.json components');
  const recordedGuards =
    components.guards === undefined
      ? undefined
      : stringArray(components.guards, '.devkit/config.json components.guards');
  const recordedHusky = booleanField(components.husky, '.devkit/config.json components.husky');
  const unknownInstalled = (recordedGuards ?? []).filter((guard) => !GUARD_IDS.includes(guard));
  if (unknownInstalled.length)
    fail(
      `components.guards contains unknown guards: ${unknownInstalled.join(', ')} — ${REVIEW_SETUP_DOCTOR}`,
    );
  const selection = normalizeSelection({
    ...(components as Partial<Selection>),
    ...(recordedGuards === undefined ? {} : { guards: recordedGuards }),
    ...(recordedHusky === undefined ? {} : { husky: recordedHusky }),
  });
  if (!selection.husky)
    fail(`review requires the installed Husky component — ${REVIEW_SETUP_DOCTOR}`);
  return selection;
}

function parseRequestedGuards(settings: Record<string, unknown>, installed: string[]): string[] {
  const requested =
    settings.guards === undefined
      ? installed.filter((guard) => REVIEWABLE_GUARD_IDS.includes(guard))
      : stringArray(settings.guards, '.devkit/config.json review.guards');
  const { invalid } = reviewGuardIssues(requested, installed);
  if (invalid.length)
    fail(
      `review.guards contains unknown or uninstalled guards: ${invalid.join(', ')} — run 'devkit init --review'.`,
    );
  return requested;
}

function parseReviewProfile(config: RawReviewConfig, installed: string[]): ReviewProfile {
  const settings =
    config.review === undefined ? {} : objectValue(config.review, '.devkit/config.json review');
  const enabled = booleanField(settings.enabled, '.devkit/config.json review.enabled') ?? true;
  if (!enabled) fail("disabled by .devkit/config.json — run 'devkit init --review'.");
  const requested = parseRequestedGuards(settings, installed);
  const decisionsDir = stringField(
    settings.decisionsDir,
    '.devkit/config.json review.decisionsDir',
  );
  if (decisionsDir !== undefined && !decisionsDir.trim()) {
    fail(`.devkit/config.json review.decisionsDir must not be empty — ${REVIEW_SETUP_DOCTOR}`);
  }
  const normalizedDecisionsDir =
    decisionsDir === undefined
      ? DEFAULT_REVIEW_DECISIONS_DIR
      : normalizeSafeReviewRelativePath(decisionsDir);
  if (normalizedDecisionsDir === null)
    fail(
      `.devkit/config.json review.decisionsDir must be repository-relative — ${REVIEW_SETUP_DOCTOR}`,
    );
  return normalizeReviewProfile(
    { enabled, guards: requested, decisionsDir: normalizedDecisionsDir },
    installed,
    { enabledDefault: true },
  );
}

export function parseReviewSetupProfile(raw: Buffer): ParsedReviewSetupProfile {
  const config = parseConfigJson(raw);
  const installed = parseInstalledSelection(config).guards;
  return {
    raw: config,
    overlay: parseOverlayMode(config),
    profile: parseReviewProfile(config, installed),
  };
}
