/** sc-2499 primary lens-hole instrument: CodeRabbit root findings (raw dump + PR head branch under
 * --research) × gate telemetry, partitioned by holes.mts. Method + tables: docs/benchmarks/external/README.md. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCoderabbitMarker } from '../mine-bots-lib.mts';
import {
  assertCountsOnly,
  type ExternalFinding,
  partitionFinding,
  reduceLensHoles,
  renderLensHoles,
  type ReviewContext,
} from './holes.mts';
import { arg, argInt } from '../scale/bench-args.mts';

const REPO = arg('repo');
const ALIAS = arg('alias', REPO?.split('/').pop());
const RESEARCH = arg(
  'research',
  path.join(os.homedir(), '.devkit', 'research', '2026-09-02-lens-holes'),
)!;
const OUT = arg('out', RESEARCH)!;
const MIN_DENOMINATOR = argInt('min-denominator', 8);
/** commit_review_scope started recording files on 2026-07-27; earlier PRs have no scope truth. */
const SINCE = arg('since', '2026-07-27')!;
/** Optional rubric-triage output (triage-lens.mts): {id, lens} per line; attaches triageLens. */
const TRIAGE = arg('triage');
const DB = path.join(os.homedir(), '.claude-usage', 'usage.db');
if (!REPO || !ALIAS) {
  console.error(
    'usage: crosstab-coderabbit --repo <owner/name> [--alias <name>] [--research <dir>] [--out <dir>]',
  );
  process.exit(2);
}

interface CrComment {
  id: number;
  in_reply_to_id: number | null;
  pr: string;
  path: string | null;
  line: number | null;
  created_at: string;
  body: string;
}

const sql = <T,>(query: string): T[] => {
  const raw = execFileSync('sqlite3', ['-readonly', '-json', DB, query], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
  // SAFETY: sqlite3 -json emits a JSON array of row objects (or nothing for an empty result).
  return raw ? (JSON.parse(raw) as T[]) : [];
};

// ── findings: CodeRabbit root comments with a parsed marker ─────────────────────────────────────
const dump = path.join(RESEARCH, 'raw', `cr-${REPO.replace('/', '_')}.jsonl`);
if (!existsSync(dump)) throw new Error(`no CodeRabbit dump at ${dump}`);
const comments = readFileSync(dump, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    // SAFETY: the dump is written by gh --jq with the shape documented in the header.
    return JSON.parse(l) as CrComment;
  });
const htmlPr = (apiUrl: string): string =>
  apiUrl
    .replace('https://api.github.com/repos/', 'https://github.com/')
    .replace('/pulls/', '/pull/');
/** CodeRabbit's verification agent posts tool traces as ROOT comments; a root with traces and NO
 * bold title anywhere is not a finding and would inflate every miss bucket. */
