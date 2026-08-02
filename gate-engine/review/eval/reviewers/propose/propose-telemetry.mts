#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * propose-telemetry — deterministic triage of raw/candidates-telemetry.jsonl (mine-telemetry's
 * output) into an adaptation queue. The telemetry-candidate counterpart of propose.mts, split
 * off per the plan of record in mine-telemetry.mts: telemetry candidates have no PR, no commit
 * anchor, and no GitHub content to enrich (`!originalCommitId` would hard-drop every one), so
 * they get their own path. No LLM calls, no network — the diff bytes ride in the candidate rows.
 *
 *   bun propose-telemetry.mts [--max N]   (default 10)
 *
 * Output: raw/queue-telemetry.jsonl (gitignored), one JSON line per surviving candidate —
 *   { queueId, suite: 'correctness', candidate: <full candidates-telemetry.jsonl row> }
 *
 * Pipeline: HARD DROPS (counted) → SORT (evidence richness, then recency) → CAP → WRITE.
 * Charter: correctness-reviewer rows only — the other telemetry emitters (commit-guard, the
 * deterministic gates) are not reviewer suites. Evidence tiers: both diffs archived › fail diff
 * only › failReason-only (kept, flagged `failReasonOnly` — adaptation from prose alone needs
 * extra care and usually waits).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDrops, makeDropCounter, readJsonl, slugify, uniqueId } from './propose-common.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
// This script lives in propose/ — candidates + raw/ live one level up, beside the corpora.
const reviewersDir = path.join(here, '..');
const CANDIDATES_FILE = path.join(reviewersDir, 'raw', 'candidates-telemetry.jsonl');
const RAW_DIR = path.join(reviewersDir, 'raw');
const OUT_FILE = path.join(RAW_DIR, 'queue-telemetry.jsonl');

/** Returns a drop reason string, or null if the candidate survives. */
function hardDropReason(c) {
  if (c.reviewer !== 'correctness-reviewer') return `out-of-charter:${c.reviewer}`;
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

const makeQueueId = (candidate, seen) =>
  uniqueId(`corr-tel-${slugify(candidate.failReason)}`, seen);

function main() {
  const argv = process.argv.slice(2);
  const maxIdx = argv.indexOf('--max');
  const max = maxIdx !== -1 ? Number.parseInt(argv[maxIdx + 1], 10) : 10;
  if (!Number.isFinite(max) || max <= 0) {
    console.error('propose-telemetry: --max must be a positive integer');
    process.exit(2);
  }
  if (!existsSync(CANDIDATES_FILE)) {
    console.error(
      `propose-telemetry: missing ${path.basename(CANDIDATES_FILE)} — run mine-telemetry.mts first`,
    );
    process.exit(2);
  }

  const candidates = readJsonl(CANDIDATES_FILE);
  const { drops, bump } = makeDropCounter();

  const kept = [];
  for (const c of candidates) {
    const dropReason = hardDropReason(c);
    if (dropReason) {
      bump(dropReason);
      continue;
    }
    kept.push(c);
  }

  kept.sort(compareCandidates);
  const queued = kept.slice(0, max);
  if (kept.length > max) bump(`over-max:${kept.length - max}`);

  const seenIds = new Set();
  const rows = queued.map((candidate) => ({
    queueId: makeQueueId(candidate, seenIds),
    suite: 'correctness',
    failReasonOnly: evidenceTier(candidate) === 2,
    candidate,
  }));

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const tiers = { 0: 0, 1: 0, 2: 0 };
  for (const c of queued) tiers[evidenceTier(c)] += 1;
  console.error(
    [
      `propose-telemetry: ${candidates.length} candidates → ${kept.length} in charter → ${rows.length} queued`,
      `  evidence tiers queued: both-diffs:${tiers[0]}, fail-diff-only:${tiers[1]}, fail-reason-only:${tiers[2]}`,
      `  drops: ${formatDrops(drops)}`,
      `  → ${path.relative(reviewersDir, OUT_FILE)}`,
    ].join('\n'),
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
