// The commands a codex judge ran (`command_execution` items; codex emits no duration), stored for
// every outcome so a FAIL caused by the judge's own command stays diagnosable after the run.
import { saveSidecar } from '../transcript-store.mts';
import { type CodexEventItem, codexEventsOf } from './result.mts';

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

/** One line per command, in first-seen order; a started-but-never-completed one reads `[in_progress]`. */
export function codexCommandLines(raw: string): string[] {
  const items = new Map<string, CodexEventItem>();
  for (const [i, event] of codexEventsOf(raw).entries()) {
    if (event.type !== 'item.started' && event.type !== 'item.completed') continue;
    if (event.item?.type !== 'command_execution') continue;
    items.set(event.item.id ?? `#${i}`, event.item);
  }
  return [...items.values()].map(commandLine);
}

/** Store the command list as `<label>.commands`; the ref, or null when the run executed nothing. */
export function saveCodexCommands(
  label: string,
  raw: string | undefined,
  lens?: string,
): string | null {
  return saveSidecar(`${label}.commands`, raw ? codexCommandLines(raw) : [], lens);
}
