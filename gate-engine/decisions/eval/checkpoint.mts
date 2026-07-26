/**
 * Checkpoint/resume for the judge bench.
 *
 * A full `all --baseline` run is ~150 minutes of `claude -p` cold starts, and every one of the ways
 * it ends early — a dark judge, a drained quota, Ctrl-C, a laptop lid — used to discard every row
 * already paid for. Each completed row is now appended to a per-sub progress file the moment it
 * lands, so re-running the SAME command replays those rows for free and pays only for the rest.
 *
 * A checkpointed row is reused only when the config AND both hashes match, so a different model, a
 * re-labelled corpus or an edited gate simply never matches: a stale checkpoint is inert, never a
 * quietly-wrong score. Outage verdicts are never salvaged — redoing them is the point of resuming.
 *
 * Progress files are local scratch (gitignored), not evidence: `runs.log` remains the ledger and
 * `results.baseline.json` remains the result. Pass `--fresh` to discard and re-measure from zero.
 */

import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const progressFile = (sub, dir = here) => path.join(dir, `progress-${sub}.jsonl`);

/** A row counts as done only if the judge actually answered. NULL is an outage (or an unparseable
 * verdict) — exactly the work a resume exists to retry, so it is never salvaged. */
const RETRYABLE = new Set(['NULL', null, undefined]);
const verdictOf = (res) => res?.final ?? res?.got;

/** Sub-benches take this by default, so a direct caller (every unit test) never touches the disk —
 * checkpointing is opt-in from main(), not an ambient side effect of running a bench. */
export const NO_CHECKPOINT = {
  size: 0,
  take: () => undefined,
  record: () => {},
};

/**
 * JSONL, read tolerantly: a run killed mid-append can leave a torn final line, and losing 40 good
 * rows because the 41st is half-written would defeat the feature. Unreadable lines are dropped and
 * announced (those rows re-run) rather than failing the load.
 */
function readProgress(file) {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return []; // no checkpoint yet — the ordinary first-run case
  }
  const rows = [];
  let torn = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      torn += 1;
    }
  }
  if (torn)
    console.error(
      `decisions-eval: checkpoint ${path.basename(file)} had ${torn} unreadable line(s) — those rows re-run`,
    );
  return rows;
}

/**
 * Open the progress file for one sub-bench.
 *
 * `config` distinguishes runs whose cost differs but whose corpus does not (model, K, cascade);
 * `gateHash`/`corpusHash` are the same identities the baseline embeds.
 */
export function openCheckpoint(sub, { config, gateHash, corpusHash, fresh = false, dir } = {}) {
  const file = progressFile(sub, dir);
  if (fresh) rmSync(file, { force: true });

  const salvaged = new Map();
  for (const p of readProgress(file)) {
    if (p.sub !== sub || p.config !== config) continue;
    if (p.gateHash !== gateHash || p.corpusHash !== corpusHash) continue;
    if (RETRYABLE.has(verdictOf(p.res))) continue;
    salvaged.set(p.res.id, p.res); // last write wins — a later re-run supersedes an earlier one
  }

  let warned = false;
  return {
    size: salvaged.size,
    take: (id) => salvaged.get(id),
    record(res) {
      try {
        appendFileSync(file, `${JSON.stringify({ sub, config, gateHash, corpusHash, res })}\n`);
      } catch (e) {
        // Loud once, then continue: the run is still valid, it just is not resumable. Silence here
        // would turn "resume works" into a claim nothing checks.
        if (!warned) {
          warned = true;
          console.error(
            `decisions-eval: WARNING — cannot write ${file} (${e?.message ?? e}); this run is NOT resumable`,
          );
        }
      }
    },
  };
}
