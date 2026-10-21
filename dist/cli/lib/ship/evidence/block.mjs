// The devkit-owned evidence block inside a PR body. Every byte outside the markers belongs to the
// caller or another tool; ship only ever replaces the span between them.
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { codeSpan, fencedJson, MAX_FAILURES, } from '../../baseline-status/regression-evidence.mjs';
import { EVIDENCE_ABSTENTIONS, EVIDENCE_STATUSES } from './outcome.mjs';
export const EVIDENCE_BEGIN = '<!-- devkit:evidence:begin -->';
export const EVIDENCE_END = '<!-- devkit:evidence:end -->';
/** The merge verdict's line; the data line carries its full reason list for later re-scoring. */
export const VERDICT_SLOT = '<!-- devkit:evidence:verdict -->';
export const VERDICT_LABEL = '**Merge verdict:**';
/** No verdict is never a reason to drop the block: the slot says why instead. */
export const verdictUnavailable = (why) => ({
    line: `${VERDICT_LABEL} unavailable (${why})`,
});
const DATA_OPEN = '<!-- devkit:evidence:data ';
const DATA_CLOSE = ' -->';
// Whole marker lines only: ship writes them that way, and prose quoting a marker inline is not a block.
const BLOCK = /^<!-- devkit:evidence:begin -->\r?\n[\s\S]*?\n<!-- devkit:evidence:end -->(?=\r?$)/m;
const BLOCKS = new RegExp(BLOCK.source, 'gm');
const MARKER = /<!-- devkit:evidence:/g;
const SHOWN_ARGS = 40;
const MAX_DETAIL_CHARS = 500;
const MAX_FAILURE_CHARS = 240;
const outcomeSchema = z.strictObject({
    status: z.enum(EVIDENCE_STATUSES),
    reason: z.enum(EVIDENCE_ABSTENTIONS).nullable(),
    detail: z.string(),
    headSha: z.string(),
    baseSha: z.string().nullable(),
    mergeVerdict: z
        .strictObject({
        verdict: z.string(),
        reasons: z.array(z.strictObject({ code: z.string(), detail: z.string().optional() })),
    })
        .optional(),
});
/** A zero-width space after the namespace keeps quoted marker text from ever parsing as a marker. */
const defuse = (text) => text.replace(MARKER, '<!-- devkit:evidence​:');
/** Caller-authored text never carries evidence: a pasted block is dropped, a stray marker defused. */
export const callerText = (body) => defuse(body.replace(BLOCKS, ''));
const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const flat = (text) => stripVTControlCharacters(text).replace(/\s+/g, ' ').trim();
const plain = (text) => clip(flat(text).replaceAll('<', '&lt;'), MAX_DETAIL_CHARS);
const failureLine = (item) => `- ${codeSpan(flat(item.fullName))}: ${codeSpan(flat(clip(item.message, MAX_FAILURE_CHARS)))}`;
/** `n` and its noun; `plus` marks a floor, from a list the report summary cut at its cap. */
const counted = (n, noun, plus = '') => `${n}${plus} ${noun}${n === 1 && !plus ? '' : 's'}`;
/** A collapsed section; `summary` is raw HTML, so it carries no markdown. */
const details = (summary, body) => [
    `<details><summary>${summary}</summary>`,
    '',
    ...body,
    '',
    '</details>',
    '',
];
/** Every failure the report summary kept, then how many it dropped at its cap. */
function failureList(title, items, total) {
    const rest = total - items.length;
    const more = rest > 0 ? [`- … and ${rest} more`] : [];
    return items.length ? details(title, [...items.map(failureLine), ...more]) : [];
}
const short = (sha) => (sha ? `\`${sha.slice(0, 12)}\`` : 'unknown');
function operandRow(name, tree, operand) {
    const exit = operand.signal ? `signal ${operand.signal}` : String(operand.exitCode);
    const counts = operand.testCounts;
    const cells = counts
        ? `${counts.passed} | ${counts.failed} | ${counts.skipped + counts.todo}`
        : 'n/a | n/a | n/a';
    return `| ${name} | ${tree} | ${exit} | ${cells} |`;
}
function runLines(evidence) {
    const { argv } = evidence.command;
    const shown = argv.length > SHOWN_ARGS
        ? [...argv.slice(0, SHOWN_ARGS), `… ${argv.length - SHOWN_ARGS} more arguments`]
        : argv;
    const { failures, fileErrors, testCounts } = evidence.red;
    const failed = testCounts?.failed ?? failures.length;
    const plus = fileErrors.length >= MAX_FAILURES ? '+' : '';
    const unloaded = counted(fileErrors.length, 'file', plus);
    return [
        '| run | what ran | exit | passed | failed | skipped |',
        '|---|---|---|---|---|---|',
        operandRow('red', 'PR test files on the PR base', evidence.red),
        operandRow('green', 'PR head', evidence.green),
        '',
        ...failureList(`Failed on red (${counted(failed, 'test')})`, failures, failed),
        ...failureList(`Did not load on red (${unloaded}): red's counts leave out the tests inside`, fileErrors, fileErrors.length),
        ...details('Test command', [fencedJson(shown)]),
    ];
}
export function renderEvidenceBlock(outcome, evidence, verdict) {
    const label = outcome.reason ? `${outcome.status} (${outcome.reason})` : outcome.status;
    const content = [
        `**Evidence:** ${label} — ${plain(outcome.detail)}`,
        `Head ${short(outcome.headSha)} · base ${short(outcome.baseSha)}`,
        '',
        ...(evidence ? runLines(evidence) : []),
        "<sub>Captured runs, not proof of causality. Dependencies are the shipping checkout's " +
            `installed packages. Stale unless the PR head is \`${outcome.headSha}\`.</sub>`,
    ].join('\n');
    const record = verdict?.verdict ? { ...outcome, mergeVerdict: verdict.verdict } : outcome;
    const data = JSON.stringify(record).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
    return [
        EVIDENCE_BEGIN,
        '#### Regression evidence (devkit ship)',
        // A line opening with a comment is a raw HTML block, so the slot trails the verdict's markdown.
        `${verdict ? `${plain(verdict.line)} ` : ''}${VERDICT_SLOT}`,
        defuse(content),
        `${DATA_OPEN}${data}${DATA_CLOSE}`,
        EVIDENCE_END,
    ].join('\n');
}
/** Replace the block in place, or append one; the rest of the body is kept byte for byte. */
export function upsertEvidenceBlock(body, block) {
    if (BLOCK.test(body))
        return body.replace(BLOCK, () => block);
    const text = body.trimEnd();
    return text ? `${text}\n\n${block}\n` : `${block}\n`;
}
/** A caller's replacement body keeps the PR's current block, so an explicit body never deletes it. */
export function carryEvidenceBlock(callerBody, currentBody) {
    const existing = BLOCK.exec(currentBody)?.[0];
    return existing ? upsertEvidenceBlock(callerText(callerBody), existing) : callerText(callerBody);
}
/** The recorded outcome, stale when it was produced at another head; null when absent or malformed. */
export function readEvidenceBlock(body, currentHead) {
    const line = BLOCK.exec(body)?.[0]
        .split('\n')
        .map((text) => text.trimEnd())
        .find((text) => text.startsWith(DATA_OPEN) && text.endsWith(DATA_CLOSE));
    if (!line)
        return null;
    let data;
    try {
        data = JSON.parse(line.slice(DATA_OPEN.length, -DATA_CLOSE.length));
    }
    catch {
        return null;
    }
    const parsed = outcomeSchema.safeParse(data);
    return parsed.success ? { ...parsed.data, stale: parsed.data.headSha !== currentHead } : null;
}
