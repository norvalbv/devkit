import { readFileSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';

const PATH_SEPARATOR_RE = /[\\/]/u;

export const isNonEmptyStringArray = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);

/** Parse the gate-injected effective topology before it reaches a Git pathspec. */
export function parseInjectedReviewRoots(name) {
  const raw = process.env[name];
  if (raw === undefined) return null;

  let roots;
  try {
    roots = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON string array`);
  }

  const normalized = Array.isArray(roots)
    ? roots.map((root) => (typeof root === 'string' ? root.trim() : root))
    : roots;
  if (
    !isNonEmptyStringArray(normalized) ||
    normalized.length === 0 ||
    normalized.some(
      (root) =>
        isAbsolute(root) || win32.isAbsolute(root) || root.split(PATH_SEPARATOR_RE).includes('..'),
    )
  )
    throw new Error(`${name} must be a non-empty JSON array of repository-relative paths`);
  return normalized;
}

/** Resolve one domain reviewer's injected roots, falling back to guard.config.json topology. */
export function resolveReviewRoots({ envName, configKey, reviewerName }) {
  const injected = parseInjectedReviewRoots(envName);
  if (injected) return injected;

  let config;
  try {
    config = JSON.parse(readFileSync('guard.config.json', 'utf-8'));
  } catch {
    return ['.'];
  }

  const review = config && typeof config === 'object' ? config.review : undefined;
  const roots = review && typeof review === 'object' ? review[configKey] : undefined;
  if (roots === undefined) return ['.'];
  if (!isNonEmptyStringArray(roots)) {
    console.error(
      `⚠️  ${reviewerName}: ignoring invalid \`review.${configKey}\` in guard.config.json (expected an array of non-empty strings) — scanning all staged files instead.`,
    );
    return ['.'];
  }
  return roots;
}
