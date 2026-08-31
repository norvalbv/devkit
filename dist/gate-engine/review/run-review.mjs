/**
 * Review-gate orchestration (guard-review --gate): the domain reviewers that used to be
 * root-agent-invoked subagents (+ forgeable `.passed` marker files) run HERE, in-chain, as
 * parallel headless judges over the staged diff.
 *
 * Per selected reviewer, a CASCADE (check-alignment shape): the first pass (review.model)
 * investigates with read-only tools; ONLY its FAIL escalates to the escalation model
 * (review.escalationModel), which re-investigates with the full first-pass transcript and
 * independently confirms or overturns. A block requires an escalation-confirmed FAIL. Pinned
 * reviewers (correctness) run single-pass and block directly.
 *
 * Contract:
 *   exit 1 = at least one confirmed FAIL
 *   exit 2 = no FAIL, but at least one judge was inconclusive (outage / no VERDICT line) → the
 *            hook treats this as fail-open (non-strict runs only)
 *   exit 3 = strict runs only (GUARD_AI_STRICT, set by devkit ship): a judge stayed inconclusive
 *            after the retry, or the gate could not run — FAIL-CLOSED, distinct from exit 1 so a
 *            hook never renders an outage as "confirmed FAIL"
 *   exit 0 = every selected reviewer PASSed (live, or via the diff-hash cache), or nothing to do
 *
 * Knobs: GUARD_NO_REVIEW=1 skip · GUARD_REVIEW_MODEL first-pass model (env > guard.config.json
 *   review.model > gpt-5.6-terra@high) · GUARD_REVIEW_ESCALATION_MODEL the FAIL re-investigator
 *   (env > review.escalationModel > gpt-5.6-sol — the block authority for unpinned reviewers) ·
 * GUARD_REVIEW_SKIP comma-list of reviewer names to disable individually ·
 * GUARD_REVIEW_CONCURRENCY max judge cascades in flight (default 6, floor 1) ·
 * GUARD_AI_STRICT=1 ship mode (first-pass retry once, then fail closed) · cfg.noLlm skip.
 * FRINK_* aliases honoured. Judges are isolated (JUDGE_ISOLATION) with an airtight read-only
 * allowlist — a gate judge can never write, stage, or commit.
 *
 * W-3: config + git resolve against the CONSUMER cwd. Commit/ship briefs resolve there too;
 * `devkit review` deliberately supplies CURRENT packaged briefs/skills via an isolated runtime.
 */
import { envFlag, resolveGuardConfig } from '../config.mjs';
import { judgeBinForModel } from '../judge/codex/result.mjs';
import { emitCacheHit } from '../judge/gate-events.mjs';
import { reportGateInfraFailure } from '../judge/odb-probe.mjs';
import { execJudgeAsync, strictRemedy } from '../judge/run-judge.mjs';
import { loadCache } from './cache.mjs';
import { runCascade } from './cascade/reviewer.mjs';
import { RESPONSE_CONTRACT_REMEDY } from './contracts/response.mjs';
import { loadReviewerContext } from './evidence/commit-message.mjs';
import { responseContractFor } from './contracts/registry.mjs';
import { renderFindingsBlockForParts } from './evidence/findings.mjs';
import { emitReviewScope, emitReviewSkipped, reportNonRuns } from './evidence/scope.mjs';
import { gitCached, headHash, stagedFiles, stagedTreeHash } from './evidence/staged-git.mjs';
import { reviewerTargetSalts } from './evidence/targets-block.mjs';
import { reviewerSkipRemedy } from './overrides.mjs';
import { emitMergedLensResults, mapLimit, planReviewWork, resolveChunkCap, resolveLensGroups, taskLabel, } from './lens/split.mjs';
import { clearProgress, writeProgress } from './progress.mjs';
import { retryableReason, runDeferredRecoveries, settleReviewOutcome, } from './recovery/settle.mjs';
import { cacheKey, effectiveReviewConfig, resolveEscalationModel, resolveReviewModel, } from './reviewers.mjs';
import { selectRepositoryReviewers } from './scope/repository.mjs';
import { gateJudgeEnv, passAssetVerifier, preflightReviewAssets, resolveReviewerIdentities, skippedReviewers, } from './runtime.mjs';
import { ReviewGateTiming, reviewConcurrency } from './telemetry/timing.mjs';
export { runCascade };
/**
 * The gate → exit code (see module contract). Selected reviewers run concurrently but BOUNDED to
 * `reviewConcurrency()` cascades in flight (GUARD_REVIEW_CONCURRENCY, default 6) — so under machine
 * load each judge keeps enough CPU + subscription slots to finish under its timeout. Wall-clock is
 * ceil(N/K) waves of the slowest cascade rather than the single slowest, a deliberate trade.
 */
