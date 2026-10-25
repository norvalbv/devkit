import type { SlotOutcome } from '../../../judge/matcher-core.mts';
import { type ConventionFinding, parseConventionLocation } from '../../evidence/conventions.mts';
import type { Finding } from './matcher.mts';

export {
  accumulateFindingMetrics,
  accumulateVerdictMetric,
  compareCaseFlips,
  finalizeOpenEndedSummary,
  measuredCaseMetrics,
  openEndedSummary,
  variantConsistency,
} from '../variant-consistency.mts';

/** Identify gold slots whose matched finding carries the production gate's blocking authority. */
export function blockingAuthorityByGoldSlot(
  outcomes: SlotOutcome[],
  findings: Finding[],
  validated: ConventionFinding[],
): Record<string, boolean> {
  const validatedLenses = new Set(
    validated.map((finding) => `${finding.offendingPath}:${finding.offendingLine}`),
  );
  return Object.fromEntries(
    outcomes
      .filter((outcome) => outcome.kind === 'gold' && !outcome.outage)
      .map((outcome) => {
        const finding = outcome.match > 0 ? findings[outcome.match - 1] : undefined;
        if (!finding) return [outcome.slotId, false];
        // A location with no line is a whole-file citation, which the parser keys `path:null`.
        const location = parseConventionLocation(finding.offendingLoc) ?? {
          path: finding.offendingLoc,
          line: null,
        };
        return [outcome.slotId, validatedLenses.has(`${location.path}:${location.line}`)];
      }),
  );
}
