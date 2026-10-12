import { splitDiffByFile } from '../judge/diff-focus.mts';
import { unquoteGitPath } from './lens/chunk.mts';
import { shellWord } from './valve/shell-word.mts';
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
   * (e.g. "the staged-file inventory above lists every file"). */
  omittedFooterHint: string;
}

/** Greedy-in-order capping: each segment gets up to `segmentCap` of the remaining `totalCap` room;
 * once room is gone, every further segment is OMITTED (named, never silently dropped). */
export interface CappedSegments {
  kept: string[];
  omitted: string[];
  /** Bare labels of the OMITTED segments, in order — `omitted` holds the rendered marker lines. */
  omittedLabels: string[];
  /** Labels of the segments cut to their cap, in order. */
  truncatedLabels: string[];
  /** Bytes of SEGMENT CONTENT kept — excludes the OMITTED/TRUNCATED marker text. */
  shownBytes: number;
}

export function capNamedSegments(
  segments: NamedSegment[],
  { totalCap, segmentCap, hint }: CapOptions,
): CappedSegments {
  const kept: string[] = [];
  const omitted: string[] = [];
  const omittedLabels: string[] = [];
  const truncatedLabels: string[] = [];
  let used = 0;
  let shownBytes = 0;
  for (const seg of segments) {
    const room = totalCap - used;
    if (room <= 0) {
      omittedLabels.push(seg.label);
      omitted.push(
        `OMITTED: ${seg.label} (${seg.content.length} chars over the evidence budget — ${hint(seg.label)})`,
      );
      continue;
    }
    const cap = Math.min(segmentCap, room);
    if (seg.content.length <= cap) {
      kept.push(seg.content);
      used += seg.content.length;
      shownBytes += Buffer.byteLength(seg.content, 'utf8');
    } else {
      truncatedLabels.push(seg.label);
      shownBytes += Buffer.byteLength(seg.content.slice(0, cap), 'utf8');
      kept.push(
        `${seg.content.slice(0, cap)}\n[TRUNCATED: ${seg.label} — ${cap} of ${seg.content.length} chars shown; ${hint(seg.label)} for the rest]\n`,
      );
      used += cap;
    }
  }
  return { kept, omitted, omittedLabels, truncatedLabels, shownBytes };
}

/** `capNamedSegments` + the OMITTED-list cutoff + the trailing INCOMPLETE-evidence warning —
 * everything after the caller's own leading context (e.g. a `--stat` map) rides first. */
