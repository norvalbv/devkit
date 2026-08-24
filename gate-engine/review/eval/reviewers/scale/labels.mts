/**
 * Telemetry-mined labels for a scale-track diff: every correctness issue recorded on a LATER
 * attempt of the same branch whose file was already present in the diff under test. Tier A
 * ("known-in-D") additionally requires the file's normalized diff identity at finding time to be
 * byte-identical to its identity in D — the judged code was exactly what D staged, so a reviewer
 * of D had everything needed to find it. Tier B is file-presence only (weaker; reported separately).
 *
 * Read-only over the collector DB and the diff archive. Never writes anywhere.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { identityByPath } from '../../../lens/chunk.mts';

export interface ScaleLabel {
  lens: string;
  file: string;
  line: number | null;
  text: string;
  foundAt: string;
  tier: 'A' | 'B';
}

const FILE_LINE_RE = /([\w@./-]+\.[A-Za-z]{1,5})(?::(\d+))?/g;

export interface IssueLocation {
  file: string;
  line: number | null;
}

/** EVERY file[:line] mention in an issue text (not just the first — first-match mislocated labels
 * whose text opens with prose or names a second file before the defect site). */
export function extractLocations(text: string): IssueLocation[] {
  const out: IssueLocation[] = [];
  for (const m of String(text).matchAll(FILE_LINE_RE))
    out.push({ file: m[1], line: m[2] ? Number(m[2]) : null });
  return out;
}

/** Resolve a mentioned location to a path in a CLOSED staged-file set: exact match, else a
 * whole-segment suffix match that is UNIQUE within the set. Ambiguity (two packages sharing a
 * trailing subpath, several same-named files) resolves to nothing — cross-attribution between
 * distinct files was measured to corrupt scoring in both directions, so no pairwise suffix
 * heuristic survives here. */
export function resolveToStaged(file: string, stagedPaths: readonly string[]): string | undefined {
  const exact = stagedPaths.find((p) => p === file);
  if (exact) return exact;
  const hits = stagedPaths.filter((p) => p.endsWith(`/${file}`) || file.endsWith(`/${p}`));
  return hits.length === 1 ? hits[0] : undefined;
}

/** The registered line rule: within ±10; a missing line on either side matches at file level
 * (pre-registered; disclosed in the experiment README). File identity is EXACT staged paths —
 * both sides go through resolveToStaged first. */
export function linesMatch(a: number | null, b: number | null): boolean {
  return a === null || b === null || Math.abs(a - b) <= 10;
}

export function archivedDiffPath(sha256: string): string {
  return path.join(os.homedir(), '.devkit', 'telemetry', 'diffs', `${sha256}.diff.gz`);
}

export function readArchivedDiff(sha256: string): string | null {
  const p = archivedDiffPath(sha256);
  if (!existsSync(p)) return null;
  try {
    return gunzipSync(readFileSync(p)).toString('utf8');
  } catch {
    return null;
  }
}

interface LensRow {
  ts: string;
  lens: string;
  issues_json: string | null;
  diff_sha256: string | null;
}

const q = (v: string): string => v.replace(/'/g, "''");
const sha12 = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12);

/** sqlite3 CLI read-only query returning JSON rows — avoids a native driver dependency.
 * Excludes attempts of the diff under test itself (a label minted by the SAME attempt the arms
 * re-review is test-retest contamination, not a later-found defect) and pins the repo so a
 * branch-name collision in another repo cannot leak labels in. */
