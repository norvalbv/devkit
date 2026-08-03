import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { checklistAssetPath, checklistScriptAt, hasChecklist, REVIEWERS, verifyChecklist, } from "./reviewers.mjs";
const REVIEW_ROOTS_HELPER = 'skills/_devkit/review-roots.mjs';
// Imported by every checklist script (createChecklistStore), so its bytes are execution inputs of
// every checklist reviewer — the bench's gateHash already treats it that way (corpus.mts
// SHARED_HELPERS); omitting it here once shipped a store edit that no cache key noticed.
const CHECKLIST_STORE_HELPER = 'skills/_devkit/checklist-store.mjs';
/**
 * Cache-key salt for a reviewer whose consumer-side identity cannot be computed (an unreadable
 * synced asset → `consumerReviewerIdentity` returns null). Deliberately NOT '' — '' is the legacy
 * pre-salt namespace every historical PASS was keyed under, so an empty fallback would replay
 * exactly the stale PASSes the salt exists to invalidate. A distinct sentinel gives the
 * unattributable population its own namespace: still cached (identical diff re-runs stay free),
 * never aliased to a verdict produced by a different prompt version.
 */
export const UNATTRIBUTABLE_IDENTITY_SALT = 'devkit:unattributable-v1';
/** Entrypoint selected by the generated hook from a frozen review package runtime. */
export const PACKAGED_REVIEW_RUNTIME_ENTRYPOINT = 'gate-engine/review/baseline-gate';
/** Entrypoint plus every package-local module it imports, without source/build extensions. */
export const PACKAGED_REVIEW_RUNTIME_MODULE_STEMS = Object.freeze(['gate-engine/review/baseline-fallow-paths', PACKAGED_REVIEW_RUNTIME_ENTRYPOINT].sort());
function reviewerAssetPaths(reviewer) {
    const paths = [`agents/${reviewer.name}.md`];
    if (hasChecklist(reviewer)) {
        paths.push(`skills/${reviewer.skill}/SKILL.md`, checklistAssetPath(reviewer), REVIEW_ROOTS_HELPER, CHECKLIST_STORE_HELPER);
    }
    return paths;
}
/** The package-relative agent-facing asset contract, independent of consumer agent surfaces. */
export const PACKAGED_REVIEW_ASSET_PATHS = Object.freeze([...new Set([REVIEW_ROOTS_HELPER, ...REVIEWERS.flatMap(reviewerAssetPaths)])].sort());
function readPackagedReviewAsset(assetRoot, relativePath) {
    return readFileSync(path.join(assetRoot, relativePath));
}
export function agentBody(cwd, cfg, name, assetRoot) {
    const dir = assetRoot ? path.join(assetRoot, 'agents') : cfg.review.agentsDir;
    const file = path.join(path.isAbsolute(dir) ? dir : path.resolve(cwd, dir), `${name}.md`);
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return null;
    }
}
/**
 * The identity of one reviewer's execution inputs: its brief, its registry entry, its checklist
 * trio when it has one, and the config subset that changes WHAT it reviews.
 *
 * Deliberately shared by the packaged review-mode preflight and the consumer-path telemetry stamp:
 * one formula means a review-mode identity and a ship-mode identity are COMPARABLE whenever the
 * bytes match, which is the entire reason for recording it. Two formulas would silently produce two
 * incomparable namespaces and every cross-mode rate would be a blend.
 */
