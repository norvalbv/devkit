import { validateCategory } from './recall/categories.mjs';
const FM_ORDER = ['slug', 'created'];
const INDEX_HEADER = '# Decision Index\n\n' +
    'Living architecture record — the current ruling per axis. Each row links to its full\n' +
    'timeline. New rationale lives in the per-axis file.\n\n' +
    '| Axis | Current ruling | Why (hook) | Updated |\n' +
    '|------|----------------|------------|---------|\n';
const INDEX_SEPARATOR_RE = /^\|[\s:|-]+\|$/;
const INDEX_SLUG_RE = /^\[([^\]]+)\]/;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const TARGET_HEAD_RE = /^## Target · /;
// Leading indentation is TOLERATED, not merely allowed. renderTarget writes Vision-fit onward with
// no blank line after the last Consequences bullet, so CommonMark folds those lines into that list
// item as a lazy continuation — and any markdown formatter that round-trips the AST (prettier,
// dprint) re-emits them indented under the bullet. sections() slices an item by node offsets and
// trims only its outer edges, so that interior indentation reaches here intact. A column-0 anchor
// therefore dropped every field after Consequences SILENTLY: no finding, no warning, just a Scope
// that stopped arming the alignment gate. Consumers format their own markdown and devkit does not
// own their toolchain (W-3), so the parser absorbs the shape rather than the renderer fighting it.
// `[ \t]` not `\s`: `\s` matches `\n`, which would let one field's value swallow the next line if
// this is ever applied to joined text rather than line-by-line.
//
// The trailing `\r?` is load-bearing, not decoration. Callers split on `\n`, so on a CRLF checkout
// every line arrives with a dangling `\r`; `.` never matches `\r` and this regex carries no `m`
// flag, so `$` could only match at end-of-string and the whole line failed — dropping every field
// that HAD a value while `**Consequences:**` and friends still parsed, because `\s*` ate the `\r`
// where the value was empty. Windows clones get CRLF by default (core.autocrlf=true) and this repo
// ships no .gitattributes, so the effect there was total: Scope unread on every axis, so the
// alignment gate armed nothing, and every Target block looked damaged to the integrity checks.
// Same failure family as the indentation one above — a field line the reader cannot see is
// indistinguishable from a field that was never written.
const TARGET_FIELD_RE = /^[ \t]*\*\*([^:]+):\*\*\s*(.*)\r?$/;
/**
 * Where a Target block's field text ENDS — the dated note bullet that opens the convergence log.
 *
 * Exported because the field rule and its boundary have to travel together. `currentTarget` breaks
 * on this positionally; the two callers that hand `parseTargetFields` a FLATTENED item array
 * (integrity's realTargetBlocks, recall's allTargetBlocks) have already lost that position and must
 * filter on it instead. One predicate, so the three readers cannot disagree about where a ruling
 * stops and its notes begin.
 *
 * Deliberately looser than note-relations.mts's NOTE_LINE_RE, which additionally demands ` — ` right
 * after the date: `- 2026-07-25 (sc-1214) — …` in coverage-gate.md is a real note that NOTE_LINE_RE
 * does not match. A boundary that under-matches is worse than useless here — it readmits exactly the
 * bullets it was added to exclude.
 */