const TRACE_LINE_RE = /^\s*(?:🏁 Script executed|🌐 Web query|💡 Result)/u;
const TITLE_LINE_RE = /^\s*\*\*[^*\n]+\*\*/u;
export function isVerificationTrace(body: string): boolean {
  // A finding carries a bold title OUTSIDE any code fence or <details> block (the analysis chain
  // and its quoted tool output live inside those); a trace-only root has traces and no such title.
  let fence = false;
  let details = 0;
  let hasTrace = false;
  let hasTitle = false;
  for (const l of body.split('\n')) {
    if (/^\s*```/.test(l)) fence = !fence;
    if (/<details\b/i.test(l)) details += 1;
    if (TRACE_LINE_RE.test(l)) hasTrace = true;
    if (!fence && details === 0 && TITLE_LINE_RE.test(l)) hasTitle = true;
    if (/<\/details>/i.test(l)) details = Math.max(0, details - 1);
  }
  return hasTrace && !hasTitle;
}
const findings: ExternalFinding[] = [];
let unparsed = 0;
let traces = 0;
for (const c of comments) {
  if (c.in_reply_to_id !== null) continue;
  if (c.created_at < SINCE) continue;
  // SAFETY: parseCoderabbitMarker (mine-bots-lib, untyped) returns exactly these two fields.
  const { crCategory, crSeverity } = parseCoderabbitMarker(c.body) as {
    crCategory: string | null;
    crSeverity: string | null;
  };
  if (!crCategory) {
    unparsed += 1;
    continue;
  }
  if (isVerificationTrace(c.body)) {
    traces += 1;
    continue;
  }
  findings.push({
    source: 'coderabbit',
    id: String(c.id),
    changeKey: htmlPr(c.pr),
    category: crCategory,
    severity: crSeverity,
    path: c.path,
    line: c.line,
  });
}
console.error(
  `${REPO}: ${comments.length} comments, ${findings.length} root findings since ${SINCE}, ${unparsed} unparsed markers, ${traces} verification traces dropped`,
);

// ── contexts: what the correctness reviewer held, saw in full, and said, per PR ─────────────────
interface PrMeta {
  html_url: string;
  head: string;
}
const metaFile = path.join(RESEARCH, 'raw', `pr-meta-${REPO.replace('/', '_')}.jsonl`);
const headByPr = new Map<string, string>();
if (existsSync(metaFile)) {
  for (const l of readFileSync(metaFile, 'utf8').split('\n'))
    if (l.trim()) {
      // SAFETY: written by gh --jq with the shape documented in the header.
      const m = JSON.parse(l) as PrMeta;
      headByPr.set(m.html_url, m.head);
    }
} else {
  console.error(`no PR metadata at ${metaFile} — joining on pr_url only (branch fallback off)`);
}
const q = (v: string): string => v.replace(/'/g, "''");
/** Ships for a PR: the attempt that opened it carries pr_url; every other attempt on the same
 * branch carries only the branch name. */
const shipPredicate = (pr: string): string => {
  const head = headByPr.get(pr);
  return head
    ? `(s.pr_url='${q(pr)}' or (s.branch='${q(head)}' and (s.pr_url is null or s.pr_url='')))`
    : `s.pr_url='${q(pr)}'`;
};

const prUrls = [...new Set(findings.map((f) => f.changeKey))];
const contexts = new Map<string, ReviewContext>();
for (const pr of prUrls) {
  const scope = sql<{ files_json: string | null; omitted: number; truncated: number }>(
    `select sc.files_json, coalesce(sc.omitted_files,0) omitted, coalesce(sc.truncated_files,0) truncated
       from commit_review_scope sc join commit_ships s using(ship_id)
      where ${shipPredicate(pr)} and sc.reviewer='correctness-reviewer' and sc.files_json is not null`,
  );
  if (scope.length === 0) continue;
  const scopeFiles = new Set<string>();
  const shownFiles = new Set<string>();
  for (const row of scope) {
    // SAFETY: files_json is written by evidence/scope.mts as JSON.stringify(string[]).
    const files = JSON.parse(row.files_json ?? '[]') as string[];
    for (const f of files) {
      scopeFiles.add(f);
      if (row.omitted === 0 && row.truncated === 0) shownFiles.add(f);
    }
  }
  const lensRows = sql<{ lens: string; issues_json: string | null }>(
    `select l.lens, l.issues_json from commit_review_lenses l join commit_ships s using(ship_id)
      where ${shipPredicate(pr)} and l.reviewer='correctness-reviewer' and l.status='fail'
        and coalesce(l.disposition,'') <> 'dropped_out_of_charter'
        and l.issues_json is not null and l.issues_json<>''`,
  );
  const issues = lensRows.flatMap((r) => {
    try {
      // SAFETY: issues_json is written by lens/split.mts as JSON.stringify(string[]).
      return (JSON.parse(r.issues_json ?? '[]') as string[]).map((text) => ({
        lens: r.lens,
        text,
      }));
    } catch {
      return [];
    }
  });
  contexts.set(pr, {
    changeKey: pr,
    scopeFiles: [...scopeFiles],
    shownFiles: [...shownFiles],
    issues,
  });
}
console.error(
  `${prUrls.length} PRs with findings, ${contexts.size} reached the correctness reviewer with scope telemetry`,
);

// ── partition + reduce ──────────────────────────────────────────────────────────────────────────
const triageById = new Map<string, string>();
let triageProvenance: { model: string; rubric: string } | null = null;
if (TRIAGE && existsSync(TRIAGE))
  for (const l of readFileSync(TRIAGE, 'utf8').split('\n'))
    if (l.trim()) {
      // SAFETY: triage-lens.mts writes {id, lens, model, rubric, at} rows.
      const t = JSON.parse(l) as { id: string; lens: string; model?: string; rubric?: string };
      const prov = { model: t.model ?? 'unknown', rubric: t.rubric ?? 'v1' };
      // One triage file = one judge + one rubric; a mixed file would stamp one provenance on rows
      // produced under another. Refuse rather than guess.
      if (
        triageProvenance &&
        (triageProvenance.model !== prov.model || triageProvenance.rubric !== prov.rubric)
      )
        throw new Error(
          `--triage ${TRIAGE} mixes ${triageProvenance.model}/${triageProvenance.rubric} with ${prov.model}/${prov.rubric} rows — one file per rubric round`,
        );
      triageById.set(t.id, t.lens);
      triageProvenance ??= prov;
    }
const rows = findings.map((f) =>
  partitionFinding({ ...f, triageLens: triageById.get(f.id) ?? null }, contexts.get(f.changeKey)),
);
mkdirSync(RESEARCH, { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(RESEARCH, `crosstab-${ALIAS}.findings.jsonl`),
  `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
  { mode: 0o600 },
);
const report = reduceLensHoles(rows, {
  source: `coderabbit:${ALIAS}`,
  minDenominator: MIN_DENOMINATOR,
});
assertCountsOnly(report);
mkdirSync(OUT, { recursive: true });
const outFile = path.join(OUT, `coderabbit-${ALIAS}-lens-holes.json`);
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      since: SINCE,
      repoAlias: ALIAS,
      // Provenance of the triage column so the committed table names the judge and rubric behind it.
      triage: triageProvenance ?? {
        model: null,
        rubric: null,
        note: 'no triage attached; unmatchedByTriage is all untriaged',
      },
      ...report,
    },
    null,
    2,
  )}\n`,
);
console.log(renderLensHoles(report));
console.error(`counts → ${outFile}; per-finding rows stay under ${RESEARCH}`);
