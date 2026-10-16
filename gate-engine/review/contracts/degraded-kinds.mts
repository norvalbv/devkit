/** Why a PASS did not fully verify, as the closed `kind` a `gate_degraded` event carries. Derived by
 * the gate from what it measured, never chosen by the judge; ordered most to least specific. */
export const DEGRADED_KINDS = [
  'mcp-missing',
  'denied',
  'unrecorded',
  'skipped',
  'unclassified',
] as const;

export type DegradedKind = (typeof DEGRADED_KINDS)[number];
