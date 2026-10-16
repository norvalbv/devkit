import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadScopedTargets, matchScope } from '../../decisions/check-alignment.mts';
import { emitGateEvent } from '../../judge/gate-events.mts';
import { readTranscript } from '../../judge/transcript-store.mts';
import { issueLocations, LOCATION_RE } from '../contracts/response.mts';
import type { ReviewItem, ReviewOutcome } from '../runtime.mts';

const FINDINGS_CAP = 12;
const ISSUE_LINE_CHARS = 160;
const LINE_BUCKET = 5;
/** Printed once per run under the first findings block, whichever reviewer or lens it came from. */
export const CLASS_FIX_HINT =
  '  ↳ A finding naming one input of a check, or one site of a rule the change states, stands for a class: fix + test every instance (commit-gates skill).';

export interface FindingsSummary {
  /** One rendered line per distinct blocking finding, capped at FINDINGS_CAP. */
  lines: string[];
  /** Distinct blocking findings before the cap, plus issues the per-lens cap dropped. */
  total: number;
  /** Findings counted in `total` that no line shows. */
  unlisted: number;
  /** Issue strings folded into an earlier line (same lens + file + 5-line bucket, or same text;
   * a file-keyed lens folds on the same line). */
  deduped: number;
}

const LEADING_DOT_SLASH_RE = /^\.?\//;

/** Whether a lens is itself the file an issue cites — commit-guard keys its items on paths. */
function lensIsCitedFile(lens: string, cited: string): boolean {
  const file = cited.replace(LEADING_DOT_SLASH_RE, '');
  return lens === file || lens.endsWith(`/${file}`);
}

