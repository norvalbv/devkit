/**
 * Review-gate orchestration (guard-review --gate): the domain reviewers that used to be
 * root-agent-invoked subagents (+ forgeable `.passed` marker files) run HERE, in-chain, as
 * parallel headless judges over the staged diff.
 *
 * Per selected reviewer, a CASCADE (check-alignment shape): the first pass (sonnet) investigates
 * with read-only tools; ONLY its FAIL escalates to opus, which re-investigates with the full
 * first-pass transcript and independently confirms or overturns. A block requires an
 * opus-confirmed FAIL.
 *
 * Contract:
 *   exit 1 = at least one opus-confirmed FAIL
 *   exit 2 = no FAIL, but at least one judge was inconclusive (outage / no VERDICT line) → the
 *            hook treats this as fail-open (non-strict runs only)
 *   exit 3 = strict runs only (GUARD_AI_STRICT, set by devkit ship): a judge stayed inconclusive
 *            after the retry, or the gate could not run — FAIL-CLOSED, distinct from exit 1 so a
 *            hook never renders an outage as "opus-confirmed FAIL"
 *   exit 0 = every selected reviewer PASSed (live, or via the diff-hash cache), or nothing to do
 *
 * Knobs: GUARD_NO_REVIEW=1 skip · GUARD_REVIEW_MODEL first-pass model (default haiku — the
 *   reviewer-eval bench validated the domain reviewers at haiku, 6/6 block/6/6 clean; a FAIL still
 *   escalates to opus, so opus stays the block authority) ·
 * GUARD_REVIEW_SKIP comma-list of reviewer names to disable individually ·
 * GUARD_REVIEW_CONCURRENCY max judge cascades in flight (default 2, floor 1) ·
 * GUARD_AI_STRICT=1 ship mode (first-pass retry once, then fail closed) · cfg.noLlm skip.
 * FRINK_* aliases honoured. Judges are isolated (JUDGE_ISOLATION) with an airtight read-only
 * allowlist — a gate judge can never write, stage, or commit.
 *
 * W-3: config + git resolve against the CONSUMER cwd. Commit/ship briefs resolve there too;
 * `devkit review` deliberately supplies CURRENT packaged briefs/skills via an isolated runtime.
 */
