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

function fingerprint(lens: string, issue: string): string {
  const loc = issue.match(LOCATION_RE);
  if (loc) return `${lens}|${loc[1]}|${Math.floor(Number(loc[2]) / LINE_BUCKET)}`;
  return `${lens}|${issue.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}

/** Every blocking issue a reviewer's lenses reported, one line each, deduplicated and bounded. */
export function summarizeFindings(items: ReviewItem[] | undefined): FindingsSummary {
  const seen = new Set<string>();
  const lines: string[] = [];
  const blocking = new Set<string>();
  let total = 0;
  let deduped = 0;
  for (const item of items ?? []) {
    // Only lenses the gate still holds against the commit: waived and out-of-charter-dropped
    // lenses both end in a PASS disposition and must not resurface here as blocking findings.
    if (
      item.status === 'pass' ||
      item.disposition === 'waived' ||
      item.disposition === 'dropped_out_of_charter'
    )
      continue;
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
): string {
  const items = parts.flatMap((part) => resolveItems(part, readRef) ?? []);
  const { lines, total, deduped, blockingLenses } = summarizeFindings(items);
  if (lines.length === 0) return '';
  const folded = deduped > 0 ? `, ${deduped} duplicate(s) folded` : '';
  const more =
    total > lines.length ? `\n  …and ${total - lines.length} more in the transcript` : '';
  const hint = blockingLenses.includes(CLASSIFICATION_LENS) ? `\n${CLASS_FIX_HINT}` : '';
  return `${name}: ${total} finding(s)${folded}:\n${lines.join('\n')}${more}${hint}`;
}

/** Single-outcome convenience over renderFindingsBlockForParts. */
export function renderFindingsBlock(
  res: ReviewOutcome,
  readRef: ItemsRefReader = readTranscript,
): string {
  return renderFindingsBlockForParts(res.name, [res], readRef);
}
