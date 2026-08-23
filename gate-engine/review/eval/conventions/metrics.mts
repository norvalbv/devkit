import type { SlotOutcome } from '../../../judge/matcher-core.mts';
import { type ConventionFinding, parseConventionLocation } from '../../evidence/conventions.mts';
import type { Finding } from './matcher.mts';

interface VariantRow {
  id: string;
  variantOf?: string;
  variantKind?: 'invariance' | 'directional';
  gold: Array<{ id: string }>;
  decoys: Array<{ id: string }>;
}

interface VariantSummary {
  slots: Record<string, { got: string }>;
}

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
        const location = finding ? parseConventionLocation(finding.offendingLoc) : null;
        const lens = location ? `${location.path}:${location.line}` : null;
        return [outcome.slotId, lens !== null && validatedLenses.has(lens)];
      }),
  );
}

/** Compare invariance variants by slot kind and ordinal, never their row-specific literal ids. */
export function variantConsistency(rows: VariantRow[], summary: VariantSummary) {
  const groups: Record<string, Set<string>> = {};
  for (const row of rows) {
    if (!row.variantOf || row.variantKind === 'directional') continue;
    groups[row.variantOf] ??= new Set([row.variantOf]);
    groups[row.variantOf].add(row.id);
  }
  const ids = Object.keys(groups);
  if (!ids.length) return null;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pattern = (caseId: string) => {
    const row = byId.get(caseId);
    if (!row) return '';
    const got = (slotId: string) => summary.slots[`${caseId}::${slotId}`]?.got ?? '';
    return [
      ...row.gold.map((slot, index) => `gold[${index}]=${got(slot.id)}`),
      ...row.decoys.map((slot, index) => `decoy[${index}]=${got(slot.id)}`),
    ]
      .sort()
      .join(',');
  };
  let consistent = 0;
  const broken: string[] = [];
  for (const group of ids) {
    const patterns = new Set([...groups[group]].map(pattern).filter((value) => value !== ''));
    if (patterns.size <= 1) consistent += 1;
    else broken.push(group);
  }
  return { consistent, total: ids.length, broken };
}