export async function runReviewGate(cwd = process.cwd(), { exec = execJudgeAsync } = {}) {
    const timing = new ReviewGateTiming();
    let preJudgeTree;
    let preJudgeHead = null;
    // Judge-integrity choke point (sc-2054): EVERY exit after the snapshot was taken re-verifies
    // the staged tree AND HEAD — pass (0), the all-cache-hit early return, and the fail-open
    // inconclusive exit (2) alike, since 2 still lets a plain commit proceed. Any violation exits 1
    // regardless of the original code: tamper is a hard fail, never an inconclusive. Tree null
    // fails closed; a moved HEAD (nested `git commit` leaves write-tree identical) fails too.
    const finish = (code) => {
        if (preJudgeTree !== undefined) {
            // Endpoint verification is the SAME stable-read bracket as the start snapshot (tree read
            // between two agreeing HEAD reads, tree re-read to agree): a write landing between two
            // unbracketed reads would let both comparisons pass individually. An actor still mutating
            // after the last read is the post-hook-exit window — git's own boundary, waived on record.
            let postTree = null;
            let postHead = null;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const h1 = headHash(cwd);
                const t = stagedTreeHash(cwd);
                if (h1 !== null && t !== null && headHash(cwd) === h1 && stagedTreeHash(cwd) === t) {
                    postTree = t;
                    postHead = h1;
                    break;
                }
            }
            if (preJudgeTree === null || postTree === null) {
                console.error('guard-review: staged tree is UNVERIFIABLE (git write-tree failed — unmerged paths?) — blocking: write-capable judges may run in this gate and their effect on the commit cannot be ruled out. Resolve the index and re-run.');
                return timing.finish(1);
            }
            if (postHead === null || postTree !== preJudgeTree || postHead !== preJudgeHead) {
                console.error(postHead === null
                    ? 'guard-review: HEAD is UNREADABLE after the review gate — blocking: repository state cannot be verified.'
                    : postTree !== preJudgeTree
                        ? `guard-review: STAGED TREE CHANGED during the review gate (${preJudgeTree.slice(0, 12)} → ${postTree.slice(0, 12)}) — the bytes to be committed are not the bytes reviewed. Blocking: re-stage deliberately and re-run.`
                        : `guard-review: HEAD MOVED during the review gate (${String(preJudgeHead).slice(0, 12)} → ${postHead.slice(0, 12)}) — something committed mid-review. Blocking: inspect the repo before trusting this commit.`);
                return timing.finish(1);
            }
        }
        return timing.finish(code);
    };
    if (envFlag('NO_REVIEW')) {
        emitReviewSkipped(null, 'gate_disabled');
        return finish(0);
    }
    const strict = envFlag('AI_STRICT'); // the ship path sets this: retry once, then fail CLOSED
    const reviewMode = process.env.DEVKIT_RUN_MODE === 'review';
    let cfg;
    let selected;
    let diffs;
    let assetRoot;
    let identitySalts = new Map();
    try {
        cfg = resolveGuardConfig(cwd);
        if (cfg.noLlm) {
            emitReviewSkipped(null, 'no_llm');
            return finish(0);
        }
        if (reviewMode)
            cfg = effectiveReviewConfig(cfg);
        // Snapshot before ANY read: every byte the gate evaluates postdates this instant, so the
        // finish-time recheck catches movement across the gate's whole life (judge or otherwise).
        // Stable-read pair: HEAD is read on BOTH sides of the tree read and must agree, or a commit
        // landing between the two reads would silently become the baseline. Unstable after retries
        // (or unreadable) → null → the choke point fails closed.
        preJudgeTree = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const before = headHash(cwd);
            const tree = stagedTreeHash(cwd);
            if (before !== null && tree !== null && headHash(cwd) === before) {
                preJudgeTree = tree;
                preJudgeHead = before;
                break;
            }
        }
        const staged = stagedFiles(cwd);
        selected = selectRepositoryReviewers(staged, cfg);
        const skip = skippedReviewers();
        const knobDropped = new Set();
        if (skip.size > 0) {
            // never a silent cap: name what the knob dropped
            for (const d of selected.filter((s) => skip.has(s.reviewer.name))) {
                console.error(`guard-review: ${d.reviewer.name} skipped (GUARD_REVIEW_SKIP)`);
                knobDropped.add(d.reviewer.name);
                emitReviewSkipped(d.reviewer.name, 'GUARD_REVIEW_SKIP');
            }
            selected = selected.filter((s) => !skip.has(s.reviewer.name));
        }
        // Before the early return: name what an empty domain root dropped, then record every non-run.
        reportNonRuns(staged, cfg, selected, knobDropped, skip);
        if (selected.length === 0)
            return finish(0);
        if (reviewMode) {
            assetRoot = process.env.DEVKIT_REVIEW_ASSET_ROOT;
            identitySalts = preflightReviewAssets(assetRoot, selected, cfg);
        }
        // One domain diff per reviewer (its cache identity): the exact staged bytes in its files.
        diffs = selected.map((s) => gitCached(cwd, [], s.files));
        // Evidence bracket: the tree must still be the snapshot AFTER the diffs are read, or the
        // judges would review swapped-in bytes while the endpoints agree (the single-swap TOCTOU).
        // A double swap timed inside this bracket is an actor with full repo write access racing
        // sub-millisecond windows — outside this gate's trust boundary (such an actor can edit .git
        // directly); hashing cannot close it and locking the index would break every parallel tool.
        if (stagedTreeHash(cwd) !== preJudgeTree)
            throw new Error('staged tree changed while review evidence was being read — re-run the gate');
    }
    catch (e) {
        // sc-1366: both branches read the staged diff, so both can die on an unreadable object. Review
        // mode is the worse — exit 1 is rendered as "A reviewer FAILED (opus-confirmed)".
        const g = 'guard-review';
        const m = `${g}: review setup failure — ${e instanceof Error ? e.message : String(e)}`;
        const fb = reviewMode ? { message: m } : { strict };
        return finish(reportGateInfraFailure(g, g, e, cwd, reviewMode ? 1 : strict ? 3 : 2, fb));
    }
    const cache = loadCache(cwd);
    const firstModel = resolveReviewModel(cfg);
    const escalationModel = resolveEscalationModel(cfg);
    // An engine-error rejection loses WHICH pass threw, so name every binary the cascade could have
    // spawned — a single guess reads as fact and sends a mixed-family operator to the wrong CLI.
    const engineOutageBin = (rev) => [
        ...new Set((rev.model ? [rev.model] : [firstModel, escalationModel]).map(judgeBinForModel)),
    ].join('` or `');
    const concurrency = reviewConcurrency();
    timing.configure(selected.map((selection) => selection.reviewer.name), concurrency);
    const judgeEnv = gateJudgeEnv(reviewMode, cfg);
    const verifyAssets = passAssetVerifier(reviewMode, assetRoot, cfg, identitySalts);
    // Identity + cache salt, one resolution for both roles (sc-1437) — see resolveReviewerIdentities.
    const { identities, cacheSalts } = resolveReviewerIdentities(reviewMode, identitySalts, selected, cwd, cfg);
    const promptIdentity = (sel) => identities.get(sel.reviewer.name) ?? null;
    // sc-1441/sc-1442: SCOPE-ONLY Target bytes join every checklist reviewer's salt — a Target edit
    // invalidates stale PASSes; the commit message + its semantic Target hits ride ONLY the prompt
    // (ship-gates-converge-not-restart: amended-message retries must reuse cached PASSes).
    const ctx = await loadReviewerContext(cwd, stagedFiles(cwd));
    const targetSalts = reviewerTargetSalts(selected, cacheSalts, ctx.saltBlock, firstModel, escalationModel);
    // Response-contract identity participates uniformly: changing any checklist-free reviewer's
    // blocking-authority protocol invalidates verdicts earned under the old contract.
    for (const { reviewer } of selected) {
        const responseContract = responseContractFor(reviewer.responseContract);
        if (responseContract)
            targetSalts.set(reviewer.name, `${targetSalts.get(reviewer.name) ?? ''}\0${responseContract.identity}`);
    }
    // What has to be judged, incl. a split reviewer's fan-out, + one scope row each (lens/split.mts).
    // chunkCap derives from the SAME resolved cfg snapshot as model/reviewer selection (W-3 +
    // no torn plan): planReviewWork's own default would re-read the launcher's guard.config.json.
    const plan = planReviewWork(selected, diffs, cache, targetSalts, cacheKey, resolveLensGroups(), resolveChunkCap(process.env.GUARD_CORRECTNESS_CHUNK, cfg.review.correctnessChunkLoc));
    for (const s of plan.scope)
        emitReviewScope(s.sel, s.diff, promptIdentity(s.sel), s.cached, ctx.scopeFields);
    for (const line of plan.cachedLines)
        console.error(line);
    for (const c of plan.fullyCached) {
        timing.cacheHit(c.name, c.duration);
        emitCacheHit(`review:${c.name}`, c.model, c.duration);
    }
    if (plan.tasks.length === 0)
        return finish(0);
    console.error(`guard-review: running ${plan.tasks.map((t) => t.sel.reviewer.name).join(', ')} (≤${concurrency} concurrent, ${firstModel} → ${escalationModel} on FAIL)…`);
    // Checkpoint each PASS as it lands, so a killed ship reruns only unfinished reviewers. The
    // progress JSON names unfinished work; heartbeat lines remain for humans. The catch prevents one
    // rejected cascade from abandoning its siblings (see mapLimit).
    const progressFile = process.env.DEVKIT_REVIEW_PROGRESS || null;
    // `running` = every reviewer to run, recorded up front — some are QUEUED (not yet started) under the
    // concurrency cap, so on a mid-flight kill `unfinishedReviewers` (running − completed) also names never-started reviewers; correct for the banner, since they're uncached and WILL be retried.
    const running = plan.tasks.map(taskLabel);
    const completed = [];
    const splitParts = plan.splitParts; // pre-seeded with groups whose PASS was already cached
    if (progressFile)
        writeProgress(progressFile, { running, completed });
    const gateStart = Date.now();
    const sctx = {
        cwd,
        firstModel,
        progressFile,
        running,
        completed,
        splitParts,
        timing,
        verifyAssets,
    };
    const baseOpts = {
        cwd,
        cfg,
        exec,
        firstModel,
        escalationModel,
        retryFirst: strict,
        assetRoot,
        judgeEnv,
        promptExtras: ctx.promptExtras,
    };
    // sc-1476: checklist-contract recovery is DEFERRED out of the contended wave (review-only —
    // the same scope the inline retry had). Parked outcomes settle nothing; the serial phase below
    // re-runs each solo through the SAME settle path with `retried` marked.
    const parked = [];
    const results = await mapLimit(plan.tasks, concurrency, (t, index) => {
        const t0 = Date.now();
        return runCascade(t.sel, { ...baseOpts, recovery: assetRoot ? 'defer' : undefined })
            .catch((e) => ({
            name: t.sel.reviewer.name,
            status: reviewMode ? 'error' : 'inconclusive',
            reason: `engine error: ${e?.message ?? e}`,
            outageBin: engineOutageBin(t.sel.reviewer),
            escalated: false,
        }))
            .then((outcome) => {
            const res = settleReviewOutcome(sctx, t, outcome, Date.now() - t0);
            const reason = retryableReason(res);
            if (reason)
                parked.push({ task: t, reason, index });
            return res;
        });
    });
    await runDeferredRecoveries(parked, results, sctx, (task, reason) => runCascade(task.sel, {
        ...baseOpts,
        retryFirst: false, // the deferred run IS the second chance — never stack the outage retry
        checklistRecoveryReason: reason,
        recovery: 'final',
    }).catch((e) => ({
        name: task.sel.reviewer.name,
        status: reviewMode ? 'error' : 'inconclusive',
        reason: `engine error: ${e?.message ?? e}`,
        inconclusiveCause: 'outage',
        outageBin: engineOutageBin(task.sel.reviewer),
        escalated: false,
    })), gateStart);
    if (progressFile)
        clearProgress(progressFile); // ran to completion → nothing unfinished to report
    emitMergedLensResults(splitParts, firstModel); // one merged review_result per split reviewer
    const fails = results.filter((r) => r.status === 'fail');
    const findingsPrinted = new Set();
    for (const f of fails) {
        console.error(`guard-review: ${f.name} FAILED${f.escalated ? ' (escalation-confirmed)' : ''} — ${f.reason || 'see findings below'}`);
        // A split reviewer fails as several lens-part results under one name: render its block ONCE,
        // merged across the failing parts, so a multi-lens failure never fragments or double-counts.
        const firstFindingForReviewer = !findingsPrinted.has(f.name);
        if (firstFindingForReviewer) {
            findingsPrinted.add(f.name);
            const findings = renderFindingsBlockForParts(f.name, fails.filter((r) => r.name === f.name));
            if (findings)
                console.error(findings);
        }
        if (f.transcript)
            console.error(f.transcript.trim());
        if (firstFindingForReviewer && f.escalated)
            console.error(`   Remedy: ${reviewerSkipRemedy(f.name)}`);
    }
    const errors = results.filter((r) => r.status === 'error');
    for (const r of errors) {
        console.error(`guard-review: ${r.name} REVIEW ERROR — ${r.reason}`);
        if (r.transcript)
            console.error(r.transcript.trim());
    }
    if (fails.length > 0 || errors.length > 0)
        return finish(1);
    const inconclusive = results.filter((r) => r.status === 'inconclusive');
    for (const r of inconclusive) {
        // Producers carry the machine cause; human-readable reasons are never parsed as an API.
        const cause = r.inconclusiveCause ?? 'outage';
        const remedy = cause === 'response-contract' ? RESPONSE_CONTRACT_REMEDY : strictRemedy(cause, r.outageBin);
        console.error(strict
            ? `guard-review: ${r.name} INCONCLUSIVE (${r.reason}) — strict ship mode fails closed.\n` +
                `   Remedy: ${remedy} (completed verdicts are cached).`
            : `guard-review: ${r.name} inconclusive — ${r.reason} (fail-open, not cached)`);
        if (cause === 'response-contract' && r.transcript)
            console.error(r.transcript.trim());
    }
    if (inconclusive.length > 0)
        return finish(strict ? 3 : 2);
    return finish(0);
}
