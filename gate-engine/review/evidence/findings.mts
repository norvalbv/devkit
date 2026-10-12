import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadScopedTargets, matchScope } from '../../decisions/check-alignment.mts';
import { emitGateEvent } from '../../judge/gate-events.mts';
import { readTranscript } from '../../judge/transcript-store.mts';
import type { ReviewItem, ReviewOutcome } from '../runtime.mts';

const FINDINGS_CAP = 12;
const ISSUE_LINE_CHARS = 160;
// A real code location, not any dotted-name:port — the extension allowlist keeps `db.internal:5432`
// out of the file:line bucket so unrelated findings never fold together.
const LOCATION_RE =
  /([\w@./-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|py|go|rs|java|rb|swift|kt|sh|bash|zsh|sql|css|scss|html|vue|svelte|json|ya?ml|toml|md)):(\d+)\b/i;
const LINE_BUCKET = 5;
/** The correctness lens whose single counterexample stands for a class (mirrors CORRECTNESS_LENSES). */
export const CLASSIFICATION_LENS = 'error-and-edge-classification';
export const CLASS_FIX_HINT =
  '  ↳ If a finding names one input to a matcher/parser/predicate/validator, derive why it fails and fix + test the whole class (commit-gates skill).';

export interface FindingsSummary {
  /** One rendered line per distinct blocking finding, capped at FINDINGS_CAP. */
  lines: string[];
  /** Distinct blocking findings before the cap. */
  total: number;
  /** Issue strings folded into an earlier line (same lens + file + 5-line bucket, or same text). */
  deduped: number;
  /** Lenses still holding at least one blocking issue, sorted — independent of the line cap. */
  blockingLenses: string[];
}

/** Every `file:line` an issue string cites, in order — the same allowlist as the fold key. */
export function issueLocations(issue: string): { file: string; line: number }[] {
  return [...String(issue).matchAll(new RegExp(LOCATION_RE.source, 'gi'))].map((m) => ({
    file: m[1],
    line: Number(m[2]),
  }));
}

function fingerprint(lens: string, issue: string): string {
  const loc = issue.match(LOCATION_RE);
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
  const lines: string[] = [];
  const blocking = new Set<string>();
  let total = 0;
  let deduped = 0;
  for (const item of items ?? []) {
    if (!isBlockingItem(item)) continue;
    for (const issue of item.issues ?? []) {
      blocking.add(item.lens);
      const key = fingerprint(item.lens, issue);
      if (seen.has(key)) {
        deduped += 1;
        continue;
      }
      seen.add(key);
      total += 1;
      if (lines.length < FINDINGS_CAP) {
        const loc = issue.match(LOCATION_RE);
        const text = issue.replace(/\s+/g, ' ').trim().slice(0, ISSUE_LINE_CHARS);
        lines.push(`  • ${item.lens}${loc ? ` · ${loc[1]}:${loc[2]}` : ''} — ${text}`);
      }
    }
  }
  return { lines, total, deduped, blockingLenses: [...blocking].sort() };
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
  driftDeps: Partial<ScopeDriftDeps> = {},
): string {
  const items = parts.flatMap((part) => resolveItems(part, readRef) ?? []);
  const { lines, total, deduped, blockingLenses } = summarizeFindings(items);
  if (lines.length === 0) return '';
  const folded = deduped > 0 ? `, ${deduped} duplicate(s) folded` : '';
  const more =
    total > lines.length ? `\n  …and ${total - lines.length} more in the transcript` : '';
  const hint = blockingLenses.includes(CLASSIFICATION_LENS) ? `\n${CLASS_FIX_HINT}` : '';
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
