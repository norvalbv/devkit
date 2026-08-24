/**
 * $0 sweep: which archived ship diffs make good scale-track rows? For every diff with a
 * correctness review_scope row and archived bytes, count telemetry labels (tier A/B) and report
 * size. Read-only; prints a ranked table. Local paths/branches print here (terminal only, never
 * committed) — the committed record keeps hashes and counts per scale-track-third-party-data.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mineLabels, readArchivedDiff } from './labels.mts';

const DB = path.join(os.homedir(), '.claude-usage', 'usage.db');
// SAFETY: sqlite3 -json prints a JSON array of row objects keyed by the selected column aliases.
const rows = JSON.parse(
  execFileSync(
    'sqlite3',
    [
      '-readonly',
      '-json',
      DB,
      `select s.repo as repo, s.branch as branch, s.ts_start as ts, sc.diff_sha256 as sha, sc.diff_bytes as bytes, sc.file_count as files
       from commit_ships s join commit_review_scope sc on sc.ship_id=s.ship_id and sc.reviewer='correctness-reviewer'
       where s.branch is not null and s.branch!='' and sc.diff_sha256 is not null and sc.diff_bytes > 20000
       order by s.ts_start`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ) || '[]',
) as Array<{ repo: string; branch: string; ts: string; sha: string; bytes: number; files: number }>;

const out: Array<{
  sha: string;
  repo: string;
  branch: string;
  ts: string;
  loc: number;
  files: number;
  tierA: number;
  tierB: number;
}> = [];
const seen = new Set<string>();
for (const r of rows) {
  if (seen.has(r.sha)) continue;
  seen.add(r.sha);
  const diffText = readArchivedDiff(r.sha);
  if (!diffText) continue;
  const labels = mineLabels({
    dbPath: DB,
    branch: r.branch,
    diffSha256: r.sha,
    diffText,
    sinceTs: r.ts,
  });
  out.push({
    sha: r.sha,
    repo: r.repo,
    branch: r.branch,
    ts: r.ts,
    loc: Math.round(r.bytes / 40),
    files: r.files,
    tierA: labels.filter((l) => l.tier === 'A').length,
    tierB: labels.filter((l) => l.tier === 'B').length,
  });
}
out.sort((a, b) => b.tierA * 10 + b.tierB - (a.tierA * 10 + a.tierB) || b.loc - a.loc);
for (const c of out.slice(0, 25))
  console.log(
    `${c.sha.slice(0, 12)}  A=${c.tierA} B=${c.tierB}  ${String(c.loc).padStart(5)} LOC ${String(c.files).padStart(3)}f  ${c.ts.slice(0, 16)}  ${c.repo} ${c.branch}`,
  );
console.log(
  `candidates with any label: ${out.filter((c) => c.tierA + c.tierB > 0).length} / ${out.length} archived+scoped diffs`,
);
