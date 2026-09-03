/** Lens-hole reducer: partition every second-detector finding (not-reviewed / not-in-scope /
 * evidence-uncertain / in-evidence-unmatched / matched) BEFORE lens attribution. Pure; counts only leave here. */
import { extractLocations, linesMatch, resolveToStaged } from '../scale/labels.mts';

export type MissBucket =
  | 'not-reviewed'
  | 'not-in-scope'
  | 'evidence-uncertain'
  | 'in-evidence-unmatched'
  | 'matched';

export const MISS_BUCKETS: readonly MissBucket[] = Object.freeze([
  'not-reviewed',
  'not-in-scope',
  'evidence-uncertain',
  'in-evidence-unmatched',
  'matched',
]);

export interface ExternalFinding {
  /** Which second detector produced it: 'coderabbit' | 'martian'. */
  source: string;
  id: string;
  /** Anonymized change key the finding belongs to (a PR URL is fine for public repos). */
  changeKey: string;
  category: string;
  severity?: string | null;
  /** Repo-relative path when the detector records one; Martian goldens carry none. */
  path?: string | null;
  line?: number | null;
  /** Pre-decided match from an external judge (Martian step3). When present it overrides the
   * path heuristic; `lens` is the lens of the devkit issue the judge matched, if resolvable. */
  judged?: { matched: boolean; lens?: string | null };
  /** Triage-only nearest lens for a miss (pre-registered rubric; never scored). */
  triageLens?: string | null;
}

export interface DevkitIssue {
  lens: string;
  text: string;
}

/** What devkit's correctness reviewer saw and said across every attempt on one change. */
export interface ReviewContext {
  changeKey: string;
  /** Union of files the reviewer held in scope across attempts. */
  scopeFiles: readonly string[];
  /** Files that were FULLY shown in at least one attempt (no omission/truncation in that
   * attempt's evidence). A subset of scopeFiles. */
  shownFiles: readonly string[];
  issues: readonly DevkitIssue[];
}

export interface PartitionedFinding {
  id: string;
  source: string;
  changeKey: string;
  category: string;
  severity: string | null;
  bucket: MissBucket;
  matchedLens: string | null;
  triageLens: string | null;
}

interface LocatedIssue {
  lens: string;
  file: string;
  line: number | null;
}

function locateIssues(ctx: ReviewContext): LocatedIssue[] {
  const out: LocatedIssue[] = [];
  for (const issue of ctx.issues)
    for (const loc of extractLocations(issue.text)) {
      const file = resolveToStaged(loc.file, ctx.scopeFiles);
      if (file !== undefined) out.push({ lens: issue.lens, file, line: loc.line });
    }
  return out;
}

/** Path-heuristic match: same resolved file, and lines within the registered ±10 rule. */
function matchByLocation(f: ExternalFinding, located: readonly LocatedIssue[], file: string) {
  return located.find((i) => i.file === file && linesMatch(f.line ?? null, i.line));
}

export function partitionFinding(
  f: ExternalFinding,
  ctx: ReviewContext | undefined,
): PartitionedFinding {
  const base = {
    id: f.id,
    source: f.source,
    changeKey: f.changeKey,
    category: f.category,
    severity: f.severity ?? null,
    triageLens: f.triageLens ?? null,
  };
  if (!ctx) return { ...base, bucket: 'not-reviewed', matchedLens: null };
  // A judged finding (Martian) carries its own match verdict; scope/evidence still partition a
  // judged MISS, since a golden on a file the reviewer never saw is not a lens hole.
  if (f.judged?.matched) return { ...base, bucket: 'matched', matchedLens: f.judged.lens ?? null };
  const file = f.path ? resolveToStaged(f.path, ctx.scopeFiles) : undefined;
  if (f.path && file === undefined) return { ...base, bucket: 'not-in-scope', matchedLens: null };
  if (file !== undefined && !ctx.shownFiles.includes(file))
    return { ...base, bucket: 'evidence-uncertain', matchedLens: null };
  if (file === undefined) {
    // No path: whole-change reading — in evidence only when EVERY scoped file was shown (an empty
    // scope is nothing shown, not everything); a judged miss never falls to the path heuristic.
    const allShown =
      ctx.scopeFiles.length > 0 && ctx.scopeFiles.every((p) => ctx.shownFiles.includes(p));
    return {
      ...base,
      bucket: allShown ? 'in-evidence-unmatched' : 'evidence-uncertain',
      matchedLens: null,
    };
  }
  if (f.judged) return { ...base, bucket: 'in-evidence-unmatched', matchedLens: null };
  const hit = matchByLocation(f, locateIssues(ctx), file);
  return hit
    ? { ...base, bucket: 'matched', matchedLens: hit.lens }
    : { ...base, bucket: 'in-evidence-unmatched', matchedLens: null };
}

export type CountTable = Record<string, Record<string, number>>;

export interface LensHoleReport {
  source: string;
  findings: number;
  /** category → bucket → count */
  partition: CountTable;
  /** category → matchedLens → count, over the matched bucket only */
  matchedByLens: CountTable;
  /** category → triageLens|'none'|'untriaged' → count, over in-evidence-unmatched only */
  unmatchedByTriage: CountTable;
  /** Per-category eligibility for the pre-registered rule: the denominator is the
   * in-evidence-unmatched + matched count (findings the reviewer could have caught). */
  eligibility: Array<{ category: string; catchable: number; unmatched: number; eligible: boolean }>;
  minDenominator: number;
}

