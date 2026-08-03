#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * propose-ghsa — deterministic triage of raw/candidates-ghsa.jsonl (mine-ghsa's output) into an
 * adaptation queue for the security suites. Known-answer path (sc-1408): every queued entry
 * carries the FIX COMMIT's per-file patches fetched from the advisory's repo, so the adapt
 * session sees the confirmed-vulnerable shape (patch pre-image) and the confirmed fix — gold =
 * vulnerable state (expected FAIL, absolute-recall row), minimal-pair decoy = fix applied.
 *
 *   bun propose/propose-ghsa.mts [--max N]   (default 10)
 *
 * Pipeline: HARD DROPS (counted) → SORT (severity, then recency) → ENRICH (gh api commit —
 * files + patches; a fetch failure drops the entry and the next-ranked is tried) → WRITE
 * raw/queue-ghsa.jsonl. Suite routing happens at adaptation (api-security vs frontend-security
 * is a fixture-placement judgment, not a path heuristic — advisories have no repo-relative
 * frontend/backend split).
 */

import { execFileSync } from 'node:child_process';
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
const reviewersDir = path.join(here, '..');
const CANDIDATES_FILE = path.join(reviewersDir, 'raw', 'candidates-ghsa.jsonl');
const OUT_FILE = path.join(reviewersDir, 'raw', 'queue-ghsa.jsonl');
const COMMIT_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/;
const PATCH_CAP = 8000;
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Returns a drop reason string, or null if the candidate survives. */
function hardDropReason(c) {
  if (c.kind !== 'ghsa') return `unknown-kind:${c.kind}`;
  if (!Array.isArray(c.fixCommits) || c.fixCommits.length === 0) return 'no-fix-commit';
  if (!COMMIT_URL_RE.test(c.fixCommits[0])) return 'unparseable-commit-url';
  return null;
}

function compareCandidates(a, b) {
  const bySev = (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4);
  if (bySev !== 0) return bySev;
  return Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0);
}

/** Fix-commit files + patches — the known-answer evidence the adapt session works from. */
function fetchFixCommit(commitUrl) {
  const [, owner, repo, sha] = COMMIT_URL_RE.exec(commitUrl);
  const raw = JSON.parse(gh(['api', `repos/${owner}/${repo}/commits/${sha}`]));
  return {
    repo: `${owner}/${repo}`,
    sha,
    files: (raw.files ?? []).map((f) => ({
      filename: f.filename,
      status: f.status,
      patch: String(f.patch ?? '').slice(0, PATCH_CAP),
    })),
  };
}

function main() {
  const max = parseMaxArg(process.argv.slice(2), 'propose-ghsa');
  requireFile(CANDIDATES_FILE, 'propose-ghsa', 'run mine-ghsa.mts first');

  const candidates = readJsonl(CANDIDATES_FILE);
  const { drops, bump } = makeDropCounter();
  const kept = partitionDrops(candidates, makeHardDrop(reviewersDir, hardDropReason), bump);
  kept.sort(compareCandidates);

  const seenIds = new Set();
  const rows = [];
  let enrichFailures = 0;
  for (const c of kept) {
    if (rows.length >= max) break;
    let fixCommit = null;
    try {
      fixCommit = fetchFixCommit(c.fixCommits[0]);
    } catch (e) {
      enrichFailures += 1;
      console.error(
        `propose-ghsa: enrich failed for ${c.ghsaId} — ${e.message?.split('\n')[0] ?? e}`,
      );
      continue;
    }
    rows.push({
      queueId: uniqueId(`sec-ghsa-${slugify(c.summary)}`, seenIds),
      knownAnswer: true,
      candidate: c,
      fixCommit,
    });
  }
  if (enrichFailures) bump('enrich-failed', enrichFailures);

  writeQueue(OUT_FILE, rows);
  printSummary(
    [
      `propose-ghsa: ${candidates.length} candidates → ${kept.length} anchored → ${rows.length} queued (${enrichFailures} enrich failures)`,
    ],
    drops,
    reviewersDir,
    OUT_FILE,
  );
}

runIfMain(import.meta.url, main);
