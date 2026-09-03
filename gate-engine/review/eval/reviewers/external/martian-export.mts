/** Pure export of lens findings into Martian's benchmark_data shape plus per-PR review contexts.
 * A PR whose every task errored is OMITTED (an empty review scores as all-FN); zero issues export []. */
import type { DiffEvidenceCap } from '../../../diff-evidence.mts';
import { extractLocations, resolveToStaged } from '../scale/labels.mts';
import type { CheckpointRow } from '../scale/lens-run.mts';
import type { ReviewContext } from './holes.mts';

export interface GoldenComment {
  comment: string;
  severity: string;
  category: string;
}
export interface Golden {
  pr_title: string;
  url: string;
  comments: GoldenComment[];
}

export interface PrRunBase {
  pr: number;
  url: string;
  slug: string;
  diffSha: string;
  base: string;
  mergedAt: string | null;
  /** Files the correctness reviewer held in scope (its selection). */
  scopeFiles: readonly string[];
  /** Every staged path in the materialized worktree — the closed set issue locations resolve
   * against. */
  staged: readonly string[];
  evidence: DiffEvidenceCap;
}

export interface MartianReviewComment {
  path: string | null;
  line: number | null;
  body: string;
  created_at: string;
}
export interface MartianReview {
  tool: string;
  repo_name: string;
  pr_url: string;
  review_comments: MartianReviewComment[];
}
export interface MartianEntry {
  golden_comments: GoldenComment[];
  golden_source_file: string;
  reviews: MartianReview[];
}

export interface ExportedContext extends ReviewContext {
  evidence: DiffEvidenceCap;
  mergedAt: string | null;
  base: string;
  diffSha: string;
}

export interface ExportResult {
  benchmarkData: Record<string, MartianEntry>;
  contexts: Record<string, ExportedContext>;
  /** PRs with no terminal verdict at all — omitted from the fragment. */
  omitted: number[];
}

export function exportFragment(o: {
  goldens: readonly Golden[];
  runs: ReadonlyArray<PrRunBase & { rows: readonly CheckpointRow[] }>;
  tool: string;
  goldenSourceFile: string;
  model: string;
}): ExportResult {
  const benchmarkData: Record<string, MartianEntry> = {};
  const contexts: Record<string, ExportedContext> = {};
  const omitted: number[] = [];
  const goldenByUrl = new Map(o.goldens.map((g) => [g.url, g]));
  for (const r of o.runs) {
    const golden = goldenByUrl.get(r.url);
    if (!golden) throw new Error(`no golden entry for ${r.url}`);
    const terminal = r.rows.filter((x) => x.status === 'pass' || x.status === 'fail');
    // Fully shown means the evidence cap omitted and truncated nothing; per-file lists are not
    // recorded, so any omission makes every file uncertain (the reducer handles that bucket).
    const fullyShown = r.evidence.omitted_files === 0 && r.evidence.truncated_files === 0;
    contexts[r.url] = {
      changeKey: r.url,
      scopeFiles: [...r.scopeFiles],
      shownFiles: fullyShown ? [...r.scopeFiles] : [],
      issues: terminal.flatMap((row) => row.issues.map((i) => ({ lens: i.lens, text: i.text }))),
      evidence: r.evidence,
      mergedAt: r.mergedAt,
      base: r.base,
      diffSha: r.diffSha,
    };
    if (terminal.length === 0) {
      omitted.push(r.pr);
      continue;
    }
    const review_comments: MartianReviewComment[] = [];
    for (const row of terminal)
      for (const issue of row.issues) {
        const loc = extractLocations(issue.text)
          .map((l) => ({ path: resolveToStaged(l.file, r.staged), line: l.line }))
          .find((l) => l.path !== undefined);
        review_comments.push({
          path: loc?.path ?? null,
          line: loc?.line ?? null,
          body: `[${issue.lens}] ${issue.text}`,
          created_at: row.at,
        });
      }
    benchmarkData[r.url] = {
      golden_comments: golden.comments,
      golden_source_file: o.goldenSourceFile,
      reviews: [
        {
          tool: o.tool,
          repo_name: o.goldenSourceFile.replace(/\.json$/, ''),
          pr_url: r.url,
          review_comments,
        },
      ],
    };
  }
  return { benchmarkData, contexts, omitted };
}

/** Parse a benchmark_data(.fragment).json text into a Map keyed by golden URL — the one place a
 * JSON-derived record is enumerated, so callers never index a raw parsed object. */
export function readFragment(text: string): Map<string, MartianEntry> {
  // Reviver: the ROOT becomes a Map before a plain record exists, so no inherited member is readable.
  // SAFETY: the text is a benchmark_data.json written by martian-bench.mts or Martian's step1.
  return JSON.parse(text, (key, value) =>
    key === '' ? new Map(Object.entries(value)) : value,
  ) as Map<string, MartianEntry>;
}
/** Merge a fragment into benchmark_data: keep other tools, replace this tool's review per PR,
 * add PRs the target lacks. Caller writes the result. */
export interface MergeResult {
  merged: Record<string, MartianEntry>;
  fragmentPrs: number;
  totalPrs: number;
}
export function mergeFragment(
  target: Record<string, MartianEntry>,
  fragment: Record<string, MartianEntry>,
): MergeResult {
  const out = new Map(Object.entries(target));
  const fragmentEntries = Object.entries(fragment);
  for (const [url, entry] of fragmentEntries) {
    const tools = new Set(entry.reviews.map((r) => r.tool));
    const existing = out.get(url);
    out.set(
      url,
      existing
        ? {
            ...existing,
            reviews: [...existing.reviews.filter((r) => !tools.has(r.tool)), ...entry.reviews],
          }
        : entry,
    );
  }
  const result: MergeResult = {
    merged: Object.fromEntries(out),
    fragmentPrs: fragmentEntries.length,
    totalPrs: out.size,
  };
  return result;
}
