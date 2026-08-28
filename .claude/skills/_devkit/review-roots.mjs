import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, matchesGlob, win32 } from 'node:path';

const MAX_CORRECTNESS_PATTERNS = 128;
const MAX_CORRECTNESS_PATTERN_LENGTH = 512;
const CORRECTNESS_PATH_KEYS = new Set(['include', 'exclude']);
const RE_GLOB_META = /[*?[\]{}()]/;
const RE_WILDCARD_SEGMENT = /^\*{1,2}$/;
const RE_TEST_INFIX = /\.(test|spec)\./;
const RE_INVALID_REPOSITORY_FILE = /(?:^\/|\/$|\/\/|\\|\0|(?:^|\/)\.{1,2}(?:\/|$))/;
// These formats do not yield reviewable source text. Unknown and extensionless files deliberately
// remain eligible when a consumer explicitly includes their path: this is an opaque-format denylist,
// not sourceExtensions under a different name.
const RE_OPAQUE_BINARY =
  /\.(?:7z|a|avi|avif|bin|bmp|class|db|dll|dmg|docx|eot|exe|flac|gif|gz|ico|jar|jpeg|jpg|lockb|mov|mp3|mp4|o|ogg|otf|pdf|png|pyc|sqlite3?|tar|tiff?|ttf|wasm|webm|webp|woff2?|xlsx|xz|zip)$/i;

// `length > 0` is load-bearing, not belt-and-braces: `[].every(...)` is vacuously TRUE, so without it
// this predicate accepts `[]` — contradicting its own name. The correctness checklist then takes
// `sourceExtensions: []` as valid, `exts.some(...)` is false for every path, and the reviewer passes
// having examined ZERO files. A gate that silently verifies nothing is the one failure mode devkit
// refuses to ship; an empty list must fall through to the caller's default.
export const isNonEmptyStringArray = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry) => typeof entry === 'string' && entry.length > 0);

/**
 * The gate's authoritative staged file list for THIS reviewer (sc-1439). The gate selects
 * reviewers from its own topology; each checklist previously re-resolved files independently
 * (env/config roots + --diff-filter=ACM), and ANY divergence stranded generate() with zero files
 * and no artifact — "checklist artifact missing" without the judge ever misbehaving. When this
 * env is present the checklist treats it as the candidate universe and still applies its own
 * filters (prose/tests/extensions). Staged deletions are dropped here (no worktree bytes to
 * review — the ACM mirror). Returns null when unset/invalid: standalone runs resolve as before.
 */
export function stagedFilesOverride() {
  const raw = process.env.DEVKIT_REVIEW_STAGED_FILES;
  if (raw === undefined) return null;
  try {
    const files = JSON.parse(raw);
    if (!isNonEmptyStringArray(files)) return null;
    return files.filter((f) => existsSync(f));
  } catch {
    return null;
  }
}

/** A Git-reported repository-relative path. Keep odd but legal names; Git receives them literally. */
export function normalizeRepositoryFile(file, name = 'staged file') {
  if (file.length === 0) throw new Error(`${name} must be a non-empty repository-relative path`);
  if ([win32.isAbsolute(file), RE_INVALID_REPOSITORY_FILE.test(file)].includes(true))
    throw new Error(`${name} must be a POSIX repository-relative path`);
  return file;
}

/**
 * Correctness is the one checklist whose selected paths are semantic evidence. When the gate injects
 * them, accept that exact list — including deletions, whose bytes still exist in the staged diff —
 * and fail loudly on a malformed override instead of silently resolving a different universe.
 */
export function authoritativeStagedFilesOverride() {
  const raw = process.env.DEVKIT_REVIEW_STAGED_FILES;
  if (raw === undefined) return null;
  let files;
  try {
    files = JSON.parse(raw);
  } catch {
    throw new Error('DEVKIT_REVIEW_STAGED_FILES must be a non-empty JSON string array');
  }
  if (!isNonEmptyStringArray(files))
    throw new Error('DEVKIT_REVIEW_STAGED_FILES must be a non-empty JSON string array');
  return [...new Set(files.map((file) => normalizeRepositoryFile(file)))];
}

function validateCorrectnessGlob(pattern, name) {
  try {
    matchesGlob('devkit-glob-validation-probe', pattern);
  } catch {
    throw new Error(`${name} contains an invalid glob`);
  }
}

function rejectMissingIncludes(length, name, allowEmpty) {
  if (!allowEmpty && length === 0) throw new Error(`${name} must be a non-empty JSON string array`);
}

function assertStringPatterns(value, name) {
  if (value.length === 0) return;
  if (!isNonEmptyStringArray(value)) throw new Error(`${name} must be a JSON string array`);
}

function normalizeCorrectnessPattern(entry, name) {
  const pattern = entry.trim().replace(/^(?:\.\/)+/, '');
  const unsafeChecks = [
    !pattern,
    pattern.length > MAX_CORRECTNESS_PATTERN_LENGTH,
    pattern.includes('\0'),
    pattern.includes('\\'),
    isAbsolute(pattern),
    win32.isAbsolute(pattern),
    pattern.startsWith('!'),
    pattern.startsWith(':'),
    pattern.endsWith('/'),
    pattern.split('/').includes('..'),
  ];
  if (unsafeChecks.includes(true))
    throw new Error(`${name} contains an unsafe or invalid repository-relative glob`);
  validateCorrectnessGlob(pattern, name);
  return pattern;
}

