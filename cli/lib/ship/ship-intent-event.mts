import { emitGateEvent } from '../../../gate-engine/judge/gate-events.mts';
import { redactSecrets, shQuote } from './redact-secrets.mts';
import { runDirectReviewCli } from './review/run-direct.mts';
import type { ShipIntent } from './ship-intent-codec.mts';

/**
 * The node-side attempt event. `command` is the replayable invocation (paths included — the
 * warehouse `command` column documents exactly this, and the sink is personal-scale); `pr_body` is
 * the decoded body for the dashboard drill-down — both pass redactSecrets, and body_bytes stays
 * the RAW length (it measures the retry cost, not the redacted rendering). Envelope adds
 * ship_id/repo/branch/source/version from the DEVKIT_SHIP_* env the ship script exports before
 * calling write. Best-effort by emitGateEvent's own contract.
 */
export function emitShipIntentEvent(intent: ShipIntent, resumed: boolean): void {
  const sourceMode = intent.sourceMode ?? 'explicit';
  const flagParts = [
    ...(intent.mode === 'reship' ? ['--pr'] : []),
    ...(intent.base ? ['--base', intent.base] : []),
    ...(sourceMode === 'branch' ? ['--from-branch'] : []),
    ...intent.links.flatMap((d) => ['--link', d]),
    // `command` is documented as the REPLAYABLE invocation, so the draft bit has to appear here —
    // without it the recorded command replays as a ready PR.
    ...(intent.draft ? ['--draft'] : []),
    ...(intent.noStack ? ['--no-stack'] : []),
  ];
  const body = Buffer.from(intent.bodyB64, 'base64');
  const commandParts =
    sourceMode === 'branch' && resumed
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

/** The HUP, INT, QUIT and TERM statuses review/process/gate-signal-handoff.sh exits with. */
const SIGNAL_EXITS = new Set([129, 130, 131, 143]);

/**
 * The ship's terminal row: ship_result describes only the gate chain, so a preflight refusal, a
 * failed push or a failed PR create had no outcome row. Null cause on success.
 */
export function shipEndRow(rc: number, cause = '') {
  const fallback = SIGNAL_EXITS.has(rc) ? 'interrupted' : 'aborted';
  return { type: 'ship_end', exit_code: rc, cause: rc === 0 ? null : cause || fallback };
}

// CLI: `node ship-intent-event.mjs end <rc> [cause]`, from ship-branch.sh's EXIT trap. Best-effort.
runDirectReviewCli(import.meta.url, ([kind, rc = '', cause]) => {
  if (kind === 'end' && /^\d+$/.test(rc)) emitGateEvent(shipEndRow(Number(rc), cause));
});
