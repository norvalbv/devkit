#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * propose-telemetry — deterministic triage of raw/candidates-telemetry.jsonl (mine-telemetry's
 * output) into an adaptation queue. The telemetry-candidate counterpart of propose.mts, split
 * off per the plan of record in mine-telemetry.mts: telemetry candidates have no PR, no commit
 * anchor, and no GitHub content to enrich (`!originalCommitId` would hard-drop every one), so
 * they get their own path. No LLM calls, no network — the diff bytes ride in the candidate rows.
 *
 *   bun propose-telemetry.mts [--max N]   (default 10 per suite)
 *
 * Output: raw/queue-telemetry.jsonl (gitignored), one JSON line per surviving candidate —
 *   { queueId, suite: 'correctness' | 'commit-guard', candidate: <full candidates-telemetry.jsonl row> }
 *
 * Pipeline: HARD DROPS (counted) → SORT (evidence richness, then recency) → CAP per suite → WRITE.
 * Charter: the reviewers in SUITES. Evidence tiers: both diffs archived › fail diff
 * only › failReason-only (kept, flagged `failReasonOnly` — adaptation from prose alone needs
 * extra care and usually waits).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeDropCounter,
  makeHardDrop,
  parseMaxArg,
  partitionDrops,
  printSummary,
  readJsonl,
  requireFile,
  runIfMain,
  slugify,
  uniqueId,
  writeQueue,
} from './propose-common.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
// This script lives in propose/ — candidates + raw/ live one level up, beside the corpora.
const reviewersDir = path.join(here, '..');
const CANDIDATES_FILE = path.join(reviewersDir, 'raw', 'candidates-telemetry.jsonl');
const RAW_DIR = path.join(reviewersDir, 'raw');
const OUT_FILE = path.join(RAW_DIR, 'queue-telemetry.jsonl');

/** Reviewer → its corpus suite (the skill) and queue-id prefix. A commit-guard FAIL is only a
 * candidate: many are correctness findings, so adaptation confirms it names a duplicated original. */
const SUITES = {
  'correctness-reviewer': { suite: 'correctness', prefix: 'corr-tel' },
  'commit-guard': { suite: 'commit-guard', prefix: 'cg-tel' },
};

/** Returns a drop reason string, or null if the candidate survives. */
function hardDropReason(c) {
  if (!SUITES[c.reviewer]) return `out-of-charter:${c.reviewer}`;
  if (c.kind === 'waived-decoy') return null;
  if (c.kind !== 'fail-fix') return `unknown-kind:${c.kind}`;
  if (!c.failReason || String(c.failReason).trim().length === 0) return 'no-fail-reason';
  return null;
}

/** Evidence tier: lower sorts first. Both diffs > fail diff only > failReason-only. */
function evidenceTier(c) {
  if (c.bytesAvailable && c.nextBytesAvailable) return 0;
  if (c.bytesAvailable) return 1;
  return 2;
}

function compareCandidates(a, b) {
  const byTier = evidenceTier(a) - evidenceTier(b);
  if (byTier !== 0) return byTier;
  // Newer first within a tier — recent findings match the current reviewer checklist.
  return Date.parse(b.tsFail ?? 0) - Date.parse(a.tsFail ?? 0);
}

/** Sort kept candidates and cap each suite at `max`, so one suite's volume never displaces another's. */
export function queueRows(kept, max, bump) {
  const seenIds = new Set();
  const rows = [];
  for (const [reviewer, { suite, prefix }] of Object.entries(SUITES)) {
    const mine = kept.filter((c) => c.reviewer === reviewer).sort(compareCandidates);
    if (mine.length > max) bump(`over-max:${suite}:${mine.length - max}`);
    for (const candidate of mine.slice(0, max))
      rows.push({
        queueId: uniqueId(`${prefix}-${slugify(candidate.failReason)}`, seenIds),
        suite,
        failReasonOnly: evidenceTier(candidate) === 2,
        candidate,
      });
  }
  return rows;
}

function main() {
  const max = parseMaxArg(process.argv.slice(2), 'propose-telemetry');
  requireFile(CANDIDATES_FILE, 'propose-telemetry', 'run mine-telemetry.mts first');

  const candidates = readJsonl(CANDIDATES_FILE);
  const { drops, bump } = makeDropCounter();

  const kept = partitionDrops(candidates, makeHardDrop(reviewersDir, hardDropReason), bump);
  const rows = queueRows(kept, max, bump);

  writeQueue(OUT_FILE, rows);

  const tiers = { 0: 0, 1: 0, 2: 0 };
  for (const { candidate } of rows) tiers[evidenceTier(candidate)] += 1;
  printSummary(
    [
      `propose-telemetry: ${candidates.length} candidates → ${kept.length} in charter → ${rows.length} queued`,
      `  evidence tiers queued: both-diffs:${tiers[0]}, fail-diff-only:${tiers[1]}, fail-reason-only:${tiers[2]}`,
    ],
    drops,
    reviewersDir,
    OUT_FILE,
  );
}

runIfMain(import.meta.url, main);
