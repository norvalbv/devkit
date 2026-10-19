import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs';
import { basename } from 'node:path';
import type { ProcessRecord } from './process-table.mts';

// Names what outlived a clean gate leader at the linger reap. Never prints env or argv past a script
// path: env holds the ownership token and API keys, and MCP server argv holds tokens.

const MAX_LISTED = 5;
const FIELD_MAX_CHARS = 64;
const PROCESS_COLUMNS = '-o pid= -o ppid= -o pgid= -o etime= -o ucomm='.split(' ');
const ARGS_COLUMNS = '-o pid= -o args='.split(' ');
const PROCESS_LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*?))?\s*$/;
const ARGS_LINE_PATTERN = /^\s*(\d+)\s+(.*)$/;

export interface SurvivorArgs {
  pid: number;
  parentPid: number;
  groupId: number;
  elapsed: string;
  name: string;
  args: string;
}

export type SurvivorArgsReader = (pids: number[]) => SurvivorArgs[];

/** Owned pids whose live table entry still carries the identity the supervisor recorded. */
export function survivingPids(
  table: Map<number, ProcessRecord>,
  identities: Map<number, string>,
): number[] {
  return [...identities]
    .filter(([pid, identity]) => table.get(pid)?.identity === identity)
    .map(([pid]) => pid);
}

function psLines(pids: number[], columns: string[]): string[] {
  const { stdout } = spawnSync('/bin/ps', [...columns, '-p', pids.join(',')], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  return (stdout ?? '').split('\n');
}

/**
 * Env-free `ps` reads (no e/E flag) of the given pids; a pid gone since the sample is skipped. The
 * name is the kernel's `ucomm`: macOS fills `comm` and `args` from the environment when argv[0] is empty.
 */
export function readSurvivorArgs(pids: number[]): SurvivorArgs[] {
  if (pids.length === 0) return [];
  const args = new Map<number, string>();
  for (const line of psLines(pids, ARGS_COLUMNS)) {
    const [, pid, rest = ''] = ARGS_LINE_PATTERN.exec(line) ?? [];
    if (pid) args.set(Number(pid), rest);
  }
  const rows: SurvivorArgs[] = [];
  for (const line of psLines(pids, PROCESS_COLUMNS)) {
    const [, pid, parentPid, groupId, elapsed = '', name = ''] =
      PROCESS_LINE_PATTERN.exec(line) ?? [];
    if (!pid) continue;
    rows.push({
      pid: Number(pid),
      parentPid: Number(parentPid),
      groupId: Number(groupId),
      elapsed,
      name,
      args: args.get(Number(pid)) ?? '',
    });
  }
  return rows;
}

function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?').slice(0, FIELD_MAX_CHARS);
}

function executableLabel(row: SurvivorArgs): string {
  const named = printable(row.name) || '?';
  const script = row.args.trim().split(/\s+/)[1];
  const pathLike = script !== undefined && /^[/.]/.test(script) && !script.includes('=');
  return pathLike ? `${named} ${printable(basename(script))}` : named;
}

function describeRow(row: SurvivorArgs): string {
  const fields = `ppid=${row.parentPid} pgid=${row.groupId} up=${printable(row.elapsed)}`;
  return `${row.pid} ${fields} ${executableLabel(row)}`;
}

/**
 * Lines naming the surviving owned processes, topmost first (its parent is not a survivor too),
 * capped with a "+N more" line. Never throws: a failed read names nothing rather than stall a reap.
 */
export function describeSurvivors(
  table: Map<number, ProcessRecord>,
  identities: Map<number, string>,
  readArgs: SurvivorArgsReader = readSurvivorArgs,
): string {
  try {
    const rows = readArgs(survivingPids(table, identities));
    const pids = new Set(rows.map((row) => row.pid));
    const ordered = [
      ...rows.filter((row) => !pids.has(row.parentPid)),
      ...rows.filter((row) => pids.has(row.parentPid)),
    ];
    const lines = ordered.slice(0, MAX_LISTED).map(describeRow);
    if (ordered.length > MAX_LISTED) lines.push(`+${ordered.length - MAX_LISTED} more`);
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** Async on purpose: a failed write can never stop the reap; the banner then names nothing. */
export function writeReapNotice(
  file: string,
  table: Map<number, ProcessRecord>,
  identities: Map<number, string>,
): void {
  writeFile(file, describeSurvivors(table, identities), () => {});
}
