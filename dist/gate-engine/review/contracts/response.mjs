/** Shared reviewer response primitives. Domain-specific evidence contracts depend on this module. */
// Tolerates markdown dressing around the verdict line; the LAST match wins. Deliberately no
// bare-word fallback: pass/fail saturate review prose, so absence must remain inconclusive.
export const VERDICT_LINE_RE = /^[\s*#>-]*VERDICT:\s*\**\s*(PASS|FAIL)\b\**\s*(?:[—–:-]+\s*)?(.*)$/gim;
export function parseReviewVerdict(raw) {
    const lines = [...String(raw).matchAll(VERDICT_LINE_RE)];
    if (lines.length === 0)
        return { verdict: null, reason: '' };
    const last = lines[lines.length - 1];
    return {
        verdict: last[1].toUpperCase(),
        reason: (last[2] ?? '').replace(/\*+/g, '').trim(),
    };
}
/** Remedy for any healthy judge whose response failed its declared machine contract. */
export const RESPONSE_CONTRACT_REMEDY = 'the judge response did not satisfy its declared contract; inspect the transcript or checklist ' +
    'above, fix a real violation if present, then re-run devkit ship';