function hashReviewerIdentity(readAsset, reviewer, cfg) {
    const [brief, skill, checklist] = reviewerAssetPaths(reviewer);
    const hash = createHash('sha256')
        .update(readAsset(brief))
        .update(JSON.stringify(reviewer));
    if (hasChecklist(reviewer)) {
        hash.update(readAsset(skill));
        hash.update(readAsset(checklist));
        hash.update(readAsset(REVIEW_ROOTS_HELPER));
        hash.update(readAsset(CHECKLIST_STORE_HELPER));
    }
    hash.update(JSON.stringify({
        scanRoots: cfg.scanRoots,
        sourceExtensions: cfg.sourceExtensions,
        review: cfg.review,
        indexPath: cfg.indexPath,
        searchTool: cfg.searchTool,
    }));
    return hash.digest('hex');
}
/** Validate and fingerprint current packaged assets before a review-mode cache lookup. */
export function preflightReviewAssets(assetRoot, selected, cfg) {
    if (!assetRoot || !path.isAbsolute(assetRoot))
        throw new Error('DEVKIT_REVIEW_ASSET_ROOT is missing or not absolute');
    // Eager, before the loop: an unreadable helper is a packaging fault, and it must surface even when
    // no selected reviewer happens to carry a checklist.
    readPackagedReviewAsset(assetRoot, REVIEW_ROOTS_HELPER);
    readPackagedReviewAsset(assetRoot, CHECKLIST_STORE_HELPER);
    const identities = new Map();
    for (const { reviewer } of selected) {
        if (hasChecklist(reviewer)) {
            if (!reviewer.stateFile.startsWith('.claude/') || !reviewer.cmds.gen || !reviewer.cmds.check)
                throw new Error(`${reviewer.name} has an invalid checklist registry binding`);
        }
        identities.set(reviewer.name, hashReviewerIdentity((rel) => readPackagedReviewAsset(assetRoot, rel), reviewer, cfg));
    }
    return identities;
}
/**
 * The SYNCED consumer copy of a packaged asset. `reviewerAssetPaths` names package-relative paths;
 * a consumer keeps its briefs wherever `review.agentsDir` points (configurable) and every skill
 * asset under `.claude/` — devkit's own sync convention, the same one `checklistScript` encodes.
 */
function readConsumerReviewAsset(cwd, cfg, relativePath) {
    const AGENTS_PREFIX = 'agents/';
    if (relativePath.startsWith(AGENTS_PREFIX)) {
        const dir = cfg.review.agentsDir;
        const base = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
        return readFileSync(path.join(base, relativePath.slice(AGENTS_PREFIX.length)));
    }
    return readFileSync(path.resolve(cwd, '.claude', relativePath));
}
/**
 * Per-reviewer prompt identity for the ordinary commit/ship path, where there is no packaged asset
 * root and `preflightReviewAssets` therefore never runs. This is what makes a production verdict
 * attributable to the prompt version that produced it — AND, since sc-1437, what salts the verdict
 * cache key on this path, so editing a synced brief/checklist/SKILL.md invalidates cached PASSes in
 * the field exactly as review mode's preflight does. Identity resolves from the RUNNING cwd while
 * the cache file anchors to the main checkout (verdict-store) — deliberate: the key describes what
 * the judge would actually read from here.
 *
 * Returns null on ANY unreadable asset rather than throwing: telemetry must never fail a gate, and
 * the cache path substitutes UNATTRIBUTABLE_IDENTITY_SALT for null (never '', the legacy
 * namespace). A genuinely missing brief is already handled upstream — `cascadeVerdict` resolves it
 * to `inconclusive` — so a null here means "unattributable", never "broken".
 */
/**
 * Identity + cache-salt resolution for one gate run — the ONE place the salt is composed (sc-1441
 * will fold the rendered Targets block in here).
 *
 * Review mode: the packaged preflight salts (throwing contract) serve both roles. Commit/ship path:
 * the consumer identity serves telemetry with honest nulls, while the cache salt substitutes
 * UNATTRIBUTABLE_IDENTITY_SALT for null — never '', the legacy pre-salt namespace whose reuse would
 * replay stale PASSes for exactly the unattributable population.
 */
export function resolveReviewerIdentities(reviewMode, identitySalts, selected, cwd, cfg) {
    if (reviewMode)
        return { identities: identitySalts, cacheSalts: identitySalts };
    const identities = new Map();
    for (const s of selected)
        identities.set(s.reviewer.name, consumerReviewerIdentity(cwd, cfg, s.reviewer));
    const cacheSalts = new Map([...identities].map(([name, id]) => [name, id ?? UNATTRIBUTABLE_IDENTITY_SALT]));
    return { identities, cacheSalts };
}
export function consumerReviewerIdentity(cwd, cfg, reviewer) {
    try {
        return hashReviewerIdentity((rel) => readConsumerReviewAsset(cwd, cfg, rel), reviewer, cfg);
    }
    catch {
        return null;
    }
}
/** Recheck one completed reviewer's exact execution inputs before its PASS becomes durable. */
export function verifyReviewAssetIdentity(assetRoot, selected, cfg, expected) {
    const actual = preflightReviewAssets(assetRoot, [selected], cfg).get(selected.reviewer.name);
    if (actual !== expected)
        throw new Error(`${selected.reviewer.name} assets changed while the reviewer was running`);
}
/** Build the PASS checkpoint guard once from the immutable review-run context. */
export function passAssetVerifier(reviewMode, assetRoot, cfg, expectedByReviewer) {
    return (outcome, selected) => {
        if (!reviewMode || outcome.status !== 'pass')
            return outcome;
        try {
            verifyReviewAssetIdentity(assetRoot, selected, cfg, expectedByReviewer.get(selected.reviewer.name) ?? '');
            return outcome;
        }
        catch (cause) {
            return {
                ...outcome,
                status: 'error',
                reason: `asset integrity failure: ${cause instanceof Error ? cause.message : String(cause)}`,
            };
        }
    };
}
export function reviewJudgeEnv(cfg) {
    return {
        ...process.env,
        DEVKIT_REVIEW_BACKEND_ROOTS: JSON.stringify(cfg.review.backendRoots),
        DEVKIT_REVIEW_FRONTEND_ROOTS: JSON.stringify(cfg.review.frontendRoots),
    };
}
/** Parsed checklist state-file artifact for a reviewer, or null (missing/corrupt/no checklist at
 * all — a skill-less reviewer has no stateFile to read → unverifiable). */
