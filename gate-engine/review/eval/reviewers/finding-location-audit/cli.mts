#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/** Usage: cli.mts [--repo <name>]... [--until <iso>] [--max-gap-hours <n>] [--out <dir>]. Read-only
 * over USAGE_DB and the FAIL-diff archive; prints counts-only JSON (see lib.mts for the question). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  buildLensPairs,
  classifyPair,
  DEFAULT_MAX_GAP_MS,
  DEFAULT_REVIEWER,
  summarizeAudit,
} from './lib.mts';
import { collectRepoArgs, sqlite3Available } from '../mine-common.mts';
import { diffArchiveRelPath } from '../mine-telemetry-lib.mts';

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) fail(`${flag} needs a value`);
  return value;
}

function fail(message) {
  console.error(`finding-location-audit: ${message}`);
  process.exit(1);
}

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/** Epoch ms of an ISO-8601 instant, or null — including for calendar values Date would roll over. */
function parseInstant(text) {
  const m = ISO_INSTANT.exec(text);
  if (!m) return null;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return null;
  const offsetMin =
    m[7] === 'Z' ? 0 : (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  const local = new Date(ms + offsetMin * 60_000);
  const fields = [
    local.getUTCFullYear(),
    local.getUTCMonth() + 1,
    local.getUTCDate(),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
  ];
  const given = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  return fields.every((f, i) => f === given[i]) ? ms : null;
}
const SECTION = '@@section:';
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Runs every query inside one BEGIN…COMMIT in a single sqlite3 process; sections are split on
 * marker lines, which cannot occur inside JSON output (string newlines are escaped). */
function readSnapshot(dbPath, queries) {
  const names = Object.keys(queries);
  const script = [
    '.mode json',
    'BEGIN;',
    ...names.flatMap((n) => [`.print ${SECTION}${n}`, queries[n]]),
    'COMMIT;',
  ].join('\n');
  const out = execFileSync('sqlite3', ['-readonly', dbPath], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const snapshot = Object.fromEntries(names.map((n) => [n, []]));
  let current = null;
  let buf = [];
  const flush = () => {
    if (current && buf.join('').trim()) snapshot[current] = JSON.parse(buf.join('\n'));
  };
  for (const line of out.split('\n')) {
    if (line.startsWith(SECTION)) {
      flush();
      current = line.slice(SECTION.length);
      buf = [];
    } else buf.push(line);
  }
  flush();
  return snapshot;
}

function main() {
  const argv = process.argv.slice(2);
  const repos = collectRepoArgs(argv);
  if (repos.length === 0) repos.push('devkit');
  const gapHours = argValue(argv, '--max-gap-hours');
  const maxGapMs = gapHours === undefined ? DEFAULT_MAX_GAP_MS : Number(gapHours) * 3_600_000;
  if (!(Number.isFinite(maxGapMs) && maxGapMs > 0))
    fail(`--max-gap-hours must be a finite positive number (got ${gapHours})`);
  const outDir = argValue(argv, '--out');
  const untilArg = argValue(argv, '--until');
  const untilMs = untilArg === undefined ? Date.now() : parseInstant(untilArg);
  if (untilMs === null)
    fail(`--until must be a real ISO-8601 instant like 2026-10-01T09:00:00Z (got ${untilArg})`);
  const until = new Date(untilMs).toISOString();

  const dbPath = process.env.USAGE_DB || path.join(os.homedir(), '.claude-usage', 'usage.db');
  if (!existsSync(dbPath))
    fail(`no usage.db at ${dbPath} — set USAGE_DB to the collector database`);
  if (!sqlite3Available()) fail('sqlite3 CLI not found on PATH — install sqlite3 and re-run');
  const telemetryDir = path.dirname(
    process.env.DEVKIT_GATE_EVENTS ||
      path.join(os.homedir(), '.devkit', 'telemetry', 'gate-events.jsonl'),
  );

  const repoList = repos.map(q).join(',');
  const shipFilter = `ship_id IN (SELECT ship_id FROM commit_ships WHERE repo IN (${repoList}))`;
  const reviewerFilter = `reviewer = ${q(DEFAULT_REVIEWER)} AND ${shipFilter}`;
  // One read transaction, so all three tables come from one snapshot while the collector writes.
  const snapshot = readSnapshot(dbPath, {
    ships: `SELECT ship_id, repo, branch, ts_start, exit_code FROM commit_ships WHERE repo IN (${repoList});`,
    lensRows: `SELECT ship_id, reviewer, lens, status, disposition, judge_status, judge_model, issues_json FROM commit_review_lenses WHERE ${reviewerFilter};`,
    scopeRows: `SELECT ship_id, reviewer, diff_sha256, cached, chunk_count, omitted_files, truncated_files FROM commit_review_scope WHERE ${reviewerFilter};`,
  });
  // ts_start mixes with/without-millis forms, so the window is applied on parsed instants.
  const ships = snapshot.ships.filter((s) => Date.parse(s.ts_start) <= untilMs);
  const { lensRows, scopeRows } = snapshot;

  const { pairs, excluded, skippedShips } = buildLensPairs({
    ships,
    lensRows,
    scopeRows,
    maxGapMs,
  });
  const cache = new Map();
  const readDiff = (sha) => {
    if (cache.has(sha)) return cache.get(sha);
    const abs = path.join(telemetryDir, diffArchiveRelPath(sha));
    let result = null;
    if (existsSync(abs)) {
      try {
        const text = gunzipSync(readFileSync(abs)).toString('utf8');
        // The archive is content-addressed: bytes that do not hash to their name are not evidence.
        const actual = createHash('sha256').update(text).digest('hex');
        result = actual === sha ? { text } : { error: 'archive bytes do not match diff_sha256' };
      } catch (e) {
        // A partially written or corrupt archive entry is evidence we cannot read, not a crash.
        result = { error: String(e?.message ?? e).split('\n')[0] };
      }
    }
    cache.set(sha, result);
    return result;
  };
  const summary = summarizeAudit(
    pairs.map((p) => classifyPair(p, readDiff)),
    { excluded, skippedShips },
  );
  const report = {
    reviewer: DEFAULT_REVIEWER,
    until,
    maxGapHours: maxGapMs / 3_600_000,
    ...summary,
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'summary.json'), json);
  }
  process.stdout.write(json);
}

main();
