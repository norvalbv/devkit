#!/usr/bin/env node
/** Report the judges' provider before the deterministic chain is paid (sc-2538). ADVISORY — never
 *  blocks, reports per MODEL. Why: docs/decisions/judge-outage-classified-not-blocked.md. */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGuardConfig } from '../../../../gate-engine/config.mjs';
import { readCodexRateLimits } from '../../../../gate-engine/judge/codex/rate-limits.mjs';
import { isCodexModel, judgeBinForModel } from '../../../../gate-engine/judge/codex/result.mjs';
import { formatResetDelta } from '../../../../gate-engine/judge/outage/classify.mjs';
import { claudeLoggedOut, codexLoggedOut } from '../../doctor/judge/judge-auth.mjs';
import { binResolvable, resolvedJudgeModels } from '../../doctor/judge/judge-family.mjs';
import { readJson } from '../../fs-helpers.mjs';
/** The three roles, in the order a cascade reaches them, for a report that reads like the run. */
const ROLES = ['review', 'escalation', 'correctness'];
/** Is the reviewer gate even selected? A repo that runs no judges must be byte-identical to
 *  before. Mirrors the `reviewSelected` gating in cli/lib/doctor/guard-config-checks.mts. */
export function reviewGuardSelected(root) {
    try {
        return (readJson(join(root, '.devkit', 'config.json'))?.components?.guards?.includes('review') === true);
    }
    catch {
        // An unparseable or absent recorded selection is not evidence either way. Staying silent is the
        // advisory-safe reading: this check may never be the reason anything changes.
        return false;
    }
}
const DEFAULT_DEPS = {
    resolvable: binResolvable,
    codexOut: () => codexLoggedOut(),
    claudeOut: () => claudeLoggedOut(),
    rateLimits: () => readCodexRateLimits(),
};
/** Classify every resolved judge model, cheapest check first. The rate-limit RPC runs at most ONCE
 *  per report even with three codex roles, because they share one account. */
export async function judgeReachability(root, deps = DEFAULT_DEPS) {
    const cfg = resolveGuardConfig(root);
    const models = resolvedJudgeModels(cfg);
    const statuses = [];
    // Resolved once per provider, not per model: three roles on one subscription share one answer,
    // and asking three times would triple the latency of the thing meant to save time.
    let codexLimits;
    const codexNeeded = models.some((m) => isCodexModel(m));
    const codexPresent = codexNeeded && deps.resolvable('codex', root);
    const codexDark = codexPresent && deps.codexOut();
    if (codexPresent && !codexDark)
        codexLimits = await deps.rateLimits();
    const claudeNeeded = models.some((m) => !isCodexModel(m));
    const claudePresent = claudeNeeded && deps.resolvable('claude', root);
    const claudeDark = claudePresent && deps.claudeOut();
    for (const [i, model] of models.entries()) {
        const bin = judgeBinForModel(model);
        const status = { role: ROLES[i], model, bin, state: 'unknown' };
        if (isCodexModel(model)) {
            if (!codexPresent)
                status.state = 'absent';
            else if (codexDark)
                status.state = 'unauthenticated';
            else if (codexLimits?.reached)
                status.state = 'rate-limited';
            else if (codexLimits)
                status.state = 'ok';
            // else: the RPC said nothing this version understands — 'unknown', reported as such.
            if (codexLimits?.resetsAt !== undefined)
                status.resetsAt = codexLimits.resetsAt;
            if (codexLimits?.usedPercent !== undefined)
                status.usedPercent = codexLimits.usedPercent;
            if (codexLimits?.windowDurationMins !== undefined)
                status.windowMins = codexLimits.windowDurationMins;
        }
        else if (!claudePresent)
            status.state = 'absent';
        else if (claudeDark)
            status.state = 'unauthenticated';
        else {
            // No cheap claude quota query exists (anthropics/claude-code#40395 is open), so binary +
            // auth is the whole truth: "reachable" claims nothing about remaining headroom.
            status.state = 'ok';
        }
        statuses.push(status);
    }
    return statuses;
}
/** "7d" / "5h" — the window a percentage is measured over, in the unit it was configured in. */
function describeWindow(mins) {
    if (mins % (24 * 60) === 0)
        return `${mins / (24 * 60)}d`;
    if (mins % 60 === 0)
        return `${mins / 60}h`;
    return `${mins}m`;
}
/** Render the report, in the style of `guard-size preflight`. The consequence and remedy appear
 *  only when something is wrong, phrased so an agent cannot read it as "retry and it will work". */
