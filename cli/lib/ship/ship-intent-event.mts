import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emitGateEvent } from '../../../gate-engine/judge/gate-events.mts';
import { redactSecrets, shQuote } from './redact-secrets.mts';
import { runDirectReviewCli } from './review/run-direct.mts';
import type { ShipIntent } from './ship-intent-codec.mts';

/** The argv that re-runs a recorded invocation; a resumed branch-mode attempt replays by name. */
export function replayableArgv(intent: ShipIntent, resumed: boolean): string[] {
  const sourceMode = intent.sourceMode ?? 'explicit';
  if (sourceMode === 'branch' && resumed) return ['devkit', 'ship', '--resume', intent.branch];
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
export function emitShipIntentEvent(intent: ShipIntent, resumed: boolean): void {
  const body = Buffer.from(intent.bodyB64, 'base64');
  emitGateEvent({
    type: 'ship_intent',
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
export function shipEndRow(rc: number, cause = '') {
  const fallback = SIGNAL_EXITS.has(rc) ? 'interrupted' : 'aborted';
  return { type: 'ship_end', exit_code: rc, cause: rc === 0 ? null : cause || fallback };
}

// CLI: `node ship-intent-event.mjs end <rc> [cause]`, from ship-branch.sh's EXIT trap. Best-effort.
runDirectReviewCli(import.meta.url, ([kind, rc = '', cause]) => {
  if (kind === 'end' && /^\d+$/.test(rc)) emitGateEvent(shipEndRow(Number(rc), cause));
});

/** A body file the hint can name: a 0700 temp dir, so the bytes never land in the repo. */
function saveRecoveredBody(body: Buffer): string | null {
  try {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'devkit-ship-body-')), 'body.md');
    writeFileSync(file, body, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/** A stale record is refused, never replayed; hand it back as the full command, which re-records.
 * stderr only (stdout is the read protocol); stdin keeps a reship from rewriting the PR body. */
export function printStaleRecovery(
  intent: ShipIntent,
  recordRel: string,
  nowMs = Date.now(),
): void {
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
  console.error(
    `ship-intent: recorded ${intent.createdAt} (${hours}h ago): ${JSON.stringify(intent.title)}, ` +
      `${intent.paths.length} path(s) — if this is still the work you mean, re-run the full command (it re-records):\n` +
      `  ${argv.map(shQuote).join(' ')}${redirect}\nship-intent: ${where}`,
  );
}
