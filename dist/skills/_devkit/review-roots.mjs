import { readFileSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';

// `length > 0` is load-bearing, not belt-and-braces: `[].every(...)` is vacuously TRUE, so without it
// this predicate accepts `[]` — contradicting its own name. The correctness checklist then takes
// `sourceExtensions: []` as valid, `exts.some(...)` is false for every path, and the reviewer passes
// having examined ZERO files. A gate that silently verifies nothing is the one failure mode devkit
// refuses to ship; an empty list must fall through to the caller's default.
export const isNonEmptyStringArray = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry) => typeof entry === 'string' && entry.length > 0);

/** Normalize trusted repository-relative roots so selector and Git pathspec readers agree. */
export function normalizeReviewRoots(value, name) {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${name} must be a non-empty JSON array of repository-relative paths`);

  const normalized = value.map((root) => {
    if (typeof root !== 'string')
      throw new Error(`${name} must be a non-empty JSON array of repository-relative paths`);
    const trimmed = root.trim();
    if (!trimmed || trimmed.includes('\0') || isAbsolute(trimmed) || win32.isAbsolute(trimmed))
      throw new Error(`${name} must be a non-empty JSON array of repository-relative paths`);
    const segments = trimmed.replaceAll('\\', '/').split('/');
    if (segments.includes('..'))
      throw new Error(`${name} must be a non-empty JSON array of repository-relative paths`);
    const rootPath = segments.filter((segment) => segment && segment !== '.').join('/') || '.';
    if (rootPath.startsWith(':'))
      throw new Error(`${name} must be a non-empty JSON array of repository-relative paths`);
    return rootPath;
  });
  return [...new Set(normalized)];
}

/** Force user/config roots to be literal Git pathspecs; `.` remains the safe scan-all sentinel. */
export const toGitPathspecs = (roots) =>
  roots.map((root) => (root === '.' ? '.' : `:(top,literal)${root}`));

/** Parse the gate-injected effective topology before it reaches a Git pathspec. */
export function parseInjectedReviewRoots(name) {
  if (process.env.DEVKIT_RUN_MODE !== 'review') return null;
  const raw = process.env[name];
  if (raw === undefined) return null;

  let roots;
  try {
    roots = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON string array`);
  }

  return normalizeReviewRoots(roots, name);
}

function readGuardConfig() {
  try {
    const config = JSON.parse(readFileSync('guard.config.json', 'utf-8'));
    return config && typeof config === 'object' ? config : null;
  } catch {
    return null;
  }
}

/** Resolve one top-level root list, conservatively scanning all files when it is absent/invalid. */
export function resolveConfigRoots({ configKey, reviewerName }) {
  const roots = readGuardConfig()?.[configKey];
  if (roots === undefined || (Array.isArray(roots) && roots.length === 0)) return ['.'];
  try {
    return normalizeReviewRoots(roots, configKey);
  } catch {
    console.error(
      `⚠️  ${reviewerName}: ignoring invalid \`${configKey}\` in guard.config.json (expected an array of non-empty strings) — scanning all staged files instead.`,
    );
    return ['.'];
  }
}

/** Resolve one domain reviewer's injected roots, falling back to guard.config.json topology. */
export function resolveReviewRoots({ envName, configKey, reviewerName }) {
  const injected = parseInjectedReviewRoots(envName);
  if (injected) return injected;

  const review = readGuardConfig()?.review;
  const roots = review && typeof review === 'object' ? review[configKey] : undefined;
  if (roots === undefined) return ['.'];
  try {
    return normalizeReviewRoots(roots, `review.${configKey}`);
  } catch {
    console.error(
      `⚠️  ${reviewerName}: ignoring invalid \`review.${configKey}\` in guard.config.json (expected an array of non-empty strings) — scanning all staged files instead.`,
    );
    return ['.'];
  }
}
