import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emitGateEvent } from '../../../gate-engine/judge/gate-events.mjs';
import { redactSecrets, shQuote } from './redact-secrets.mjs';
import { runDirectReviewCli } from './review/run-direct.mjs';
/** The argv that re-runs a recorded invocation; a resumed branch-mode attempt replays by name. */
export function replayableArgv(intent, resumed) {
    const sourceMode = intent.sourceMode ?? 'explicit';
    if (sourceMode === 'branch' && resumed)
        return ['devkit', 'ship', '--resume', intent.branch];
    return [
        'devkit',
        'ship',
        intent.branch,
        intent.title,
        ...(intent.mode === 'reship' ? ['--pr'] : []),
        ...(intent.base ? ['--base', intent.base] : []),
        ...(sourceMode === 'branch' ? ['--from-branch'] : []),
        ...intent.links.flatMap((d) => ['--link', d]),
        // The command must replay the draft bit too, or a recorded draft ship replays as a ready PR.
        ...(intent.draft ? ['--draft'] : []),
        ...(intent.noStack ? ['--no-stack'] : []),
        ...(sourceMode === 'explicit' ? ['--', ...intent.paths] : []),
    ];
}
/**
 * The node-side attempt event. `command` is the replayable invocation (paths included — the
 * warehouse `command` column documents exactly this, and the sink is personal-scale); `pr_body` is
 * the decoded body for the dashboard drill-down — both pass redactSecrets, and body_bytes stays
 * the RAW length (it measures the retry cost, not the redacted rendering). Envelope adds
 * ship_id/repo/branch/source/version from the DEVKIT_SHIP_* env the ship script exports before
 * calling write. Best-effort by emitGateEvent's own contract.
 */
export function emitShipIntentEvent(intent, resumed, root) {
    const body = Buffer.from(intent.bodyB64, 'base64');
    emitGateEvent({
        type: 'ship_intent',
        root,
        mode: intent.mode,
        source_mode: intent.sourceMode ?? 'explicit',
        command: redactSecrets(replayableArgv(intent, resumed).map(shQuote).join(' ')),
        pr_body: redactSecrets(body.toString('utf8')),
        body_bytes: body.length,
        path_count: intent.paths.length,
        resumed,
    });
}
/** The HUP, INT, QUIT and TERM statuses review/process/gate-signal-handoff.sh exits with. */
const SIGNAL_EXITS = new Set([129, 130, 131, 143]);
/**
 * The ship's terminal row: ship_result describes only the gate chain, so a preflight refusal, a
 * failed push or a failed PR create had no outcome row. Null cause on success.
 */
export function shipEndRow(rc, cause = '') {
    const fallback = SIGNAL_EXITS.has(rc) ? 'interrupted' : 'aborted';
    return { type: 'ship_end', exit_code: rc, cause: rc === 0 ? null : cause || fallback };
}
const SHIP_EVENT_KEYS = [
    'mode',
    'resumed',
    'body_bytes',
    'queued_s',
    'log_path',
    'exit_code',
    'timed_out',
    'reaped',
    'root',
    'blocked_gate',
    'duration_s',
    'pr_url',
    'pr_number',
];
// The shell's ship rows use emitGateEvent's single append: bash line-buffers stdout at BUFSIZ
// (1,024 bytes on macOS), so a longer `printf >>` row reaches the shared sink as several write()s.
export function shipEventRow(kind, args) {
    if (kind === 'attempt')
        return {
            type: 'ship_attempt',
            root: args.root || undefined,
            mode: args.mode ?? 'ship',
            resumed: args.resumed === 'true',
            body_bytes: count(args.body_bytes),
            queued_s: args.queued_s === undefined ? undefined : count(args.queued_s),
            log_path: args.log_path,
        };
    if (kind === 'result')
        return {
            type: 'ship_result',
            root: args.root || undefined,
            exit_code: count(args.exit_code),
            timed_out: args.timed_out === 'true',
            reaped: args.reaped === 'true',
            blocked_gate: args.blocked_gate && args.blocked_gate !== 'null' ? args.blocked_gate : null,
            duration_s: count(args.duration_s),
            log_path: args.log_path,
        };
    if (kind === 'pr')
        return { type: 'ship_pr', pr_url: args.pr_url, pr_number: count(args.pr_number) };
    return null;
}
/** The collector type-checks these fields, so a non-numeric argument becomes null, never a string. */
function count(value) {
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}
function parseShipEventArgs(pairs) {
    const args = {};
    for (const pair of pairs) {
        const at = pair.indexOf('=');
        const key = SHIP_EVENT_KEYS.find((known) => at > 0 && known === pair.slice(0, at));
        if (key)
            args[key] = pair.slice(at + 1);
    }
    return args;
}
// CLI: `node ship-intent-event.mjs end <rc> [cause]` or `attempt|result|pr key=value…`. Best-effort.
runDirectReviewCli(import.meta.url, ([kind = '', ...rest]) => {
    if (kind === 'end') {
        if (/^\d+$/.test(rest[0] ?? ''))
            emitGateEvent(shipEndRow(Number(rest[0]), rest[1]));
        return;
    }
    const row = shipEventRow(kind, parseShipEventArgs(rest));
    if (row)
        emitGateEvent(row);
});
/** A body file the hint can name: a 0700 temp dir, so the bytes never land in the repo. */
function saveRecoveredBody(body) {
    try {
        const file = path.join(mkdtempSync(path.join(tmpdir(), 'devkit-ship-body-')), 'body.md');
        writeFileSync(file, body, { mode: 0o600 });
        return file;
    }
    catch {
        return null;
    }
}
/** A stale record is refused, never replayed; hand it back as the full command, which re-records.
 * stderr only (stdout is the read protocol); stdin keeps a reship from rewriting the PR body. */
export function printStaleRecovery(intent, recordRel, nowMs = Date.now()) {
    const hours = Math.floor((nowMs - Date.parse(intent.createdAt)) / 3_600_000);
    const bodyFile = saveRecoveredBody(Buffer.from(intent.bodyB64, 'base64'));
    const argv = replayableArgv(intent, false);
    const viaStdin = intent.mode === 'reship' && !intent.updatePrBody;
    if (bodyFile && !viaStdin) {
        const pathsAt = (intent.sourceMode ?? 'explicit') === 'explicit' ? intent.paths.length + 1 : 0;
        argv.splice(argv.length - pathsAt, 0, '--body-file', bodyFile);
    }
    const redirect = bodyFile && viaStdin ? ` < ${shQuote(bodyFile)}` : '';
    const where = bodyFile
        ? `${bodyFile} is a temporary copy of the recorded body; \`devkit ship --resume ${shQuote(intent.branch)}\` regenerates it`
        : `could not save the recorded body to a temp file; its bytes are base64 in ${recordRel} (bodyB64)`;
    console.error(`ship-intent: recorded ${intent.createdAt} (${hours}h ago): ${JSON.stringify(intent.title)}, ` +
        `${intent.paths.length} path(s) — if this is still the work you mean, re-run the full command (it re-records):\n` +
        `  ${argv.map(shQuote).join(' ')}${redirect}\nship-intent: ${where}`);
}
