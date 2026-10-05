#!/usr/bin/env node
/**
 * guard-review — the in-chain reviewer gate CLI.
 *
 *   guard-review --gate                          run the selected domain reviewers (pre-commit)
 *   guard-review completeness --gate <msg-file>  feature-completeness judge (commit-msg, warn-only)
 *   guard-review scan                            reviewer→files mapping + cache status (no judges)
 *   guard-review lens <reviewer>[:<lens>]        re-judge ONE reviewer/lens on the staged index
 *   guard-review clear-cache                     drop cached PASS verdicts
 *   guard-review waive <reviewer>[:<lens>] <id> [--base <sha>] "<why>"  record an override
 *   guard-review waive --list                    show active waives
 *   guard-review transcript <ref>                print a persisted agent transcript by its ref
 *   guard-review record-agent <label>            record one Task-dispatched agent run (stdin)
 *   guard-review record-feedback prior-art --run <id> ...  claim a correction to a recorded run
 *
 * Everything resolves from resolveGuardConfig(process.cwd()) — the CONSUMER repo, never the
 * package dir (W-3). Exit contract per sub-engine (run-review.mjs / completeness.mjs headers).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { envFlag, resolveGuardConfig } from '../config.mjs';
import { recordAgentRun } from '../judge/run-judge.mjs';
import { readTranscript } from '../judge/transcript-store.mjs';
import { clearCache, loadCache } from './cache.mjs';
import { runRecordFeedback } from '../prior-art/feedback.mjs';
import { runCompleteness } from './completeness.mjs';
import { gitCached, stagedFiles } from './evidence/staged-git.mjs';
import { loadReviewerTargetsBlocks, reviewerTargetSalts } from './evidence/targets-block.mjs';
import { planReviewWork, resolveChunkCap, resolveLensGroups } from './lens/split.mjs';
import { cacheKey, resolveEscalationModel, resolveReviewModel } from './reviewers.mjs';
import { selectRepositoryReviewers } from './scope/repository.mjs';
import { runReviewGate } from './run-review.mjs';
import { resolveReviewerIdentities, skippedReviewers } from './runtime.mjs';
import { parseRecheckTarget } from './valve/recheck.mjs';
import { runWaive } from './valve/waive.mjs';
/**
 * `guard-review scan` — reviewer→files mapping + cache status, no judges. Informational. Cache
 * status is computed by `planReviewWork` — the gate's OWN planner — so scan can never diverge
 * from what the commit path would actually skip (sc-1473: a hand-rolled key here missed the
 * lens-split suffix and made a cached correctness-reviewer structurally unreportable). Scan is
 * not authoritative under review mode (no packaged-asset preflight here).
 */
async function printReviewScan(cwd) {
    const cfg = resolveGuardConfig(cwd);
    const cache = loadCache(cwd);
    // Same GUARD_REVIEW_SKIP filter as the gate: a skipped reviewer's cached PASS must not be
    // reported as work the gate would skip-by-cache — the gate never plans it at all.
    const skip = skippedReviewers();
    const staged = stagedFiles(cwd);
    const sels = selectRepositoryReviewers(staged, cfg).filter((selection) => !skip.has(selection.reviewer.name));
    const { cacheSalts } = resolveReviewerIdentities(false, new Map(), sels, cwd, cfg);
    // Same salt composition as the gate (sc-1441/sc-1442: scope-only Target bytes join checklist
    // salts) — keying on cacheSalts alone reported '[cached PASS]' for entries the gate re-judges.
    const { saltBlock } = await loadReviewerTargetsBlocks(cwd, staged);
    const salts = reviewerTargetSalts(sels, cacheSalts, saltBlock, resolveReviewModel(cfg), resolveEscalationModel(cfg));
    const diffs = sels.map((selection) => gitCached(cwd, [], selection.files));
    // Same consumer-cwd chunk resolution as the gate (W-3) — a divergent default here would make
    // scan disagree with the gate's plan on configured installs.
    const plan = planReviewWork(sels, diffs, cache, salts, cacheKey, resolveLensGroups(), resolveChunkCap(process.env.GUARD_CORRECTNESS_CHUNK, cfg.review.correctnessChunkLoc));
    for (const { sel, cached } of plan.scope) {
        console.log(`${sel.reviewer.name}${cached ? ' [cached PASS]' : ''}: ${sel.files.join(', ')}`);
    }
}
async function scanReview(cwd = process.cwd()) {
    try {
        await printReviewScan(cwd);
    }
    catch (e) {
        console.error(`guard-review: scan failed — ${e instanceof Error ? e.message : String(e)}`);
    }
    return 0;
}
/** Raw bytes from a path or fd; null when unreadable. Hashing raw bytes keeps CRLF/invalid UTF-8 exact. */
function readBytes(source) {
    try {
        return readFileSync(source);
    }
    catch {
        return null;
    }
}
/** Strict UTF-8 text, or null: a lossy decode would store bytes the recorded hash does not cover. */
function exactText(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        return null;
    }
}
function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
/** The dispositions a root agent may report. Anything else is dropped, so the field stays groupable. */
const DISPOSITIONS = new Set(['followed', 'overridden', 'unverified']);
/**
 * `guard-review record-agent <label>` — record ONE agent run the assistant dispatched itself.
 *
 * The reviewers reach telemetry through `execJudge`, which emits their `judge_exec` line and stores
 * their transcript. An agent spawned via the Task tool never enters that path: the `prior-art`
 * subagent the brainstorming skill invokes was therefore invisible in production, while its BENCH
 * runs — which do go through execJudgeAsync — were fully recorded. This is the entry point for those
 * runs; `recordAgentRun` is the one implementation both use, so a Task-dispatched agent and a
 * spawned judge land the same event shape.
 *
 * The response arrives on stdin. ALWAYS returns 0: telemetry must never block, and the caller here
 * is an assistant mid-conversation rather than a gate.
 */
