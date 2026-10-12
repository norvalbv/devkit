/**
 * Decides whether a finding may block the commit.
 *
 * @param {import('./samples.mjs').Finding} finding
 * @returns {'block' | 'advisory'}
 */
export function routeFinding(finding) {
  // TODO: everything blocks today.
  return 'block';
}
