import { superviseGateCommand } from '../lib/ship/review/process/gate-supervisor.mts';
import {
  type ProcessTableReader,
  readProcessTable,
} from '../lib/ship/review/process/process-table.mts';

function usage(): never {
  throw new Error('usage: test-subprocess [--group-only] <timeout-ms> -- <command...>');
}

async function main(args: string[]): Promise<void> {
  const groupOnly = args[0] === '--group-only';
  const timeoutIndex = groupOnly ? 1 : 0;
  const separatorIndex = timeoutIndex + 1;
  if (args.length < separatorIndex + 2 || args[separatorIndex] !== '--') return usage();
  const timeoutMs = Number(args[timeoutIndex]);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return usage();
  const inspectProcesses: ProcessTableReader = groupOnly ? () => new Map() : readProcessTable;

  process.exitCode = await superviseGateCommand(
    timeoutMs,
    args.slice(separatorIndex + 1),
    inspectProcesses,
    undefined,
    false,
  );
}

void main(process.argv.slice(2)).catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
