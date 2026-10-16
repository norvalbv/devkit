/** The sentry judge's one-line outcome renderings. Pure; check-sentry owns the streams. */

/** A judged result as check-sentry and the verdict cache return it. */
export interface SentryVerdictLike {
  verdict: string | null;
  evidence: string;
  cached?: boolean;
}

/** Report-mode (no --gate) one-liner for a human running the gate by hand. */
export function reportLine(result: SentryVerdictLike | null): string {
  const verdict = result?.verdict ?? 'no verdict (judge unavailable / ambiguous)';
  return `sentry-judge: ${verdict}${result?.evidence ? ` — ${result.evidence}` : ''}`;
}

/**
 * Gate-mode verdict line: exactly one per judged run, so the retained gate log always shows the
 * outcome. A judged SKIP renders as PASS, because SKIP in a gate log means "verified nothing".
 */
export function gateVerdictLine(result: SentryVerdictLike | null): string {
  const cached = result?.cached ? ' (cached)' : '';
  if (result === null)
    return '⚠️  sentry-judge: SKIPPED — no verdict (judge unavailable); commit proceeds unjudged.';
  if (result.verdict === 'MONITOR')
    return `⚠️  sentry-advisory: MONITOR${cached} — consider a Sentry capture${result.evidence ? ` (${result.evidence})` : ''}.`;
  if (result.verdict === 'SKIP')
    return `sentry-judge: PASS${cached}${result.evidence ? ` — ${result.evidence}` : ''}`;
  return '⚠️  sentry-judge: SKIPPED — no confident verdict (samples split or unparseable); commit proceeds unjudged.';
}
