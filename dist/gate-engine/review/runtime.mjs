import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { checklistAssetPath, hasChecklist, REVIEWERS, verifyChecklist, } from "./reviewers.mjs";
const REVIEW_ROOTS_HELPER = 'skills/_devkit/review-roots.mjs';
/** Entrypoint selected by the generated hook from a frozen review package runtime. */
export const PACKAGED_REVIEW_RUNTIME_ENTRYPOINT = 'gate-engine/review/baseline-gate';
/** Entrypoint plus every package-local module it imports, without source/build extensions. */
export const PACKAGED_REVIEW_RUNTIME_MODULE_STEMS = Object.freeze(['gate-engine/review/baseline-fallow-paths', PACKAGED_REVIEW_RUNTIME_ENTRYPOINT].sort());
function reviewerAssetPaths(reviewer) {
    const paths = [`agents/${reviewer.name}.md`];
    if (hasChecklist(reviewer)) {
        paths.push(`skills/${reviewer.skill}/SKILL.md`, checklistAssetPath(reviewer), REVIEW_ROOTS_HELPER);
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
/** Validate and fingerprint current packaged assets before a review-mode cache lookup. */
export function preflightReviewAssets(assetRoot, selected, cfg) {
    if (!assetRoot || !path.isAbsolute(assetRoot))
        throw new Error('DEVKIT_REVIEW_ASSET_ROOT is missing or not absolute');
    const reviewRootsHelper = readPackagedReviewAsset(assetRoot, REVIEW_ROOTS_HELPER);
    const identities = new Map();
    for (const { reviewer } of selected) {
        const [brief, skill, checklist] = reviewerAssetPaths(reviewer);
        const hash = createHash('sha256')
            .update(readPackagedReviewAsset(assetRoot, brief))
            .update(JSON.stringify(reviewer));
        if (hasChecklist(reviewer)) {
            if (!reviewer.stateFile.startsWith('.claude/') || !reviewer.cmds.gen || !reviewer.cmds.check)
                throw new Error(`${reviewer.name} has an invalid checklist registry binding`);
            hash.update(readPackagedReviewAsset(assetRoot, skill));
            hash.update(readPackagedReviewAsset(assetRoot, checklist));
            hash.update(reviewRootsHelper);
        }
        hash.update(JSON.stringify({
            scanRoots: cfg.scanRoots,
            sourceExtensions: cfg.sourceExtensions,
            review: cfg.review,
            indexPath: cfg.indexPath,
            searchTool: cfg.searchTool,
        }));
        identities.set(reviewer.name, hash.digest('hex'));
    }
    return identities;
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
