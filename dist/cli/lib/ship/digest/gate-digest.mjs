/**
 * The ship terminus findings digest: what every gate observed this run, not only the one that
 * blocked.
 *
 * AUTHORITY: none, and that is a constraint no code here can demonstrate. Per
 * blocking-gates-narrate-attribution-never-depend-on-it this module may only narrate a verdict
 * already decided — so it holds no exit, its caller invokes it through an errexit-suppressing
 * OR-list, and every failure path returns the empty string. It also never re-derives which gate
 * blocked: the shell settled that and published it on this ship's ship_result row, which this
 * reader consumes, so the two can never disagree.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
/** The ship_attempt row opens this attempt's span, so finding it bounds the backward read exactly. */
const ATTEMPT = 'ship_attempt';
const CHUNK = 256 * 1024;
/** Backstop for a sink whose ship_attempt is missing (a hand-set DEVKIT_SHIP_ID, a rotated file). */
const MAX_READ = 16 * 1024 * 1024;
const DETAIL_CHARS = 140;
/** The parallel judge's gate name — a `gate_result` row, not a fleet `review_result`. */
const COMPLETENESS = 'completeness';
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
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
    if (!sink || !shipId)
        return [];
    let fd;
    try {
        fd = openSync(sink, 'r');
        let pos = fstatSync(fd).size;
        let read = 0;
        // The partial FIRST line of the region already scanned — completed by the chunk read next,
        // which sits EARLIER in the file.
        let carry = EMPTY;
        const perChunk = [];
        while (pos > 0 && read < MAX_READ) {
            const len = Math.min(CHUNK, pos);
            pos -= len;
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, pos);
            read += len;
            const combined = carry.length > 0 ? Buffer.concat([buf, carry]) : buf;
            // Split on the newline BYTE rather than decoding the whole accumulation each pass: 0x0A can
            // never occur inside a UTF-8 multi-byte sequence, so this cannot cut a codepoint, and the
            // scan stays linear in the bytes read instead of quadratic in the chunks.
            let text;
            const cut = pos === 0 ? -1 : combined.indexOf(NEWLINE);
            if (pos === 0) {
                // Offset 0 IS a line boundary — the file begins here, so nothing is left dangling.
                text = combined.toString('utf8');
                carry = EMPTY;
            }
            else if (cut === -1) {
                carry = combined;
                text = '';
            }
            else {
                carry = combined.subarray(0, cut);
                text = combined.subarray(cut + 1).toString('utf8');
            }
            const rows = [];
            for (const line of text.split('\n')) {
                const event = line ? parseEvent(line, shipId) : undefined;
                if (event)
                    rows.push(event);
            }
            perChunk.unshift(rows);
            // Stop at MY attempt, never at whichever attempt the scan meets first. The default sink is
            // per-MACHINE, so two panes shipping different repos at once interleave in it; breaking on a
            // stranger's row truncates this run's findings to whatever happened to sit after it.
            if (rows.some((e) => e.type === ATTEMPT))
                break;
        }
        return perChunk.flat();
    }
    catch {
        return [];
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                /* nothing left to do with a descriptor we cannot close */
            }
        }
    }
}
const oneLine = (text = '') => {
    // Template coercion, not `.replace` on the parameter: the value reaches here from unvalidated
    // JSON, so its declared type is an assertion and a number would throw on a string method.
    const flat = `${text ?? ''}`.replace(/\s+/g, ' ').trim();
    return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 1)}…` : flat;
};
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
    if (!blocked || finding.family !== blocked)
        return false;
    if (finding.gate !== COMPLETENESS)
        return true;
    return !siblings.some((s) => s.family === 'review' && s.gate !== COMPLETENESS);
}
/** Pure: events → the rows the terminus should show. No IO, so the interesting cases unit-test. */
export function summarise(events, shipId) {
    const all = events.filter((e) => e.ship_id === shipId);
    // DEVKIT_SHIP_ID is INHERITED when already set (commit-with-gate-capture.sh), so one id can span
    // attempts, and the chunk holding this attempt's ship_attempt can also hold the previous one's
    // rows. Everything before the NEWEST attempt marker belongs to a run that is already over.
    const opened = all.map((e) => e.type).lastIndexOf(ATTEMPT);
    const mine = opened === -1 ? all : all.slice(opened);
    // The LAST result row, not the first: index arithmetic rather than findLast, which this
    // target's lib does not carry.
    const results = mine.filter((e) => e.type === 'ship_result');
    const result = results[results.length - 1];
    const blocked = result?.blocked_gate ?? '';
    // 'unknown' is what the shell records when the run failed and none of its prose greps matched
    // (sc-2520); an absent ship_result is a --dry-gates rehearsal, which emits none. Either way the
    // blocking gate is not knowable, and saying "did NOT block this run" about a finding would state
    // something this digest cannot know. A run that exited 0 attributes trivially: nothing blocked.
    const exitCode = result?.exit_code ?? null;
    const unattributed = (blocked === '' || blocked === 'unknown') && exitCode !== 0;
    // Findings and could-not-runs share one list because BOTH can be the blocker: under
    // GUARD_DETERMINISTIC_STRICT=1 an opted-out gate is labelled could-not-run and exits 1, so
    // hard-coding these rows non-blocking misattributes the run to whatever else it found.
    const attributable = [];
    const cached = [];
    for (const e of mine) {
        if (e.type === 'review_result' && e.status === 'fail') {
            const reviewer = e.reviewer ?? 'unknown';
            attributable.push({
                gate: `review:${reviewer}`,
                family: 'review',
                detail: oneLine(e.reason),
                state: 'finding',
            });
        }
        else if (e.type === 'gate_result' && e.status === 'fail') {
            const gate = e.gate ?? 'unknown';
            // A row without its own family IS its family — only the deterministic chain reports finer
            // than the blocked_gate vocabulary.
            attributable.push({
                gate,
                family: e.family ?? gate,
                detail: oneLine(e.detail),
                state: 'finding',
            });
        }
        else if (e.type === 'gate_result' &&
            (e.status === 'could_not_run' || e.status === 'bypassed')) {
            const gate = e.gate ?? 'unknown';
            attributable.push({
                gate,
                family: e.family ?? gate,
                // A bypassed gate verified NOTHING — the reason the green banner already says to hunt for
                // SKIP lines. Naming the flag makes that hunt unnecessary.
                detail: e.bypass ? `bypassed via ${e.bypass} — verified nothing` : oneLine(e.detail),
                state: 'could-not-run',
            });
        }
        else if (e.type === 'gate_infra_failure') {
            const gate = e.gate ?? 'unknown';
            attributable.push({
                gate,
                family: e.family ?? gate,
                // `cause` is where this event names WHY (timeout / empty / transient / response_contract).
                // Reading only `detail` collapsed every one of them to "could not run" and threw away the
                // field that decides whether an operator checks quota or simply re-runs.
                detail: oneLine(e.detail) || oneLine(e.cause) || 'could not run',
                state: 'could-not-run',
            });
        }
        else if (e.type === 'cache_hit') {
            cached.push({ gate: e.judge ?? 'unknown', state: 'cached', blocking: false, detail: '' });
        }
    }
    const seen = new Set();
    const unique = attributable.filter((a) => !seen.has(`${a.state}:${a.gate}`) && seen.add(`${a.state}:${a.gate}`) !== undefined);
    return [
        ...unique.map((a) => ({
            gate: a.gate,
            state: a.state,
            blocking: unattributed ? null : isBlocking(a, blocked, unique),
            detail: a.detail,
        })),
        ...cached,
    ];
}
/** Pure: rows → the block printed below the blocking gate's remediation, or '' for silence. */
export function render(rows, logPath = '') {
    const findings = rows.filter((r) => r.state === 'finding');
    const missing = rows.filter((r) => r.state === 'could-not-run');
    if (findings.length === 0 && missing.length === 0)
        return '';
    const cached = rows.filter((r) => r.state === 'cached').length;
    const out = [`📋 Gate findings this run (${findings.length + missing.length}):`];
    for (const r of findings.slice(0, MAX_FINDINGS)) {
        const tail = r.detail ? `: ${r.detail}` : '';
        if (r.blocking === true)
            out.push(`   ✗ ${r.gate} — BLOCKED this run${tail}`);
        else if (r.blocking === null) {
            // No "did NOT block" claim: the blocking gate is unknowable on this run.
            out.push(`   ⚠ ${r.gate} — finding recorded — read it before retrying${tail}`);
        }
        else {
            out.push(`   ⚠ ${r.gate} — finding recorded, did NOT block this run — read it before retrying${tail}`);
        }
    }
    if (findings.length > MAX_FINDINGS) {
        out.push(`   … ${findings.length - MAX_FINDINGS} more finding(s) — all of them are in the log`);
    }
    for (const r of missing.slice(0, MAX_MISSING)) {
        // A gate that could not run is normally advisory context, but under GUARD_DETERMINISTIC_STRICT
        // an opt-out IS the block — so this marker follows the computed status, never the row's kind.
        const mark = r.blocking === true ? '✗' : '·';
        const tail = r.blocking === true ? ' — BLOCKED this run' : '';
        out.push(`   ${mark} ${r.gate}${tail} — ${r.detail}`);
    }
    if (missing.length > MAX_MISSING) {
        out.push(`   … ${missing.length - MAX_MISSING} more gate(s) that could not run`);
    }
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
    const text = render(summarise(readShipEvents(sink, shipId), shipId), logPath);
    if (text)
        process.stdout.write(`${text}\n`);
}
