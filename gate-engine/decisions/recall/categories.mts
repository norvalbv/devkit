/**
 * Controlled category vocabulary for a decision's Target `**Category:** <value>` field.
 *
 * A category answers "what does this decision GOVERN", not "which directory does it touch". Scope
 * globs were tried first and rejected: measured across the real corpus, most Scope globs already
 * share a single top-level directory (gate-engine/decisions/**, cli/lib/ship/**, …), so grouping by
 * Scope just re-derives folder names — it does not cluster the cross-cutting question ("what config
 * moves where, and why") this view exists to answer. So the list below is hand-curated by reading
 * every axis's Target, not computed from Scope.
 *
 * Closed vocabulary, not free text: an open tag set drifts into near-duplicate labels the moment two
 * authors describe the same governance area differently (e.g. "ship" vs "ship-pipeline" vs
 * "shipping"), which is exactly the fragmentation this view is meant to undo. `validateCategory`
 * makes an unknown value a hard write-time error rather than a silent new bucket — the list only
 * grows by a deliberate edit here.
 */

export const CATEGORIES = [
  // The guard-decisions engine's own format/retrieval/dedup/expiry/CLI rules — decisions ABOUT the
  // decision log itself (e.g. decision-format-parsed-not-regexed, decision-retrieval-tier-fusion).
  'decision-log',
  // What a commit-time gate judges and how it decides pass/fail/skip/fail-open (e.g.
  // correctness-reviewer-precision, review-gate-in-chain, coverage-gate).
  'commit-gates',
  // How gates and judges are measured, and how that measurement evidence is kept (e.g.
  // bench-gates-on-flips-not-deltas, benchmark-evidence-append-only).
  'benchmarking',
  // The `ship` command's own orchestration, retries, and telemetry (e.g.
  // ship-gates-converge-not-restart, reconcile-manifest-accumulates-per-ship).
  'ship-pipeline',
  // What devkit installs or syncs into a CONSUMER repo, and who owns the result afterward (e.g.
  // non-devkit-asset-collision-preserve, zero-consumer-tool-deps).
  'consumer-distribution',
  // devkit's own build, dogfood, and release mechanics (e.g. devkit-self-dogfood,
  // typescript-source-prebuilt-mjs).
  'self-host-release',
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** Null when `value` is a recognised category; the write-time error message otherwise. */
export function validateCategory(value: string): string | null {
  if (isCategory(value.trim())) return null;
  return `Unknown category "${value}". Allowed: ${CATEGORIES.join(', ')}`;
}
