export const CONVENTIONS_GATE_HASH_INPUTS = Object.freeze([
  'gate-engine/review/cascade/reviewer.mts',
  'gate-engine/review/reviewers.mts',
  'gate-engine/review/run-review.mts',
  'gate-engine/review/claude-md.mts',
  'gate-engine/review/diff-evidence.mts',
  'gate-engine/review/evidence/targets-block.mts',
  'gate-engine/review/evidence/commit-message.mts',
  'gate-engine/review/evidence/staged-git.mts',
  'gate-engine/review/evidence/conventions.mts',
  'gate-engine/review/evidence/line-counts.mts',
  // line-counts delegates its semantics to this shared ratchet authority.
  'gate-engine/ratchets/size-line-authority.mts',
  // Owns VERDICT_LINE_RE, whose match index decides where the evidence slice ends, and the shared
  // line-ending normalizer both parsers run first: an edit here changes what the gate parses.
  'gate-engine/review/contracts/response.mts',
  'gate-engine/review/eval/conventions/hash-inputs.mts',
]);

export const CONVENTIONS_MATCHER_HASH_INPUTS = Object.freeze([
  'gate-engine/judge/matcher-core.mts',
  'gate-engine/review/eval/conventions/matcher.mts',
  'gate-engine/review/eval/conventions/metrics.mts',
  'gate-engine/review/evidence/conventions.mts',
  // parseConventionEvidencePairs normalizes line endings through this module, so it is now on the
  // matcher's own input path, not just the gate's.
  'gate-engine/review/contracts/response.mts',
  'gate-engine/review/eval/conventions/hash-inputs.mts',
]);
