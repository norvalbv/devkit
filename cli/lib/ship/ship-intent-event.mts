import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { emitGateEvent } from '../../../gate-engine/judge/gate-events.mts';
import { redactSecrets, shQuote } from './redact-secrets.mts';
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

/** The `key=value` arguments the ship scripts pass, as raw strings; shipEventRow types them. */
export interface ShipEventArgs {
  mode?: string;
  resumed?: string;
  body_bytes?: string;
  log_path?: string;
  exit_code?: string;
  timed_out?: string;
  blocked_gate?: string;
  duration_s?: string;
  pr_url?: string;
  pr_number?: string;
}

const SHIP_EVENT_KEYS = [
  'mode',
  'resumed',
  'body_bytes',
  'log_path',
  'exit_code',
  'timed_out',
  'blocked_gate',
  'duration_s',
  'pr_url',
  'pr_number',
] as const satisfies readonly (keyof ShipEventArgs)[];

// The shell's ship rows use emitGateEvent's single append: bash line-buffers stdout at BUFSIZ
// (1,024 bytes on macOS), so a longer `printf >>` row reaches the shared sink as several write()s.
export function shipEventRow(kind: string, args: ShipEventArgs) {
  if (kind === 'attempt')
    return {
      type: 'ship_attempt',
      mode: args.mode ?? 'ship',
      resumed: args.resumed === 'true',
      body_bytes: count(args.body_bytes),
      log_path: args.log_path,
    };
  if (kind === 'result')
    return {
      type: 'ship_result',
      exit_code: count(args.exit_code),
      timed_out: args.timed_out === 'true',
      blocked_gate: args.blocked_gate && args.blocked_gate !== 'null' ? args.blocked_gate : null,
      duration_s: count(args.duration_s),
      log_path: args.log_path,
    };
  if (kind === 'pr')
    return { type: 'ship_pr', pr_url: args.pr_url, pr_number: count(args.pr_number) };
  return null;
}

/** The collector type-checks these fields, so a non-numeric argument becomes null, never a string. */
function count(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function parseShipEventArgs(pairs: string[]): ShipEventArgs {
  const args: ShipEventArgs = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const key = SHIP_EVENT_KEYS.find((known) => at > 0 && known === pair.slice(0, at));
    if (key) args[key] = pair.slice(at + 1);
  }
  return args;
}

// CLI: `node ship-intent-event.mjs attempt|result|pr key=value…`. Best-effort, like emitGateEvent.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [kind = '', ...pairs] = process.argv.slice(2);
  const row = shipEventRow(kind, parseShipEventArgs(pairs));
  if (row) emitGateEvent(row);
}