function bump(t: CountTable, row: string, col: string): void {
  t[row] ??= {};
  t[row][col] = (t[row][col] ?? 0) + 1;
}

/** Reduce partitioned findings to committed count tables; a category under `minDenominator`
 * catchable findings is reported ineligible, never as a null result. */
export function reduceLensHoles(
  rows: readonly PartitionedFinding[],
  o: { source: string; minDenominator: number },
): LensHoleReport {
  const partition: CountTable = {};
  const matchedByLens: CountTable = {};
  const unmatchedByTriage: CountTable = {};
  for (const r of rows) {
    bump(partition, r.category, r.bucket);
    if (r.bucket === 'matched') bump(matchedByLens, r.category, r.matchedLens ?? 'unknown');
    if (r.bucket === 'in-evidence-unmatched')
      bump(unmatchedByTriage, r.category, r.triageLens ?? 'untriaged');
  }
  const eligibility = Object.keys(partition)
    .sort()
    .map((category) => {
      const p = partition[category];
      const unmatched = p['in-evidence-unmatched'] ?? 0;
      const catchable = unmatched + (p.matched ?? 0);
      return { category, catchable, unmatched, eligible: catchable >= o.minDenominator };
    });
  return {
    source: o.source,
    findings: rows.length,
    partition,
    matchedByLens,
    unmatchedByTriage,
    eligibility,
    minDenominator: o.minDenominator,
  };
}

/** Render the report as a fixed-width text table for the terminal / README. */
export function renderLensHoles(r: LensHoleReport): string {
  const cats = Object.keys(r.partition).sort();
  const w = Math.max(8, ...cats.map((c) => c.length)) + 2;
  const lines: string[] = [];
  lines.push(
    `${r.source}: ${r.findings} finding(s); min catchable per category = ${r.minDenominator}`,
  );
  lines.push(
    `${'category'.padEnd(w)}${MISS_BUCKETS.map((b) => b.padStart(22)).join('')}${'eligible'.padStart(10)}`,
  );
  for (const c of cats) {
    const e = r.eligibility.find((x) => x.category === c);
    lines.push(
      `${c.padEnd(w)}${MISS_BUCKETS.map((b) => String(r.partition[c][b] ?? 0).padStart(22)).join('')}${String(e?.eligible ?? false).padStart(10)}`,
    );
  }
  const lenses = [...new Set(Object.values(r.matchedByLens).flatMap((m) => Object.keys(m)))].sort();
  if (lenses.length > 0) {
    lines.push('');
    lines.push(`matched, by lens:`);
    lines.push(`${'category'.padEnd(w)}${lenses.map((l) => l.padStart(30)).join('')}`);
    for (const c of Object.keys(r.matchedByLens).sort())
      lines.push(
        `${c.padEnd(w)}${lenses.map((l) => String(r.matchedByLens[c][l] ?? 0).padStart(30)).join('')}`,
      );
  }
  const triage = [
    ...new Set(Object.values(r.unmatchedByTriage).flatMap((m) => Object.keys(m))),
  ].sort();
  if (triage.length > 0) {
    lines.push('');
    lines.push(`in-evidence-unmatched, by triage lens (rubric-only, never scored):`);
    lines.push(`${'category'.padEnd(w)}${triage.map((l) => l.padStart(30)).join('')}`);
    for (const c of Object.keys(r.unmatchedByTriage).sort())
      lines.push(
        `${c.padEnd(w)}${triage.map((l) => String(r.unmatchedByTriage[c][l] ?? 0).padStart(30)).join('')}`,
      );
  }
  return lines.join('\n');
}

/** Guard for the committed artifact: a report carries counts and names only. Throws on any key
 * that would smuggle finding text, paths, or per-finding rows into the public repo. */
const FORBIDDEN_KEY_RE = /"(text|body|comment|path|file|rows|findingsList)"\s*:/;
/** A repo-relative source path (any depth, any common source extension); URLs are stripped first. */
export const PATH_LIKE_RE =
  /[\w.-]+(?:\/[\w.-]+)+\.(?:[mc]?[jt]sx?|json|jsonc|sh|bash|py|rb|go|java|kt|rs|vue|svelte|md|ya?ml|toml|css|scss|html|sql|graphql|prisma|tf|xml|txt|env)\b/;
const MAX_LABEL_LEN = 80;
export function assertCountsOnly(report: LensHoleReport): void {
  // Keys AND string values are checked: a category or lens label that carried finding text or a
  // file path would leak just as surely as a forbidden key.
  const text = JSON.stringify(report);
  const key = text.match(FORBIDDEN_KEY_RE);
  if (key) throw new Error(`lens-hole report is counts-only; found key '${key[1]}'`);
  for (const [, value] of text.replace(/https?:\/\/\S+/g, '').matchAll(/"([^"\\]*)"/g)) {
    if (value.length > MAX_LABEL_LEN)
      throw new Error(
        `lens-hole report is counts-only; a string value exceeds ${MAX_LABEL_LEN} chars`,
      );
    if (PATH_LIKE_RE.test(value))
      throw new Error(`lens-hole report is counts-only; a value looks like a source path`);
  }
}