import { execFileSync } from 'node:child_process';
import { envFlag, resolveGuardConfig } from "../config.mjs";
import { emitCacheHit, emitGateEvent } from "../judge/gate-events.mjs";
import { JUDGE_ISOLATION } from "../judge/judge-isolation.mjs";
import { DEEP_JUDGE_TIMEOUT_MS, execJudgeAsync, strictRemedy } from "../judge/run-judge.mjs";
import { composeTranscript, saveTranscript } from "../judge/transcript-store.mjs";
import { loadCache, savePasses } from "./cache.mjs";
import { renderGoverningClaudeMd } from "./claude-md.mjs";
import { buildCappedDiffEvidence } from "./diff-evidence.mjs";
import { attachItems, itemFields } from "./evidence/items.mjs";
import { emitReviewScope, emitReviewSkipped, emitUnselected } from "./evidence/scope.mjs";
import { applyOverrideValve } from "./overrides.mjs";
import { clearProgress, writeProgress } from "./progress.mjs";
import { allowedToolsFor, cacheKey, effectiveReviewConfig, escalatePrompt, hasChecklist, parseReviewVerdict, selectReviewers, wrapConventionsPrompt, wrapPrompt, } from "./reviewers.mjs";
import { agentBody, cleanupChecklistState, consumerReviewerIdentity, enforceChecklistContract, passAssetVerifier, preflightReviewAssets, readChecklistState, reviewJudgeEnv, } from "./runtime.mjs";
import { ReviewGateTiming, reviewConcurrency } from "./telemetry/timing.mjs";
// A missing brief / missing checklist artifact is a SYNC gap, not an auth/quota outage — the strict
// remedy branches on it (see the inconclusive loop). Matches the reasons set in cascadeVerdict
// (`agent brief …`) and verifyChecklist (`checklist artifact missing …`).
const SYNC_INCONCLUSIVE_RE = /^agent brief |^checklist artifact missing/;
// A cap kill, likewise, is the gate's OWN contention kill — not auth/quota. Matches the reasons
// cascadeVerdict sets from the judge's outage KIND (`judge timed out` / `escalation timed out`).
const TIMEOUT_INCONCLUSIVE_RE = /timed out$/;
// GUARD_REVIEW_SKIP / FRINK_REVIEW_SKIP: comma-list of reviewer names to drop from a run — the
// per-reviewer rollback lever (GUARD_NO_REVIEW kills the whole gate; this surgically disables one).
function skippedReviewers() {
    return new Set((process.env.GUARD_REVIEW_SKIP ?? process.env.FRINK_REVIEW_SKIP ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean));
}
// Every pass here — first, strict first, opus escalation — runs on the SHARED DEEP_JUDGE_TIMEOUT_MS
// (judge/run-judge.mts), as does the commit-msg completeness judge; the 30-min rationale lives with
// the constant. Three same-valued locals here is exactly how it drifted from completeness (sc-1227).
//
// Budget arithmetic — the ship ceiling bounds the WHOLE hook chain, not this gate alone: deterministic
// prefix ~240s + decisions ≤60s (both ≈0 on a cache hit) + this cascade gate + completeness on the same
// cap. PER-CASCADE worst ≈ 1800 (first) + 1800 (escalate) = 3600s; under the concurrency cap (default
// 2, see the docblock) cascades run in ceil(N/K) WAVES, so the theoretical worst far exceeds
// SHIP_COMMIT_TIMEOUT (3600s) — by design: a killed ship CONVERGES on re-run because PASSes checkpoint
// per-completion and the caches skip what was earned (docs/decisions/ship-gates-converge-not-restart.md).
// Only correctness nears the cap; the rest finish <300s, so a real ship is one slow wave + fast waves.
// Bounded-concurrency map: at most `limit` fn calls in flight, input order preserved.
// LOAD-BEARING: fn must never reject — the caller pre-wraps the cascade body in .catch. A worker
// rejection here would reject Promise.all and abandon siblings' pending per-completion checkpoints.
// ponytail: static pool. Load-adaptive sizing (os.loadavg / live concurrent-`claude` count) is the
// upgrade path if one fixed cap ever proves too blunt across differently-loaded machines.
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await fn(items[i], i);
        }
    };
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, worker));
    return results;
}
// argv-based on purpose: staged FILENAMES ride these calls, and a shell string (even
// JSON.stringify-quoted) lets a crafted path like `$(cmd).ts` expand before git runs.
function gitCached(cwd, args, files) {
    return execFileSync('git', ['diff', '--cached', ...args, '--', ...files], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
}
function stagedFiles(cwd) {
    return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
}
/**
 * One reviewer's cascade → {name, status: 'pass'|'fail'|'inconclusive', reason, escalated}.
 * `exec` is injectable for tests; the gate always passes execJudgeAsync.
 *
 * Wraps the verdict cascade with the checklist-artifact contract: the state file is cleaned
 * BEFORE the judge runs (a stale artifact from an interactive session must never satisfy the
 * gate), a PASS is voided to inconclusive when the artifact is missing/incomplete/inconsistent
 * (verifyChecklist), and the artifact is removed afterwards either way.
 */
export async function runCascade(sel, opts) {
    const { cwd } = opts;
    cleanupChecklistState(cwd, sel.reviewer);
    let res = await cascadeVerdict(sel, opts);
    res = await enforceChecklistContract(sel, res, cwd, opts.assetRoot, (reason) => cascadeVerdict(sel, { ...opts, checklistRecoveryReason: reason }));
    // Override valve: all failed lenses waived → PASS; any unwaived finding remains a named FAIL. Runs
    // BEFORE the cleanup below — the fingerprint needs the failed lens names off the artifact. Returns
    // what the gate decided about each failing lens, which the item vector records: an out-of-charter
    // drop and a waiver both leave a PASS behind, and only the disposition tells them apart.
    const disposition = applyOverrideValve(sel, res, cwd, {
        readState: () => readChecklistState(cwd, sel.reviewer),
        stagedDiff: () => gitCached(cwd, [], sel.files),
    });
    // LAST read before the artifact is destroyed, and for EVERY status — not just the failing pinned
    // path the valve above covers. This is the vector that answers "did this reviewer's lenses ever
    // fire", which four of the domain reviewers currently cannot be asked at all.
    attachItems(res, readChecklistState(cwd, sel.reviewer), disposition);
    cleanupChecklistState(cwd, sel.reviewer);
    return res;
}
async function cascadeVerdict({ reviewer, files }, { cwd, cfg, exec = execJudgeAsync, firstModel = 'haiku', retryFirst = false, assetRoot, judgeEnv, checklistRecoveryReason, }) {
    const body = agentBody(cwd, cfg, reviewer.name, assetRoot);
    if (body === null)
        // A missing brief must never be judged as an EMPTY brief (a wrapper-only prompt fake-passes):
        // inconclusive → fail-open on a normal commit, fail-closed on a ship — exactly the loudness
        // an updated-CLI-but-unsynced-agents consumer needs.
        return {
            name: reviewer.name,
            status: 'inconclusive',
            reason: `agent brief ${reviewer.name}.md missing under ${cfg.review.agentsDir} — run devkit sync-agents && devkit sync-skills`,
            escalated: false,
        };
    // A skill-less reviewer (no checklist, no Bash) gets its evidence PRE-RENDERED instead of a
    // "fetch it yourself" instruction: the capped diff (diff-evidence.mts) rides on stdin exactly
    // like completeness.mts's judge, and the governing CLAUDE.md rules (claude-md.mts) are baked
    // into the prompt itself.
    const stat = gitCached(cwd, ['--stat'], files);
    const prompt = hasChecklist(reviewer)
        ? wrapPrompt(body, reviewer, files, assetRoot, checklistRecoveryReason)
        : wrapConventionsPrompt(body, files, renderGoverningClaudeMd(cwd, files));
    const input = hasChecklist(reviewer)
        ? stat
        : buildCappedDiffEvidence(gitCached(cwd, [], files), stat);
    const args = (p, model) => [
        '-p',
        p,
        '--model',
        model,
        ...JUDGE_ISOLATION,
        '--allowedTools',
        allowedToolsFor(reviewer, cfg, assetRoot),
    ];
    // A model-pinned reviewer (correctness, conventions) runs single-pass at its pinned model — no escalation.
    const passModel = reviewer.model ?? firstModel;
    let firstOutage;
    const firstOpts = {
        label: `review:${reviewer.name}`,
        args: args(prompt, passModel),
        input,
        timeout: DEEP_JUDGE_TIMEOUT_MS,
        cwd,
        transcript: false, // this gate persists its own review-<name> transcript — don't store twice
        env: judgeEnv,
        onOutage: (kind) => {
            firstOutage = kind;
        },
    };
    let first = await exec(firstOpts);
    if (first === null && retryFirst && firstOutage !== 'timeout') {
        // Strict (ship) runs get ONE first-pass retry — a TRANSIENT/empty failure must not fail a ship
        // closed. A TIMEOUT is NOT retried: the pass already had the full DEEP_JUDGE_TIMEOUT_MS (a
        // contended judge got its time UP FRONT), so a re-run burns the same budget again past the ship
        // ceiling. The escalation pass never retries: outage stays inconclusive.
        // Colon (not " — ") on purpose: the ship timeout banner's awk reads `<name> — ` as COMPLETED.
        console.error(`guard-review: ${reviewer.name}: judge run failed (${firstOutage ?? 'transient'}), retrying once…`);
        cleanupChecklistState(cwd, reviewer); // a dead first pass may have left partial rows
        first = await exec(firstOpts);
    }
    if (first === null)
        return {
            name: reviewer.name,
            status: 'inconclusive',
            // The CAUSE rides in the reason so the strict remedy can name it (sc-1227): a cap kill is
            // not an auth/quota outage, and that remedy wastes the operator's time on a healthy CLI.
            reason: firstOutage === 'timeout' ? 'judge timed out' : 'judge outage',
            escalated: false,
            model: passModel,
        };
    const firstVerdict = parseReviewVerdict(first);
    if (firstVerdict.verdict === 'PASS')
        // Keep the judge's one-line PASS reason (the tail of its VERDICT line) instead of dropping it —
        // it flows to the telemetry event + the terminal line, and `first` is persisted as a transcript.
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
            escalated: false,
            model: passModel,
            transcript: first,
        };
    // Single-pass (model-pinned) reviewer: this FAIL is final — no opus escalation to second-guess it.
    if (reviewer.model)
        return {
            name: reviewer.name,
            status: 'fail',
            reason: firstVerdict.reason,
            escalated: false,
            model: passModel,
            transcript: first,
        };
    let secondOutage;
    const second = await exec({
        label: `review:${reviewer.name}:escalate`,
        args: args(escalatePrompt(prompt, first), 'opus'),
        input: stat,
        timeout: DEEP_JUDGE_TIMEOUT_MS, // opus re-investigation; only fires pre-block, never retried
        cwd,
        transcript: false, // this gate persists its own review-<name> transcript — don't store twice
        env: judgeEnv,
        onOutage: (kind) => {
            secondOutage = kind;
        },
    });
    if (second === null)
        return {
            name: reviewer.name,
            status: 'inconclusive',
            reason: secondOutage === 'timeout' ? 'escalation timed out' : 'escalation outage',
            escalated: true,
            model: passModel,
            transcript: first, // the first-pass FAIL evidence survives even when opus was dark
        };
    const finalVerdict = parseReviewVerdict(second);
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
        escalated: true,
        model: passModel,
        transcript: second,
    };
}
/**
 * The gate → exit code (see module contract). Selected reviewers run concurrently but BOUNDED to
 * `reviewConcurrency()` cascades in flight (GUARD_REVIEW_CONCURRENCY, default 2) — so under machine
 * load each judge keeps enough CPU + subscription slots to finish under its timeout. Wall-clock is
 * ceil(N/K) waves of the slowest cascade rather than the single slowest, a deliberate trade.
 */
