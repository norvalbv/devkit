// One module-scope classifier per gate event type, so summarise() only dispatches and attributes.
import { blockingFindings, judgeFinding } from './blocking.mjs';
import { count, oneLine, textOf } from './fields.mjs';
/** The parallel judge's gate name — a `gate_result` row, not a fleet `review_result`. */
export const COMPLETENESS = 'completeness';
/** Never the bare word "transient": it reads as "a retry clears it", and a usage lock wore it. */
const UNCLASSIFIED = 'judge failed, cause unclassified — read the guard-judge preflight lines at the top of the log';
/** Causes whose judge_exec ledger row holds the words that explain them; a response-contract
 *  inconclusive is a judge that answered, so an earlier failed spawn's words would mislead. */
const OUTAGE_CAUSES = new Set(['outage', 'rate-limited', 'transient', 'unauthenticated', 'absent']);
const PATHS_SHOWN = 3;
/** Sorts one event into its bucket. A switch, not a keyed lookup: a sink row's `type` is untrusted. */
export function classify(e, b) {
    switch (e.type) {
        case 'review_result':
            return reviewResult(e, b);
        case 'gate_result':
            return gateResult(e, b);
        case 'gate_infra_failure':
            b.attributable.push(infraFailureRow(e, b.outageWords));
            return;
        case 'advisory_result':
            b.advisory.push(advisoryRow(e));
            return;
        case 'gate_degraded':
            b.unverified.push(degradedRow(e));
            return;
        case 'cache_hit':
            return cacheHit(e, b);
    }
}
/** Built only on an arm that emits a row: a malformed reviewer must not throw on a row-less status. */
const reviewGate = (e) => `review:${e.reviewer ?? 'unknown'}`;
function reviewResult(e, b) {
    if (e.status === 'fail') {
        const gate = reviewGate(e);
        for (const f of blockingFindings(e)) {
            b.attributable.push({ gate, family: 'review', state: 'finding', ...f });
        }
    }
    else if (e.status === 'inconclusive') {
        // Strict ship fails closed on every one of these, so omitting them hid most of what blocked.
        const gate = reviewGate(e);
        const cause = textOf(e.inconclusive_cause);
        const words = OUTAGE_CAUSES.has(cause) ? b.outageWords.get(gate) : undefined;
        b.attributable.push({
            gate,
            family: 'review',
            detail: (words ?? oneLine(e.reason)) || oneLine(cause) || 'could not run',
            state: 'could-not-run',
        });
    }
    else if (e.status === 'pass' && partialPacket(e)) {
        // A clean PASS adds no row; one whose capped packet left files out was not fully judged.
        b.unverified.push(unverifiedRow(reviewGate(e), partialPacketDetail(e)));
    }
}
function gateResult(e, b) {
    const gate = e.gate ?? 'unknown';
    // A row without its own family IS its family — only the deterministic chain reports finer
    // than the blocked_gate vocabulary.
    const family = e.family ?? gate;
    if (e.status === 'fail') {
        b.attributable.push({ gate, family, state: 'finding', ...judgeFinding(e) });
    }
    else if (e.status === 'could_not_run' || e.status === 'bypassed') {
        b.attributable.push({
            gate,
            family,
            // A bypassed gate verified NOTHING; naming the flag spares the reader a hunt for SKIP lines.
            detail: e.bypass ? `bypassed via ${e.bypass} — verified nothing` : oneLine(e.detail),
            state: 'could-not-run',
        });
    }
}
function infraFailureRow(e, outageWords) {
    const gate = e.gate ?? 'unknown';
    return {
        gate,
        family: e.family ?? gate,
        // `cause` says WHY (see classifyJudgeOutage), which decides between checking quota and a re-run.
        detail: oneLine(e.detail) ||
            (OUTAGE_CAUSES.has(textOf(e.cause)) ? outageWords.get(`review:${gate}`) : '') ||
            (e.cause === 'transient' ? UNCLASSIFIED : oneLine(e.cause)) ||
            'could not run',
        state: 'could-not-run',
    };
}
/** A stage that CANNOT block (the self-host fallow audit, the skill-projection check). */
function advisoryRow(e) {
    return {
        gate: e.gate ?? 'unknown',
        state: e.status === 'could_not_run' ? 'could-not-run' : 'finding',
        blocking: false,
        detail: oneLine(e.detail),
        advisory: true,
    };
}
/** A judge that stripped its own blocking authority; one naming its degradation supplies `detail`. */
function degradedRow(e) {
    return unverifiedRow(e.judge ?? 'unknown', oneLine(e.detail) ||
        `downgraded to advisory: ${oneLine(e.cause) || 'cause not recorded'} — could not block this commit`);
}
/** A reused PASS. A partial packet may ALSO sit on an earlier diff or a drifted base, and one row
 *  per gate survives, so that row names every reason. */
