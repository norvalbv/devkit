import { emitGateEvent } from '../../../gate-engine/judge/gate-events.mjs';
import { redactSecrets, shQuote } from './redact-secrets.mjs';
/**
 * The node-side attempt event. `command` is the replayable invocation (paths included — the
 * warehouse `command` column documents exactly this, and the sink is personal-scale); `pr_body` is
 * the decoded body for the dashboard drill-down — both pass redactSecrets, and body_bytes stays
 * the RAW length (it measures the retry cost, not the redacted rendering). Envelope adds
 * ship_id/repo/branch/source/version from the DEVKIT_SHIP_* env the ship script exports before
 * calling write. Best-effort by emitGateEvent's own contract.
 */
export function emitShipIntentEvent(intent, resumed) {
    const sourceMode = intent.sourceMode ?? 'explicit';
    const flagParts = [
        ...(intent.mode === 'reship' ? ['--pr'] : []),
        ...(intent.base ? ['--base', intent.base] : []),
        ...(sourceMode === 'branch' ? ['--from-branch'] : []),
        ...intent.links.flatMap((d) => ['--link', d]),
        ...(intent.noQavisPublish ? ['--no-qavis-publish'] : []),
        // `command` is documented as the REPLAYABLE invocation, so the draft bit has to appear here —
        // without it the recorded command replays as a ready PR.
        ...(intent.draft ? ['--draft'] : []),
    ];
    const body = Buffer.from(intent.bodyB64, 'base64');
    const commandParts = sourceMode === 'branch' && resumed
        ? ['devkit', 'ship', '--resume', intent.branch]
        : [
            'devkit',
            'ship',
            intent.branch,
            intent.title,
            ...flagParts,
            ...(sourceMode === 'explicit' ? ['--', ...intent.paths] : []),
        ];
    emitGateEvent({
        type: 'ship_intent',
        mode: intent.mode,
        source_mode: sourceMode,
        command: redactSecrets(commandParts.map(shQuote).join(' ')),
        pr_body: redactSecrets(body.toString('utf8')),
        body_bytes: body.length,
        path_count: intent.paths.length,
        resumed,
    });
}
