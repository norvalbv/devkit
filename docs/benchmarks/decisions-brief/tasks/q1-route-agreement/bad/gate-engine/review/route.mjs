/**
 * Decides whether a finding may block the commit.
 *
 * @param {import('./samples.mjs').Finding} finding
 * @returns {'block' | 'advisory'}
 */
export function routeFinding(finding) {
  const flagged = finding.samples.filter((s) => s.flagged);
  if (!flagged.length) return 'advisory';
  const mean = flagged.reduce((sum, s) => sum + s.confidence, 0) / flagged.length;
  return mean >= 0.8 ? 'block' : 'advisory';
}
