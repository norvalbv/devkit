import { judgeBinForModel } from '../../judge/codex/result.mjs';
import { JUDGE_ISOLATION } from '../../judge/judge-isolation.mjs';
import { namedAgentMcpProfile } from '../../judge/mcp/profile.mjs';
import { DEEP_JUDGE_TIMEOUT_MS, execJudgeAsync } from '../../judge/run-judge.mjs';
import { renderGoverningClaudeMd } from '../claude-md.mjs';
import { renderStagedLineCounts } from '../evidence/line-counts.mjs';
import { parseReviewVerdict } from '../contracts/response.mjs';
import { buildCappedDiffEvidence } from '../diff-evidence.mjs';
import { responseContractFor } from '../contracts/registry.mjs';
import { attachItems } from '../evidence/items.mjs';
import { gitCached } from '../evidence/staged-git.mjs';
import { lensGroupId } from '../lens/groups.mjs';
import { applyOverrideValve } from '../overrides.mjs';
import { allowedToolsFor, escalatePrompt, hasChecklist, resolveEscalationModel, resolveReviewModel, wrapConventionsPrompt, wrapPrompt, } from '../reviewers.mjs';
import { enforceChecklistContract } from '../contracts/checklist.mjs';
import { agentBody, cleanupChecklistState, initializeCommitGuardChecklist, readChecklistState, withStagedFiles, } from '../runtime.mjs';
import { consumerChecklistAssetRoot } from './consumer-assets.mjs';
/** Reason + machine cause for an inconclusive outcome, both naming what the PROVIDER said: a usage
 *  lock collapsed into "judge outage" sends the reader to the one remedy that cannot work. */
function outageReason(outage, pass = 'judge') {
    const subject = pass === 'escalation' ? 'escalation' : 'judge';
    if (outage?.kind === 'timeout')
        return `${subject} timed out`;
    if (outage?.kind === 'rate-limited')
        return `${subject} hit the provider usage limit`;
    if (outage?.kind === 'unauthenticated')
        return `${subject} CLI is not authenticated`;
    if (outage?.kind === 'absent')
        return `${subject} CLI is not installed`;
    return `${subject} outage`;
}
/** The machine cause `strictRemedy` branches on. Only the two whose remedies genuinely differ are
 *  split out; absent/unauthenticated share the auth/quota remedy, which is right for both. */
