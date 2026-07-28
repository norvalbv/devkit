import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CriticSource } from './run-critic.mts';

export interface SalvagedTrial {
  raw: string;
}

/** Read saved trials for one row from a transcripts directory. */
export function loadSalvageDir(dir: string, rowId: string): SalvagedTrial[] {
  const trials: SalvagedTrial[] = [];
  for (let run = 1; run <= 3; run += 1) {
    try {
      trials.push({
        raw: readFileSync(path.join(dir, `${rowId}.run${run}.summary.txt`), 'utf8'),
      });
    } catch {
      // Missing or unreadable trials are unavailable for salvage.
    }
  }
  return trials;
}

/** A K=3 majority needs at least two saved trials; a K=1 development row needs one. */
export const salvageUsable = (trials: SalvagedTrial[], runs: number): boolean =>
  trials.length >= (runs >= 3 ? 2 : 1);

export const sha12 = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';

export const runnerHash = () =>
  sha12(
    readFileSync(path.join(here, `run-critic${SELF_EXT}`), 'utf8') +
      readFileSync(path.join(here, `matcher${SELF_EXT}`), 'utf8') +
      readFileSync(path.join(here, `../response-contract${SELF_EXT}`), 'utf8'),
  );

export const salvageFingerprint = (
  critic: Pick<CriticSource, 'model' | 'raw'>,
  corpusRaw: string,
  runnerDigest = runnerHash(),
) =>
  sha12(
    JSON.stringify({
      agent: critic.raw,
      model: critic.model,
      runner: runnerDigest,
      corpus: corpusRaw,
    }),
  );
