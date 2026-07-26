import { superviseGateCommand } from '../lib/ship/review/process/gate-supervisor.mts';
import { readProcessTable } from '../lib/ship/review/process/process-table.mts';

function usage(): never {
  throw new Error('usage: test-subprocess <timeout-ms> -- <command...>');
}

async function main(args: string[]): Promise<void> {
  if (args.length < 3 || args[1] !== '--') return usage();
  const timeoutMs = Number(args[0]);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return usage();

  process.exitCode = await superviseGateCommand(
    timeoutMs,
    args.slice(2),
    readProcessTable,
    undefined,
    false,
  );
}

void main(process.argv.slice(2)).catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