export const NOTE_BULLET_RE = /^-\s+\d{4}-\d{2}-\d{2}\b/;
const TITLE_CUT_RE = /\. |\.$| — |; /;
const MARKDOWN_TABLE_BREAK_RE = /\s*[|\n\r]+\s*/g;
export function hasTargetFields(options) {
    return Boolean(options.ruling &&
        options.context &&
        options.consequences &&
        options.tradeoff &&
        options.visionFit);
}
export function today() {
    return process.env.DECISIONS_TODAY ?? new Date().toISOString().slice(0, 10);
}
export function sanitizeCell(value) {
    return String(value ?? '')
        .replace(MARKDOWN_TABLE_BREAK_RE, ' ')
        .trim();
}
export function whyHook(why) {
    const one = sanitizeCell(why);
    return one.length > 70 ? `${one.slice(0, 67)}…` : one;
}
export function parseIndex(markdown) {
    const rows = [];
    for (const line of markdown.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|') || !trimmed.endsWith('|'))
            continue;
        if (INDEX_SEPARATOR_RE.test(trimmed))
            continue;
        const cells = trimmed
            .slice(1, -1)
            .split('|')
            .map((cell) => cell.trim());
        if (cells.length < 4 || cells[0].toLowerCase() === 'axis')
            continue;
        const slug = cells[0].match(INDEX_SLUG_RE);
        rows.push({
            slug: slug ? slug[1] : cells[0],
            ruling: cells[1],
            why: cells[2],
            updated: cells[3],
        });
    }
    return rows;
}
export function renderIndex(rows) {
    const body = [...rows]
        .sort((left, right) => left.slug.localeCompare(right.slug))
        .map((row) => `| [${row.slug}](${row.slug}.md) | ${sanitizeCell(row.ruling)} | ${sanitizeCell(row.why)} | ${sanitizeCell(row.updated)} |`)
        .join('\n');
    return INDEX_HEADER + (body ? `${body}\n` : '');
}
export function upsertRow(rows, row) {
    const index = rows.findIndex((candidate) => candidate.slug === row.slug);
    if (index === -1)
        rows.push(row);
    else
        rows[index] = { ...rows[index], ...row };
    return rows;
}
export function parseDecision(markdown) {
    const match = markdown.match(FRONTMATTER_RE);
    if (!match)
        return { fm: {}, body: markdown };
    const fm = {};
    for (const line of match[1].split('\n')) {
        const separator = line.indexOf(':');
        if (separator === -1)
            continue;
        fm[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    return { fm, body: match[2] };
}
export function renderDecision(fm, body) {
    const keys = [
        ...FM_ORDER.filter((key) => fm[key]),
        ...Object.keys(fm).filter((key) => !FM_ORDER.includes(key) && fm[key]),
    ];
    return `---\n${keys.map((key) => `${key}: ${fm[key]}`).join('\n')}\n---\n${body}`;
}
function firstClause(value) {
    const text = String(value).trim();
    const cut = text.search(TITLE_CUT_RE);
    const clause = cut > 0 ? text.slice(0, cut) : text;
    if (clause.length <= 100)
        return clause;
    // Cap at a WORD boundary — a hard slice published headings ending mid-word ("…ids, h").
    const capped = clause.slice(0, 100);
    const lastSpace = capped.lastIndexOf(' ');
    return lastSpace > 60 ? capped.slice(0, lastSpace) : capped;
}
export function renderTarget(date, options) {
    const lines = [
        `## Target · ${date} — ${sanitizeCell(options.title || firstClause(options.ruling))}`,
        '',
    ];
    lines.push(`**Context:** ${options.context}`);
    lines.push(`**Ruling:** ${options.ruling}`);
    lines.push('**Consequences:**');
    lines.push(`- Positive: ${options.consequences}`);
    lines.push(`- Negative: ${options.tradeoff}`);
    lines.push(`**Vision-fit:** ${options.visionFit}`);
    if (options.researched)
        lines.push(`**Researched:** ${options.researched}`);
    if (options.rejected)
        lines.push(`**Rejected:** ${options.rejected}`);
    if (options.anchoredBet)
        lines.push(`**Anchored-bet:** ${options.anchoredBet}`);
    if (options.revisitWhen)
        lines.push(`**Revisit-when:** ${options.revisitWhen}`);
    if (options.scope)
        lines.push(`**Scope:** ${options.scope}`);
    if (options.category) {
        // Write-time validation, not a caller precondition: renderTarget is the ONLY place that emits
        // `**Category:**`, so it is the one place that can guarantee an axis file never carries a value
        // outside the frozen list (recall/categories.mts) — the read side (category-report.mts) treats
        // an unrecognised value as uncategorised, so a value that slipped past here would silently lose
        // its category rather than error, defeating the whole point of a closed vocabulary.
        const err = validateCategory(options.category);
        if (err)
            throw new Error(err);
        lines.push(`**Category:** ${options.category}`);
    }
    if (options.supersedes)
        lines.push(`**Supersedes:** ${options.supersedes}`);
    lines.push(`**Source:** ${[options.source || 'manual', options.ref].filter(Boolean).join(' · ')}`);
    // Trimmed on both sides of the test: a whitespace-only value must not render a hollow
    // `**Evidence-change:**` line, which parseTargetFields reads back as an empty (not absent) field.
    if (options.evidenceChange?.trim())
        lines.push(`**Evidence-change:** ${options.evidenceChange.trim()}`);
    return lines.join('\n');
}
export function renderNote(date, text) {
    return `- ${date} — ${sanitizeCell(text)}`;
}
/**
 * Extract every `**Field:** value` line from a block's raw text.
 *
 * The one field-parsing rule, shared: `currentTarget` below applies it to the LAST block only;
 * `allTargetBlocks` (recall/supersession.mts) applies the same rule to every block, so a field like
 * Supersedes reads identically wherever a caller reads it from — never two divergent extractors.
 */
export function parseTargetFields(text) {
    const fields = {};
    for (const line of text.split('\n')) {
        const field = line.match(TARGET_FIELD_RE);
        if (field)
            fields[field[1].trim().toLowerCase()] = field[2].trim();
    }
    return fields;
}
export function currentTarget(body) {
    let last = null;
    const parts = body.split('\n## ');
    for (let index = 0; index < parts.length; index += 1) {
        const heading = index === 0 ? parts[index] : `## ${parts[index]}`;
        if (TARGET_HEAD_RE.test(heading))
            last = heading;
    }
    if (!last)
        return null;
    const blockLines = [];
    for (const line of last.split('\n')) {
        if (NOTE_BULLET_RE.test(line))
            break;
        blockLines.push(line);
    }
    const fields = parseTargetFields(blockLines.join('\n'));
    return {
        ruling: fields.ruling ?? '',
        scope: fields.scope ?? '',
        fields,
        block: blockLines.join('\n').trim(),
    };
}
