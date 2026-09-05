/** What an OVERLAY anti-slop run may claim, and what it must refuse. */

import { resolveOxlintEntryConfig } from '../../oxc/lifecycle.mts';

/**
 * Name the overlay contract on EVERY run, green ones included: it enforces strictly less than
 * package mode, and gate-opt-out-is-visible-and-detectable requires a weaker gate to say so.
 */
export function reportOverlayContract(cwd: string): void {
  if (resolveOxlintEntryConfig(cwd) === null) return;
  console.log(
    'anti-slop: overlay — judged against a per-clone, git-ignored baseline; no committed base, so no shrink-only ratchet or rename/receipt enforcement',
  );
}

/**
 * Why a base-tree comparison cannot run here, or null when it can. Refusing beats a vacuous pass:
 * `baselineAtTree` is always null in overlay, so the envelope's checks go inert, not satisfied.
 */
export function overlayBaseRefusal(
  operation: string | undefined,
  hasBaseRef: boolean,
): string | null {
  if (!hasBaseRef && operation !== 'adopt-renames') return null;
  const subject = operation === 'adopt-renames' ? 'adopt-renames is' : '--base is';
  return `anti-slop: ${subject} unavailable in an overlay install — the baseline is per-clone and git-ignored, so no committed base tree carries one to compare against. Use \`devkit anti-slop check --staged\` (the pre-commit gate) or a plain working-tree \`check\`.`;
}
