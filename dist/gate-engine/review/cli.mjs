#!/usr/bin/env node
/**
 * guard-review — the in-chain reviewer gate CLI.
 *
 *   guard-review --gate                          run the selected domain reviewers (pre-commit)
 *   guard-review completeness --gate <msg-file>  feature-completeness judge (commit-msg, warn-only)
 *   guard-review scan                            reviewer→files mapping + cache status (no judges)
 *   guard-review clear-cache                     drop cached PASS verdicts
 *   guard-review waive <reviewer>[:<lens>] <id> "<why>"   record an override (see valve/waive.mts)
 *   guard-review waive --list                    show active waives
 *   guard-review transcript <ref>                print a persisted agent transcript by its ref
 *
 * Everything resolves from resolveGuardConfig(process.cwd()) — the CONSUMER repo, never the
 * package dir (W-3). Exit contract per sub-engine (run-review.mjs / completeness.mjs headers).
 */
import { envFlag, resolveGuardConfig } from "../config.mjs";
import { readTranscript } from "../judge/transcript-store.mjs";
import { clearCache, loadCache } from "./cache.mjs";
import { runCompleteness } from "./completeness.mjs";
import { gitCached, stagedFiles } from "./evidence/staged-git.mjs";
import { loadReviewerTargetsBlocks, reviewerTargetSalts } from "./evidence/targets-block.mjs";
import { cacheKey, selectReviewers } from "./reviewers.mjs";
import { runReviewGate } from "./run-review.mjs";
import { resolveReviewerIdentities } from "./runtime.mjs";
import { runWaive } from "./valve/waive.mjs";
/**
 * `guard-review scan` — reviewer→files mapping + cache status, no judges. Informational. Salt
 * resolution matches the gate's COMMIT path (sc-1437), or the reported status would lie after an
 * asset edit; scan is not authoritative under review mode (no packaged-asset preflight here).
 */
async function scanReview(cwd = process.cwd()) {
    try {
        const cfg = resolveGuardConfig(cwd);
        const cache = loadCache(cwd);
        const sels = selectReviewers(stagedFiles(cwd), cfg);
        const { cacheSalts } = resolveReviewerIdentities(false, new Map(), sels, cwd, cfg);
        // Same salt composition as the gate (sc-1441/sc-1442: scope-only Target bytes join checklist
        // salts) — keying on cacheSalts alone reported '[cached PASS]' for entries the gate re-judges.
        const { saltBlock } = await loadReviewerTargetsBlocks(cwd, stagedFiles(cwd));
        const salts = reviewerTargetSalts(sels, cacheSalts, saltBlock);
        for (const s of sels) {
            const diff = gitCached(cwd, [], s.files);
            const salt = salts.get(s.reviewer.name) ?? '';
            const hit = cache[cacheKey(s.reviewer.name, diff, salt)] ? ' [cached PASS]' : '';
            console.log(`${s.reviewer.name}${hit}: ${s.files.join(', ')}`);
        }
    }
    catch (e) {
        console.error(`guard-review: scan failed — ${e instanceof Error ? e.message : String(e)}`);
    }
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
    if (cmd === 'clear-cache') {
        clearCache(process.cwd());
        return 0;
    }
    if (cmd === 'waive' && rest.length >= 1)
        return runWaive(rest);
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
    console.error('Usage: guard-review --gate | completeness --gate <msg-file> | scan | clear-cache | ' +
        'waive <reviewer>[:<lens>] <id> "<why>" | waive --list | transcript <ref>');
    return 2;
}
run(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`guard-review: ${e?.message ?? e}`);
    // Fail-open — an engine crash must never hard-block a commit — EXCEPT on a strict ship
    // run (GUARD_AI_STRICT), where a dark gate must block rather than silently skip.
    process.exit(envFlag('AI_STRICT') ? 3 : 2);
});
