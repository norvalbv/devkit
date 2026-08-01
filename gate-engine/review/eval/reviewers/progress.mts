// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * Checkpoint/salvage/baseline-file IO layer for the reviewer-eval bench (split out of bench.mts to
 * keep it within its size ratchet). Owns the per-config progress ledger a killed run resumes from,
 * the salvage-matching that decides which checkpointed rows are still valid, and the --against
 * "before" snapshot loader for A/B comparisons.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchAbort, parseCasesText } from '../../../decisions/eval/bench.mts';
import { rowHash } from './corpus.mts';

const here = path.dirname(fileURLToPath(import.meta.url));

// Retryable outcomes always re-run rather than salvage — an outage/engine-error checkpoint is not
// a real result.
export const RETRYABLE = new Set(['outage', 'engine-error']);

// Checkpoint/resume: every completed row is appended to a per-config progress file the moment it
// lands, so a run killed by a rate limit / account switch loses NOTHING — re-running the same
// command auto-resumes (rows with matching config+hashes and a non-outage result are reused;
// --fresh discards).
export const progressFile = (model, cascade) =>
  path.join(here, `progress-${model}-${cascade ? 'on' : 'off'}.jsonl`);

export function loadProgress(model, cascade) {
  try {
    return parseCasesText(readFileSync(progressFile(model, cascade), 'utf8'));
  } catch {
    return [];
  }
}

/** Checkpointed rows reusable for THIS reviewer + gate + row: per-row matching (not corpus-wide) —
 * a checkpoint salvages iff its reviewer/gateHash match AND its stored `rowHash` equals the
 * CURRENT row's rowHash, so appending/editing sibling rows never invalidates an untouched row's
 * checkpoint. Retryable outcomes (outage/engine-error) always re-run; a hash mismatch simply never
 * matches — stale checkpoints are inert, not dangerous. */
export function salvageMap(progress, reviewerName, meta, rows) {
  const currentRowHash = new Map(rows.map((r) => [r.id, rowHash(r)]));
  return new Map(
    progress
      .filter(
        (p) =>
          p.reviewer === reviewerName &&
          p.gateHash === meta.gateHash &&
          p.rowHash === currentRowHash.get(p.res.id) &&
          !RETRYABLE.has(p.res.subcause),
      )
      .map((p) => [p.res.id, p.res]),
  );
}

// --against: the explicit "before" snapshot for a prompt A/B. Unlike loadBaseline (a missing
// baseline is fine → null), a bad --against path is a hard error — the user asked for a comparison.
export function loadAgainstFile(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new BenchAbort(2, `reviewer-eval: --against file unreadable (${p}): ${e?.message ?? e}`);
  }
}
