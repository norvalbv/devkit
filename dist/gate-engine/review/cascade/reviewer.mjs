import { judgeBinForModel } from '../../judge/codex/result.mjs';
import { JUDGE_ISOLATION } from '../../judge/judge-isolation.mjs';
import { mcpSpawnTracker, namedAgentMcpProfile } from '../../judge/mcp/profile.mjs';
import { spawnWithRetry } from '../../judge/outage/retry.mjs';
import { DEEP_JUDGE_TIMEOUT_MS, execJudgeAsync, remedyCause } from '../../judge/run-judge.mjs';
import { outageReason } from '../../judge/outage/wording.mjs';
import { renderGoverningClaudeMd } from '../claude-md.mjs';
import { renderStagedLineCounts } from '../evidence/line-counts.mjs';
import { renderMovedLines } from '../evidence/packet/moved-lines.mjs';
import { parseReviewVerdict } from '../contracts/response.mjs';
import { buildCappedDiffEvidence } from '../diff-evidence.mjs';
import { omissionHintFor } from '../evidence/packet/omission-hint.mjs';
import { responseContractFor } from '../contracts/registry.mjs';
import { attachItems } from '../evidence/items.mjs';
import { stagedGroundingSource } from '../contracts/conventions-grounding.mjs';
import { gitCached, stagedTreeHash } from '../evidence/staged-git.mjs';
import { lensGroupId } from '../lens/groups.mjs';
import { applyOverrideValve } from '../overrides.mjs';
import { allowedToolsFor, hasChecklist, resolveEscalationModel, resolveReviewModel, wrapConventionsPrompt, wrapPrompt, } from '../reviewers.mjs';
import { enforceChecklistContract, reportDeniedCalls, retrievalDegradation, } from '../contracts/checklist.mjs';
import { agentBody, cleanupChecklistState, initializeCommitGuardChecklist, isNamedSkip, readChecklistState, withStagedFiles, } from '../runtime.mjs';
import { retryableReason } from '../recovery/settle.mjs';
import { checklistAssetRoot } from './consumer-assets.mjs';
import { escalateOverReopened, escalatePrompt, labelPasses } from './escalation.mjs';
const ALSO_STAGED_MAX = 40;
/** Names the staged paths outside a reviewer's file list, so it never reads one as unstaged. */
export function renderAlsoStaged(files, stagedFiles) {
    const inList = new Set(files);
    const others = stagedFiles.filter((f) => !inList.has(f));
    if (others.length === 0)
        return '';
    const more = others.length - ALSO_STAGED_MAX;
    const named = others.slice(0, ALSO_STAGED_MAX).join(', ') + (more > 0 ? `, and ${more} more` : '');
    return (`Also staged in this commit, outside this review's file list (paths only, not in your evidence): ${named}. ` +
        'They ARE staged (any edit or deletion is in this commit): never call them unstaged. They are ' +
        'not yours to judge; inspect one only if an in-scope change depends on it.');
}
/** Run one reviewer with checklist verification, override handling, and cleanup. */
export async function runCascade(sel, opts) {
    const { cwd } = opts;
    const checklistRoot = checklistAssetRoot(cwd, sel.reviewer, opts.assetRoot);
    cleanupChecklistState(cwd, sel.reviewer);
    try {
        // The SAME authoritative list the judge gets (sc-3400): without it the script re-resolved its
        // own ACM universe, and a deletion-only change read as a clobbered index → engine error.
        const initEnv = withStagedFiles(opts.judgeEnv ?? process.env, sel.reviewer, sel.files);
        const seeded = initializeCommitGuardChecklist(cwd, sel.reviewer, checklistRoot, initEnv);
        // Nothing reviewable (every selected path was deleted, say): no judge can add a finding about a
        // file that no longer exists, so spawning one would only buy an outage risk for a certain PASS.
        if (isNamedSkip(seeded)) {
            const skip = {
                name: sel.reviewer.name,
                status: 'pass',
                reason: `no reviewable files — ${seeded.skipped}`,
                escalated: false,
            };
            attachItems(skip, seeded, new Map(), { full: opts.fullItems });
            return skip;
        }
        // The spawns' own MCP profiles decide over the run-level read: the registry can change, or the
        // private config fail, between the two (sc-2837).
        const mcpSpawn = mcpSpawnTracker(opts.mcpDegradedCause);
        const exec = opts.exec ?? execJudgeAsync;
        // Reset per exec: only the spawn that produced the verdict may explain it.
        const spawn = { denied: null };
        // Kept across spawns: an escalation PASS may rest on the first pass's searches. A verdict from
        // an unmeasured spawn (codex) makes the whole set unknown, never zero.
        let toolCalls = null;
        let unmeasured = false;
        const observed = async (o) => {
            spawn.denied = null;
            let heard = false;
            const text = await exec({
                ...o,
                onMcpPrepared: (fingerprint, cause) => {
                    o.onMcpPrepared?.(fingerprint, cause);
                    mcpSpawn.observe(cause);
                },
                onPermissionDenials: (denied) => {
                    spawn.denied = denied;
                },
                onToolCalls: (lines) => {
                    heard = true;
                    toolCalls = [...(toolCalls ?? []), ...lines];
                },
            });
            if (text !== null && !heard)
                unmeasured = true;
            return text;
        };
        let res = await cascadeVerdict(sel, { ...opts, exec: observed }, checklistRoot);
        // Recovery below only schedules/classifies; it deletes this attempt's artifact without
        // running another judge. Keep its exact private evidence for the resulting inconclusive row.
        const captureState = opts.fullItems ? readChecklistState(cwd, sel.reviewer) : null;
        res = await enforceChecklistContract(sel, res, cwd, opts.recovery !== undefined, async (reason) => {
            if (opts.recovery === 'defer')
                return { ...res, status: 'inconclusive', reason, retryable: reason };
            // Exhausted recovery: review blocks at exit 1 (REVIEW ERROR); ship stays inconclusive at
            // exit 3, its strict retry/fail-closed contract. `assetRoot` is set only by review mode.
            if (opts.recovery === 'final') {
                const exhausted = `reviewer checklist contract failed after one retry — ${reason}`;
                const terminal = opts.assetRoot
                    ? { ...res, status: 'error', reason: exhausted }
                    : { ...res, status: 'inconclusive', inconclusiveCause: undefined, reason: exhausted };
                return terminal;
            }
            // Unreachable from the three direct callers (the reviewer/conventions/scale benches): they
            // schedule no recovery, so enforceChecklistContract never invokes this callback at all.
            throw new Error(`checklist recovery has no scheduling mode — ${reason}`);
        }, spawn.denied);
        const disposition = applyOverrideValve(sel, res, cwd, {
            readState: () => readChecklistState(cwd, sel.reviewer),
            stagedDiff: () => gitCached(cwd, [], sel.files),
        });
        const finalState = readChecklistState(cwd, sel.reviewer) ?? captureState;
        if (!retryableReason(res))
            reportDeniedCalls(sel.reviewer, res, spawn.denied, finalState);
        attachItems(res, finalState, disposition, { full: opts.fullItems });
        // Read before the finally deletes the artifact — the flag lives nowhere else (sc-2317).
        const mcpCause = mcpSpawn.cause();
        const calls = unmeasured ? null : toolCalls;
        const evidence = { mcpCause, denied: spawn.denied, calls, searchTool: opts.cfg.searchTool };
        const degraded = retrievalDegradation(sel.reviewer.name, finalState, res.status, evidence);
        if (degraded)
            res.degraded = degraded;
        // A named skip judged nothing, so a missing tool weakened nothing — same rule as retrieval.
        if (mcpCause && res.status === 'pass' && !isNamedSkip(finalState))
            res.mcpDegraded = { cause: mcpCause };
        return res;
    }
    finally {
        cleanupChecklistState(cwd, sel.reviewer);
    }
}
async function cascadeVerdict({ reviewer, files }, { cwd, cfg, exec = execJudgeAsync, firstModel = resolveReviewModel(cfg), escalationModel = resolveEscalationModel(cfg), retryFirst = false, assetRoot, judgeEnv, checklistRecoveryReason, promptExtras, judgeTimeoutMs, }, checklistRoot) {
    // ONE budget for the whole cascade, not one per judge: an unpinned reviewer runs a first pass AND
    // an escalation, so a per-judge cap would let the pair run to twice the ceiling it was given.
    const cascadeDeadline = judgeTimeoutMs === undefined ? null : Date.now() + judgeTimeoutMs;
    const budgetLeft = () => cascadeDeadline === null
        ? DEEP_JUDGE_TIMEOUT_MS
        : Math.max(0, Math.min(DEEP_JUDGE_TIMEOUT_MS, cascadeDeadline - Date.now()));
    const env = withStagedFiles(judgeEnv ?? process.env, reviewer, files);
    const body = agentBody(cwd, cfg, reviewer.name, assetRoot);
    // Both forms name every in-scope staged file; only the checklist reviewers have the Bash to verify a churn
    // count, so the Bash-less one is given the inventory without it.
    // The index the judge's evidence is cut from; grounding refuses a tree restaged after this point.
    const evidenceTree = responseContractFor(reviewer.responseContract)
        ? stagedTreeHash(cwd, 'reviewer evidence tree')
        : null;
    const inventory = hasChecklist(reviewer)
        ? gitCached(cwd, ['--stat'], files)
        : `STAGED FILES (in scope):\n${gitCached(cwd, ['--name-only'], files)}`;
    const extras = {
        ...promptExtras,
        alsoStagedBlock: renderAlsoStaged(files, promptExtras?.stagedFiles ?? []),
    };
    const prompt = hasChecklist(reviewer)
        ? wrapPrompt(body, reviewer, files, assetRoot, checklistRecoveryReason, extras, checklistRoot)
        : wrapConventionsPrompt(body, files, renderGoverningClaudeMd(cwd, files), {
            ...extras,
            lineCountBlock: renderStagedLineCounts(cwd, files),
        });
    const responseContract = responseContractFor(reviewer.responseContract);
    // Lazy: git is read only for files a FAIL actually cites, once each across all three checks.
    const grounding = stagedGroundingSource(cwd, files, evidenceTree);
    const lensesOf = (raw) => responseContract?.blockingLenses(raw, grounding) ?? [];
    const passModel = reviewer.model ?? firstModel;
    // A shell-less judge gets a Read hint beside each OMITTED/TRUNCATED marker (sc-2305).
    const input = buildCappedDiffEvidence(gitCached(cwd, [], files), `${inventory}${renderMovedLines(cwd, files, promptExtras?.stagedFiles ?? [])}`, omissionHintFor(reviewer, passModel));
    const allowedTools = allowedToolsFor(reviewer, cfg, checklistRoot);
    const mcpProfile = namedAgentMcpProfile();
    const args = (promptBody, model) => [
        '-p',
        promptBody,
        '--model',
        model,
        ...JUDGE_ISOLATION,
        '--allowedTools',
        allowedTools,
    ];
    // Per-lens spend attribution: every split part deliberately shares one judge LABEL (the reviewer
    // identity the caches and warehouse key on), so the lens rides the judge_exec event as its own field.
    const lens = reviewer.lens?.length ? lensGroupId(reviewer.lens) : undefined;
    // First pass, retries and escalation write one checklist state file, so all carry its grant.
    const shared = {
        input,
        cwd,
        transcript: false,
        mcpProfile,
        env,
        lens,
        codexWritableFile: reviewer.stateFile,
    };
    const firstOpts = {
        ...shared,
        label: `review:${reviewer.name}`,
        args: args(prompt, passModel),
    };
    const firstRun = await spawnWithRetry((timeout, onOutage) => exec({ ...firstOpts, timeout, onOutage }), {
        retry: retryFirst,
        label: reviewer.name,
        capMs: budgetLeft(),
        beforeRetry: () => {
            cleanupChecklistState(cwd, reviewer);
            initializeCommitGuardChecklist(cwd, reviewer, checklistRoot, env);
        },
    });
    let first = firstRun.result;
    const { outage: firstOutage, retried: initialRetryUsed } = firstRun;
    if (first === null) {
        const outcome = {
            name: reviewer.name,
            status: 'inconclusive',
            reason: outageReason(firstOutage),
            inconclusiveCause: remedyCause(firstOutage),
            outageBin: judgeBinForModel(passModel),
            escalated: false,
            model: passModel,
        };
        if (firstOutage?.resetsAt !== undefined)
            outcome.outageResetsAt = firstOutage.resetsAt;
        return outcome;
    }
    let firstVerdict = parseReviewVerdict(first);
    if (firstVerdict.verdict === 'PASS')
        return {
            name: reviewer.name,
            status: 'pass',
            reason: firstVerdict.reason,
            escalated: false,
            model: passModel,
            transcript: first,
        };
    if (firstVerdict.verdict === null)
        return {
            name: reviewer.name,
            status: 'inconclusive',
            reason: 'no VERDICT line',
            inconclusiveCause: 'response-contract',
            escalated: false,
            model: passModel,
            transcript: first,
        };
    if (reviewer.model) {
        if (responseContract && lensesOf(first).length === 0) {
            let contractRetryUsed = false;
            if (retryFirst && !initialRetryUsed) {
                contractRetryUsed = true;
                console.error(`guard-review: ${reviewer.name}: FAIL did not satisfy its response contract, retrying once…`);
                let contractRetryOutage;
                const retried = await exec({
                    ...firstOpts,
                    timeout: budgetLeft(),
                    args: args(`${prompt}\n\n${responseContract.retryInstruction}`, passModel),
                    onOutage: (outage) => {
                        contractRetryOutage = outage;
                    },
                });
                if (retried === null) {
                    const outcome = {
                        name: reviewer.name,
                        status: 'inconclusive',
                        reason: outageReason(contractRetryOutage),
                        inconclusiveCause: remedyCause(contractRetryOutage),
                        outageBin: judgeBinForModel(passModel),
                        escalated: false,
                        model: passModel,
                        transcript: first,
                    };
                    if (contractRetryOutage?.resetsAt !== undefined)
                        outcome.outageResetsAt = contractRetryOutage.resetsAt;
                    return outcome;
                }
                if (retried !== null) {
                    first = retried;
                    firstVerdict = parseReviewVerdict(first);
                    if (firstVerdict.verdict === 'PASS')
                        return {
                            name: reviewer.name,
                            status: 'pass',
                            reason: firstVerdict.reason,
                            escalated: false,
                            model: passModel,
                            transcript: first,
                        };
                    if (firstVerdict.verdict === null)
                        return {
                            name: reviewer.name,
                            status: 'inconclusive',
                            reason: 'response-contract retry produced no VERDICT line',
                            inconclusiveCause: 'response-contract',
                            escalated: false,
                            model: passModel,
                            transcript: first,
                        };
                }
            }
            if (firstVerdict.verdict === 'FAIL' && lensesOf(first).length > 0)
                return {
                    name: reviewer.name,
                    status: 'fail',
                    reason: firstVerdict.reason,
                    escalated: false,
                    model: passModel,
                    transcript: first,
                    blockingLenses: lensesOf(first),
                };
            return {
                name: reviewer.name,
                status: 'inconclusive',
                reason: responseContract.missingEvidenceReason(initialRetryUsed || contractRetryUsed),
                inconclusiveCause: 'response-contract',
                escalated: false,
                model: passModel,
                transcript: first,
            };
        }
        return {
            name: reviewer.name,
            status: 'fail',
            reason: firstVerdict.reason,
            escalated: false,
            model: passModel,
            transcript: first,
            ...(responseContract && { blockingLenses: lensesOf(first) }),
        };
    }
    // Node reads `timeout: 0` as NO cap, so a spent budget skips the escalation. Sampled ONCE: a
    // second read could cross the deadline after the check and hand exec the 0 it guarded.
    const escalationBudget = budgetLeft();
    if (escalationBudget <= 0)
        return {
            name: reviewer.name,
            status: 'inconclusive',
            reason: 'escalation skipped — the first pass spent the whole budget',
            inconclusiveCause: 'timeout',
            firstPassReason: firstVerdict.reason,
            escalated: false,
            model: passModel,
            transcript: first,
        };
    let secondOutage;
    const second = await escalateOverReopened(cwd, reviewer, (reopened) => exec({
        ...shared,
        label: `review:${reviewer.name}:escalate`,
        args: args(escalatePrompt(prompt, first, reopened), escalationModel),
        timeout: escalationBudget,
        onOutage: (outage) => {
            secondOutage = outage;
        },
    }));
    if (second === null) {
        const outcome = {
            name: reviewer.name,
            status: 'inconclusive',
            reason: outageReason(secondOutage, 'escalation'),
            inconclusiveCause: remedyCause(secondOutage),
            firstPassReason: firstVerdict.reason,
            outageBin: judgeBinForModel(escalationModel),
            escalated: true,
            model: passModel,
            transcript: first,
        };
        if (secondOutage?.resetsAt !== undefined)
            outcome.outageResetsAt = secondOutage.resetsAt;
        return outcome;
    }
    const finalVerdict = parseReviewVerdict(second);
    // The escalation's verdict is final; the archive keeps both passes, each under its own model.
    const escalated = {
        name: reviewer.name,
        escalated: true,
        model: passModel,
        transcript: second,
        fullTranscript: labelPasses(passModel, first, escalationModel, second),
    };
    if (finalVerdict.verdict === 'FAIL' && responseContract && lensesOf(second).length === 0)
        return {
            ...escalated,
            status: 'inconclusive',
            reason: responseContract.missingEvidenceReason(true),
            inconclusiveCause: 'response-contract',
        };
    if (finalVerdict.verdict === 'FAIL')
        return {
            ...escalated,
            status: 'fail',
            reason: finalVerdict.reason,
            ...(responseContract && { blockingLenses: lensesOf(second) }),
        };
    if (finalVerdict.verdict === 'PASS')
        return { ...escalated, status: 'pass', reason: finalVerdict.reason };
    return {
        ...escalated,
        status: 'inconclusive',
        reason: 'no VERDICT line',
        inconclusiveCause: 'response-contract',
    };
}
