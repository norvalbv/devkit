/** Shared reviewer response primitives. Domain-specific evidence contracts depend on this module. */

// A real code location, not any dotted-name:port — the extension allowlist keeps `db.internal:5432`
// out of the file:line bucket so unrelated findings never fold together.
export const LOCATION_RE =
  /([\w@./-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|py|go|rs|java|rb|swift|kt|sh|bash|zsh|sql|css|scss|html|vue|svelte|json|ya?ml|toml|md)):(\d+)\b/i;

/** Every `file:line` an issue string cites, in order — the same allowlist as the fold key. */
export function issueLocations(issue: string): { file: string; line: number }[] {
  return [...String(issue).matchAll(new RegExp(LOCATION_RE.source, 'gi'))].map((m) => ({
    file: m[1],
    line: Number(m[2]),
  }));
}

/** `rate-limited` is split out of `outage` because its remedy inverts the generic one: re-running
 *  is exactly what cannot succeed until the provider's window resets (sc-2538). `engine` is the
 *  gate's own failure — a throw no judge answered for — which no auth/quota check can clear (sc-3400). */
export type ReviewInconclusiveCause =
  | 'timeout'
  | 'response-contract'
  | 'outage'
  | 'rate-limited'
  | 'absent'
  | 'model-unavailable'
  | 'engine';

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
  /^(?:(?![\r\n])[\s*#>\-\p{Extended_Pictographic}\u{FE0F}\u{200D}])*VERDICT:\s*\**\s*(PASS|FAIL)\b\**[ \t]*(?:[—–:-]+[ \t]*)?(.*)$/gimu;

export function parseReviewVerdict(raw: string): ReviewVerdict {
  const lines = [...String(raw).matchAll(VERDICT_LINE_RE)];
  if (lines.length === 0) return { verdict: null, reason: '' };
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

/** The writer half of parseAdvisories: only a final-reply marker line ever reaches the author. */
export const PASS_ADVISORY_RULE =
  'FAIL only for a finding that must block THIS commit. Every concrete in-charter defect that ' +
  'does not block, on a PASS too, goes in your FINAL reply directly above the VERDICT line as ' +
  'ADVISORY: <file:line> — <finding> (a plain line number). A defect named only in a bullet, in ' +
  'earlier narration or in the verdict reason never reaches the author.';

/** The judge's `ADVISORY:` lines citing a code location — non-blocking, to resolve before merge. */
export function parseAdvisories(raw: string): string[] {
  const texts = [...normalizeLineEndings(raw).matchAll(ADVISORY_LINE_RE)]
    .map((m) => m[1].replace(/\*+/g, '').replace(/\s+/g, ' ').trim().slice(0, ADVISORY_CHARS))
    // The contract asks for a file:line, so `none` or an echoed `<file:line>` is not a finding.
    .filter((text) => issueLocations(text).length > 0);
  return [...new Set(texts)].slice(0, ADVISORY_CAP);
}

/** Remedy for a cascade that THREW: the gate failed before or around the judge, so pointing the
 *  operator at a judge CLI's auth/quota sends them after a healthy binary (sc-3400). */
export const ENGINE_ERROR_REMEDY =
  'the gate itself failed before or around the judge — this is NOT an auth/quota problem. The ' +
  'error is quoted above; re-run devkit ship, and if it repeats, report it against devkit';

/** Remedy for any healthy judge whose response failed its declared machine contract. */
export const RESPONSE_CONTRACT_REMEDY =
  'the judge response did not satisfy its declared contract; inspect the transcript or checklist ' +
  'above, fix a real violation if present, then re-run devkit ship';