function recordAgent(label, rest) {
    const flag = (name) => {
        const i = rest.indexOf(`--${name}`);
        return i !== -1 && i + 1 < rest.length ? rest[i + 1] : undefined;
    };
    // One correlation id PER INVOCATION. Without it runId() falls back to `commit-<write-tree>`, and
    // two prior-art runs made before anything is staged — the normal case, since this fires during
    // brainstorming — would share an id and merge downstream into a single synthesized commit row.
    // A ship/review that legitimately owns the run still wins: runId() checks those first.
    process.env.DEVKIT_AGENT_RUN_ID ||= `agent-${randomUUID()}`;
    // A tty or closed pipe reads as empty — still emit the event. That the agent RAN is the fact the
    // dashboard needs most, and a run recorded without its transcript beats a run recorded nowhere.
    const stdin = readBytes(0) ?? Buffer.alloc(0);
    const exactOutput = exactText(stdin);
    const output = exactOutput ?? stdin.toString('utf8');
    const requestFile = flag('request-file');
    const request = requestFile === undefined ? null : readBytes(requestFile);
    if (requestFile !== undefined && !request)
        console.error(`guard-review: cannot read --request-file "${requestFile}"; recording without it`);
    const duration = Number.parseInt(flag('duration-ms') ?? '', 10);
    const disposition = flag('disposition');
    const reason = flag('reason');
    if (disposition !== undefined && !DISPOSITIONS.has(disposition))
        console.error(`guard-review: ignoring unknown --disposition "${disposition}" ` +
            `(expected ${[...DISPOSITIONS].join(' | ')})`);
    // Minted HERE, never runId(): a ship/review id is shared, and feedback must cite one run.
    const receipt = {
        invocation_id: randomUUID(),
        output_sha256: sha256(stdin),
    };
    if (exactOutput === null)
        receipt.output_status = 'not_utf8';
    const input = request ? exactText(request) : null;
    if (request)
        receipt.request_sha256 = sha256(request);
    if (requestFile !== undefined && input === null)
        receipt.request_status = request ? 'not_utf8' : 'unreadable';
    const extra = { ...receipt };
    if (disposition !== undefined && DISPOSITIONS.has(disposition))
        extra.disposition = disposition;
    if (reason)
        extra.disposition_reason = reason;
    // Spend flags, mirroring the judge_exec usage keys execJudge emits so a Task-dispatched agent's
    // row prices identically in the warehouse. A malformed or negative value OMITS the key — an
    // emitted 0 would read downstream as a genuinely free agent and deflate every cost total.
    for (const name of [
        'input-tokens',
        'output-tokens',
        'cache-creation',
        'cache-read',
        'cost-usd',
    ]) {
        // Number(), not parseFloat: '1200oops' must read as malformed, never as a fabricated 1200.
        // Token counters are integers; only cost-usd is legitimately fractional.
        const raw = (flag(name) ?? '').trim();
        const n = raw === '' ? Number.NaN : Number(raw);
        if (Number.isFinite(n) && n >= 0 && (name === 'cost-usd' || Number.isInteger(n)))
            extra[name.replace(/-/g, '_')] = n;
    }
    // The DISPATCHED agent's own session; the root session rides the envelope as parent_session_id.
    const sessionId = flag('session-id');
    if (sessionId)
        extra.session_id = sessionId;
    const billing = flag('billing');
    if (billing)
        extra.billing = billing;
    const { ref, telemetry } = recordAgentRun({
        label,
        output,
        input: input ?? undefined,
        // A lossy response copy would not match output_sha256, so store no transcript at all.
        transcript: exactOutput !== null,
        model: flag('model') ?? null,
        ...(Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
        extra,
    });
    console.log(JSON.stringify({ ...receipt, transcript_ref: ref, telemetry }));
    return 0;
}
async function run(argv) {
    const [cmd, ...rest] = argv;
    if (cmd === '--gate')
        return runReviewGate();
    if (cmd === 'completeness' && rest[0] === '--gate' && rest[1])
        return runCompleteness(rest[1]);
    if (cmd === 'scan')
        return scanReview();
    if (cmd === 'lens' && rest[0]) {
        let only;
        try {
            only = parseRecheckTarget(rest[0]);
        }
        catch (e) {
            console.error(`guard-review lens: ${e instanceof Error ? e.message : String(e)}`);
            return 2;
        }
        // The gate exits 0 on these, which a recheck must never mistake for "the fix cleared it".
        if (envFlag('NO_REVIEW') || resolveGuardConfig().noLlm) {
            console.error('guard-review lens: review is disabled (GUARD_NO_REVIEW / noLlm) — nothing judged');
            return 1;
        }
        // Same per-invocation id rule as waive below: never filed as a fabricated commit run.
        process.env.DEVKIT_AGENT_RUN_ID ||= `recheck-${randomUUID()}`;
        return runReviewGate(process.cwd(), { only });
    }
    if (cmd === 'clear-cache') {
        clearCache(process.cwd());
        return 0;
    }
    if (cmd === 'waive' && rest.length >= 1) {
        // Same per-invocation id rule as recordAgent above: without it a plain CLI waive falls back to
        // runId()'s `commit-<write-tree>` envelope — run_mode:'commit' fabricates a commit run the
        // collector synthesizes a row for, and two waives on an unchanged index share one id. A
        // ship/review that legitimately owns the run still wins: runId() checks those first.
        process.env.DEVKIT_AGENT_RUN_ID ||= `waive-${randomUUID()}`;
        return runWaive(rest);
    }
    // The local "API" behind a transcript_ref: cat any persisted agent transcript (review-* OR
    // decisions) the telemetry stream referenced, so a human can read the full reasoning on demand.
    if (cmd === 'transcript' && rest[0]) {
        const text = readTranscript(rest[0]);
        if (text === null) {
            console.error(`guard-review: no transcript at ${rest[0]}`);
            return 1;
        }
        process.stdout.write(text);
        return 0;
    }
    if (cmd === 'record-agent' && rest[0])
        return recordAgent(rest[0], rest.slice(1));
    if (cmd === 'record-feedback' && rest[0] === 'prior-art') {
        // Same id rule as record-agent and waive: replaces runId()'s fabricated commit-<write-tree>
        // run; a ship/review that owns the call still wins. invocation_id is the link to the run.
        process.env.DEVKIT_AGENT_RUN_ID ||= `feedback-${randomUUID()}`;
        return runRecordFeedback(rest.slice(1));
    }
    console.error('Usage: guard-review --gate | completeness --gate <msg-file> | scan | lens <reviewer>[:<lens>] | clear-cache | ' +
        'waive <reviewer>[:<lens>] <id> [--base <sha>] "<why>" | waive --list | transcript <ref> | ' +
        'record-agent <label> [--request-file <path>] [--model <m>] [--duration-ms <n>] ' +
        '[--disposition followed|overridden|unverified] [--reason "<why>"] ' +
        '[--input-tokens <n>] [--output-tokens <n>] [--cache-creation <n>] [--cache-read <n>] ' +
        '[--cost-usd <n>] [--session-id <dispatched-agent-session>] [--billing subscription] | ' +
        'record-feedback prior-art --run <invocation_id> --claimed-verdict <V> [--claimed-framing <F>] ' +
        '[--supersedes <feedback_id>] --source root|user --reason "<why>"');
    return 2;
}
run(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`guard-review: ${e?.message ?? e}`);
    // Fail-open — an engine crash must never hard-block a commit — EXCEPT on a strict ship
    // run (GUARD_AI_STRICT), where a dark gate must block rather than silently skip.
    process.exit(envFlag('AI_STRICT') ? 3 : 2);
});
