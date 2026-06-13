/**
 * Co-occurrence tier rule (pure, testable).
 *
 * Decides whether a cross-file chunk pair is a duplication candidate, and which
 * tier. Derived empirically: the description channel alone is noisy (semantic
 * neighbours score high), code embeddings cluster tight (random TS floor maxes
 * ~0.84), and NO metric separates "should DRY" from "parallel by design" — that
 * stays a human call via the allowlist.
 *
 * So: block the unambiguous (identical bytes), surface the probable, ignore the
 * floor. The drifted tier uses an AND-gate (code AND desc both high) to veto the
 * structural-similarity floor where desc is low, plus a size floor to drop
 * trivially-similar tiny chunks.
 *
 *   exact   : identical code across files (codeHash)            → block-worthy
 *   near    : code ≥ nearCode                                   → advisory (strong)
 *   drifted : code ≥ driftCode AND desc ≥ driftDesc AND LOC ≥ N → advisory
 *   (none)  : everything else                                   → ignore
 */

// Defaults are recall-biased: the matcher is advisory (candidates are
// human-triaged via the allowlist, never auto-blocked), so a missed real dup
// costs more than an extra review item. A future *blocking* gate should tighten
// these (e.g. drift-code 0.85, min-loc 15) to favour precision. These are the
// fallback used when no thresholds reach the rule (the engine seeds them from
// resolveGuardConfig().thresholds; bench/unit tests use these directly).
export const DEFAULT_KNOBS = {
  nearCode: 0.95,
  driftCode: 0.8,
  driftDesc: 0.88,
  minLoc: 2,
};

/**
 * @param {object} p
 * @param {boolean} p.hashEqual  - identical code_hash across the two files
 * @param {number}  p.code       - cosine of code_embedding (rawCode semantics)
 * @param {number}  p.desc       - cosine of description embedding
 * @param {number}  p.minLoc     - min line-count of the two chunks
 * @param {boolean} p.bothTest   - both chunks live in *.test.* files
 * @param {object} [knobs]
 * @returns {'exact'|'near'|'drifted'|null}
 */
export function classifyPair(p, knobs = DEFAULT_KNOBS) {
  // Test boilerplate duplication is near-always acceptable — out of scope.
  if (p.bothTest) return null;
  if (p.hashEqual) return 'exact';
  if (p.code >= knobs.nearCode) return 'near';
  if (p.code >= knobs.driftCode && p.desc >= knobs.driftDesc && p.minLoc >= knobs.minLoc) {
    return 'drifted';
  }
  return null;
}

/** Convenience: is this pair a duplication candidate at all? */
export function isCandidate(p, knobs = DEFAULT_KNOBS) {
  return classifyPair(p, knobs) !== null;
}
