import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { superviseGateCommand } from '../lib/ship/review/process/gate-supervisor.mts';
import {
  type ProcessTableReader,
  readProcessTable,
} from '../lib/ship/review/process/process-table.mts';
import { runDirectReviewCli } from '../lib/ship/review/run-direct.mts';

/** File this runner creates when its OWN deadline fired; out of band, so no exit status is reserved. */
export const DEADLINE_NOTICE_ENV = 'DEVKIT_TEST_DEADLINE_NOTICE';

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
  const deadlineNotice = process.env[DEADLINE_NOTICE_ENV];
  delete process.env[DEADLINE_NOTICE_ENV];
  const reapNotice = deadlineNotice && `${deadlineNotice}.reaped`;

  try {
    const started = Date.now();
    const status = await superviseGateCommand(
      timeoutMs,
      args.slice(separatorIndex + 1),
      inspectProcesses,
      undefined,
      false,
      reapNotice,
    );
    // A linger reap cancels the deadline timer, so its 124 is never the deadline however late it lands.
    const reaped = reapNotice !== undefined && existsSync(reapNotice);
    if (deadlineNotice && status === 124 && !reaped && Date.now() - started >= timeoutMs) {
      writeFileSync(deadlineNotice, '');
    }
    process.exitCode = status;
  } finally {
    if (reapNotice) rmSync(reapNotice, { force: true });
  }
}

runDirectReviewCli(import.meta.url, (args) => {
  void main(args).catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
});
