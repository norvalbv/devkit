import { devkitDataFile, loadEntries, saveEntries } from '../judge/verdict-store.mjs';
import { commentFailureCause, commentFailureRemedy, dominantFailure } from './batch.mjs';
import { detectChangedComments } from './detect.mjs';
import { commentJudgeModel, judgeComments, receiptKey } from './judge.mjs';
import { describeRationaleStore, loadWorkingRationales } from './rationales.mjs';
export const COMMENT_RECEIPTS_FILE = 'comment-firewall-receipts.json';
const defaults = {
    detect: detectChangedComments,
    loadRationales: loadWorkingRationales,
    describeStore: describeRationaleStore,
    loadReceipts: loadEntries,
    saveReceipt: saveEntries,
    judge: judgeComments,
    model: (cwd) => commentJudgeModel(process.env, cwd),
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
/** The reviewer failure the operator should act on first — one cause line, never the old
 * "unavailable or malformed" disjunction that made five distinct causes indistinguishable. */
function describeFailure(outcome) {
    const failure = dominantFailure(outcome.failures);
    return failure ? commentFailureCause(failure, outcome.bin) : 'the reviewer returned no verdict';
}
function printRemedy(outcome) {
    const failure = dominantFailure(outcome.failures);
    if (failure)
        console.error(`   Remedy: ${commentFailureRemedy(failure, outcome.bin)}.`);
}
function shellQuote(value) {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function printStore(store) {
    if (!store)
        return;
    const total = store.sharedFindingIds?.length;
    const count = total === undefined ? 'unreadable' : `${total} recorded rationale${total === 1 ? '' : 's'}`;
    const state = store.sharedExists ? count : 'file does not exist';
    console.error(`\nEvidence store: ${store.sharedFile} — ${state}`);
    if (!store.privateReview)
        return;
    console.error(`A managed-review data root is in effect: ${store.writableFile}`);
    console.error('devkit ship reads ONLY the shared store above, never the private one.');
}
function printMissing(findings, store) {
    const shipLog = process.env.DEVKIT_SHIP_GATE_LOG;
    const shipEvidence = shipLog ? ` --from-ship-log ${shellQuote(shipLog)}` : '';
    console.error(`guard-comments: ${findings.length} added/modified comment paragraph${findings.length === 1 ? '' : 's'} need a decision.`);
    for (const finding of findings)
        printFinding(finding);
    printStore(store);
    console.error('\nFix the implementation and remove the explanatory workaround, or justify a load-bearing comment:');
    console.error(`  guard-comments justify <id> "why code/types/tests cannot express this durable constraint"${shipEvidence}`);
    console.error('If this is legitimate temporary debt, create/link its cleanup ticket:');
    console.error(`  guard-comments justify <id> "why unavoidable now and what removes it" --ticket SC-123${shipEvidence}`);
    console.error('The rationale stays in Git-local state; one batched Haiku review must still approve it.');
}
function passReceipt(meta) {
    return meta?.verdict === 'PASS';
}
function evidenceFor(finding, rationales) {
    const evidence = rationales.entries[finding.id];
    return evidence?.rationale.trim() ? evidence : undefined;
}
/** Recompute the evidence just before publishing PASS, closing the stage-while-judge-runs race. */
function allRemainCurrent(cwd, expected, deps, model) {
    const refreshed = deps.detect(cwd);
    if (refreshed.unsupported.length > 0 || refreshed.findings.length !== expected.length)
        return false;
    const currentById = new Map(refreshed.findings.map((finding) => [finding.id, finding]));
    if (currentById.size !== expected.length)
        return false;
    const rationales = deps.loadRationales(cwd);
    return expected.every((item) => {
        const current = currentById.get(item.finding.id);
        if (!current)
            return false;
        const rationale = evidenceFor(current, rationales);
        return Boolean(rationale && receiptKey(current, rationale, model) === item.key);
    });
}
/**
 * Exit contract: 0 clean/receipted, 1 unresolved/rejected, 2 ordinary judge outage (fail-open),
 * 3 strict judge outage, 4 unreadable evidence, deterministic batch overflow, or unsupported language.
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
        console.error(`guard-comments: comment evidence unreadable — ${cause instanceof Error ? cause.message : cause}`);
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
    // ONE model resolution per run, used for keying, judging, AND revalidation — a mid-run config
    // edit must never persist a verdict from model B under model A's receipt key.
    const model = deps.model(cwd);
    const missing = [];
    const snapshot = [];
    const pending = [];
    for (const finding of detection.findings) {
        const rationale = evidenceFor(finding, rationales);
        if (!rationale) {
            missing.push(finding);
            continue;
        }
        const key = receiptKey(finding, rationale, model);
        const item = { finding, rationale, key };
        snapshot.push(item);
        if (!passReceipt(receipts[key]))
            pending.push(item);
    }
    if (missing.length > 0) {
        let store = null;
        try {
            store = deps.describeStore(cwd);
        }
        catch {
            store = null; // a diagnostic must never convert a clean block into a crash
        }
        printMissing(missing, store);
        return 1;
    }
    if (pending.length === 0)
        return 0;
    let outcome;
    try {
        outcome = deps.judge(cwd, pending.map(({ finding, rationale }) => ({ finding, rationale })), model);
    }
    catch (cause) {
        console.error(`guard-comments: deterministic review-batch limit exceeded; split the staged change — ${cause instanceof Error ? cause.message : cause}`);
        return 4;
    }
    const results = outcome.results;
    const judged = pending.filter(({ finding }) => results[finding.id] !== undefined);
    const unjudged = pending.filter(({ finding }) => results[finding.id] === undefined);
    if (judged.length === 0) {
        // Nothing to publish, so the freshness re-read below is skipped: it guards publication, not
        // review, and re-deriving evidence here would only mask the reviewer failure with a second one.
        console.error(`guard-comments: no verdict for any of the ${pending.length} pending finding${pending.length === 1 ? '' : 's'} — ${describeFailure(outcome)}. No receipt was written.`);
        printRemedy(outcome);
        return deps.strict() ? 3 : 2;
    }
    try {
        if (!allRemainCurrent(cwd, snapshot, deps, model)) {
            console.error('guard-comments: local evidence changed during review; stale batch discarded.');
            return 1;
        }
    }
    catch (cause) {
        console.error(`guard-comments: could not re-read local evidence before publishing PASS — ${cause instanceof Error ? cause.message : cause}`);
        return 4;
    }
    const approved = judged.filter(({ finding }) => results[finding.id]?.verdict === 'PASS');
    if (approved.length > 0) {
        const entries = Object.fromEntries(approved.map((item) => [
            item.key,
            {
                at: deps.now(),
                verdict: 'PASS',
                findingId: item.finding.id,
                path: item.finding.path,
                model,
                reason: results[item.finding.id]?.reason,
            },
        ]));
        const saved = deps.saveReceipt(receiptFile, entries);
        if (!saved) {
            console.error('guard-comments: approved PASS receipts could not be persisted; commit blocked.');
            return 4;
        }
        Object.assign(receipts, entries);
    }
    if (unjudged.length > 0) {
        console.error(`guard-comments: judged ${judged.length} of ${pending.length} pending findings in ${outcome.planned - outcome.failures.length} of ${outcome.planned} batches — ${unjudged.length} have no verdict (${describeFailure(outcome)}).`);
    }
    let rejected = false;
    for (const item of judged) {
        const result = results[item.finding.id];
        if (result?.verdict === 'FAIL') {
            rejected = true;
            console.error(`guard-comments: [${item.finding.id}] rationale rejected — ${result.reason}`);
        }
        else {
            console.error(`guard-comments: [${item.finding.id}] approved — ${result?.reason}`);
        }
    }
    if (unjudged.length > 0) {
        console.error('Unjudged this run (still blocking):');
        for (const item of unjudged)
            printFinding(item.finding);
        printRemedy(outcome);
        console.error(`Approved findings are receipted, so re-running reviews only the ${unjudged.length} that ${unjudged.length === 1 ? 'is' : 'are'} left.`);
    }
    if (rejected) {
        console.error('Fix the implementation/comment, or replace the rationale with specific evidence.');
        console.error('For unavoidable temporary debt, include a cleanup ticket with --ticket SC-123.');
        return 1;
    }
    if (unjudged.length > 0)
        return deps.strict() ? 3 : 2;
    return 0;
}
