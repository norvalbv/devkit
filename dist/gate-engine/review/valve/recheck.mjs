/** `guard-review lens <reviewer>[:<lens>]`: re-judge one reviewer or correctness lens group through
 * the gate's own path, so a PASS lands on the part key a full gate reads — never a reviewer-level one. */
import { composeTranscript, saveTranscript } from '../../judge/transcript-store.mjs';
import { taskLabel } from '../lens/split.mjs';
import { isShipLane } from '../cascade/consumer-assets.mjs';
import { emitAdvisoryResult } from '../../judge/advisory/emit.mjs';
import { ADVISORY_CAP, parseAdvisories } from '../contracts/response.mjs';
import { printAdvisories } from '../evidence/base-context.mjs';
import { emitReviewSkipped } from '../evidence/scope.mjs';
import { lensGroupId, resolveLensGroups } from '../lens/groups.mjs';
import { REVIEWERS } from '../reviewers.mjs';
import { reviewerSkipRemedy } from '../overrides.mjs';
import { skippedReviewers } from '../runtime.mjs';
/** The only reviewer the gate fans out into lens groups (lens/split.mts planReviewWork). */
const SPLIT_REVIEWER = 'correctness-reviewer';
/** Parse `<reviewer>[:<lens>]`; throws a message naming the valid choices on anything else. */
export function parseRecheckTarget(arg, groups = resolveLensGroups()) {
    const sep = arg.indexOf(':');
    const reviewer = sep === -1 ? arg : arg.slice(0, sep);
    const lens = sep === -1 ? null : arg.slice(sep + 1);
    const names = REVIEWERS.map((r) => r.name);
    if (!names.includes(reviewer))
        throw new Error(`unknown reviewer '${reviewer}' — expected one of: ${names.join(', ')}`);
    if (lens === null)
        return { reviewer, lens };
    if (reviewer !== SPLIT_REVIEWER)
        throw new Error(`${reviewer} has no lenses — re-check it whole: guard-review lens ${reviewer}`);
    const ids = groups?.map(lensGroupId) ?? [];
    if (ids.length === 0)
        throw new Error(`the correctness lens split is off (GUARD_CORRECTNESS_SPLIT) — re-check it whole: guard-review lens ${SPLIT_REVIEWER}`);
    if (!ids.includes(lens))
        throw new Error(`unknown lens '${lens}' for ${reviewer} — expected one of: ${ids.join(', ')}`);
    return { reviewer, lens };
}
/** Keep only the target reviewer; the rest are recorded as skipped for `recheck`, never
 * `not_selected`. An empty result is named here so an unselected target never reads as a PASS. */
export function narrowSelection(selected, target, reported) {
    for (const { reviewer } of selected.filter((s) => s.reviewer.name !== target.reviewer)) {
        reported.add(reviewer.name);
        emitReviewSkipped(reviewer.name, 'recheck');
    }
    const kept = selected.filter((s) => s.reviewer.name === target.reviewer);
    if (kept.length === 0)
        console.error(skippedReviewers().has(target.reviewer)
            ? `guard-review: ${target.reviewer} is dropped by GUARD_REVIEW_SKIP — unset it to re-check`
            : `guard-review: ${target.reviewer} is not selected by the staged files — nothing to re-check`);
    return kept;
}
/** Keep only the target lens group's tasks — split parts and chunk parts alike carry `group`. */
export function narrowTasks(tasks, target) {
    return target.lens === null ? tasks : tasks.filter((t) => t.group === target.lens);
}
/** The re-check line under a FAIL block: each failing lens group once (chunks share a group).
 * Under ship it says what must match the briefed worktree for the PASS to seed ship's cache. */
export function recheckHint(reviewer, parts, shipLane) {
    const groups = [
        ...new Set((parts ?? []).filter((p) => p.res.status === 'fail').flatMap((p) => p.task.group ?? [])),
    ];
    const cmds = groups.length
        ? groups.map((g) => `guard-review lens ${reviewer}:${g}`)
        : [`guard-review lens ${reviewer}`];
    const caveat = shipLane
        ? "\n     (judges YOUR checkout's staged index: stage the same paths ship briefed and keep the same GUARD_REVIEW_* model env, or its PASS will not seed ship's cache)"
        : '';
    return `   Re-check a fix locally (this reviewer only), after staging it: ${cmds.join(' · ')}${caveat}`;
}
/** A failed reviewer's remedies: the cascade skip valve when escalation confirmed it, then the
 * recheck command — omitted inside a recheck, where it would only name itself. */
export function printRemedy(f, splitParts, only) {
    if (f.escalated)
        console.error(`   Remedy: ${reviewerSkipRemedy(f.name)}`);
    if (!only)
        console.error(recheckHint(f.name, splitParts.get(f.name), isShipLane()));
}
/** A lens recheck emits no merged row, so each live PASS part prints its own advisories, and each
 * reviewer still gets ONE advisory_result. A cached part carries no transcript: it already replayed. */
export function reportLensPartAdvisories(splitParts) {
    for (const [name, parts] of splitParts) {
        const all = [];
        for (const p of parts) {
            if (p.res.status !== 'pass' || !p.res.transcript)
                continue;
            const advisories = parseAdvisories(p.res.transcript);
            if (!advisories.length)
                continue;
            const label = taskLabel(p.task);
            const text = composeTranscript(p.task.diffText, p.res.transcript);
            printAdvisories(label, advisories, saveTranscript(`review-${label}`, text));
            all.push(...advisories);
        }
        const unique = [...new Set(all)].slice(0, ADVISORY_CAP);
        if (unique.length)
            emitAdvisoryResult(`review:${name}`, 'finding', unique.join(' | '));
    }
}
