/** Shared reviewer response primitives. Domain-specific evidence contracts depend on this module. */
// A real code location, not any dotted-name:port — the extension allowlist keeps `db.internal:5432`
// out of the file:line bucket so unrelated findings never fold together.
export const LOCATION_RE = /([\w@./-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|py|go|rs|java|rb|swift|kt|sh|bash|zsh|sql|css|scss|html|vue|svelte|json|ya?ml|toml|md)):(\d+)\b/i;
/** Every `file:line` an issue string cites, in order — the same allowlist as the fold key. */
export function issueLocations(issue) {
    return [...String(issue).matchAll(new RegExp(LOCATION_RE.source, 'gi'))].map((m) => ({
        file: m[1],
        line: Number(m[2]),
    }));
}
// A completeness finding line, through markdown dressing (`**CRITICAL**:`, `- IMPORTANT:`). The
// colon is required, so a severity word in prose ("this is a CRITICAL gap") starts no finding.
export const FINDING_LINE_RE = /^[\s>*#-]*\**(CRITICAL|IMPORTANT|LOW)\**\s*:\s*(.+)$/;
export const ISSUES_LINE_RE = /^[\s>*#-]*\**ISSUES\**\s*:\s*(\d+)\s*critical\D+(\d+)\s*important\D+(\d+)\s*low/i;
/** Per severity, the larger of the prefixed lines and the judge's own ISSUES tally: the gate prompt
 *  requires neither, so a model that drops one still gets counted by the other. */
export function findingTally(raw) {
    const lines = normalizeLineEndings(raw).split('\n');
    const tally = lines
        .map((line) => line.match(ISSUES_LINE_RE))
        .filter(Boolean)
        .at(-1);
    return {
        critical: Math.max(linesOf(lines, 'CRITICAL'), Number(tally?.[1] ?? 0)),
        important: Math.max(linesOf(lines, 'IMPORTANT'), Number(tally?.[2] ?? 0)),
    };
}
const linesOf = (lines, severity) => lines.filter((line) => line.match(FINDING_LINE_RE)?.[1] === severity).length;
/**
 * Collapse CRLF and bare CR to LF before any line-oriented contract reads a transcript. `\r\n?`
 * rather than `\r\n`: a judge quoting a line out of a CRLF-checked-out file emits a LONE `\r`,
 * which the label regexes below cannot cross either (JS `.` never matches a carriage return), so
 * narrowing this to CRLF-only silently re-opens sc-2284. Idempotent — entry points may normalize
 * independently without coordinating.
 */
export function normalizeLineEndings(raw) {
    return String(raw).replace(/\r\n?/g, '\n');
}
// Tolerates markdown dressing around the verdict line; the LAST match wins. Deliberately no
// bare-word fallback: pass/fail saturate review prose, so absence must remain inconclusive. The
// leading dressing class is guarded so it can never consume a line terminator: multiline `^`
// matches immediately after a bare `\r`, so an unguarded `[\s*#>-]*` swallows the `\n` of a CRLF
// and every consumer that slices on `.index` gets a fragment ending in a dangling `\r`.
export const VERDICT_LINE_RE = /^(?:(?![\r\n])[\s*#>\-\p{Extended_Pictographic}\u{FE0F}\u{200D}])*VERDICT:\s*\**\s*(PASS|FAIL)\b\**[ \t]*(?:[—–:-]+[ \t]*)?(.*)$/gimu;
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
// Same guarded dressing as VERDICT_LINE_RE: the marker must open its line, never sit inside prose.
const ADVISORY_LINE_RE = /^(?:(?![\r\n])[\s*#>-])*ADVISORY:\**[^\S\r\n]*(.+)$/gim;
export const ADVISORY_CAP = 5;
const ADVISORY_CHARS = 200;
/** The judge's `ADVISORY:` lines citing a code location — non-blocking, to resolve before merge. */
export function parseAdvisories(raw, maxChars = ADVISORY_CHARS) {
    const texts = [...normalizeLineEndings(raw).matchAll(ADVISORY_LINE_RE)]
        .map((m) => m[1].replace(/\*+/g, '').replace(/\s+/g, ' ').trim().slice(0, maxChars))
        // The contract asks for a file:line, so `none` or an echoed `<file:line>` is not a finding.
        .filter((text) => issueLocations(text).length > 0);
    return [...new Set(texts)].slice(0, ADVISORY_CAP);
}
/** Remedy for a cascade that THREW: the gate failed before or around the judge, so pointing the
 *  operator at a judge CLI's auth/quota sends them after a healthy binary (sc-3400). */
export const ENGINE_ERROR_REMEDY = 'the gate itself failed before or around the judge — this is NOT an auth/quota problem. The ' +
    'error is quoted above; re-run devkit ship, and if it repeats, report it against devkit';
/** Remedy for any healthy judge whose response failed its declared machine contract. */
export const RESPONSE_CONTRACT_REMEDY = 'the judge response did not satisfy its declared contract; inspect the transcript or checklist ' +
    'above, fix a real violation if present, then re-run devkit ship';