export function readChecklistState(cwd, reviewer) {
    if (!reviewer.stateFile)
        return null;
    try {
        return JSON.parse(readFileSync(path.resolve(cwd, reviewer.stateFile), 'utf8'));
    }
    catch {
        return null;
    }
}
/** Remove a reviewer's checklist artifact so a stale one can never satisfy the NEXT run. A
 * skill-less reviewer has no stateFile — nothing to clean up. */
export function cleanupChecklistState(cwd, reviewer) {
    if (reviewer.stateFile)
        rmSync(path.resolve(cwd, reviewer.stateFile), { force: true });
}
/**
 * Deterministically seed commit-guard's per-file checklist before the headless judge runs.
 * Domain reviewers reliably generate their small fixed-lens checklists themselves; commit-guard's
 * longer interactive brief has repeatedly returned a prose PASS without executing `init`, leaving
 * strict ship permanently inconclusive. The gate owns enumeration, while the judge still owns every
 * per-file pass/fail mark and `finalize` — a pre-seeded all-pending artifact grants no authority.
 */
export function initializeCommitGuardChecklist(cwd, reviewer, assetRoot, env = process.env) {
    if (reviewer.name !== 'commit-guard' || !hasChecklist(reviewer))
        return;
    const script = checklistScriptAt(reviewer, assetRoot);
    try {
        execFileSync(process.execPath, [script, reviewer.cmds.gen], {
            cwd,
            encoding: 'utf8',
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch (cause) {
        const stderr = cause && typeof cause === 'object' && 'stderr' in cause ? String(cause.stderr).trim() : '';
        throw new Error(`commit-guard checklist initialization failed${stderr ? ` — ${stderr}` : ''}`);
    }
    const files = readChecklistState(cwd, reviewer)?.files;
    if (!Array.isArray(files) || files.length === 0)
        throw new Error('commit-guard checklist initialization produced no staged files');
}
/** Review-mode packaged assets make a missing checklist an execution-contract error, not a sync gap. */
export async function enforceChecklistContract(selection, initial, cwd, assetRoot, retry) {
    // A skill-less reviewer (no stateFile) has no artifact to verify — its PASS is trusted
    // directly, the same trust level completeness.mts already uses for its own straight verdict;
    // its substitute anti-hallucination mechanism is the AC's own quote-both-or-stay-silent
    // contract, enforced by the brief, not an artifact this gate can independently check.
    if (initial.status !== 'pass' || !selection.reviewer.stateFile)
        return initial;
    let result = initial;
    let hole = verifyChecklist(readChecklistState(cwd, selection.reviewer), 'PASS');
    if (hole && assetRoot) {
        console.error(`guard-review: ${selection.reviewer.name} — checklist contract not satisfied; retrying once (${hole})`);
        cleanupChecklistState(cwd, selection.reviewer);
        result = await retry(hole);
        if (initial.transcript && result.transcript)
            result.transcript = `${initial.transcript}\n\n───── CHECKLIST-CONTRACT RETRY ─────\n${result.transcript}`;
        if (result.status === 'pass') {
            hole = verifyChecklist(readChecklistState(cwd, selection.reviewer), 'PASS');
            if (hole) {
                result.status = 'error';
                result.reason = `reviewer checklist contract failed after one retry — ${hole}`;
            }
        }
    }
    else if (hole) {
        result.status = 'inconclusive';
        result.reason = hole;
    }
    return result;
}
