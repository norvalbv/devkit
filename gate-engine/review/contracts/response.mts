/** Shared reviewer response primitives. Domain-specific evidence contracts depend on this module. */

/** `rate-limited` is split out of `outage` because its remedy inverts the generic one: re-running
 *  is exactly what cannot succeed until the provider's window resets (sc-2538). */
export type ReviewInconclusiveCause =
  | 'timeout'
  | 'sync'
  | 'response-contract'
  | 'outage'
  | 'rate-limited';

/** A parsed VERDICT line: the token (null when absent) plus its markdown-stripped reason. */
export interface ReviewVerdict {
  verdict: string | null;
  reason: string;
}

/**
 * Collapse CRLF and bare CR to LF before any line-oriented contract reads a transcript. `\r\n?`
 * rather than `\r\n`: a judge quoting a line out of a CRLF-checked-out file emits a LONE `\r`,
 * which the label regexes below cannot cross either (JS `.` never matches a carriage return), so
 * narrowing this to CRLF-only silently re-opens sc-2284. Idempotent — entry points may normalize
 * independently without coordinating.
 */
export function normalizeLineEndings(raw: string): string {
  return String(raw).replace(/\r\n?/g, '\n');
}

// Tolerates markdown dressing around the verdict line; the LAST match wins. Deliberately no
// bare-word fallback: pass/fail saturate review prose, so absence must remain inconclusive. The
// leading dressing class is guarded so it can never consume a line terminator: multiline `^`
// matches immediately after a bare `\r`, so an unguarded `[\s*#>-]*` swallows the `\n` of a CRLF
// and every consumer that slices on `.index` gets a fragment ending in a dangling `\r`.
export const VERDICT_LINE_RE =
  /^(?:(?![\r\n])[\s*#>-])*VERDICT:\s*\**\s*(PASS|FAIL)\b\**\s*(?:[—–:-]+\s*)?(.*)$/gim;

export function parseReviewVerdict(raw: string): ReviewVerdict {
  const lines = [...String(raw).matchAll(VERDICT_LINE_RE)];
  if (lines.length === 0) return { verdict: null, reason: '' };
  const last = lines[lines.length - 1];
  return {
    verdict: last[1].toUpperCase(),
    reason: (last[2] ?? '').replace(/\*+/g, '').trim(),
  };
}

/** Remedy for any healthy judge whose response failed its declared machine contract. */
export const RESPONSE_CONTRACT_REMEDY =
  'the judge response did not satisfy its declared contract; inspect the transcript or checklist ' +
  'above, fix a real violation if present, then re-run devkit ship';