export function renderPreflight(statuses, now = Date.now()) {
    if (statuses.length === 0)
        return [];
    const lines = ['guard-judge preflight — judge reachability, before the gate chain'];
    for (const s of statuses) {
        const detail = [];
        if (s.usedPercent !== undefined) {
            const window = s.windowMins === undefined ? 'window' : `${describeWindow(s.windowMins)} window`;
            detail.push(`${Math.round(s.usedPercent)}% of a ${window} used`);
        }
        if (s.state === 'rate-limited' && s.resetsAt !== undefined)
            detail.push(`resets in ${formatResetDelta(s.resetsAt, now)}`);
        const suffix = detail.length > 0 ? ` (${detail.join(', ')})` : '';
        const verdict = s.state === 'ok'
            ? 'reachable'
            : s.state === 'absent'
                ? `\`${s.bin}\` not installed or not on PATH`
                : s.state === 'unauthenticated'
                    ? `\`${s.bin}\` not authenticated`
                    : s.state === 'rate-limited'
                        ? 'USAGE LIMIT REACHED'
                        : 'not verified';
        lines.push(`  ${s.role}: ${s.model} via ${s.bin} — ${verdict}${suffix}`);
    }
    const blocked = statuses.filter((s) => s.state !== 'ok' && s.state !== 'unknown');
    if (blocked.length === 0)
        return lines;
    const locked = blocked.filter((s) => s.state === 'rate-limited');
    const reset = locked.find((s) => s.resetsAt !== undefined)?.resetsAt;
    lines.push('⚠️  guard-judge preflight: the gates below will still run, but every reviewer that is not ' +
        'already cached will fail closed.');
    // Avoids the word "transient" rather than negating it: an agent grepping for that label must
    // not find it here, since a six-day lock wearing it is why this line exists.
    if (locked.length > 0)
        lines.push(reset === undefined
            ? '   A usage limit does not clear on its own — re-running will not help.'
            : `   A usage limit does not clear on its own — re-running will not help for another ${formatResetDelta(reset, now)}.`);
    // Naming the override, never taking it: a runtime cross-family swap moves spend to an unwatched
    // subscription and puts its verdicts outside the model-keyed cache salt (review-gate-in-chain).
    lines.push('   To ship inside this window, move the judges to another family: `devkit doctor --fix` ' +
        'binds the claude family when codex is unresolvable, or set GUARD_REVIEW_MODEL / ' +
        'GUARD_REVIEW_ESCALATION_MODEL / GUARD_CORRECTNESS_MODEL to claude-family ids for this run.');
    return lines;
}
async function main(argv) {
    const root = argv[0];
    if (!root) {
        console.error('usage: ship preflight judge <consumer-root>');
        return 2;
    }
    if (!reviewGuardSelected(root))
        return 0;
    const statuses = await judgeReachability(root);
    for (const line of renderPreflight(statuses))
        console.error(line);
    return 0;
}
// Entry only when this file IS the entry point: a substring test on argv[1] would also fire for
// this module's own test file, and the body below calls process.exit().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2))
        // Nothing this module can hit is worth failing a ship over — an unexpected throw is the same
        // "could not run" as a timeout, and the shell maps 2 to a warn.
        .then((code) => process.exit(code))
        .catch(() => process.exit(2));
}
