import { spawnSync } from 'node:child_process';

/**
 * Reading the OS process table — the supervisor's only window onto the gate tree it owns.
 *
 * Split out of gate-supervisor.mts when that file crossed the 500-line cap: this is the one layer
 * with no supervisor state in it (a `/bin/ps` call plus its parse), so it lifts cleanly and leaves
 * the lifetime machinery — ownership, signalling, settle — as the supervisor's single subject.
 */

// `ps` output is bounded rather than streamed: 16MB is far above the ~1MB a loaded box produces,
// and a table that somehow exceeds it must fail loudly (ENOBUFS below) rather than be silently
// truncated — a truncated table reads as "that process is gone" and would strand a live gate child.
const PROCESS_TABLE_MAX_BYTES = 16 * 1024 * 1024;
const PROCESS_LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+?)\s*$/;
const PROCESS_PID_PATTERN = /^\s*(\d+)/;

export interface ProcessRecord {
  pid: number;
  parentPid: number;
  groupId: number;
  identity: string;
  ownershipToken: boolean;
}

export type ProcessTableReader = (ownershipMarker?: string) => Map<number, ProcessRecord>;

function processTableOutput(args: string[]): string {
  const result = spawnSync('/bin/ps', args, {
    encoding: 'utf8',
    maxBuffer: PROCESS_TABLE_MAX_BYTES,
  });
  if (result.error)
    throw new Error('could not inspect the gate process tree', { cause: result.error });
  if (result.status !== 0) {
    throw new Error(`could not inspect the gate process tree (ps exit ${String(result.status)})`);
  }
  return result.stdout;
}

/**
 * Every process on the box, keyed by pid. `identity` is the start-time-qualified name the supervisor
 * uses to tell a tracked process from an unrelated one that inherited its recycled pid.
 *
 * With an `ownershipMarker`, a second pass dumps each process's ENVIRONMENT and flags the ones
 * carrying the supervisor's private token. That is what lets a gate child which escaped into its own
 * process group still be recognised as ours and reaped.
 */
export function readProcessTable(ownershipMarker?: string): Map<number, ProcessRecord> {
  const output = processTableOutput('-A -o pid= -o ppid= -o pgid= -o stat= -o lstart='.split(' '));
  const table = new Map<number, ProcessRecord>();
  for (const line of output.split('\n')) {
    const match = PROCESS_LINE_PATTERN.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    table.set(pid, {
      pid,
      parentPid: Number(match[2]),
      groupId: Number(match[3]),
      identity: match[4] as string,
      ownershipToken: false,
    });
  }
  if (ownershipMarker) {
    const environmentArgs =
      process.platform === 'linux'
        ? ['-A', 'eww', '-o', 'pid=', '-o', 'command=']
        : ['-A', '-wwE', '-o', 'pid=', '-o', 'command='];
    for (const line of processTableOutput(environmentArgs).split('\n')) {
      const pid = Number(PROCESS_PID_PATTERN.exec(line)?.[1]);
      const record = table.get(pid);
      if (record && line.includes(ownershipMarker)) record.ownershipToken = true;
    }
  }
  return table;
}
