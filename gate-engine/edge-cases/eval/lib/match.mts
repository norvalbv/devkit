/**
 * The ONE suffix-tolerant path-overlap helper, shared by finalize.mts (anchorCoverage),
 * kappa.mts (blind-agreement matching) and sources.mts (diff relevance scoring) — three separate
 * implementations of "do these file lists intersect" would drift, and divergent matching logic is
 * exactly the artifact class this pipeline exists to eliminate. Node-clean.
 */

/** True when the two repo-relative-ish paths refer to the same file (suffix-tolerant: one side
 * may carry a longer prefix — absolute path, worktree root, a/ b/ header remnants). */
export const samePath = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a !== '' &&
  b !== '' &&
  (a.endsWith(b) || b.endsWith(a));

/** How many entries of `files` match at least one entry of `others`. */
export const overlapCount = (files, others) =>
  (files ?? []).filter((f) => (others ?? []).some((o) => samePath(f, o))).length;