function cacheHit(e, b) {
    const staleDiff = earlierDiffDetail(e);
    const drifted = baseDriftDetail(e);
    if (partialPacket(e)) {
        const detail = [partialPacketDetail(e), staleDiff, drifted].filter(Boolean).join('; ');
        b.unverified.push(unverifiedRow(cacheGate(e), detail));
    }
    else if (staleDiff)
        b.unverified.push(unverifiedRow(cacheGate(e), staleDiff));
    else if (drifted)
        b.unverified.push(unverifiedRow(e.judge ?? 'unknown', drifted));
    else
        b.cached.push({ gate: e.judge ?? 'unknown', state: 'cached', blocking: false, detail: '' });
}
const unverifiedRow = (gate, detail) => ({
    gate,
    state: 'unverified',
    blocking: false,
    detail,
});
/** A cache_hit's gate label; completeness's intent key reports under the judge's own gate name. */
const cacheGate = (e) => e.judge === `review:${COMPLETENESS}` ? COMPLETENESS : (e.judge ?? 'unknown');
/** A PASS reused across an earlier diff, or ''. `=== false`: an absent field covers it. */
const earlierDiffDetail = (e) => e.diff_matches === false
    ? 'cached PASS judged an earlier diff — this diff was not re-judged'
    : '';
/** A sink row's judged base, short — JSON.stringify never invokes a row-supplied toString, so a
 * malformed value (`{"toString":1}`) degrades to "an earlier base" instead of throwing. */
const shortJudgedBase = (sha) => /^"([0-9a-f]{7,64})"$/.exec(JSON.stringify(sha ?? null))?.[1].slice(0, 12) ?? 'an earlier base';
/** A PASS judged on an earlier base whose reviewed paths moved, or ''. An absent base_state
 * (non-review emitters) or 'moved-clear' stays a ✓. */
function baseDriftDetail(e) {
    if (e.base_state === 'unknown')
        return 'cached PASS whose judged base is unknown — not re-judged against this base';
    if (e.base_state === 'moved-overlap')
        return `cached PASS judged against ${shortJudgedBase(e.judged_base_sha)} — reviewed paths changed on the base since; not re-judged`;
    return '';
}
function partialPacket(e) {
    return count(e.evidence_omitted_files) > 0 || count(e.evidence_truncated_files) > 0;
}
/** ` — <label>: a, b, c, …` over an untrusted path list, or '' when it holds no usable path. */
function namedPaths(label, list, total) {
    const paths = (Array.isArray(list) ? list : []).map(textOf).filter(Boolean);
    const more = paths.length > PATHS_SHOWN || total > PATHS_SHOWN ? ', …' : '';
    return paths.length
        ? ` — ${label}: ${paths
            .slice(0, PATHS_SHOWN)
            .map((p) => oneLine(p))
            .join(', ')}${more}`
        : '';
}
function partialPacketDetail(e) {
    const omitted = count(e.evidence_omitted_files);
    const truncated = count(e.evidence_truncated_files);
    const lensName = textOf(e.evidence_lens);
    const lens = lensName ? ` (${oneLine(lensName)} lens)` : '';
    const total = count(e.evidence_file_count) ? `/${count(e.evidence_file_count)}` : '';
    const named = namedPaths('not shown', e.evidence_omitted_paths, omitted) +
        namedPaths('truncated', e.evidence_truncated_paths, truncated);
    const cached = e.type === 'cache_hit' ? 'cached ' : '';
    return `${cached}PASS over an incomplete packet${lens}: ${omitted}${total} file(s) omitted, ${truncated} truncated${named}`;
}
