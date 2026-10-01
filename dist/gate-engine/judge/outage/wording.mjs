/** How a classified outage reads to the operator, and what it tells them to do next. Split from
 *  classify.mts so the decision stays separable from its phrasing; all pure, so all unit-testable. */
import { judgeProviderOfBin } from '../codex/result.mjs';
import { classifyJudgeOutage, formatResetDelta, } from './classify.mjs';
import { familyOverrideRemedy } from './family-override.mjs';
// Shared by both runners so the twin catch blocks cannot diverge. Both name the BINARY that went
// dark: "check claude auth" on a codex outage sends the operator to the wrong subscription.
export function warnNoOutput(label, bin) {
    // Ran (exit 0) but emitted nothing — a soft outage the parser would silently read as "no
    // verdict". Surface it so this variant of a dark judge is not silent either.
    console.error(`⚠️  ${label}: ${bin} judge returned no output — judgement skipped`);
}
// sc-1049 kept a cap kill out of the quota label; sc-2538 splits the rest whenever the provider
// says which cause applies. "offline/quota/absent" now names only the residue it cannot tell.
export function unavailableMessage(label, e, timeout, bin = 'claude') {
    const outage = classifyJudgeOutage(e);
    const prefix = `⚠️  ${label}: ${bin} judge`;
    if (outage.kind === 'timeout') {
        // `> 0` too, not just finite — a 0ms cap would render a nonsense "after 0s".
        const secs = timeout != null && Number.isFinite(timeout) && timeout > 0
            ? `after ${Math.round(timeout / 1000)}s `
            : '';
        return `${prefix} timed out ${secs}(machine contention?) — judgement skipped`;
    }
    if (outage.kind === 'absent')
        return `${prefix} unavailable — \`${bin}\` is not installed or not on PATH — judgement skipped`;
    if (outage.kind === 'unauthenticated')
        return `${prefix} unavailable — \`${bin}\` is not authenticated — judgement skipped`;
    if (outage.kind === 'rate-limited') {
        // The word a six-day lock must never carry is "transient"; the fact it must carry is WHEN.
        const resets = outage.resetsAt === undefined
            ? ' (no reset time given)'
            : `, resets in ${formatResetDelta(outage.resetsAt)}`;
        return `${prefix} unavailable — usage limit reached${resets} — judgement skipped`;
    }
    const reason = e.code ?? (e.status != null ? `exit ${e.status}` : (e.message ?? 'unknown'));
    return `${prefix} unavailable (${reason}; offline/quota/absent) — judgement skipped`;
}
/** ONE outage→cause mapper for every fail-closed gate (sc-2769), so no gate keeps a private copy. */
export function remedyCause(outage) {
    const kind = outage?.kind;
    return kind === 'timeout' || kind === 'rate-limited' || kind === 'absent' ? kind : 'outage';
}
/** A missing brief/checklist: in a ship lane ship projected it from the running package, so only a
 *  complete package fixes it (sc-1882); elsewhere the sync commands do. */
export function syncRemedy(shipLane) {
    return shipLane
        ? 'ship projects the briefs + checklist scripts from the running devkit package, so a missing ' +
            'one means that package is incomplete — reinstall or rebuild devkit'
        : 'run `devkit sync-agents && devkit sync-skills` so the briefs + checklist scripts are present';
}
/** The remedy a fail-closed gate prints when a judge produced no verdict — ONE wording seam for
 *  every gate (sc-1227). The CAUSE picks the remedy, and the wrong one costs real operator time. */
export function strictRemedy(cause, bin = 'claude', resetsAt, shipLane = false) {
    if (cause === 'timeout')
        return ('the judge hit its time cap — this is NOT an auth/quota problem. Re-run `devkit ship`; run ' +
            'it in a real terminal or a detached ship so the 600s agent tool cap cannot kill it early; ' +
            'or stage a smaller commit, which judges faster');
    if (cause === 'sync')
        return `${syncRemedy(shipLane)}, then re-run devkit ship`;
    if (cause === 'rate-limited') {
        const window = resetsAt === undefined
            ? 'until the limit resets'
            : `for another ${formatResetDelta(resetsAt)}`;
        // A binary that reported its usage limit ran, so it resolves: the doctor route cannot bind.
        // Naming the override, never taking it: a runtime cross-family swap moves spend to an unwatched
        // subscription and puts its verdicts outside the model-keyed cache salt (review-gate-in-chain).
        return (`\`${bin}\` reports its usage limit reached — re-running cannot succeed ${window}. Either ` +
            `wait it out, or ${familyOverrideRemedy(bin, true)}`);
    }
    if (cause === 'absent') {
        // Install leads: a family move needs the OTHER CLI, and doctor's bind needs claude to resolve.
        const pathHint = judgeProviderOfBin(bin) === 'codex' ? ' (or point GUARD_CODEX_BIN at it)' : '';
        const install = `\`${bin}\` is not installed or not on PATH — this is NOT an auth/quota problem. Install ` +
            `it${pathHint}, then resume the ship.`;
        if (judgeProviderOfBin(bin) === null)
            return `${install} Otherwise ${familyOverrideRemedy(bin)}`;
        return `${install} If the other judge CLI is installed, you can instead ${familyOverrideRemedy(bin, false)}`;
    }
    // Every binary reaching this arm ran (only ENOENT reads as absent), so doctor's bind cannot apply.
    return (`check \`${bin}\` CLI auth/quota, then re-run devkit ship. If the account stays dark longer ` +
        `than the ship can wait, ${familyOverrideRemedy(bin, true)}`);
}
