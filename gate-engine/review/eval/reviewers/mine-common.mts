// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * mine-common — the plumbing the miners (mine-bots.mts, mine-telemetry.mts) and proposers share:
 * url-keyed candidates-file reading, `--repo` argv collection, promoted-corpus url collection,
 * and read-only sqlite3 access. Extracted so consumers stay byte-identical by construction
 * instead of by copy (commit-guard caught the copies).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CORPUS_CASES_FILE_RE = /^cases-.*\.jsonl$/;

/** Collect every source.url already promoted into a cases-*.jsonl corpus file in `dir` —
 * the dedup key that keeps miners and proposers from re-offering landed candidates.
 *
 * This set is treated as AUTHORITATIVE by makeHardDrop ('a landed source.url must never be
 * re-queued'), so it fails closed: a set that is silently short re-offers work already promoted,
 * and the re-offer looks identical to a genuine new candidate. Only ENOENT is a real empty —
 * a corpus that does not exist yet has promoted nothing. Every other failure (EACCES, EIO, a
 * corpus file that reads but does not parse) means we cannot know what has landed, so it throws
 * rather than hand back a partial answer the caller cannot tell apart from a complete one. */
export function collectCorpusUrls(dir) {
  const urls = new Set();
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return urls;
    throw new Error(`mine-common: cannot list corpus dir ${dir} (${e.code ?? e.message}) — \
refusing to dedup against an unknown corpus`);
  }
  for (const name of entries) {
    if (!CORPUS_CASES_FILE_RE.test(name)) continue;
    const file = path.join(dir, name);
    let content = '';
    try {
      content = readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue; // vanished between readdir and read
      throw new Error(`mine-common: cannot read promoted corpus ${name} (${e.code ?? e.message}) — \
refusing to dedup against an unknown corpus`);
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      let row = null;
      try {
        row = JSON.parse(lines[i]);
      } catch {
        // A corpus row that does not parse is a URL we cannot see, i.e. the same silent
        // under-count as an unreadable file — never the tolerated skip readCandidatesFile allows
        // for an unlanded merge input.
        throw new Error(`mine-common: malformed JSON in promoted corpus ${name} line ${i + 1} — \
refusing to dedup against an unknown corpus`);
      }
      const u = row?.source?.url;
      if (u) urls.add(u);
    }
  }
  return urls;
}

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

/** Collect every `--repo <value>` pair from argv (repeatable flag, both miners).
 *
 * A missing or flag-shaped value is a hard usage error, never a silently-accepted repo. Both
 * callers treat ANY non-empty result as an explicit scope that replaces their defaults
 * (mine-bots' DEFAULT_REPOS, mine-telemetry's allowlist), so swallowing the following flag —
 * `--repo --dev` storing `"--dev"` as the repository — would narrow the sweep to a repo that
 * cannot exist and mine nothing, while reporting a clean run. Failing loudly is the only safe
 * reading of an incomplete pair. */
export function collectRepoArgs(argv) {
  const repoArgs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--repo') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(
        `--repo needs a repository name, got ${value ? `"${value}"` : 'nothing'} — ` +
          'pass it as `--repo <name>` (repeatable).',
      );
    }
    i += 1;
    repoArgs.push(value);
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
 * set (mine-telemetry sweeps whole tables; mine-bots only ever joins per-PR).
 *
 * `-readonly` opens the collector db in SQLite's own read-only mode, so the boundary is enforced
 * by the engine rather than by convention: a caller that ever passes an INSERT/UPDATE/DDL gets
 * "attempt to write a readonly database" instead of mutating the user's telemetry. The miners are
 * strictly read-side (the collector owns every write path) and this keeps that true by
 * construction. */
export function sqliteJson(dbPath, sql, maxBuffer = 256 * 1024 * 1024) {
  const raw = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer,
  }).trim();
  return raw ? JSON.parse(raw) : [];
}
