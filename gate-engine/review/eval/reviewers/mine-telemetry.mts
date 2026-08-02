#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * mine-telemetry — turns real gate telemetry (`~/.claude-usage/usage.db`, the diff-bytes archive
 * at `<telemetry-dir>/diffs/<diff_sha256>.diff.gz`) into corpus-growth candidates, without any PR
 * or bot involved. This is capture point 1 (fail→fix correlation) + the historical override-valve
 * slice of capture point 2 (waived decoys), per docs/benchmarks/corpus-growth.md.
 *
 *   bun mine-telemetry.mts [--repo <basename>]...   (default: devkit; or TELEMETRY_REPO_ALLOWLIST=a,b)
 *
 * Emits two candidate kinds, one row per (ship, reviewer[, lens]):
 *   - fail-fix     — a reviewer FAILed ship S1 on a given lens; the next attempt on the same
 *                    (repo, branch) where THAT SAME lens specifically passes (or, absent
 *                    lens-level data, the reviewer overall passes / the ship ships clean with the
 *                    reviewer silent) is the fix. Correlation is chronological within
 *                    (repo, branch) and per-lens, not just per-reviewer — a reviewer failing on
 *                    two distinct lenses in one ship gets two independently-scanned verdicts, not
 *                    one reviewer-level verdict stamped onto both. See findNextLensOutcome (and
 *                    findNextOutcome for the reviewer-level fallback used when a FAIL has no
 *                    lens-level breakdown at all) in mine-telemetry-lib.mts for the exact scan
 *                    rules. `hasDiffEvidence` flags rows where neither the FAIL nor the fix ship
 *                    has a commit_review_scope row at all (common for FAILs predating
 *                    2026-07-27, when lens/scope capture began) — for those, reconstruction is
 *                    failReason-only, not diffSha256-plus-failReason as it is for the rest.
 *   - waived-decoy — a `commit_review_lenses` row with disposition='waived' (the correctness
 *                    override valve, overrides.mts). Rationale text is NOT in telemetry today
 *                    (only `.devkit/correctness-overrides.json` on whichever checkout wrote it
 *                    has it) — the field is always emitted as `null`, never fabricated.
 *
 * Repo scoping: `commit_ships.repo` spans every project ever shipped from on this machine, most
 * of them unrelated private checkouts. Defaults to a `devkit`-only allowlist (see
 * DEFAULT_REPO_ALLOWLIST below) so a bare `bun mine-telemetry.mts` never writes another project's
 * diff text or finding prose into this repo's working tree; widen it explicitly via --repo/env
 * when mining a different checkout on purpose.
 *
 * Read-only against the db (execFileSync sqlite3 -json, USAGE_DB env override) and the archive
 * (existsSync + gunzipSync only) — this script writes nothing back to either.
 *
 * Output: raw/candidates-telemetry.jsonl (gitignored), atomic write (tmp+rename), merged by the
 * synthetic key `telemetry://<shipId>/<reviewer>[/<lens>]` (new wins), same contract as
 * mine-bots.mts's `url`-keyed merge onto candidates.jsonl.
 *
 * Plan of record (scouted 2026-08-01, docs/benchmarks/corpus-growth.md): telemetry candidates do
 * NOT flow through propose.mts. propose.mts's hard-drop `!originalCommitId` is unconditional and
 * every telemetry candidate has none (a blocked ship never committed) — they would die before
 * routing even ran, and its GitHub-contents-API enrichment step has no ref to fetch against
 * anyway. Consumption is a SEPARATE later step: an adapt-stage agent reads
 * raw/candidates-telemetry.jsonl directly (dedupe, drop `bytesAvailable:false` rows past some
 * threshold, sort by recency/reviewer), never propose.mts. Do not wire this file into propose.mts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  collectRepoArgs,
  readCandidatesFile,
  sqlite3Available,
  sqliteJson,
} from './mine-common.mts';
import {
  buildFailFixCandidate,
  buildHistogram,
  buildWaivedCandidate,
  diffArchiveRelPath,
  findNextLensOutcome,
  findNextOutcome,
  groupShipsByRepoBranch,
  hasDiffEvidence,
  histogramKey,
  isSameDiff,
  mergeCandidates,
  pickFailReason,
  resolveDiffPayload,
  selectFailLensRows,
} from './mine-telemetry-lib.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(here, 'raw');
const OUT = path.join(RAW_DIR, 'candidates-telemetry.jsonl');

