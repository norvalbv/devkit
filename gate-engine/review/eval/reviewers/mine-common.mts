// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * mine-common — the plumbing both miners (mine-bots.mts, mine-telemetry.mts) share: url-keyed
 * candidates-file reading, `--repo` argv collection, and read-only sqlite3 access. Extracted so
 * the two stay byte-identical by construction instead of by copy (commit-guard caught the copies).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** Parse an existing url-keyed candidates .jsonl into a Map<url, row>; malformed lines are
 * skipped rather than aborting the whole merge. */
export function readCandidatesFile(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.url) map.set(row.url, row);
    } catch {
      // skip malformed line rather than aborting the whole merge
    }
  }
  return map;
}

/** Collect every `--repo <value>` pair from argv (repeatable flag, both miners). */
export function collectRepoArgs(argv) {
  const repoArgs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo' && argv[i + 1]) {
      i += 1;
      repoArgs.push(argv[i]);
    }
  }
  return repoArgs;
}

/** True when the sqlite3 CLI is invocable (both miners fail open without it). */
export function sqlite3Available() {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Read-only -json SELECT via the sqlite3 CLI. maxBuffer sized for the largest expected result
 * set (mine-telemetry sweeps whole tables; mine-bots only ever joins per-PR). */
export function sqliteJson(dbPath, sql, maxBuffer = 256 * 1024 * 1024) {
  const raw = execFileSync('sqlite3', [dbPath, '-json', sql], {
    encoding: 'utf8',
    maxBuffer,
  }).trim();
  return raw ? JSON.parse(raw) : [];
}