function fingerprint(lens: string, issue: string): string {
  const loc = issue.match(LOCATION_RE);
  // A lens that IS the cited file separates nothing, so the 5-line bucket would merge two distinct
  // findings in one file: fold those on the exact line only.
  if (loc && lensIsCitedFile(lens, loc[1])) return `${lens}||${loc[2]}`;
  if (loc) return `${lens}|${loc[1]}|${Math.floor(Number(loc[2]) / LINE_BUCKET)}`;
  return `${lens}|${issue.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}

/** Only lenses the gate still holds against the commit: waived and out-of-charter-dropped lenses
 * both end in a PASS disposition and must not resurface as blocking findings. */
export function isBlockingItem(item: ReviewItem): boolean {
  return (
    item.status !== 'pass' &&
    item.disposition !== 'waived' &&
    item.disposition !== 'dropped_out_of_charter'
  );
}

/** Every blocking issue a reviewer's lenses reported, one line each, deduplicated and bounded. */
export function summarizeFindings(items: ReviewItem[] | undefined): FindingsSummary {
  const seen = new Set<string>();
  const summary: FindingsSummary = { lines: [], total: 0, deduped: 0, unlisted: 0 };
  for (const item of items ?? []) {
    if (!isBlockingItem(item)) continue;
    for (const issue of item.issues ?? []) {
      const key = fingerprint(item.lens, issue);
      if (seen.has(key)) {
        summary.deduped += 1;
        continue;
      }
      seen.add(key);
      listOrCount(summary, 1, () => issueLine(item.lens, issue));
    }
    const omitted = item.issues_omitted ?? 0;
    if (omitted > 0) listOrCount(summary, omitted, () => omittedLine(item.lens, omitted));
  }
  return summary;
}

/** Counts `count` findings and lists them on one line while FINDINGS_CAP has room. */
function listOrCount(summary: FindingsSummary, count: number, line: () => string): void {
  summary.total += count;
  if (summary.lines.length < FINDINGS_CAP) summary.lines.push(line());
  else summary.unlisted += count;
}

function issueLine(lens: string, issue: string): string {
  const loc = issue.match(LOCATION_RE);
  const text = issue.replace(/\s+/g, ' ').trim().slice(0, ISSUE_LINE_CHARS);
  return `  • ${lens}${loc ? ` · ${loc[1]}:${loc[2]}` : ''} — ${text}`;
}

/** The per-lens cap dropped these before the gate saw their text, so the remedy is the knob. */
function omittedLine(lens: string, omitted: number): string {
  return `  • ${lens} — +${omitted} more issue(s) past the per-lens cap; raise GUARD_REVIEW_MAX_ISSUES_PER_LENS (max 10) to record them`;
}

/** Reads a spilled `itemsRef` sidecar; injectable so the spill path is testable without I/O. */
export type ItemsRefReader = (ref: string) => string | null;

/** `items` spills to an `itemsRef` sidecar past the event byte budget (items.mts) — the block must
 * not vanish on exactly the multi-finding failures it exists for, so read the spill back. */
function resolveItems(res: ReviewOutcome, readRef: ItemsRefReader): ReviewItem[] | undefined {
  if (res.items) return res.items;
  if (!res.itemsRef) return undefined;
  try {
    const raw = readRef(res.itemsRef);
    // SAFETY: the sidecar is written by attachItems as JSON.stringify of the capped ReviewItem[].
    return raw ? (JSON.parse(raw) as ReviewItem[]) : undefined;
  } catch {
    return undefined; // best-effort — the transcript still carries everything
  }
}

/** The block printed under a FAILED reviewer's reason — ONE block per reviewer, merged across a
 * split reviewer's failing lens parts so multi-lens failures never fragment or double-count. */
export function renderFindingsBlockForParts(
  name: string,
  parts: ReviewOutcome[],
  readRef: ItemsRefReader = readTranscript,
  withHint = true,
  driftDeps: Partial<ScopeDriftDeps> = {},
): string {
  const items = parts.flatMap((part) => resolveItems(part, readRef) ?? []);
  const { lines, total, deduped, unlisted } = summarizeFindings(items);
  if (lines.length === 0) return '';
  const folded = deduped > 0 ? `, ${deduped} duplicate(s) folded` : '';
  const more = unlisted > 0 ? `\n  …and ${unlisted} more not shown` : '';
  const hint = withHint ? `\n${CLASS_FIX_HINT}` : '';
  const drift = scopeDriftHint(name, items, driftDeps);
  return `${name}: ${total} finding(s)${folded}:\n${lines.join('\n')}${more}${hint}${drift ? `\n${drift}` : ''}`;
}

/** Single-outcome convenience over renderFindingsBlockForParts. */
export function renderFindingsBlock(
  res: ReviewOutcome,
  readRef: ItemsRefReader = readTranscript,
): string {
  return renderFindingsBlockForParts(res.name, [res], readRef);
}

// A blocking finding citing `TARGET: <slug>` outside that Target's Scope means the edit-time brief
// never showed the ruling. Advisory only: the hint and its event never change a verdict.

const TARGET_CITE_RE = /TARGET:\s*([a-z0-9][a-z0-9-]*)/g;

/** The slice of a scoped Target this check reads. */
export interface ScopeGlobs {
  slug: string;
  scopeGlobs: string[];
}

/** One cited Target enforced on a path its Scope does not cover. */
export interface ScopeDrift {
  slug: string;
  path: string;
  globs: string[];
}

export interface ScopeDriftDeps {
  cwd: string;
  loadTargets: () => ScopeGlobs[];
  exists: (p: string) => boolean;
  emit: (ev: {
    type: 'decision_scope_drift';
    reviewer: string;
    slug: string;
    path: string;
  }) => void;
}

/** Repo-relative form of a cited path, or null when it cannot be resolved to a real file. */
export function normalizeCitedPath(
  cited: string,
  cwd: string,
  exists: (p: string) => boolean,
): string | null {
  const rel = path.isAbsolute(cited) ? path.relative(cwd, cited) : path.normalize(cited);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join('/');
  return exists(path.join(cwd, posix)) ? posix : null;
}

/** Every (slug, path) pair where a blocking issue cites a known Target on an out-of-Scope path. */
export function scopeDriftFindings(
  items: ReviewItem[],
  targets: ScopeGlobs[],
  cwd: string,
  exists: (p: string) => boolean,
): ScopeDrift[] {
  const bySlug = new Map(targets.map((t) => [t.slug, t.scopeGlobs]));
  const seen = new Set<string>();
  const drifts: ScopeDrift[] = [];
  for (const issue of items.filter(isBlockingItem).flatMap((i) => i.issues ?? [])) {
    const slugs = [...issue.matchAll(TARGET_CITE_RE)].map((m) => m[1]);
    for (const slug of slugs) {
      const globs = bySlug.get(slug);
      if (!globs) continue;
      for (const loc of issueLocations(issue)) {
        const rel = normalizeCitedPath(loc.file, cwd, exists);
        if (!rel || matchScope([rel], globs) || seen.has(`${slug}\0${rel}`)) continue;
        seen.add(`${slug}\0${rel}`);
        drifts.push({ slug, path: rel, globs });
      }
    }
  }
  return drifts;
}

/** One advisory line per drift, with the rescope command prefilled — rescope REPLACES the Scope. */
export function renderScopeDriftHints(reviewer: string, drifts: ScopeDrift[]): string {
  return drifts
    .map(({ slug, path: p, globs }) => {
      const scope = globs.join(',');
      return (
        `  ↳ Target ${slug} was enforced outside its Scope (${scope}) on ${p}. If it governs this file: ` +
        `guard-decisions rescope ${slug} --scope "${scope},${p}" --reason "enforced on ${p} by ${reviewer}"; ` +
        'if not, the finding applies a ruling outside its Scope.'
      );
    })
    .join('\n');
}

const DEFAULT_DEPS: Omit<ScopeDriftDeps, 'cwd'> = {
  loadTargets: () => loadScopedTargets(),
  exists: existsSync,
  emit: (ev) => {
    emitGateEvent(ev);
  },
};

/** The hint block for a failed reviewer, or '' — fail-open, and Targets load only on a citation. */
export function scopeDriftHint(
  reviewer: string,
  items: ReviewItem[],
  deps: Partial<ScopeDriftDeps> = {},
): string {
  if (!items.some((i) => isBlockingItem(i) && i.issues?.some((s) => s.includes('TARGET:'))))
    return '';
  const d = { ...DEFAULT_DEPS, cwd: process.cwd(), ...deps };
  try {
    const drifts = scopeDriftFindings(items, d.loadTargets(), d.cwd, d.exists);
    for (const { slug, path: p } of drifts)
      d.emit({ type: 'decision_scope_drift', reviewer, slug, path: p });
    return renderScopeDriftHints(reviewer, drifts);
  } catch {
    return '';
  }
}
