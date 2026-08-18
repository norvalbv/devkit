import { devkitDataFile, loadEntries, saveEntries } from "../judge/verdict-store.mjs";
import { detectChangedComments } from "./detect.mjs";
import { commentJudgeModel, judgeComment, receiptKey } from "./judge.mjs";
import { loadStagedRationales } from "./rationales.mjs";
export const COMMENT_RECEIPTS_FILE = 'comment-firewall-receipts.json';
const defaults = {
    detect: detectChangedComments,
    loadRationales: loadStagedRationales,
    loadReceipts: loadEntries,
    saveReceipt: saveEntries,
    judge: judgeComment,
    model: commentJudgeModel,
    now: () => new Date().toISOString(),
    strict: () => Boolean(process.env.GUARD_AI_STRICT),
};
function findingLocation(finding) {
    return `${finding.path}:${finding.startLine}${finding.endLine === finding.startLine ? '' : `-${finding.endLine}`}`;
}
function printFinding(finding) {
    const summary = finding.comment.replace(/\s+/g, ' ').slice(0, 140);
    console.error(`  • [${finding.id}] ${findingLocation(finding)} — ${summary}`);
}
function printMissing(findings) {
    console.error(`guard-comments: ${findings.length} added/modified comment${findings.length === 1 ? '' : 's'} need a decision.`);
    for (const finding of findings)
        printFinding(finding);
    console.error('\nFix the implementation and remove the explanatory workaround, or justify a load-bearing comment:');
    console.error(`  guard-comments justify <id> "why code/types/tests cannot express this durable constraint"`);
    console.error('If this is legitimate temporary debt, create/link its cleanup ticket:');
    console.error(`  guard-comments justify <id> "why unavoidable now and what removes it" --ticket SC-123`);
    console.error('The rationale is staged as audit evidence; a separate Haiku reviewer must still approve it.');
}
function passReceipt(meta) {
    return meta?.verdict === 'PASS';
}
function evidenceFor(finding, rationales) {
    const evidence = rationales.entries[finding.id];
    return evidence?.rationale.trim() ? evidence : undefined;
}
/** Recompute the evidence just before publishing PASS, closing the stage-while-judge-runs race. */
function remainsCurrent(cwd, originalKey, findingId, deps) {
    const refreshed = deps.detect(cwd);
    const current = refreshed.findings.find((finding) => finding.id === findingId);
    if (!current)
        return false;
    const rationale = evidenceFor(current, deps.loadRationales(cwd));
    return Boolean(rationale && receiptKey(current, rationale, deps.model()) === originalKey);
}
/**
 * Exit contract: 0 clean/receipted, 1 unresolved/rejected, 2 ordinary judge outage (fail-open),
 * 3 strict judge outage, 4 unreadable staged evidence or unsupported configured language.
 */
export function runCommentFirewall(cwd = process.cwd(), injected = {}) {
    const deps = { ...defaults, ...injected };
    let detection;
    let rationales;
    try {
        detection = deps.detect(cwd);
        rationales = deps.loadRationales(cwd);
    }
    catch (cause) {
        console.error(`guard-comments: staged evidence unreadable — ${cause instanceof Error ? cause.message : cause}`);
        return 4;
    }
    if (detection.unsupported.length > 0) {
        console.error('guard-comments: configured staged source uses unsupported comment syntax:');
        for (const item of detection.unsupported) {
            console.error(`  • .${item.extension || '(none)'} — ${item.path}`);
        }
        console.error('Add an explicit lexer adapter or exclude that extension from sourceExtensions; no regex fallback was used.');
        return 4;
    }
    if (detection.findings.length === 0)
        return 0;
    const receiptFile = devkitDataFile(cwd, COMMENT_RECEIPTS_FILE);
    const receipts = deps.loadReceipts(receiptFile);
    const missing = [];
    const pending = [];
    for (const finding of detection.findings) {
        const rationale = evidenceFor(finding, rationales);
        if (!rationale) {
            missing.push(finding);
            continue;
        }
        const key = receiptKey(finding, rationale, deps.model());
        if (!passReceipt(receipts[key]))
            pending.push({ finding, rationale, key });
    }
    if (missing.length > 0) {
        printMissing(missing);
        return 1;
    }
    for (const item of pending) {
        const result = deps.judge(cwd, item.finding, item.rationale);
        if (!result) {
            console.error(`guard-comments: [${item.finding.id}] reviewer unavailable or returned malformed evidence; no receipt was written.`);
            return deps.strict() ? 3 : 2;
        }
        if (result.verdict === 'FAIL') {
            console.error(`guard-comments: [${item.finding.id}] rationale rejected — ${result.reason}`);
            console.error('Fix the implementation/comment, or replace the rationale with specific evidence.');
            console.error('For unavoidable temporary debt, include a cleanup ticket with --ticket SC-123.');
            return 1;
        }
        try {
            if (!remainsCurrent(cwd, item.key, item.finding.id, deps)) {
                console.error(`guard-comments: [${item.finding.id}] staged evidence changed during review; stale PASS discarded.`);
                return 1;
            }
        }
        catch (cause) {
            console.error(`guard-comments: could not re-read staged evidence before publishing PASS — ${cause instanceof Error ? cause.message : cause}`);
            return 4;
        }
        const saved = deps.saveReceipt(receiptFile, {
            [item.key]: {
                at: deps.now(),
                verdict: 'PASS',
                findingId: item.finding.id,
                path: item.finding.path,
                model: deps.model(),
                reason: result.reason,
            },
        });
        if (!saved) {
            console.error(`guard-comments: [${item.finding.id}] reviewer approved, but its PASS receipt could not be persisted; commit blocked.`);
            return 4;
        }
        receipts[item.key] = { verdict: 'PASS' };
        console.error(`guard-comments: [${item.finding.id}] approved — ${result.reason}`);
    }
    return 0;
}
