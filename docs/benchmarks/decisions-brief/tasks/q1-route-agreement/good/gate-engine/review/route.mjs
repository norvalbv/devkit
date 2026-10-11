/**
 * Decides whether a finding may block the commit.
 *
 * @param {import('./samples.mjs').Finding} finding
 * @returns {'block' | 'advisory'}
 */
export function routeFinding(finding) {
  const unanimous = finding.samples.length > 0 && finding.samples.every((s) => s.flagged);
  return unanimous ? 'block' : 'advisory';
}
