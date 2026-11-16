import {
  type ReferenceCheckouts,
  resolveReferenceCheckouts,
} from '../../../gate-engine/prior-art/reference-checkouts.mts';
import type { Selection } from '../components.mts';

const CONSEQUENCE =
  'the local research leg reads no reference checkout, so prior-art cannot return GENUINE_NEW_WORK here';

/**
 * prior-art advisory: the gate or the prior-art agent is installed, yet no reference checkout
 * resolves. Uses the one resolver; a corrupt config is the validity check's to report.
 */
export function printPriorArtAdvisoryHealth(cwd: string, sel: Partial<Selection>): void {
  if (!sel.priorArtGate && !sel.agents) return;
  let checkouts: ReferenceCheckouts;
  try {
    checkouts = resolveReferenceCheckouts(cwd);
  } catch {
    return;
  }
  const { declared, resolved } = checkouts;
  if (resolved.length) return;
  console.log(
    declared.length
      ? `  · prior-art: none of the ${declared.length} research.referenceCheckouts pattern(s) resolves to a directory (${declared.join(', ')}) — ${CONSEQUENCE} (check the paths or clone the siblings)`
      : `  · prior-art: guard.config.json declares no research.referenceCheckouts — ${CONSEQUENCE} (declare sibling clones as globs)`,
  );
}