function outageCause(outage) {
    if (outage?.kind === 'timeout')
        return 'timeout';
    if (outage?.kind === 'rate-limited')
        return 'rate-limited';
    return 'outage';
}
/** Run one reviewer with checklist verification, override handling, and cleanup. */
export async function runCascade(sel, opts) {
    const { cwd } = opts;
    const checklistRoot = opts.assetRoot ?? consumerChecklistAssetRoot(cwd, sel.reviewer);
    cleanupChecklistState(cwd, sel.reviewer);
    try {
        initializeCommitGuardChecklist(cwd, sel.reviewer, checklistRoot, opts.judgeEnv);
        let res = await cascadeVerdict(sel, opts, checklistRoot);
        res = await enforceChecklistContract(sel, res, cwd, opts.recovery !== undefined, async (reason) => {
            if (opts.recovery === 'defer')
                return { ...res, status: 'inconclusive', reason, retryable: reason };
            // Exhausted recovery: review blocks at exit 1, ship stays inconclusive at exit 3. 'error'
            // on ship would render as an escalation-confirmed reviewer FAIL — a verdict claim about a
            // diff no judge ever finished reading. `assetRoot` is set only by review mode.
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
        });
        const disposition = applyOverrideValve(sel, res, cwd, {
            readState: () => readChecklistState(cwd, sel.reviewer),
            stagedDiff: () => gitCached(cwd, [], sel.files),
        });
        attachItems(res, readChecklistState(cwd, sel.reviewer), disposition, { full: opts.fullItems });
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
    if (body === null)
        return {
            name: reviewer.name,
            status: 'inconclusive',
            reason: `agent brief ${reviewer.name}.md missing under ${cfg.review.agentsDir} — run devkit sync-agents && devkit sync-skills`,
            inconclusiveCause: 'sync',
            escalated: false,
        };
    // Both forms name every staged file; only the checklist reviewers have the Bash to verify a churn
    // count, so the Bash-less one is given the inventory without it.
    const inventory = hasChecklist(reviewer)
        ? gitCached(cwd, ['--stat'], files)
        : `STAGED FILES (complete inventory):\n${gitCached(cwd, ['--name-only'], files)}`;
    const prompt = hasChecklist(reviewer)
        ? wrapPrompt(body, reviewer, files, assetRoot, checklistRecoveryReason, promptExtras, checklistRoot)
        : wrapConventionsPrompt(body, files, renderGoverningClaudeMd(cwd, files), {
            ...promptExtras,
            lineCountBlock: renderStagedLineCounts(cwd, files),
        });
    const responseContract = responseContractFor(reviewer.responseContract);
    const input = buildCappedDiffEvidence(gitCached(cwd, [], files), inventory);
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
    const passModel = reviewer.model ?? firstModel;
    // Per-lens spend attribution: every split part deliberately shares one judge LABEL (the reviewer
    // identity the caches and warehouse key on), so the lens rides the judge_exec event as its own field.
    const lens = reviewer.lens?.length ? lensGroupId(reviewer.lens) : undefined;
    let firstOutage;
    const firstOpts = {
        label: `review:${reviewer.name}`,
        args: args(prompt, passModel),
        input,
        timeout: budgetLeft(),
        cwd,
        transcript: false,
        mcpProfile,
        env,
        lens,
        onOutage: (outage) => {
            firstOutage = outage;
        },
    };
    let first = await exec(firstOpts);
    let initialRetryUsed = false;
    // `permanent`, not `!== 'timeout'`: a usage lock cannot clear inside a retry, and re-spawning it
    // cost EIGHT wasted judge calls per ship for six days. A timeout stays permanent as before.
    if (first === null && retryFirst && !firstOutage?.permanent) {
        initialRetryUsed = true;
        console.error(`guard-review: ${reviewer.name}: judge run failed (${firstOutage?.kind ?? 'transient'}), retrying once…`);
        cleanupChecklistState(cwd, reviewer);
        initializeCommitGuardChecklist(cwd, reviewer, checklistRoot, judgeEnv);
        first = await exec(firstOpts);
    }
    if (first === null) {
        const outcome = {
            name: reviewer.name,
            status: 'inconclusive',
            reason: outageReason(firstOutage),
            inconclusiveCause: outageCause(firstOutage),
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
        if (responseContract && !responseContract.validatesFail(first)) {
            let contractRetryUsed = false;
            if (retryFirst && !initialRetryUsed) {
                contractRetryUsed = true;
                console.error(`guard-review: ${reviewer.name}: FAIL did not satisfy its response contract, retrying once…`);
                let contractRetryOutage;
                const retried = await exec({
                    ...firstOpts,
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
                        inconclusiveCause: outageCause(contractRetryOutage),
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
            if (firstVerdict.verdict === 'FAIL' && responseContract.validatesFail(first))
                return {
                    name: reviewer.name,
                    status: 'fail',
                    reason: firstVerdict.reason,
                    escalated: false,
                    model: passModel,
                    transcript: first,
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
        };
    }
    let secondOutage;
    const second = await exec({
        label: `review:${reviewer.name}:escalate`,
        args: args(escalatePrompt(prompt, first), escalationModel),
        input,
        timeout: budgetLeft(),
        cwd,
        transcript: false,
        mcpProfile,
        env,
        lens,
        onOutage: (outage) => {
            secondOutage = outage;
        },
    });
    if (second === null) {
        const outcome = {
            name: reviewer.name,
            status: 'inconclusive',
            reason: outageReason(secondOutage, 'escalation'),
            inconclusiveCause: outageCause(secondOutage),
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
    if (finalVerdict.verdict === 'FAIL' &&
        responseContract &&
        !responseContract.validatesFail(second))
        return {
            name: reviewer.name,
            status: 'inconclusive',
            reason: responseContract.missingEvidenceReason(true),
            inconclusiveCause: 'response-contract',
            escalated: true,
            model: passModel,
            transcript: second,
        };
    if (finalVerdict.verdict === 'FAIL')
        return {
            name: reviewer.name,
            status: 'fail',
            reason: finalVerdict.reason,
            escalated: true,
            model: passModel,
            transcript: second,
        };
    if (finalVerdict.verdict === 'PASS')
        return {
            name: reviewer.name,
            status: 'pass',
            reason: finalVerdict.reason,
            escalated: true,
            model: passModel,
            transcript: second,
        };
    return {
        name: reviewer.name,
        status: 'inconclusive',
        reason: 'no VERDICT line',
        inconclusiveCause: 'response-contract',
        escalated: true,
        model: passModel,
        transcript: second,
    };
}
