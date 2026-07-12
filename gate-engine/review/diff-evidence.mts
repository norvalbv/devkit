import { splitDiffByFile } from '../judge/diff-focus.mts';
// Capped, omission-accounted stdin evidence for a checklist-less gate judge that has no Bash of
// its own to fetch its own diff (sc-1060's completeness lesson, generalized). The old contract was
// positionally sliced at a blunt byte cap — every byte past the slice point silently vanished, and
// whether a gap buried there was ever seen depended on the judge choosing to investigate the right
// file. The fix: per-segment + total budgets in segment order, and OMISSION ACCOUNTING — evidence
// dropped by a cap names itself, so the judge knows what it has NOT seen. A total budget already
// under cap passes through whole — the common small-diff case is byte-identical to no cap at all.
// Long positionally-sliced input also measurably degrades judgment (arXiv:2402.14848, 2302.00093,
// 2409.01666).
//
// `capNamedSegments`/`renderCappedSegments` are the reusable core (any ordered list of named,
// independently-sized chunks — a diff's per-file hunks, or a reviewer's per-file governing docs).
// `buildCappedDiffEvidence` is the diff-specific instance, moved out of completeness.mts unchanged
// so `gate-engine/review/claude-md.mts`'s CLAUDE.md renderer can reuse the same capping shape
// without duplicating it.

export interface NamedSegment {
  label: string;
  content: string;
}

export interface CapOptions {
  totalCap: number;
  segmentCap: number;
  omittedListMax: number;
  /** The "…investigate further" hint appended to an OMITTED/TRUNCATED message, e.g.
   * "run `git diff --cached -- <label>`" or "Read `<label>` directly". */
  hint: (label: string) => string;
  /** Footer appended after the OMITTED_LIST_MAX cutoff, naming where the FULL inventory lives
   * (e.g. "the --stat map above lists every file"). */
  omittedFooterHint: string;
}

/** Greedy-in-order capping: each segment gets up to `segmentCap` of the remaining `totalCap` room;
 * once room is gone, every further segment is OMITTED (named, never silently dropped). */
export function capNamedSegments(
  segments: NamedSegment[],
  { totalCap, segmentCap, hint }: CapOptions,
): { kept: string[]; omitted: string[]; truncated: number } {
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  let truncated = 0;
  for (const seg of segments) {
    const room = totalCap - used;
    if (room <= 0) {
      omitted.push(
        `OMITTED: ${seg.label} (${seg.content.length} chars over the evidence budget — ${hint(seg.label)})`,
      );
      continue;
    }
    const cap = Math.min(segmentCap, room);
    if (seg.content.length <= cap) {
      kept.push(seg.content);
      used += seg.content.length;
    } else {
      truncated += 1;
      kept.push(
        `${seg.content.slice(0, cap)}\n[TRUNCATED: ${seg.label} — ${cap} of ${seg.content.length} chars shown; ${hint(seg.label)} for the rest]\n`,
      );
      used += cap;
    }
  }
  return { kept, omitted, truncated };
}

/** `capNamedSegments` + the OMITTED-list cutoff + the trailing INCOMPLETE-evidence warning —
 * everything after the caller's own leading context (e.g. a `--stat` map) rides first. */
export function renderCappedSegments(segments: NamedSegment[], opts: CapOptions): string {
  const { kept, omitted, truncated } = capNamedSegments(segments, opts);
  const omittedBlock =
    omitted.length > opts.omittedListMax
      ? `${omitted.slice(0, opts.omittedListMax).join('\n')}\n…and ${omitted.length - opts.omittedListMax} more OMITTED segment(s) — ${opts.omittedFooterHint}`
      : omitted.join('\n');
  const warning =
    omitted.length || truncated
      ? `\n[WARNING: ${omitted.length} segment(s) OMITTED and ${truncated} TRUNCATED — the stdin evidence is INCOMPLETE. Investigate EVERY OMITTED/TRUNCATED path before any PASS verdict.]`
      : '';
  return `${kept.join('')}${omitted.length ? `\n${omittedBlock}` : ''}${warning}`;
}

// ─── The diff-specific instance (moved from completeness.mts, sc-1060) ────────────

const EVIDENCE_TOTAL_CAP = 60000; // same total budget as the old blunt cap — no cost claim
const SEGMENT_CAP = 8000; // no single file may eat the budget (greedy in diff order)
const OMITTED_LIST_MAX = 40; // OMITTED pointer lines; the --stat header is the full inventory
const SEGMENT_PATH_RE = /^diff --git (?:a\/)?(\S+)/;

function segmentPath(seg: string): string {
  return seg.match(SEGMENT_PATH_RE)?.[1] ?? '(unknown path)';
}

const diffHint = (label: string) => `run \`git diff --cached -- ${label}\``;

/** Per-file capped diff evidence + explicit omission accounting. `stat` (the full `--stat` map)
 * always rides first — the complete inventory. */
export function buildCappedDiffEvidence(fullDiff: string, stat: string): string {
  const diff = String(fullDiff);
  if (diff.length <= EVIDENCE_TOTAL_CAP) return `${stat}\n${diff}`;
  const segments = splitDiffByFile(diff).map((content) => ({
    label: segmentPath(content),
    content,
  }));
  const body = renderCappedSegments(segments, {
    totalCap: EVIDENCE_TOTAL_CAP,
    segmentCap: SEGMENT_CAP,
    omittedListMax: OMITTED_LIST_MAX,
    hint: diffHint,
    omittedFooterHint: 'the --stat map above lists every file',
  });
  return `${stat}\n${body}`;
}
