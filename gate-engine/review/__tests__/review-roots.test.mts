/**
 * skills/_devkit/review-roots.mjs — the shared root-validation module every reviewer checklist
 * imports. It is the single choke point that stops an absolute path, a `..` traversal, or a
 * pathspec-magic string from reaching a `git diff -- <pathspec>` call, and the single place that
 * decides when a reviewer falls back to scanning everything.
 *
 * The tests live HERE and not beside the module on purpose: `skills/**` is excluded from the vitest
 * include globs (repo-coupled helper scripts must not redden devkit's run), and everything under
 * skills/_devkit/ is PROJECTED into consumer repos by `devkit sync-skills` — a test file there would
 * ship into every consumer's .claude/.cursor tree as dead weight their runner might pick up.
 */
import { describe, expect, it } from 'vitest';
import {
  isNonEmptyStringArray,
  normalizeReviewRoots,
  parseInjectedReviewRoots,
  toGitPathspecs,
} from '../../../skills/_devkit/review-roots.mjs';

const ENV_KEYS = ['DEVKIT_RUN_MODE', 'DEVKIT_REVIEW_BACKEND_ROOTS'];
const withEnv = <T,>(env: Record<string, string | undefined>, fn: () => T): T => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe('isNonEmptyStringArray', () => {
  // The regression this module was fixed for: `[].every()` is vacuously true, so an empty array
  // passed a predicate whose NAME promises otherwise. Downstream that made the correctness
  // checklist match zero files and pass having reviewed nothing.
  it('REJECTS an empty array (a gate must never verify nothing)', () => {
    expect(isNonEmptyStringArray([])).toBe(false);
  });

  it('accepts a populated array of non-empty strings', () => {
    expect(isNonEmptyStringArray(['ts', 'tsx'])).toBe(true);
  });

  it.each([
    ['an empty string entry', ['ts', '']],
    ['a non-string entry', ['ts', 42]],
    ['a nested array', [['ts']]],
    ['null', null],
    ['undefined', undefined],
    ['a string, not an array', 'ts'],
    ['an object', { 0: 'ts' }],
  ])('rejects %s', (_label, value) => {
    expect(isNonEmptyStringArray(value)).toBe(false);
  });
});

describe('normalizeReviewRoots — path containment', () => {
  it.each([
    ['an absolute posix path', ['/etc/passwd']],
    ['an absolute windows path', ['C:\\Windows']],
    ['a parent traversal', ['../secrets']],
    ['a traversal mid-path', ['src/../../etc']],
    ['a backslash traversal', ['src\\..\\..\\etc']],
    ['a null byte', ['src\0evil']],
    ['a pathspec-magic root', [':(exclude)src']],
    ['an empty string', ['']],
    ['a whitespace-only string', ['   ']],
    ['a non-string entry', [42]],
    ['an empty list', []],
    ['a non-array', 'src'],
  ])('THROWS on %s', (_label, value) => {
    expect(() => normalizeReviewRoots(value, 'scanRoots')).toThrow(/scanRoots/);
  });

  it('normalizes and de-duplicates equivalent spellings', () => {
    expect(normalizeReviewRoots(['./src', 'src/', 'src'], 'scanRoots')).toEqual(['src']);
  });

  it('collapses a bare "." to the scan-all sentinel', () => {
    expect(normalizeReviewRoots(['.'], 'scanRoots')).toEqual(['.']);
  });

  it('converts windows separators to posix', () => {
    expect(normalizeReviewRoots(['src\\main\\lib'], 'scanRoots')).toEqual(['src/main/lib']);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeReviewRoots(['  src/main  '], 'scanRoots')).toEqual(['src/main']);
  });

  it('names the offending key in the error, so a consumer can find it', () => {
    expect(() => normalizeReviewRoots(['/abs'], 'review.backendRoots')).toThrow(
      /review\.backendRoots/,
    );
  });
});

describe('toGitPathspecs', () => {
  // Without :(top,literal) a root containing glob or magic characters would be reinterpreted by git.
  it('forces every real root to a top-anchored LITERAL pathspec', () => {
    expect(toGitPathspecs(['src', 'socket-server'])).toEqual([
      ':(top,literal)src',
      ':(top,literal)socket-server',
    ]);
  });

  it('leaves "." bare — it is the scan-all sentinel, not a path', () => {
    expect(toGitPathspecs(['.'])).toEqual(['.']);
  });

  it('handles a mixed list', () => {
    expect(toGitPathspecs(['.', 'src'])).toEqual(['.', ':(top,literal)src']);
  });
});

describe('parseInjectedReviewRoots', () => {
  it('returns null outside review mode — a stray env var cannot re-scope a normal commit', () => {
    expect(
      withEnv({ DEVKIT_RUN_MODE: undefined, DEVKIT_REVIEW_BACKEND_ROOTS: '["src"]' }, () =>
        parseInjectedReviewRoots('DEVKIT_REVIEW_BACKEND_ROOTS'),
      ),
    ).toBeNull();
  });

  it('returns null when the var is unset in review mode', () => {
    expect(
      withEnv({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_BACKEND_ROOTS: undefined }, () =>
        parseInjectedReviewRoots('DEVKIT_REVIEW_BACKEND_ROOTS'),
      ),
    ).toBeNull();
  });

  it('parses and normalizes an injected list in review mode', () => {
    expect(
      withEnv({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_BACKEND_ROOTS: '["./src","src/"]' }, () =>
        parseInjectedReviewRoots('DEVKIT_REVIEW_BACKEND_ROOTS'),
      ),
    ).toEqual(['src']);
  });

  it('THROWS on unparseable JSON rather than silently scanning everything', () => {
    expect(() =>
      withEnv({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_BACKEND_ROOTS: '{not json' }, () =>
        parseInjectedReviewRoots('DEVKIT_REVIEW_BACKEND_ROOTS'),
      ),
    ).toThrow(/must be a JSON string array/);
  });

  it('THROWS on an injected traversal — the env is trusted-ish, not unchecked', () => {
    expect(() =>
      withEnv({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_BACKEND_ROOTS: '["../../etc"]' }, () =>
        parseInjectedReviewRoots('DEVKIT_REVIEW_BACKEND_ROOTS'),
      ),
    ).toThrow(/DEVKIT_REVIEW_BACKEND_ROOTS/);
  });

  it('THROWS on an injected empty array', () => {
    expect(() =>
      withEnv({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_BACKEND_ROOTS: '[]' }, () =>
        parseInjectedReviewRoots('DEVKIT_REVIEW_BACKEND_ROOTS'),
      ),
    ).toThrow(/DEVKIT_REVIEW_BACKEND_ROOTS/);
  });
});

describe('end-to-end: config value → git pathspec', () => {
  it('a hostile root never reaches git', () => {
    expect(() => toGitPathspecs(normalizeReviewRoots(['../../etc'], 'scanRoots'))).toThrow();
  });

  it('a legitimate topology survives intact', () => {
    expect(
      toGitPathspecs(normalizeReviewRoots(['src/main', './socket-server'], 'scanRoots')),
    ).toEqual([':(top,literal)src/main', ':(top,literal)socket-server']);
  });
});