function normalizeCorrectnessPatterns(value, name, { allowEmpty }) {
  if (!Array.isArray(value)) throw new Error(`${name} must be a JSON string array`);
  rejectMissingIncludes(value.length, name, allowEmpty);
  assertStringPatterns(value, name);
  if (value.length > MAX_CORRECTNESS_PATTERNS)
    throw new Error(`${name} must contain at most ${MAX_CORRECTNESS_PATTERNS} patterns`);
  const normalized = value.map((entry) => normalizeCorrectnessPattern(entry, name));
  return [...new Set(normalized)].sort();
}

const optionalPatterns = (value) => value ?? [];

function broadSubtreePrefix(pattern) {
  const segments = pattern.split('/');
  const firstGlob = segments.findIndex((segment) => RE_GLOB_META.test(segment));
  if (firstGlob < 0) return null;
  const tail = segments.slice(firstGlob);
  if (!tail.includes('**') || !tail.every((segment) => RE_WILDCARD_SEGMENT.test(segment)))
    return null;
  return segments.slice(0, firstGlob).join('/');
}

function excludeCoversInclude(include, exclude) {
  if (include === exclude) return true;
  const prefix = broadSubtreePrefix(exclude);
  if (prefix === null) return false;
  return [prefix === '', include === prefix, include.startsWith(`${prefix}/`)].includes(true);
}

function rejectFullyExcludedScope(include, exclude, name) {
  const allCovered = include.every((included) =>
    exclude.some((excluded) => excludeCoversInclude(included, excluded)),
  );
  if (allCovered)
    throw new Error(
      `${name}.exclude must not disable the entire correctness reviewer; leave at least one include scope reviewable`,
    );
}

/** Strict, canonical config boundary for review.correctnessPaths. */
export function normalizeCorrectnessPaths(value, name = 'review.correctnessPaths') {
  if (value === undefined) return undefined;
  if (Object.prototype.toString.call(value) !== '[object Object]')
    throw new Error(`${name} must be an object with include and exclude arrays`);
  const keys = Object.keys(value);
  if (!keys.every((key) => CORRECTNESS_PATH_KEYS.has(key)))
    throw new Error(`${name} only accepts include and exclude`);
  const include = Object.freeze(
    normalizeCorrectnessPatterns(value.include, `${name}.include`, { allowEmpty: false }),
  );
  const exclude = Object.freeze(
    normalizeCorrectnessPatterns(optionalPatterns(value.exclude), `${name}.exclude`, {
      allowEmpty: true,
    }),
  );
  rejectFullyExcludedScope(include, exclude, name);
  return Object.freeze({ include, exclude });
}

const underReviewRoot = (file, root) =>
  root === '.' || file === root || file.startsWith(`${root.replace(/\/$/, '')}/`);

/**
 * The single correctness file selector used by the gate and standalone checklist. Configured paths
 * are repo-wide and authoritative; the absent-block branch intentionally preserves legacy roots +
 * sourceExtensions behavior for existing consumers.
 */
export function selectCorrectnessFiles(files, { correctnessPaths, roots, sourceExtensions }) {
  if (correctnessPaths !== undefined) {
    const scope = normalizeCorrectnessPaths(correctnessPaths);
    return files.filter((file) => {
      normalizeRepositoryFile(file);
      if (RE_OPAQUE_BINARY.test(file)) return false;
      return (
        scope.include.some((pattern) => matchesGlob(file, pattern)) &&
        !scope.exclude.some((pattern) => matchesGlob(file, pattern))
      );
    });
  }

  const normalizedRoots = normalizeReviewRoots(roots, 'correctness legacy roots');
  const extensions = isNonEmptyStringArray(sourceExtensions) ? sourceExtensions : ['ts', 'tsx'];
  const suffixes = extensions.map((extension) =>
    extension.startsWith('.') ? extension : `.${extension}`,
  );
  return files.filter((file) => {
    normalizeRepositoryFile(file);
    const name = file.split('/').pop() ?? '';
    return (
      normalizedRoots.some((root) => underReviewRoot(file, root)) &&
      suffixes.some((suffix) => name.endsWith(suffix)) &&
      !RE_TEST_INFIX.test(name)
    );
  });
}

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

/**
 * Every checklist selects its files with `--diff-filter=ACM`, which drops deletions. So a staged set
 * that is ENTIRELY deletions renders as "nothing to review" and the reviewer waves the commit
 * through — the exact blind spot that let a clobbered ship index (a foreign tree staged as a
 * ~5,976-file deletion of the whole repo) reach the review gate reporting "no items".
 *
 * Call this on the empty-ACM path, BEFORE reporting zero items. It re-asks git WITHOUT the filter:
 * if the index does hold staged paths after all, they are deletions the checklist cannot see, and
 * that must be loud rather than silent. This is the same rule the correctness checklist already
 * applies to a git FAILURE ("must never masquerade as nothing staged"), extended to a successful
 * query with an answer the filter made meaningless.
 *
 * Exits non-zero on detection; returns normally when there is genuinely nothing staged.
 */
export function assertStagedSetSane(pathspecs, reviewerName) {
  let unfiltered;
  try {
    unfiltered = execFileSync('git', ['diff', '--cached', '--name-only', '--', ...pathspecs], {
      encoding: 'utf-8',
    });
  } catch {
    // The ACM query already succeeded, so git works here; a failure now is not evidence of anything.
    // Stay silent and let the caller report its honest "nothing staged".
    return;
  }
  const staged = unfiltered.split('\n').filter((line) => line.trim().length > 0);
  if (staged.length === 0) return;
  console.error(
    `❌ ${reviewerName}: ${staged.length} path(s) are staged but NONE are additions/copies/modifications — ` +
      'the staged set is pure deletions. Refusing to report "no items": a reviewer that examines ' +
      'nothing must not read as a pass. If this is a deliberate deletion-only commit, review it by ' +
      'hand; if it is not, your index has been overwritten — check `git diff --cached --stat`.',
  );
  process.exit(1);
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
