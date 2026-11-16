import { branchNarration } from './advisories.mjs';
import { groupAdvisories } from './advisory-rows.mjs';
import { COMPLETENESS, classify } from './event-rows.mjs';
import { oneLine, textOf } from './fields.mjs';
import { withRecurrence } from './recurrence.mjs';
import { scanBackward } from './tail.mjs';
import { waivedRows } from './waived.mjs';
/** The ship_attempt row opens this attempt's span, so finding it bounds the backward read exactly. */
export const ATTEMPT = 'ship_attempt';
/** From the newest ship_attempt on, else all: an inherited DEVKIT_SHIP_ID spans attempts. */
const fromNewestAttempt = (rows) => rows.slice(Math.max(0, rows.map((r) => r.type).lastIndexOf(ATTEMPT)));
/** Caps on what one terminus prints: past these the digest is the wall of text it replaces. */
const MAX_FINDINGS = 8;
const MAX_MISSING = 3;
/**
 * The I/O boundary: one JSONL line in, this ship's event or nothing. Every downstream function
 * takes GateEvent, so no unparsed value travels past here.
 */
function parseEvent(line, shipId) {
    try {
        // SAFETY: the cast asserts a SHAPE, never the runtime type of any field — a row is arbitrary
        // JSON, so a field declared string here can hold a number. What makes it sound is that no read
        // downstream relies on the declared type: every field is compared with === or coerced through
        // a template literal (see oneLine), so a wrong-typed value renders oddly instead of throwing.
        const event = JSON.parse(line);
        return event.ship_id === shipId ? event : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * The tail of `sink` back to this ship's own ship_attempt row, filtered to this ship.
 *
 * The default sink is per-MACHINE (~/.devkit/telemetry/gate-events.jsonl) and accumulates across
 * every commit on the box, so a full read is unbounded and a ship_id filter is not optional —
 * without it a digest blends repos. Never throws: an absent, unreadable or torn sink yields [].
 */
export function readShipEvents(sink, shipId) {
    if (!shipId)
        return [];
    return fromNewestAttempt(scanBackward(sink, (line) => parseEvent(line, shipId), 
    // Stop at MY attempt, not the first one met: two repos' ships interleave in the per-machine sink.
    (kept) => kept.some((e) => e.type === ATTEMPT)));
}
/**
 * Which finding this run actually stopped on, given the coarse `blocked_gate` the shell published.
 *
 * `blocked_gate` names a FAMILY ('review', 'deterministic', 'decisions'), and the review family
 * holds both the reviewer fleet and the completeness judge. The hook's own precedence settles the
 * ambiguity: the fleet's status ($rrc) is dispatched BEFORE the completeness status ($crc), so when
 * a fleet reviewer failed, that is what stopped the run and completeness did not — which is exactly
 * the case this digest exists for. Completeness is blocking only when nothing else in the family
 * failed.
 */
function isBlocking(finding, blocked, siblings) {
    // `comments` is the one deterministic sub-gate that keeps its own blocked_gate token (sc-2753).
    if (!blocked || (finding.family !== blocked && finding.gate !== blocked))
        return false;
    if (finding.gate !== COMPLETENESS)
        return true;
    return !siblings.some((s) => s.family === 'review' && s.gate !== COMPLETENESS);
}
/** A codex error envelope's message (`error.message` or `detail`, one JSON line), else
 *  the text as given — the envelope alone would spend the whole detail budget before the cause. */
function providerMessage(text) {
    try {
        // SAFETY: a shape, not a type — `?.` survives null or a primitive, and textOf drops a non-string.
        const parsed = JSON.parse(text.split('\n')[0] ?? '');
        return textOf(parsed?.error?.message) || textOf(parsed?.detail) || text;
    }
    catch {
        return text;
    }
}
/** The provider's own words per reviewer: each (judge, lens) keeps only its LAST spawn's, so a later
 *  wordless failure clears them while one lens's `ok` cannot erase a concurrent lens's outage. */
function outageWordsByJudge(events) {
    const last = new Map();
    for (const e of events) {
        if (e.type !== 'judge_exec')
            continue;
        const judge = textOf(e.judge).replace(/:escalate$/, '');
        const detail = e.outcome === 'ok' ? '' : oneLine(providerMessage(textOf(e.outage_detail)));
        last.set(`${judge}\0${textOf(e.lens)}`, [judge, detail]);
    }
    return new Map([...last.values()].filter(([, detail]) => detail));
}
/** Pure: events → the rows the terminus should show. No IO, so the interesting cases unit-test. */
export function summarise(events, shipId) {
    const mine = fromNewestAttempt(events.filter((e) => e.ship_id === shipId));
    // The LAST result row, not the first: index arithmetic rather than findLast, which this
    // target's lib does not carry.
    const results = mine.filter((e) => e.type === 'ship_result');
    const result = results[results.length - 1];
    const blocked = textOf(result?.blocked_gate ?? undefined);
    // 'unknown': the run failed and none of the shell's prose greps matched. 'interrupted':
    // a signal stopped the chain. No ship_result at all: a --dry-gates rehearsal. Either way the
    // blocking gate is not knowable, and "did NOT block this run" would state something this digest
    // cannot know. A run that exited 0 attributes trivially: nothing blocked.
    const exitCode = result?.exit_code ?? null;
    const unattributed = ['', 'unknown', 'interrupted'].includes(blocked) && exitCode !== 0;
    // Findings and could-not-runs share one list because BOTH can be the blocker: under
    // GUARD_DETERMINISTIC_STRICT=1 an opted-out gate is labelled could-not-run and exits 1, so
    // hard-coding these rows non-blocking misattributes the run to whatever else it found.
    const b = {
        attributable: [],
        advisory: [],
        unverified: [],
        bypassed: [],
        cached: [],
        outageWords: outageWordsByJudge(mine),
    };
    for (const e of mine)
        classify(e, b);
    const seen = new Set();
    const key = (a) => `${a.state}:${a.gate}:${a.fp ?? ''}`;
    const unique = b.attributable.filter((a) => !seen.has(key(a)) && seen.add(key(a)) !== undefined);
    const stoppers = unattributed ? [] : unique.filter((a) => isBlocking(a, blocked, unique));
    const why = notBlockingWhy([...new Set(stoppers.map((a) => a.gate))], blocked, exitCode);
    return [
        ...unique.map((a) => {
            const blocking = unattributed ? null : stoppers.includes(a);
            const row = { gate: a.gate, state: a.state, blocking, detail: a.detail };
            if (blocking === false && a.state === 'finding')
                row.why = why;
            if (a.fp)
                row.fp = a.fp;
            if (a.findings)
                row.findings = a.findings;
            return row;
        }),
        ...firstPerGate(b.bypassed),
        // NOT passed through the `unattributed` null-blocking arm: that arm exists for a run whose
        // blocker is unknowable, and an advisory's non-blocking status is knowable on every run.
        ...groupAdvisories(b.advisory),
        // Deduped for the same reason: pre-commit and commit-msg can both replay one stale verdict.
        ...firstPerGate(b.unverified),
        ...waivedRows(mine),
        ...b.cached,
    ];
}
/** Why a finding did not stop the run, from facts this digest holds — never a guess at the retry. */
function notBlockingWhy(stoppers, blocked, exitCode) {
    if (exitCode === 0)
        return ' (its gate let the run pass) — read it before merging';
    if (stoppers.length)
        return ` only because ${stoppers.join(', ')} stopped it first — read it before retrying`;
    return ` — the run ended on ${oneLine(blocked)} — read it before retrying`;
}
/** The first row per state+gate, in event order. */
function firstPerGate(rows) {
    const seen = new Set();
    return rows.filter((r) => {
        const id = `${r.state}:${r.gate}`;
        if (seen.has(id))
            return false;
        seen.add(id);
        return true;
    });
}
/** A row built outside summarise() carries no reason, so it keeps the plain retry hint. */
const whyNot = (r) => r.why ?? ' — read it before retrying';
/** Pure: rows → the block printed below the blocking gate's remediation, or '' for silence. */
export function render(rows, logPath = '') {
    const findings = rows.filter((r) => r.state === 'finding');
    const missing = rows.filter((r) => r.state === 'could-not-run');
    const unverified = rows.filter((r) => r.state === 'unverified');
    // An unverified row alone is reason to speak: it is exactly the green run a reader stops tailing.
    if (findings.length === 0 && missing.length === 0 && unverified.length === 0)
        return '';
    const cached = rows.filter((r) => r.state === 'cached').length;
    const listed = [...findings, ...missing, ...unverified];
    const total = listed.reduce((n, r) => n + (r.findings ?? 1), 0);
    const gates = new Set(listed.map((r) => r.gate)).size;
    // Findings, not gates, are what a reader must clear: one reviewer can block on several IDs.
    const counted = gates === total ? `${total}` : `${gates} gate(s) / ${total} finding(s)`;
    const out = [`📋 Gate findings this run (${counted}):`];
    // Never capped: a blocker, or a row naming a fingerprint even when attribution is unknown — each
    // is a separate ID to fix or waive, and a hidden one costs a whole re-ship.
    const pinned = (r) => r.blocking === true || r.fp !== undefined;
    const blockers = findings.filter(pinned);
    const others = findings.filter((r) => !pinned(r));
    for (const r of [...blockers, ...others.slice(0, MAX_FINDINGS)]) {
        const tail = r.detail ? `: ${r.detail}` : '';
        if (r.blocking === true)
            out.push(`   ✗ ${r.gate} — BLOCKED this run${tail}`);
        else if (r.advisory)
            out.push(`   ⚠ ${r.gate} — advisory, did NOT block this run${tail}`);
        else if (r.blocking === null) {
            // No "did NOT block" claim: the blocking gate is unknowable on this run.
            out.push(`   ⚠ ${r.gate} — finding recorded — read it before retrying${tail}`);
        }
        else
            out.push(`   ⚠ ${r.gate} — finding recorded, did NOT block this run${whyNot(r)}${tail}`);
    }
    if (others.length > MAX_FINDINGS) {
        out.push(`   … ${others.length - MAX_FINDINGS} more finding(s) — all of them are in the log`);
    }
    // Blockers are never capped, as with findings: each fail-closed reviewer is one more to clear.
    const missingBlockers = missing.filter((r) => r.blocking === true || r.skipped);
    const missingOthers = missing.filter((r) => r.blocking !== true && !r.skipped);
    for (const r of [...missingBlockers, ...missingOthers.slice(0, MAX_MISSING)]) {
        // A gate that could not run is normally advisory context, but under GUARD_DETERMINISTIC_STRICT
        // an opt-out IS the block — so this marker follows the computed status, never the row's kind.
        const mark = r.blocking === true ? '✗' : '·';
        const tail = r.blocking === true ? ' — BLOCKED this run' : '';
        out.push(`   ${mark} ${r.gate}${tail} — ${r.detail}`);
    }
    if (missingOthers.length > MAX_MISSING) {
        out.push(`   … ${missingOthers.length - MAX_MISSING} more gate(s) that could not run`);
    }
    // Uncapped: one row per judge or waived ID survives the dedupe, and a cut one would be the silent
    // omission this section exists to end. The same `·` a bypass wears, because it carries that weight.
    for (const r of unverified)
        out.push(`   · ${r.gate} — ${r.detail}`);
    if (cached > 0) {
        out.push(`   ✓ ${cached} verdict(s) served from cache — not re-judged, not re-reported`);
    }
    if (logPath)
        out.push(`   Full log: ${logPath}`);
    return out.join('\n');
}
// CLI: `node gate-digest.mjs digest <sink> <ship-id> [log-path]`. commit-with-gate-capture.sh shells
// here by a path RELATIVE to itself, so it resolves in every install mode without a bunx/registry
// lookup. Guarded so importing the module never triggers the CLI. Writes to stdout; the caller
// redirects to stderr (a ship's stdout is reserved for the PR URL). Any throw is contained above,
// so this prints nothing rather than adding noise to a run that already failed.
if (/[/\\]gate-digest\.m[jt]s$/.test(process.argv[1] ?? '') && process.argv[2] === 'digest') {
    const [sink = '', shipId = '', logPath = ''] = process.argv.slice(3);
    // The ship exports its own repo/branch (commit-with-gate-capture.sh); unset = no trend line.
    const { DEVKIT_SHIP_REPO: repo = '', DEVKIT_SHIP_BRANCH: branch = '' } = process.env;
    const key = { shipId, repo, branch };
    const text = [
        render(withRecurrence(summarise(readShipEvents(sink, shipId), shipId), sink, key), logPath),
        branchNarration(sink, key),
    ]
        .filter(Boolean)
        .join('\n');
    if (text)
        process.stdout.write(`${text}\n`);
}