export function renderCappedSegments(segments: NamedSegment[], opts: CapOptions): string {
  const { kept, omitted, truncatedLabels } = capNamedSegments(segments, opts);
  const truncated = truncatedLabels.length;
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

// The POST-image path, whole even with spaces: `+++ b/<p>` (git tab-terminates a spaced name), else
// `rename to`/`copy to` (a pure rename has no hunks), else the same-path `diff --git` header.
const POST_IMAGE_RES = [
  /^\+\+\+ b\/(.+?)\t?$/m,
  /^(?:rename|copy) to (.+)$/m,
  /^diff --git a\/(.+) b\/\1$/m,
];
// The same three shapes as git C-quotes them (a `"`, `\\`, control or non-ASCII byte in the path).
const QUOTED_POST_IMAGE_RES = [
  /^\+\+\+ "b\/((?:[^"\\]|\\.)*)"\t?$/m,
  /^(?:rename|copy) to "((?:[^"\\]|\\.)*)"$/m,
  /^diff --git "a\/(?:[^"\\]|\\.)*" "b\/((?:[^"\\]|\\.)*)"$/m,
];
function segmentPath(seg: string): string {
  const hunk = seg.indexOf('\n@@');
  const header = hunk === -1 ? seg : seg.slice(0, hunk);
  for (const re of QUOTED_POST_IMAGE_RES) {
    const quoted = re.exec(header)?.[1];
    if (quoted !== undefined) return unquoteGitPath(`"${quoted}"`);
  }
  for (const re of POST_IMAGE_RES) {
    const path = re.exec(header)?.[1];
    if (path) return path;
  }
  return seg.match(SEGMENT_PATH_RE)?.[1] ?? '(unknown path)';
}

const diffHint = (label: string) => `run \`git diff --cached -- ${shellWord(label)}\``;

/** The recovery hint for a judge with Read but no shell (a claude-runtime reviewer without a
 * checklist): the `git diff` hint above names a command it cannot run (sc-2305). */
export const readFileHint = (label: string) =>
  `Read \`${label}\` directly — the post-change file (absent if this change deleted it); its diff hunk is not in this evidence`;

/** What `buildCappedDiffEvidence` would SHOW of a diff: UTF-8 content bytes kept (marker text and
 * stat header excluded) — compare with `diff_bytes`, NOT the caps, which act on UTF-16 units. */
export interface DiffEvidenceCap {
  evidence_bytes_shown: number;
  omitted_files: number;
  truncated_files: number;
}

function namedDiffSegments(diff: string): NamedSegment[] {
  return splitDiffByFile(diff).map((content) => ({ label: segmentPath(content), content }));
}

function capDiffSegments(segments: NamedSegment[]): CappedSegments {
  return capNamedSegments(segments, {
    totalCap: EVIDENCE_TOTAL_CAP,
    segmentCap: SEGMENT_CAP,
    omittedListMax: OMITTED_LIST_MAX,
    hint: diffHint,
    omittedFooterHint: '',
  });
}

export function measureDiffEvidenceCap(fullDiff: string): DiffEvidenceCap {
  const diff = String(fullDiff);
  if (diff.length <= EVIDENCE_TOTAL_CAP)
    return {
      evidence_bytes_shown: Buffer.byteLength(diff, 'utf8'),
      omitted_files: 0,
      truncated_files: 0,
    };
  const { omitted, truncatedLabels, shownBytes } = capDiffSegments(namedDiffSegments(diff));
  return {
    evidence_bytes_shown: shownBytes,
    omitted_files: omitted.length,
    truncated_files: truncatedLabels.length,
  };
}

/** How much of a diff the judge's packet covered, in files — the verdict-side twin of
 * `measureDiffEvidenceCap` (sc-2305), read by evidence/packet/coverage.mts. */
export interface DiffCoverage {
  file_count: number;
  omitted_files: number;
  truncated_files: number;
  /** The first OMITTED_LIST_MAX omitted paths — the same cutoff the packet itself applies. */
  omitted_paths: string[];
  /** The first OMITTED_LIST_MAX paths shown only up to the per-file cap. */
  truncated_paths: string[];
}

export function measureDiffCoverage(fullDiff: string): DiffCoverage {
  const diff = String(fullDiff);
  const segments = namedDiffSegments(diff);
  if (diff.length <= EVIDENCE_TOTAL_CAP)
    return {
      file_count: segments.length,
      omitted_files: 0,
      truncated_files: 0,
      omitted_paths: [],
      truncated_paths: [],
    };
  const { omittedLabels, truncatedLabels } = capDiffSegments(segments);
  return {
    file_count: segments.length,
    omitted_files: omittedLabels.length,
    truncated_files: truncatedLabels.length,
    omitted_paths: omittedLabels.slice(0, OMITTED_LIST_MAX),
    truncated_paths: truncatedLabels.slice(0, OMITTED_LIST_MAX),
  };
}

/** Per-file capped diff evidence + explicit omission accounting. `inventory` (the full `--stat`
 * map, or a churn-free `--name-only` list for a reviewer with no Bash to verify churn with — see
 * cascade/reviewer.mts) always rides first, and either form names every file. */
export function buildCappedDiffEvidence(
  fullDiff: string,
  inventory: string,
  { hint = diffHint }: { hint?: (label: string) => string } = {},
): string {
  const diff = String(fullDiff);
  if (diff.length <= EVIDENCE_TOTAL_CAP) return `${inventory}\n${diff}`;
  const body = renderCappedSegments(namedDiffSegments(diff), {
    totalCap: EVIDENCE_TOTAL_CAP,
    segmentCap: SEGMENT_CAP,
    omittedListMax: OMITTED_LIST_MAX,
    hint,
    omittedFooterHint: 'the staged-file inventory above lists every file',
  });
  return `${inventory}\n${body}`;
}