export async function runReviewGate(cwd = process.cwd(), { exec = execJudgeAsync } = {}) {
    const timing = new ReviewGateTiming();
    const finish = (code) => timing.finish(code);
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
        selected = selectReviewers(stagedFiles(cwd), cfg);
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
        // Before the early return: a run where nothing was selected is still a run, and "this reviewer
        // did not look at this commit" is the fact that stops a later miss-analysis mislabelling it.
        emitUnselected(selected, knobDropped);
        if (selected.length === 0)
            return finish(0);
        if (reviewMode) {
            assetRoot = process.env.DEVKIT_REVIEW_ASSET_ROOT;
            identitySalts = preflightReviewAssets(assetRoot, selected, cfg);
        }
        // One domain diff per reviewer (its cache identity): the exact staged bytes in its files.
        diffs = selected.map((s) => gitCached(cwd, [], s.files));
    }
    catch (e) {
        if (reviewMode) {
            console.error(`guard-review: review setup failure — ${e instanceof Error ? e.message : String(e)}`);
            return finish(1);
        }
        console.error(`guard-review: could not run — ${e instanceof Error ? e.message : String(e)}${strict ? ' (strict ship mode: failing closed)' : ''}`);
        return finish(strict ? 3 : 2); // fail-open, except on a ship
    }
    const cache = loadCache(cwd);
    const firstModel = process.env.GUARD_REVIEW_MODEL ?? process.env.FRINK_REVIEW_MODEL ?? 'haiku';
    const concurrency = reviewConcurrency();
    timing.configure(selected.map((selection) => selection.reviewer.name), concurrency);
    const judgeEnv = reviewMode ? reviewJudgeEnv(cfg) : undefined;
    const verifyAssets = passAssetVerifier(reviewMode, assetRoot, cfg, identitySalts);
    // Prompt-version identity for this run. Review mode already computed it over the PACKAGED assets
    // (and needs the throwing preflight for its cache-safety contract); the ordinary commit/ship path
    // has no asset root, so it reads the SYNCED consumer copies best-effort — same formula, so the two
    // are comparable, and null rather than a throw when an asset is unreadable.
    const promptIdentity = (sel) => identitySalts.get(sel.reviewer.name) ?? consumerReviewerIdentity(cwd, cfg, sel.reviewer);
    const toRun = [];
    for (let i = 0; i < selected.length; i++) {
        const name = selected[i].reviewer.name;
        const key = cacheKey(name, diffs[i], identitySalts.get(name) ?? '');
        const cached = Boolean(cache[key]);
        // Emitted for BOTH branches, before any judge runs: the scope row is the only record a cached
        // PASS leaves behind that names the files and bytes it covered.
        emitReviewScope(selected[i], diffs[i], promptIdentity(selected[i]), cached);
        if (cached) {
            const cachedDuration = typeof cache[key].duration_ms === 'number' ? cache[key].duration_ms : 0;
            timing.cacheHit(name, cachedDuration);
            console.error(`guard-review: ${name} — cached PASS (identical diff)`);
            emitCacheHit(`review:${name}`, cache[key].model, cachedDuration);
        }
        else
            toRun.push({ sel: selected[i], key, diffText: diffs[i] });
    }
    if (toRun.length === 0)
        return finish(0);
    console.error(`guard-review: running ${toRun.map((t) => t.sel.reviewer.name).join(', ')} (≤${concurrency} concurrent, ${firstModel} → opus on FAIL)…`);
    // Checkpoint each PASS as it lands, so a killed ship reruns only unfinished reviewers. The
    // progress JSON names unfinished work; heartbeat lines remain for humans. The catch prevents one
    // rejected cascade from abandoning its siblings (see mapLimit).
    const progressFile = process.env.DEVKIT_REVIEW_PROGRESS || null;
    // `running` = every reviewer to run, recorded up front. Under the concurrency cap some are QUEUED,
    // not yet started, so on a mid-flight kill `unfinishedReviewers` (running − completed) also names
    // never-started reviewers. Correct for the banner's purpose — they're uncached and WILL be retried.
    const running = toRun.map((t) => t.sel.reviewer.name);
    const completed = [];
    if (progressFile)
        writeProgress(progressFile, { running, completed });
    const results = await mapLimit(toRun, concurrency, (t) => {
        const t0 = Date.now();
        return runCascade(t.sel, {
            cwd,
            cfg,
            exec,
            firstModel,
            retryFirst: strict,
            assetRoot,
            judgeEnv,
        })
            .catch((e) => ({
            name: t.sel.reviewer.name,
            status: reviewMode ? 'error' : 'inconclusive',
            reason: `engine error: ${e?.message ?? e}`,
            escalated: false,
        }))
            .then((outcome) => {
            const res = verifyAssets(outcome, t.sel);
            const durationMs = Date.now() - t0;
            timing.observed(res.name, durationMs);
            if (res.status === 'pass')
                // res.model = the model that actually judged (a Reviewer.model pin wins over the cascade
                // default) — recording firstModel here mislabeled every pinned reviewer's cached PASS.
                savePasses(cwd, {
                    [t.key]: {
                        at: new Date().toISOString(),
                        model: res.model ?? firstModel,
                        duration_ms: durationMs,
                    },
                });
            if (progressFile) {
                completed.push(res.name);
                writeProgress(progressFile, { running, completed });
            }
            const secs = Math.round(durationMs / 1000);
            // Persist the full judge transcript — the reviewed diff AND the agent's output — so a PASS
            // reviewer's reasoning is fetchable on demand rather than discarded; the event carries only
            // the ref + one-liner. No-op off-run (see run-context.mts).
            const transcriptRef = res.transcript
                ? saveTranscript(`review-${res.name}`, composeTranscript(t.diffText, res.transcript))
                : null;
            // Ship telemetry (best-effort, no-op off-ship): every reviewer outcome (pass/fail/
            // inconclusive) so the usage tracker can report per-reviewer error counts and fail-rate.
            emitGateEvent({
                type: 'review_result',
                reviewer: res.name,
                status: res.status,
                escalated: res.escalated,
                // First-pass model that actually ran (pin-aware); firstModel only when no judge ran at
                // all (missing brief / engine error), keeping the field always present for consumers.
                model: res.model ?? firstModel,
                reason: res.reason,
                secs,
                ...(res.waivers?.length ? { waivers: res.waivers } : {}),
                // The per-lens vector, passes included; empty when the judge left no artifact (see
                // evidence/items.mts for the shape and the spill rule).
                ...itemFields(res),
                ...(transcriptRef ? { transcript_ref: transcriptRef } : {}),
            });
            // Surface the one-line verdict reason on the completion line too (fails get theirs in the
            // dedicated block below, with the full transcript — don't double-print it here).
            const tail = !['fail', 'error'].includes(res.status) && res.reason ? ` — ${res.reason}` : '';
            console.error(`guard-review: ${res.name} — ${res.status.toUpperCase()}${res.escalated ? ' (escalated)' : ''} in ${secs}s${res.status === 'pass' ? ' (checkpointed)' : ''}${tail}`);
            return res;
        });
    });
    if (progressFile)
        clearProgress(progressFile); // ran to completion → nothing unfinished to report
    const fails = results.filter((r) => r.status === 'fail');
    for (const f of fails) {
        console.error(`guard-review: ${f.name} FAILED${f.escalated ? ' (opus-confirmed)' : ''} — ${f.reason || 'see findings below'}`);
        if (f.transcript)
            console.error(f.transcript.trim());
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
        // The remedy must match the CAUSE (wording: judge/run-judge strictRemedy). A missing brief
        // (cascadeVerdict) or missing checklist artifact (verifyChecklist) is a SYNC gap — auth/quota is
        // actively wrong there and contradicts the reason; in a `devkit ship` worktree the briefs/skills
        // must also be LINKED in (ship-branch.sh does this), an un-synced main checkout being the other
        // cause. A cap kill is a TIMEOUT, also not auth/quota. Only a genuine dark judge keeps it.
        const remedy = strictRemedy(SYNC_INCONCLUSIVE_RE.test(r.reason)
            ? 'sync'
            : TIMEOUT_INCONCLUSIVE_RE.test(r.reason)
                ? 'timeout'
                : 'outage');
        console.error(strict
            ? `guard-review: ${r.name} INCONCLUSIVE (${r.reason}) — strict ship mode fails closed.\n` +
                `   Remedy: ${remedy} (completed verdicts are cached).`
            : `guard-review: ${r.name} inconclusive — ${r.reason} (fail-open, not cached)`);
    }
    if (inconclusive.length > 0)
        return finish(strict ? 3 : 2);
    return finish(0);
}
/** `guard-review scan` — reviewer→files mapping + cache status, no judges. Informational. */
export function scanReview(cwd = process.cwd()) {
    try {
        const cfg = resolveGuardConfig(cwd);
        const cache = loadCache(cwd);
        for (const s of selectReviewers(stagedFiles(cwd), cfg)) {
            const diff = gitCached(cwd, [], s.files);
            const hit = cache[cacheKey(s.reviewer.name, diff)] ? ' [cached PASS]' : '';
            console.log(`${s.reviewer.name}${hit}: ${s.files.join(', ')}`);
        }
    }
    catch (e) {
        console.error(`guard-review: scan failed — ${e instanceof Error ? e.message : String(e)}`);
    }
    return 0;
}
