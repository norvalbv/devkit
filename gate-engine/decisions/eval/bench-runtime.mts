import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { BenchAbort } from './cases.mts';
import { judgeBinForModel } from '../../judge/codex/result.mts';

/** Append one run to `<dir>/runs.log` — the anti-Goodhart ledger. Telemetry: never breaks a run. */
export function appendLedger<Entry>(dir: string, entry: Entry) {
  try {
    appendFileSync(path.join(dir, 'runs.log'), `${JSON.stringify(entry)}\n`);
  } catch {
    // The ledger is telemetry; never let it break a run.
  }
}

/** Exit 2 before any paid call when the CLI that runs `model` (claude or codex) is missing. */
export function preflightJudge(
  bench: string,
  role: 'reviewer' | 'matcher',
  model: string,
  probe: (bin: string) => void = (bin) => {
    execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 30000 });
  },
) {
  const bin = judgeBinForModel(model);
  try {
    probe(bin);
  } catch {
    throw new BenchAbort(
      2,
      `${bench}: ${role} model ${model} requires \`${bin}\`, but that CLI is not available`,
    );
  }
}