// `commit_ships.repo` is the basename of whatever checkout shipped from — on a shared dev
// machine that spans every project the developer has ever shipped from, most of them private
// and unrelated to this one. Mirrors mine-bots.mts's `--repo owner/name` allowlist convention
// (default benord-labs/frink + norvalbv/devkit) so this miner never sweeps every repo in the
// collector db by default. Override with repeated `--repo <basename>` args or a comma-separated
// TELEMETRY_REPO_ALLOWLIST env var.
const DEFAULT_REPO_ALLOWLIST = ['devkit'];

function resolveRepoAllowlist() {
  const repoArgs = collectRepoArgs(process.argv.slice(2));
  if (repoArgs.length > 0) return repoArgs;
  const fromEnv = (process.env.TELEMETRY_REPO_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_REPO_ALLOWLIST;
}

// ---------------------------------------------------------------------------------------------
// sqlite3 access (read-only SELECTs only — mirrors mine-bots.mts's resolveScopeDb/sqliteJson).
// ---------------------------------------------------------------------------------------------

function resolveDb() {
  const dbPath = process.env.USAGE_DB || path.join(os.homedir(), '.claude-usage', 'usage.db');
  if (!existsSync(dbPath)) {
    console.error(`mine-telemetry: no usage.db at ${dbPath} — nothing to mine, exiting`);
    return null;
  }
  if (!sqlite3Available()) {
    console.error('mine-telemetry: sqlite3 CLI not found on PATH — nothing to mine, exiting');
    return null;
  }
  return dbPath;
}

// ---------------------------------------------------------------------------------------------
// Telemetry-dir resolution — mirrors judge/run-context.mts's telemetrySink() (dirname of the
// gate-events sink), replicated here rather than imported so this bench-only tool stays
// self-contained (same call as mine-bots.mts makes for the usage.db path).
// ---------------------------------------------------------------------------------------------

function resolveTelemetryDir() {
  const sink =
    process.env.DEVKIT_GATE_EVENTS ||
    path.join(os.homedir(), '.devkit', 'telemetry', 'gate-events.jsonl');
  return path.dirname(sink);
}

/** Reads + gunzips an archived diff if present. Never throws — a corrupt/missing archive entry
 * degrades to `null`, matching diff-archive.mts's own fail-open contract. */
function readArchivedDiff(telemetryDir, diffSha256) {
  const rel = diffArchiveRelPath(diffSha256);
  if (!rel) return { bytesAvailable: false, diffText: null, relPath: null };
  const abs = path.join(telemetryDir, rel);
  if (!existsSync(abs)) return { bytesAvailable: false, diffText: null, relPath: rel };
  try {
    return {
      bytesAvailable: true,
      diffText: gunzipSync(readFileSync(abs)).toString('utf8'),
      relPath: rel,
    };
  } catch (e) {
    console.error(`mine-telemetry: archive read failed for ${rel} (${e.message?.split('\n')[0]})`);
    return { bytesAvailable: false, diffText: null, relPath: rel };
  }
}

// ---------------------------------------------------------------------------------------------
// Merge / atomic write (mirrors mine-bots.mts's readExistingCandidates + tmp+rename write).
// ---------------------------------------------------------------------------------------------

function writeAtomic(rows) {
  mkdirSync(RAW_DIR, { recursive: true });
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  renameSync(tmp, OUT);
}

// ---------------------------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------------------------

function main() {
  const dbPath = resolveDb();
  if (!dbPath) {
    process.exit(0);
  }

  let ships = [];
  let reviews = [];
  let scopeRows = [];
  let lensRows = [];
  try {
    ships = sqliteJson(
      dbPath,
      'SELECT ship_id, repo, branch, ts_start, exit_code FROM commit_ships;',
    );
    reviews = sqliteJson(dbPath, 'SELECT ship_id, reviewer, status, reason FROM commit_reviews;');
    scopeRows = sqliteJson(
      dbPath,
      'SELECT ship_id, reviewer, diff_sha256 FROM commit_review_scope;',
    );
    lensRows = sqliteJson(
      dbPath,
      'SELECT ship_id, reviewer, lens, status, disposition, issues_json FROM commit_review_lenses;',
    );
  } catch (e) {
    console.error(`mine-telemetry: query failed (${e.message?.split('\n')[0]}) — exiting`);
    process.exit(0);
  }

  const repoAllowlist = new Set(resolveRepoAllowlist());
  const shipsBeforeAllowlist = ships.length;
  ships = ships.filter((s) => repoAllowlist.has(s.repo));
  const allowedShipIds = new Set(ships.map((s) => s.ship_id));
  reviews = reviews.filter((r) => allowedShipIds.has(r.ship_id));
  scopeRows = scopeRows.filter((s) => allowedShipIds.has(s.ship_id));
  lensRows = lensRows.filter((l) => allowedShipIds.has(l.ship_id));
  const excludedByRepo = shipsBeforeAllowlist - ships.length;

  const telemetryDir = resolveTelemetryDir();
  if (!existsSync(telemetryDir)) {
    console.error(
      `mine-telemetry: no telemetry dir at ${telemetryDir} — bytesAvailable will be false everywhere`,
    );
  }

  const shipsById = new Map(ships.map((s) => [s.ship_id, s]));
  const { groups, indexByShipId, skippedNullBranch } = groupShipsByRepoBranch(ships);

  const reviewStatus = new Map(); // `${shipId}::${reviewer}` -> status
  for (const r of reviews) {
    reviewStatus.set(`${r.ship_id}::${r.reviewer}`, r.status);
  }
  const statusOf = (shipId, reviewer) => reviewStatus.get(`${shipId}::${reviewer}`);

  const scopeByShipReviewer = new Map(); // same key -> diff_sha256
  for (const s of scopeRows)
    scopeByShipReviewer.set(`${s.ship_id}::${s.reviewer}`, s.diff_sha256 ?? null);

  const lensesByShipReviewer = new Map(); // key -> LensRow[]
  const lensStatus = new Map(); // `${shipId}::${reviewer}::${lens}` -> status
  const waivedLenses = [];
  for (const l of lensRows) {
    const key = `${l.ship_id}::${l.reviewer}`;
    if (!lensesByShipReviewer.has(key)) lensesByShipReviewer.set(key, []);
    lensesByShipReviewer.get(key).push(l);
    lensStatus.set(`${l.ship_id}::${l.reviewer}::${l.lens}`, l.status);
    if (l.disposition === 'waived') waivedLenses.push(l);
  }
  const lensStatusOf = (shipId, reviewer, lens) =>
    lensStatus.get(`${shipId}::${reviewer}::${lens}`);

  const newRows = [];
  const dropReasons = {};
  const bumpDrop = (reason) => {
    dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
  };

  // ---- fail-fix -------------------------------------------------------------------------------
  const failedReviews = reviews.filter((r) => r.status === 'fail');
  for (const fr of failedReviews) {
    const ship = shipsById.get(fr.ship_id);
    if (!ship) {
      bumpDrop('fail-fix:ship-missing');
      continue;
    }
    const loc = indexByShipId.get(fr.ship_id);
    if (!loc) {
      // null/blank branch — uncorrelatable, already counted in skippedNullBranch.
      continue;
    }
    const chain = groups.get(loc.key);
    // diffSha256 (the broken side) is per (ship, reviewer), not per lens — same for every lens
    // of this fail, so resolve it and its archive once, outside the per-lens loop below.
    const diffSha256 = scopeByShipReviewer.get(`${fr.ship_id}::${fr.reviewer}`) ?? null;
    const archived = readArchivedDiff(telemetryDir, diffSha256);

    // Blocking-only allowlist, and the "all failing lenses were waived/dropped" case skips this
    // fail outright instead of falling back to a reviewer-level candidate — see
    // selectFailLensRows in mine-telemetry-lib.mts for the full rule.
    const { rows, skipped } = selectFailLensRows(
      lensesByShipReviewer.get(`${fr.ship_id}::${fr.reviewer}`),
    );
    if (skipped) {
      bumpDrop(`fail-fix:${skipped}`);
      continue;
    }

    for (const lensRow of rows) {
      const lens = lensRow?.lens ?? null;
      // Per-lens correlation when this FAIL has lens-level data: each failing lens of a
      // multi-lens FAIL is independently scanned for ITS OWN pass, not stamped with one shared
      // reviewer-level verdict (see findNextLensOutcome's docstring in mine-telemetry-lib.mts).
      // Falls back to the reviewer-level scan only when there's no lens breakdown at all.
      const { kind, nextShipId } =
        lens !== null
          ? findNextLensOutcome(chain, fr.ship_id, fr.reviewer, lens, statusOf, lensStatusOf)
          : findNextOutcome(chain, fr.ship_id, fr.reviewer, statusOf);
      if (kind !== 'fixed') {
        bumpDrop(`fail-fix:${kind}`);
        continue;
      }
      const nextDiffSha256 = scopeByShipReviewer.get(`${nextShipId}::${fr.reviewer}`) ?? null;
      if (isSameDiff(diffSha256, nextDiffSha256)) {
        // Same bytes reconciled to pass with no code change — an override-valve waiver, not a
        // fix. That case is captured separately via commit_review_lenses.disposition='waived'.
        bumpDrop('fail-fix:same-diff-override-not-fix');
        continue;
      }
      const nextShip = shipsById.get(nextShipId);
      const nextArchived = readArchivedDiff(telemetryDir, nextDiffSha256);
      newRows.push(
        buildFailFixCandidate({
          shipId: fr.ship_id,
          repo: ship.repo,
          branch: ship.branch,
          reviewer: fr.reviewer,
          lens,
          tsFail: ship.ts_start,
          diffSha256,
          bytesAvailable: archived.bytesAvailable,
          diffPayload: resolveDiffPayload(archived.diffText, archived.relPath),
          failReason: pickFailReason(lensRow?.issues_json, fr.reason),
          nextShipId,
          nextDiffSha256,
          nextBytesAvailable: nextArchived.bytesAvailable,
          nextDiffPayload: resolveDiffPayload(nextArchived.diffText, nextArchived.relPath),
          tsFix: nextShip?.ts_start ?? null,
        }),
      );
    }
  }

  // ---- waived-decoy -----------------------------------------------------------------------------
  for (const l of waivedLenses) {
    const ship = shipsById.get(l.ship_id);
    if (!ship) {
      bumpDrop('waived-decoy:ship-missing');
      continue;
    }
    const diffSha256 = scopeByShipReviewer.get(`${l.ship_id}::${l.reviewer}`) ?? null;
    const archived = readArchivedDiff(telemetryDir, diffSha256);
    newRows.push(
      buildWaivedCandidate({
        shipId: l.ship_id,
        repo: ship.repo,
        branch: ship.branch ?? null,
        reviewer: l.reviewer,
        lens: l.lens,
        tsFail: ship.ts_start,
        diffSha256,
        bytesAvailable: archived.bytesAvailable,
        diffPayload: resolveDiffPayload(archived.diffText, archived.relPath),
        failReason: pickFailReason(l.issues_json, null),
        disposition: l.disposition,
        // Rationale is NOT captured in telemetry today (only in whichever checkout's
        // .devkit/correctness-overrides.json wrote it) — never fabricated here.
        rationale: null,
      }),
    );
  }

  // ---- merge + write ------------------------------------------------------------------------
  // Prune any existing rows outside the CURRENT repo allowlist before merging in new ones. Without
  // this, a prior run made with a wider (or no) allowlist leaves other-repo rows — including their
  // full diff text — sitting in this file forever, since mergeCandidates only ever adds/updates by
  // url and never removes. The allowlist must be enforced on every write, not just on what a given
  // run discovers fresh.
  const existing = readCandidatesFile(OUT);
  let prunedByRepo = 0;
  for (const [url, row] of existing) {
    if (!repoAllowlist.has(row?.repo)) {
      existing.delete(url);
      prunedByRepo += 1;
    }
  }
  const merged = mergeCandidates(existing, newRows);
  const rows = [...merged.values()];
  writeAtomic(rows);

  // ---- stderr summary -------------------------------------------------------------------------
  const hist = buildHistogram(rows, histogramKey);
  const hollowFailFix = rows.filter(
    (r) => r.kind === 'fail-fix' && hasDiffEvidence(r.diffSha256, r.nextDiffSha256) === false,
  ).length;
  console.error(
    [
      `mine-telemetry: ${rows.length} candidates → ${path.relative(here, OUT)} (${newRows.length} new/updated this run)`,
      `  repo allowlist: ${[...repoAllowlist].join(', ')} (excluded ${excludedByRepo} ships from other repos, pruned ${prunedByRepo} stale off-allowlist rows from the output file)`,
      `  skipped (null/blank branch): ${skippedNullBranch}`,
      `  fail-fix rows with NO diff evidence at all (diffSha256 and nextDiffSha256 both null — failReason-only): ${hollowFailFix}`,
      `  drops: ${
        Object.entries(dropReasons)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}:${v}`)
          .join(', ') || '—'
      }`,
      '  by kind × reviewer × bytesAvailable:',
      ...hist.map(([k, v]) => `    ${k}: ${v}`),
    ].join('\n'),
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