export function queryLensFails(
  dbPath: string,
  repo: string,
  branch: string,
  sinceTs: string,
  ownDiffSha: string,
): LensRow[] {
  const sql = `select l.ts as ts, l.lens as lens, l.issues_json as issues_json, sc.diff_sha256 as diff_sha256
    from commit_review_lenses l
    join commit_ships s on s.ship_id = l.ship_id
    left join commit_review_scope sc on sc.ship_id = l.ship_id and sc.reviewer = l.reviewer
    where s.repo = '${q(repo)}' and s.branch = '${q(branch)}' and l.reviewer='correctness-reviewer'
      and l.status='fail' and l.ts >= '${q(sinceTs)}'
      and (sc.diff_sha256 is null or sc.diff_sha256 != '${q(ownDiffSha)}')
    order by l.ts`;
  const out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  // SAFETY: sqlite3 -json prints a JSON array of row objects matching the selected LensRow columns.
  return out.trim() ? (JSON.parse(out) as LensRow[]) : [];
}

/** The telemetry repo name that shipped this diff (needed to scope label mining to one repo). */
export function repoForDiff(dbPath: string, diffSha256: string): string | null {
  const sql = `select s.repo as repo from commit_ships s
    join commit_review_scope sc on sc.ship_id = s.ship_id
    where sc.diff_sha256 = '${q(diffSha256)}' and s.repo is not null and s.repo != ''
    order by s.ts_start limit 1`;
  const out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!out.trim()) return null;
  // SAFETY: sqlite3 -json prints a JSON array of {repo} rows for the select above.
  const rows = JSON.parse(out) as Array<{ repo: string }>;
  return rows[0]?.repo ?? null;
}

/** Labels for the diff under test D: later-found issues located in files D staged. Rows from
 * D's own attempts are excluded upstream (test-retest contamination), and mining is pinned to
 * the repo that shipped D (branch names collide across repos on one machine). */
export function mineLabels(opts: {
  dbPath: string;
  branch: string;
  diffSha256: string;
  diffText: string;
  sinceTs: string;
  repo?: string;
}): ScaleLabel[] {
  const repo = opts.repo ?? repoForDiff(opts.dbPath, opts.diffSha256);
  if (repo === null) return [];
  const dIdentity = identityByPath(opts.diffText);
  const labels: ScaleLabel[] = [];
  const seen = new Set<string>();
  for (const row of queryLensFails(opts.dbPath, repo, opts.branch, opts.sinceTs, opts.diffSha256)) {
    let issues: string[] = [];
    try {
      // SAFETY: issues_json is written by the collector as a JSON string array; the catch below covers corruption.
      issues = row.issues_json ? (JSON.parse(row.issues_json) as string[]) : [];
    } catch {
      issues = [];
    }
    for (const issue of issues) {
      // All mentioned locations; prefer the first that carries a line number AND names a staged
      // file (first-match alone mislocated labels whose text opens with prose or a sibling file).
      const locs = extractLocations(String(issue));
      const staged = (l: IssueLocation): string | undefined =>
        resolveToStaged(l.file, [...dIdentity.keys()]);
      const withFile = locs
        .map((l) => ({ loc: l, file: staged(l) }))
        .filter((x): x is { loc: IssueLocation; file: string } => x.file !== undefined);
      const best = withFile.find((x) => x.loc.line !== null) ?? withFile[0];
      if (!best) continue;
      const file = best.file;
      const key = `${row.lens}|${file}|${best.loc.line ?? ''}|${sha12(String(issue))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let tier: 'A' | 'B' = 'B';
      if (row.diff_sha256) {
        const laterDiff =
          row.diff_sha256 === opts.diffSha256 ? opts.diffText : readArchivedDiff(row.diff_sha256);
        if (laterDiff) {
          const laterIdentity = identityByPath(laterDiff).get(file);
          if (laterIdentity !== undefined && laterIdentity === dIdentity.get(file)) tier = 'A';
        }
      }
      labels.push({
        lens: row.lens,
        file,
        line: best.loc.line,
        text: String(issue).slice(0, 300),
        foundAt: row.ts,
        tier,
      });
    }
  }
  return labels;
}

/** Compression helper for locally persisting probe inputs beside the checkpoint (never committed). */
export function gzipText(text: string): Buffer {
  return gzipSync(Buffer.from(text, 'utf8'));
}
