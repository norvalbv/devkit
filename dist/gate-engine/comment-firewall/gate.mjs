import { detectChangedComments } from './detect.mjs';
import { emptyInventory } from './inventory.mjs';
import { emitCommentBudget } from './telemetry.mjs';
const defaults = { detect: detectChangedComments, emit: emitCommentBudget };
function findingLocation(finding) {
    return `${finding.path}:${finding.startLine}${finding.endLine === finding.startLine ? '' : `-${finding.endLine}`}`;
}
function printFinding(finding) {
    const summary = finding.comment.replace(/\s+/g, ' ').slice(0, 140);
    console.error(`  • [${finding.id}] ${findingLocation(finding)} — ${summary}`);
}
/** The first line is the collector's classification key; keep it byte-stable. */
function printBlock(findings) {
    console.error(`guard-comments: ${findings.length} added/modified comment paragraph${findings.length === 1 ? '' : 's'} need a decision.`);
    for (const finding of findings)
        printFinding(finding);
    console.error('\nEach paragraph is over the 2-line budget. Shorten it to at most 2 lines, or move the information');
    console.error('into code, types, a test name/assertion, or a decision record (guard-decisions).');
    console.error('There is no rationale or waiver.');
}
/** Exit contract: 0 clean, 1 over budget, 4 unreadable evidence or unsupported language. */
export function runCommentFirewall(cwd = process.cwd(), injected = {}) {
    const deps = { ...defaults, ...injected };
    let detection;
    try {
        detection = deps.detect(cwd);
    }
    catch (cause) {
        console.error(`guard-comments: comment evidence unreadable — ${cause instanceof Error ? cause.message : cause}`);
        deps.emit('unreadable', emptyInventory(), []);
        return 4;
    }
    if (detection.unsupported.length > 0) {
        console.error('guard-comments: configured staged source uses unsupported comment syntax:');
        for (const item of detection.unsupported) {
            console.error(`  • .${item.extension || '(none)'} — ${item.path}`);
        }
        console.error('Add an explicit lexer adapter or exclude that extension from sourceExtensions; no regex fallback was used.');
        deps.emit('unsupported', detection.inventory, detection.findings);
        return 4;
    }
    if (detection.findings.length === 0) {
        deps.emit('pass', detection.inventory, []);
        return 0;
    }
    printBlock(detection.findings);
    deps.emit('block', detection.inventory, detection.findings);
    return 1;
}
