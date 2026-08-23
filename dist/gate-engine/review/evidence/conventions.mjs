const CONVENTION_VIOLATION_START_RE = /^[\s>*#-]*\**VIOLATION\**\s*:\s*(.*)$/i;
const CONVENTION_OFFENDING_START_RE = /^[\s>*#-]*\**OFFENDING\**\s*:\s*(.*)$/i;
const CONVENTION_CLOSER_RE = /^[\s>*#-]*\**(VERDICT|NO_VIOLATIONS)\b/i;
const CODE_FENCE_RE = /^\s*```/;
const CITATION_SEPARATOR_RE = /(?:^|\s)[—–-]\s/g;
const TERMINAL_LINE_RE = /:(\d+)(?:[-–]\d+)?\s*$/;
const LINELESS_RULE_LOCATION_RE = /(?:^|\/)CLAUDE\.md(?:\s+\([^)]*\))?$/i;
function citationLocation(block) {
    const separator = [...block.matchAll(CITATION_SEPARATOR_RE)].at(-1);
    if (separator?.index === undefined)
        return null;
    return block.slice(separator.index + separator[0].length).trim() || null;
}
function hasConventionCitationTrailer(block) {
    const location = citationLocation(block);
    return Boolean(location &&
        (parseConventionLocation(location) !== null || LINELESS_RULE_LOCATION_RE.test(location)));
}
// Tolerates markdown dressing around the verdict line; the LAST match wins (the body may discuss
// pass/fail while reasoning). Deliberately NO bare-word fallback — unlike ALIGN/CONTRADICT,
// "pass"/"fail" saturate ordinary review prose, so a missing VERDICT line must read as "no
// verdict" (null → no block, no cache), never be guessed from body words.
export const VERDICT_LINE_RE = /^[\s*#>-]*VERDICT:\s*\**\s*(PASS|FAIL)\b\**\s*(?:[—–:-]+\s*)?(.*)$/gim;
/**
 * Scan free-form reviewer output into ordered VIOLATION/OFFENDING pairs. Blocks may wrap across
 * lines, including quoted content that resembles a protocol label before its citation trailer.
 * Orphaned blocks are discarded. Consumers separately decide how strict each citation must be.
 */
export function parseConventionEvidencePairs(raw) {
    const pairs = [];
    let mode = 'idle';
    let buffer = [];
    let pendingViolation = null;
    const blockHasTrailer = () => hasConventionCitationTrailer(buffer.join(' '));
    const finalize = () => {
        if (mode === 'violation' && buffer.length)
            pendingViolation = buffer.join(' ');
        else if (mode === 'offending' && buffer.length) {
            if (pendingViolation)
                pairs.push({ violation: pendingViolation, offending: buffer.join(' ') });
            pendingViolation = null;
        }
        mode = 'idle';
        buffer = [];
    };
    const lines = String(raw).split(/\r?\n/);
    const hasCitationTrailerAhead = (index) => {
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            if (!lines[cursor].trim() || CODE_FENCE_RE.test(lines[cursor]))
                return false;
            if (CONVENTION_CLOSER_RE.test(lines[cursor]) ||
                CONVENTION_VIOLATION_START_RE.test(lines[cursor]) ||
                CONVENTION_OFFENDING_START_RE.test(lines[cursor]))
                return false;
            if (hasConventionCitationTrailer(lines[cursor]))
                return true;
        }
        return false;
    };
    for (const [index, line] of lines.entries()) {
        if (!line.trim() || CODE_FENCE_RE.test(line)) {
            finalize();
            continue;
        }
        if (CONVENTION_CLOSER_RE.test(line)) {
            if (mode !== 'idle' && !blockHasTrailer() && hasCitationTrailerAhead(index))
                buffer.push(line.trim());
            else
                finalize();
            continue;
        }
        const violation = line.match(CONVENTION_VIOLATION_START_RE);
        if (violation) {
            if (mode !== 'idle' && !blockHasTrailer() && hasCitationTrailerAhead(index)) {
                buffer.push(line.trim());
                continue;
            }
            finalize();
            mode = 'violation';
            buffer = violation[1] ? [violation[1]] : [];
            continue;
        }
        const offending = line.match(CONVENTION_OFFENDING_START_RE);
        if (offending) {
            if (mode !== 'idle' &&
                !(mode === 'violation' && buffer.length > 0) &&
                !blockHasTrailer() &&
                hasCitationTrailerAhead(index)) {
                buffer.push(line.trim());
                continue;
            }
            finalize();
            mode = 'offending';
            buffer = offending[1] ? [offending[1]] : [];
            continue;
        }
        if (mode !== 'idle') {
            if (blockHasTrailer() &&
                !hasConventionCitationTrailer(line) &&
                !hasCitationTrailerAhead(index))
                finalize();
            else
                buffer.push(line.trim());
        }
    }
    finalize();
    return pairs;
}
/** Normalize a citation location into the same path/start-line record the gate uses for lenses. */
export function parseConventionLocation(location) {
    const line = location.match(TERMINAL_LINE_RE);
    if (!line)
        return null;
    const path = location.slice(0, line.index).trim();
    return path ? { path, line: Number(line[1]) } : null;
}
/** Parse the last spaced dash trailer; only OFFENDING citations require a numeric line. */
function parseConventionCitation(block, requireLine) {
    const location = citationLocation(block);
    if (!location)
        return null;
    const normalized = parseConventionLocation(location);
    if (normalized)
        return normalized;
    return !requireLine && LINELESS_RULE_LOCATION_RE.test(location)
        ? { path: location, line: null }
        : null;
}
/**
 * Parse complete adjacent `VIOLATION`/`OFFENDING` pairs before the terminal verdict. The same
 * canonical records authorize a conventions FAIL and supply override-valve lens keys, so an orphan
 * line can do neither. The offending path:line stays deterministic for a fixed diff, unlike the
 * free-text verdict reason a judge may paraphrase between byte-identical runs.
 */
export function parseConventionFindings(raw) {
    const transcript = String(raw);
    const verdicts = [...transcript.matchAll(VERDICT_LINE_RE)];
    const terminalVerdict = verdicts.at(-1);
    const evidence = transcript.slice(0, terminalVerdict?.index ?? transcript.length);
    const findings = [];
    const seenLenses = new Set();
    for (const pair of parseConventionEvidencePairs(evidence)) {
        const violation = parseConventionCitation(pair.violation, false);
        const offending = parseConventionCitation(pair.offending, true);
        if (!violation || !offending || offending.line === null)
            continue;
        const offendingPath = offending.path;
        const offendingLine = offending.line;
        const lens = `${offendingPath}:${offendingLine}`;
        if (!seenLenses.has(lens)) {
            findings.push({
                rulePath: violation.path,
                ruleLine: violation.line,
                offendingPath,
                offendingLine,
            });
            seenLenses.add(lens);
        }
    }
    return findings;
}
