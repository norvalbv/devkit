import { detectChangedComments } from './detect.mjs';
import { emptyInventory } from './inventory.mjs';
import { recordShown, shownAnchors } from './shown.mjs';
import { emitCommentBudget } from './telemetry.mjs';
const defaults = {
    detect: detectChangedComments,
    shown: shownAnchors,
    record: recordShown,
    emit: emitCommentBudget,
};
function findingLocation(finding) {
    return `${finding.path}:${finding.startLine}${finding.endLine === finding.startLine ? '' : `-${finding.endLine}`}`;
}
function printFinding(finding) {
    const summary = finding.comment.replace(/\s+/g, ' ').slice(0, 140);
    console.error(`  • [${finding.id}] ${findingLocation(finding)} — ${summary}`);
}
const PARAGRAPH_REMEDY = [
    '',
    'Each paragraph has 3+ changed text lines. Shorten the comment where possible.',
    'If you need a paragraph-long comment to justify a workaround, the code is wrong — fix the code.',
    'If every line states something the code cannot, retry unchanged: a paragraph blocks only once.',
].join('\n');
const REF_REMEDY = [
    '',
    'Comments outlive tickets and internal docs. State the fact the reference stands for, or drop it:',
    'the ticket belongs in the commit message or PR body, and a decision record reaches readers',
    'through its Scope, not a citation. This block repeats until the reference is gone.',
].join('\n');
function printParagraphs(findings) {
    for (const finding of findings)
        printFinding(finding);
    console.error(PARAGRAPH_REMEDY);
}
function printRefs(findings) {
    for (const { path, line, refs, comment } of findings) {
        console.error(`  • ${path}:${line} cites ${refs.join(', ')} — ${comment}`);
    }
    console.error(REF_REMEDY);
}
/** The first line is the collector's classification key; keep it byte-stable. */
function printBlock(paragraphs, refs) {
    const total = paragraphs.length + refs.length;
    console.error(`guard-comments: ${total} added/modified comment paragraph${total === 1 ? '' : 's'} need a decision.`);
    if (paragraphs.length > 0)
        printParagraphs(paragraphs);
    if (refs.length > 0)
        printRefs(refs);
}
/** A review reports every finding and spends no block, so it never touches the store. */
const reviewing = () => process.env.DEVKIT_RUN_MODE === 'review';
function printUnsupported(unsupported) {
    console.error('guard-comments: configured staged source uses unsupported comment syntax:');
    for (const item of unsupported)
        console.error(`  • .${item.extension || '(none)'} — ${item.path}`);
    console.error('Add an explicit lexer adapter or exclude that extension from sourceExtensions; no regex fallback was used.');
}
function unreadable(cause, deps) {
    console.error(`guard-comments: comment evidence unreadable — ${cause instanceof Error ? cause.message : cause}`);
    deps.emit('unreadable', emptyInventory(), [], { kept: 0, refs: 0 });
    return 4;
}
/** Over-budget paragraphs an earlier attempt showed pass; the rest, and every reference, block.
 * The block is printed before it is recorded, so an interrupted run can never pass it unseen. */
function decide(cwd, detection, deps) {
    const { findings, refFindings, inventory } = detection;
    const review = reviewing();
    const kept = review
        ? new Set()
        : deps.shown(cwd, findings.map((item) => item.anchor));
    const fresh = findings.filter((finding) => !kept.has(finding.anchor));
    const counts = { kept: kept.size, refs: refFindings.length };
    if (fresh.length === 0 && refFindings.length === 0) {
        if (counts.kept > 0) {
            console.error(`guard-comments: kept ${counts.kept} long comment(s) shown on an earlier attempt.`);
        }
        deps.emit('pass', inventory, [], counts);
        return 0;
    }
    printBlock(fresh, refFindings);
    if (!review)
        deps.record(cwd, fresh.map((finding) => finding.anchor));
    deps.emit('block', inventory, fresh, counts);
    return 1;
}
/** Exit contract: 0 clean, 1 new over-budget paragraph or forbidden reference, 4 unreadable
 * evidence, an unusable shown store, or an unsupported language. */
export function runCommentFirewall(cwd = process.cwd(), injected = {}) {
    const deps = { ...defaults, ...injected };
    let detection;
    try {
        detection = deps.detect(cwd);
    }
    catch (cause) {
        return unreadable(cause, deps);
    }
    if (detection.unsupported.length > 0) {
        printUnsupported(detection.unsupported);
        deps.emit('unsupported', detection.inventory, detection.findings, {
            kept: 0,
            refs: detection.refFindings.length,
        });
        return 4;
    }
    try {
        return decide(cwd, detection, deps);
    }
    catch (cause) {
        return unreadable(cause, deps);
    }
}
