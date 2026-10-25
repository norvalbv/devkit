// The commands a codex judge ran (`command_execution` items; codex emits no duration), stored for
// every outcome so a FAIL caused by the judge's own command stays diagnosable after the run.
import { emitGateEvent } from '../gate-events.mts';
import { saveTranscriptUnique } from '../transcript-store.mts';
import { type CodexEventItem, codexEventsOf } from './result.mts';
import { takeLedger, toolGateLedgerDir } from './tool-gate.mts';

// Output is kept only for a failed command, and only this much: enough to name the error, too
// little to copy an env dump or a secret file into the telemetry store.
const FAILED_OUTPUT_CHARS = 200;

function commandLine(item: CodexEventItem): string {
  const code = item.exit_code ?? null;
  const line = `[${code === null ? (item.status ?? 'unknown') : `exit ${code}`}] ${item.command ?? ''}`;
  const output = (item.aggregated_output ?? '').slice(0, FAILED_OUTPUT_CHARS).trimEnd();
  if (code === null || code === 0 || !output) return line;
  return `${line}\n    ${output.replaceAll('\n', '\n    ')}`;
}

/** Each command_execution item once, latest state wins, in first-seen order. */
function commandItems(raw: string): CodexEventItem[] {
  const items = new Map<string, CodexEventItem>();
  for (const [i, event] of codexEventsOf(raw).entries()) {
    if (event.type !== 'item.started' && event.type !== 'item.completed') continue;
    if (event.item?.type !== 'command_execution') continue;
    items.set(event.item.id ?? `#${i}`, event.item);
  }
  return [...items.values()];
}

/** One line per command, in first-seen order; a started-but-never-completed one reads `[in_progress]`. */
export function codexCommandLines(raw: string): string[] {
  return commandItems(raw).map(commandLine);
}

/** The tool gate's refusals in this codex run, or null for non-codex bytes. A command the gate never
 * allowed means the hook did not fire: warned, never blocking. */
export function codexGateDenials(label: string, raw: string | undefined): string[] | null {
  const id = raw ? codexEventsOf(raw).find((e) => e.type === 'thread.started')?.thread_id : null;
  if (!raw || !id) return null;
  const ledger = takeLedger(toolGateLedgerDir(), id);
  // A hook-refused call emits no command_execution item (codex 0.150–0.162); `declined` is codex's own.
  const executed = commandItems(raw).filter((item) => item.status !== 'declined').length;
  const allowed = ledger.filter(
    (e) => e.decision === 'allow' && e.line.startsWith('Bash: '),
  ).length;
  if (executed > allowed) {
    const detail = `codex tool gate inactive: saw ${allowed} of ${executed} commands — the rest ran unchecked; check \`codex --version\` (tested 0.150–0.162) or pin GUARD_CODEX_BIN`;
    console.error(`⚠️  guard-review: ${label} — ${detail}`);
    emitGateEvent({ type: 'gate_degraded', judge: label, cause: 'tool-gate-inactive', detail });
  }
  return ledger.filter((e) => e.decision === 'deny').map((e) => e.line);
}

/** Store the command list as `<label>.commands`; the ref, or null when the run executed nothing. */
export function saveCodexCommands(
  label: string,
  raw: string | undefined,
  lens?: string,
): string | null {
  const lines = raw ? codexCommandLines(raw) : [];
  if (lines.length === 0) return null;
  return saveTranscriptUnique(
    `${label}.commands`,
    `${lens ? `lens: ${lens}\n` : ''}${lines.join('\n')}\n`,
  );
}
