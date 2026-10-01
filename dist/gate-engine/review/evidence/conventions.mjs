import { createHash } from 'node:crypto';
import { normalizeLineEndings, VERDICT_LINE_RE } from '../contracts/response.mjs';
const CONVENTION_VIOLATION_START_RE = /^[\s>*#-]*\**VIOLATION\**\s*:\s*(.*)$/i;
const CONVENTION_OFFENDING_START_RE = /^[\s>*#-]*\**OFFENDING\**\s*:\s*(.*)$/i;
const CONVENTION_CLOSER_RE = /^[\s>*#-]*\**(VERDICT|NO_VIOLATIONS)\b/i;
const CODE_FENCE_RE = /^\s*```/;
const CITATION_SEPARATOR_RE = /(?:^|\s)[—–-]\s/g;
const TERMINAL_LINE_RE = /:(\d+)(?:[-–]\d+)?\s*$/;
const LINELESS_RULE_LOCATION_RE = /(?:^|\/)CLAUDE\.md(?:\s+\([^)]*\))?$/i;
export function splitConventionCitation(block) {
    const separator = [...block.matchAll(CITATION_SEPARATOR_RE)].at(-1);
    if (separator?.index === undefined)
        return null;
    const location = block.slice(separator.index + separator[0].length).trim();
    if (!location)
        return null;
    return { quote: block.slice(0, separator.index).trim(), location };
}
function citationLocation(block) {
    return splitConventionCitation(block)?.location ?? null;
}
function hasConventionCitationTrailer(block) {
    const location = citationLocation(block);
    return Boolean(location &&
        (parseConventionLocation(location) !== null || LINELESS_RULE_LOCATION_RE.test(location)));
}
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
    const lines = normalizeLineEndings(raw).split('\n');
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
        if (!line.trim()) {
            finalize();
            continue;
        }
        if (CODE_FENCE_RE.test(line)) {
            finalize();
            pendingViolation = null;
            continue;
        }
        if (CONVENTION_CLOSER_RE.test(line)) {
            finalize();
            pendingViolation = null;
            continue;
        }
        const violation = line.match(CONVENTION_VIOLATION_START_RE);
        if (violation) {
            if (mode !== 'idle' && !blockHasTrailer() && hasCitationTrailerAhead(index)) {
                buffer.push(line.trim());
                continue;
            }
            finalize();
            pendingViolation = null;
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
        if (mode === 'idle') {
            pendingViolation = null;
            continue;
        }
        if (blockHasTrailer() &&
            !hasConventionCitationTrailer(line) &&
            !hasCitationTrailerAhead(index)) {
            finalize();
            pendingViolation = null;
        }
        else
            buffer.push(line.trim());
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
 * Every complete cited pair before the terminal verdict, in order and NOT deduplicated — the input
 * quote grounding needs, since a fabricated pair must not shadow a genuine one at the same line.
 */
export function parseConventionFindingCandidates(raw) {
    const transcript = normalizeLineEndings(raw);
    const verdicts = [...transcript.matchAll(VERDICT_LINE_RE)];
    const terminalVerdict = verdicts.at(-1);
    const evidence = transcript.slice(0, terminalVerdict?.index ?? transcript.length);
    const findings = [];
    for (const pair of parseConventionEvidencePairs(evidence)) {
        const violation = parseConventionCitation(pair.violation, false);
        const offending = parseConventionCitation(pair.offending, true);
        if (!violation || !offending || offending.line === null)
            continue;
        findings.push({
            rulePath: violation.path,
            ruleLine: violation.line,
            offendingPath: offending.path,
            offendingLine: offending.line,
            offendingQuote: splitConventionCitation(pair.offending)?.quote ?? '',
            ruleQuote: splitConventionCitation(pair.violation)?.quote ?? '',
        });
    }
    return findings;
}
/** Judges decorate paths: backticks, a leading `./`, Windows separators. */
export function normalizeCitedPath(path) {
    let text = path.trim();
    const fence = text.match(/^`+([^`]*)`+$/);
    if (fence)
        text = fence[1].trim();
    return text.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
}
// A judge's ` (repo root)` after a CLAUDE.md is its own prose, and varies run to run.
const RULE_LOCATION_NOTE_RE = /^(.*?)\s+\([^()]*\)$/;
/** The rule's CLAUDE.md: fences unwrapped around the whole location or its file part, note dropped. */
function ruleFile(location) {
    const whole = normalizeCitedPath(location);
    const note = whole.match(RULE_LOCATION_NOTE_RE);
    const file = note && /CLAUDE\.md`*$/i.test(note[1]) ? note[1] : whole;
    return normalizeCitedPath(file);
}
/** Override-valve lens: offending FILE + the rule, never the line a judge re-picks each run (sc-3324).
 * A lineless rule is told apart from its siblings by its quoted text. */
export function conventionWaiverLens(finding) {
    const file = normalizeCitedPath(finding.offendingPath);
    const rule = ruleFile(finding.rulePath);
    if (finding.ruleLine !== null)
        return `${file}@${rule}:${finding.ruleLine}`;
    const text = finding.ruleQuote.toLowerCase().replace(/\s+/g, ' ').trim();
    const digest = createHash('sha256').update(`${rule}\0${text}`).digest('hex').slice(0, 8);
    return `${file}@${rule}#${digest}`;
}
/** Distinct waiver lenses of a finding set, in first-seen order. */
export function conventionWaiverLenses(findings) {
    return [...new Set(findings.map(conventionWaiverLens))];
}
/** First finding per offending path:line — the grounding and eval identity of a finding; waivers key
 * on the coarser conventionWaiverLens instead. */
export function dedupeConventionFindings(findings) {
    const seenLenses = new Set();
    return findings.filter((finding) => {
        const lens = `${finding.offendingPath}:${finding.offendingLine}`;
        if (seenLenses.has(lens))
            return false;
        seenLenses.add(lens);
        return true;
    });
}
/** Syntax-valid pairs, deduped by path:line. Blocking authority also
 * needs grounding — see contracts/conventions-grounding.mts. */
export function parseConventionFindings(raw) {
    return dedupeConventionFindings(parseConventionFindingCandidates(raw));
}
