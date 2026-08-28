/**
 * Deterministic evidence assembly for the sentry commit-msg judge (sc-1984).
 *
 * The gate blocks on the ABSENCE of a Sentry capture, so its blocking authority is only as honest as
 * the evidence it actually showed the judge. Before this module, three things could hide a capture the
 * commit really added:
 *   1. RELEVANCE — a hunk whose only signal was a project wrapper (`captureContained(err)`) matched no
 *      error token, so the selector dropped it and the judge saw a file list with zero code.
 *   2. THE CAP — a blind 6000-char slice cut later hunks, so a capture could be truncated away while an
 *      earlier swallow survived.
 *   3. NO GROUND TRUTH — nothing told the judge which captures the commit added when evidence was
 *      incomplete, and the truncation fail-safe explicitly biases it toward MONITOR.
 *
 * So: `capturesHunk` widens what counts as relevant, `packSelection` drops WHOLE hunks lowest-priority
 * first (never a capture-bearing one while a non-capture hunk survives) and REPORTS what it dropped,
 * and `captureInventory` names every capture the commit adds — anywhere in the staged diff, cap or no
 * cap. `evidenceSufficient` is the gate's floor: a run whose capture evidence is provably incomplete
 * warns instead of blocking (see check-sentry's effectiveHard).
 *
 * Deterministic EVIDENCE selection only — the LLM still decides the verdict.
 */

import { envFlag } from '../config.mts';
import { capturesHunk, hunkCodeLines, scanCode } from './capture-lexer.mts';
import {
  filePathOf,
  type HunkSelection,
  hunkAnchor,
  renderSelection,
  selectHunks,
  splitDiffByFile,
} from '../judge/diff-focus.mts';

// Test files never instrument production error paths: a test asserting `captureContained` was called
// is evidence about the TEST, not about the surface. Excluded from the inventory (but NOT from hunk
// relevance — the judge should still see the test hunk as part of the commit's shape).
const TEST_PATH_RE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

// ─── The capture inventory ──────────────────────────────────────────────────────

/** Ground truth about instrumentation, computed over the WHOLE staged diff — cap-independent. */
export interface CaptureInventory {
  /** `<path>:<hunk anchor> — <symbol>` per ADDED capture, deduped, in diff order. */
  entries: string[];
  /** Entries beyond the display cap (the inventory is bounded; the count is not). */
  extra: number;
  /** False only if the scan itself failed — the gate treats that as incomplete evidence. */
  ok: boolean;
}

// Bound the payload: a commit adding more captures than this is instrumented beyond any doubt, and the
// count still rides along so the number is never silently lost.
const INVENTORY_CAP = 40;

/**
 * Every capture the commit ADDS, named by the surface it sits on: `<path>:<anchor> — <symbol>`.
 *
 * Surface-BOUND on purpose. A flat commit-wide list ("this commit adds captureContained") invites the
 * judge to SKIP a DIFFERENT un-instrumented swallow in the same commit, which would regress the
 * gate's "a capture ELSEWHERE still MONITORs" property. The anchor is git's function context (shared
 * `hunkAnchor`), so the entry names a surface without a line number an insertion would shift.
 *
 * DATA BOUNDARY: paths and capture SYMBOL names only. Never the source line, never argument text.
 */
export function captureInventory(diff: string): CaptureInventory {
  try {
    const entries: string[] = [];
    const seen = new Set<string>();
    let extra = 0;
    for (const seg of splitDiffByFile(diff)) {
      const path = filePathOf(seg);
      if (!path || TEST_PATH_RE.test(path)) continue;
      for (const { anchor, lines } of hunksOf(seg)) {
        const code = hunkCodeLines(lines);
        const joined = code.map((l) => l.code).join('\n');
        // Offset of each line's code within `joined`, so a hit can be mapped back to the diff lines
        // it covers — whose `+` decides whether this commit ADDED the capture.
        const starts: number[] = [];
        let at = 0;
        for (const l of code) {
          starts.push(at);
          at += l.code.length + 1;
        }
        const rowAt = (offset: number) => {
          const after = starts.findIndex((from) => from > offset);
          return after === -1 ? code.length - 1 : Math.max(0, after - 1);
        };
        for (const hit of scanCode(joined)) {
          // A call can SPAN lines, and the commit that adds only its ARGUMENTS still adds the call:
          // a context `captureContained` completed by an added `(err);` is new instrumentation. So
          // every line the call covers is considered, not just the one carrying its name. A call
          // entirely on context lines was already there and still counts for nothing.
          const from = rowAt(hit.index);
          const to = rowAt(hit.argsIndex);
          if (!code.slice(from, to + 1).some((l) => l.added)) continue;
          const entry = `${path}:${anchor} — ${hit.symbol}`;
          if (seen.has(entry)) continue;
          seen.add(entry);
          if (entries.length < INVENTORY_CAP) entries.push(entry);
          else extra += 1;
        }
      }
    }
    return { entries, extra, ok: true };
  } catch {
    // A malformed diff must not fail the commit — but it DOES mean the gate cannot prove
    // instrumentation, which evidenceSufficient turns into a warn rather than a block.
    return { entries: [], extra: 0, ok: false };
  }
}

/** A file segment split into its hunks, each with the anchor its `@@` header names. */
function hunksOf(seg: string): Array<{ anchor: string; lines: string[] }> {
  const hunks: Array<{ anchor: string; lines: string[] }> = [];
  for (const line of seg.split('\n')) {
    if (line.startsWith('@@ ')) {
      hunks.push({ anchor: hunkAnchor(line), lines: [] });
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('--- ')) continue;
    hunks.at(-1)?.lines.push(line);
  }
  return hunks;
}

/** The inventory as judge-facing text, or '' when the commit adds no capture at all. */
export function renderInventory({ entries, extra }: CaptureInventory): string {
  if (!entries.length) return '';
  const more = extra ? `\n… and ${extra} more` : '';
  return (
    'CAPTURES ADDED BY THIS COMMIT (deterministic scan of the whole staged diff — ' +
    '`<file>:<function> — <symbol>`). A capture listed for one surface does NOT instrument a ' +
    `different surface this commit touches:\n${entries.join('\n')}${more}`
  );
}

// ─── Cap-aware packing ──────────────────────────────────────────────────────────

/** What the packer actually managed to show the judge. */
export interface PackedEvidence {
  text: string;
  /** Every capture-bearing hunk reached the judge WHOLE. The gate's licence to block. */
  capturesComplete: boolean;
  /** Relevant hunks the CAP dropped — never the selector's own relevance omissions. */
  droppedByCap: number;
  /** Relevant hunks the selector kept, before the cap. */
  keptCount: number;
}

/** The marker a char-sliced payload ends with — the last-resort fail-safe, kept from the original gate. */
// Could this hunk carry a capture AT ALL? Asked of raw text, deliberately over-inclusive, and
// deliberately NOT the lexer's question. Review found a steady supply of source the lexer cannot
// parse — regex literals inside template interpolations, nested braces, exotic receivers — and every
// one had the same consequence: a capture it could not see let the cap drop a capture-bearing hunk
// while `capturesComplete` stayed true, so the gate hard-blocked on evidence it never showed. This
// test cannot be wrong in that direction. Over-firing only withholds a block, which is safe.
const CAPTURE_TOKEN_RE = /\bcapture[A-Z]/;

export const TRUNCATION_MARKER =
  '[EVIDENCE TRUNCATED — later hunks omitted; a swallow whose capture is not shown here may still be ' +
  'UN-instrumented. Do NOT infer SKIP from an absent capture.]';

// The cap note must never overclaim. While only non-capture hunks have gone the judge can still read
// an absent capture as absent; once a CAPTURE hunk has gone it must not, so the note flips to the
// original truncation fail-safe's instruction (the inventory below the diff names it either way).
const capNote = (n: number, capturesComplete: boolean) =>
  capturesComplete
    ? `${n} further hunk(s) dropped by the evidence cap — every capture this commit adds is still shown below`
    : `${n} further hunk(s) dropped by the evidence cap, INCLUDING a capture — do NOT infer SKIP or MONITOR from a capture missing here; read the inventory below`;

/** A selection minus the dropped hunks, preserving file and hunk order. */
function withoutDropped(sel: HunkSelection, dropped: Set<string>): HunkSelection {
  const kept = sel.kept
    .map((f, fi) => ({ ...f, hunks: f.hunks.filter((_, hi) => !dropped.has(`${fi}:${hi}`)) }))
    .filter((f) => f.hunks.length > 0);
  return { ...sel, kept };
}

/**
 * Fit a selection into `cap` chars by dropping WHOLE hunks, lowest-priority first.
 *
 * Priority is the fix for sc-1984: capture-bearing hunks are dropped LAST, so the evidence that
 * self-clears a MONITOR can never be the thing the cap cut while a swallow survived. Everything that
 * goes is COUNTED and named in the payload — the judge is never left inferring from a silent absence.
 *
 * Two invariants the gate leans on:
 *   · at least one hunk always survives (dropping the last one would recreate the zero-code-evidence
 *     block this module exists to remove);
 *   · a single hunk larger than the whole budget is char-sliced with TRUNCATION_MARKER rather than
 *     dropped, and that run is reported as capturesComplete=false — evidence, but not blocking
 *     evidence.
 */
export function packSelection(sel: HunkSelection, cap: number, omitNoun: string): PackedEvidence {
  // Clamp first: `slice(0, -1)` keeps everything but the LAST character, so a negative budget would
  // append the marker to a near-complete payload and hand back MORE text than it was given — the cap
  // inverted into growth. NaN clamps to 0; Infinity stays uncapped. The cap is a module constant
  // today, but judge caps are moving into resolvable config (sc-2107), so a bad value must not invert.
  const budget = Number.isNaN(cap) ? 0 : Math.max(0, cap);
  const keptCount = sel.kept.reduce((n, f) => n + f.hunks.length, 0);
  let text = renderSelection(sel, omitNoun);
  if (keptCount === 0 || text.length <= budget) {
    return { text, capturesComplete: true, droppedByCap: 0, keptCount };
  }

  // Drop order: non-capture hunks from the END of the diff first, capture-bearing ones only if that
  // was not enough (and never the last survivor).
  const refs = sel.kept.flatMap((f, fi) =>
    f.hunks.map((h, hi) => ({
      key: `${fi}:${hi}`,
      capture: capturesHunk(h),
      // The LEXER decides ordering (what to drop last); RAW TEXT decides authority (whether the run
      // may still block once it is dropped). A hunk the lexer cannot read still counts here.
      mayCapture: capturesHunk(h) || CAPTURE_TOKEN_RE.test(h),
    })),
  );
  const dropOrder = [
    ...refs.filter((r) => !r.capture).reverse(),
    ...refs.filter((r) => r.capture).reverse(),
  ];

  const dropped = new Set<string>();
  let capturesComplete = true;
  for (const ref of dropOrder) {
    if (text.length <= budget || dropped.size >= refs.length - 1) break;
    dropped.add(ref.key);
    if (ref.mayCapture) capturesComplete = false;
    text = renderSelection(withoutDropped(sel, dropped), omitNoun, [
      capNote(dropped.size, capturesComplete),
    ]);
  }
  if (text.length > budget) {
    text = `${text.slice(0, budget)}\n${TRUNCATION_MARKER}`;
    capturesComplete = false;
  }
  return { text, capturesComplete, droppedByCap: dropped.size, keptCount };
}

/**
 * The BLOCKING FLOOR (sc-1984, following reviewer-blocks-require-validated-evidence): the sentry gate
 * may exit 1 only when it can prove it showed the judge the evidence that would have cleared the
 * commit — at least one hunk of real code, every capture-bearing hunk intact, and a computed
 * inventory. Anything else is a warn + watchlist entry, never a block.
 */
export function evidenceSufficient(packed: PackedEvidence, inventory: CaptureInventory): boolean {
  return packed.keptCount > 0 && packed.capturesComplete && inventory.ok;
}

// ─── The diff tier's assembled evidence ─────────────────────────────────────────

// Cap the staged-diff evidence fed to the `diff` tier.
const DIFF_EVIDENCE_CAP = 6000;

// A hunk is error-handling-relevant if it touches a catch/throw/reject/.catch or a log.warn|error —
// the SWALLOW half of the signal. The CAPTURE half is `capturesHunk` above, which recognises project
// wrappers (`captureContained`) the old inline identifier list could not and rejects look-alikes
// (`Error.captureStackTrace`). Keeping them separate is what closed sc-1984: a hunk whose only signal
// was a wrapper capture used to be dropped as a distractor, and the gate then blocked on its absence.
const ERROR_HUNK_RE =
  /\b(?:try|catch|throw|reject)\b|\.catch\s*\(|(?:log|logger|console)\.(?:warn|error)/;

/**
 * SELECT the staged diff's error-handling hunks — the decisions-detect pattern (send the judge the
 * signal, not the whole commit): every changed file's path, then ONLY the error-relevant hunks per
 * file, then an omission count. Dropping distractors is a MEASURED win on the 104-case eval (haiku
 * 0.83→~0.91) — it kills borderline over-fires and stops the cap from truncating the signal out of a
 * big commit. Deterministic EVIDENCE selection only; the LLM still decides.
 * The per-file split lives in ../judge/diff-focus; the capture half + packing, above.
 */
export function selectSentryHunks(diffText: string) {
  return selectHunks(diffText, (h) => ERROR_HUNK_RE.test(h) || capturesHunk(h));
}

/** Everything deterministic the diff tier knows about one staged diff — computed ONCE per run,
 * because both the judge payload AND the gate's licence to block are derived from it. */
export interface SentryEvidence {
  packed: PackedEvidence;
  inventory: CaptureInventory;
  /** True when the gate can prove it showed the judge whatever would have cleared the commit. */
  sufficient: boolean;
  /** GUARD_SENTRY_DIFF_FULL=1 — the raw-diff A/B path, which has no packing to prove anything. */
  exempt: boolean;
}

/**
 * Assemble the diff tier's evidence: the capture inventory over the WHOLE diff, plus the focused hunks
 * packed to the cap capture-first. `sufficient` is the blocking floor — see evidenceSufficient.
 *
 * GUARD_SENTRY_DIFF_FULL=1 feeds the whole diff blindly capped instead (the documented A/B escape
 * hatch). That path has no hunk packing, so it cannot prove a capture survived the cap; it keeps its
 * historical blocking behaviour by the owner's explicit choice and says so on stderr.
 */
export function buildEvidence(diff: string): SentryEvidence {
  const inventory = captureInventory(diff);
  if (envFlag('SENTRY_DIFF_FULL')) {
    const raw = String(diff).trim();
    const text =
      raw.length > DIFF_EVIDENCE_CAP
        ? `${raw.slice(0, DIFF_EVIDENCE_CAP)}\n${TRUNCATION_MARKER}`
        : raw;
    const packed = { text, capturesComplete: true, droppedByCap: 0, keptCount: 1 };
    return { packed, inventory, sufficient: true, exempt: true };
  }
  const packed = packSelection(selectSentryHunks(diff), DIFF_EVIDENCE_CAP, 'non-error');
  const sufficient = evidenceSufficient(packed, inventory) && allCapturesShown(diff, packed.text);
  return { packed, inventory, sufficient, exempt: false };
}

/**
 * Did every added line that could POSSIBLY be a capture reach the judge? Asked end to end, over raw
 * diff text, because a capture can go missing at either step — the relevance selector may not
 * recognise it, or the cap may drop its hunk — and the two answers must not be checked separately.
 *
 * COUNTED, not merely looked for: two hunks can add byte-identical capture lines, and a presence test
 * lets the dropped one borrow the proof of the one that survived. The test is deliberately
 * over-inclusive and lexer-free — any `capture<Upper>` token counts, whether or not it parses — so
 * over-firing withholds a block, while under-firing would let the gate demand a capture that was
 * sitting in the diff all along, the defect this whole module exists to remove.
 */
function allCapturesShown(diff: string, shown: string): boolean {
  return captureTokenLines(splitDiffByFile(diff).join('\n')) <= captureTokenLines(shown);
}

/** How many ADDED lines carry a capture token. Counting `+` lines in the payload works because the
 * packer emits hunks verbatim, so a line that survived is still an added line there. */
function captureTokenLines(text: string): number {
  return text
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++') && CAPTURE_TOKEN_RE.test(l)).length;
}

/** Why a hard-eligible run lost its block — the degrade cause, named for stderr + telemetry
 * (gate-telemetry-self-describing: a non-outcome that stays silent reads as a gate that never ran). */
export function degradeCause(evidence: SentryEvidence | null): string {
  if (!evidence) return 'empty staged diff (message-only evidence)';
  if (!evidence.inventory.ok) return 'the capture inventory could not be computed';
  if (evidence.packed.keptCount === 0) return 'no error-handling hunk was selected from this diff';
  if (!evidence.packed.capturesComplete)
    return 'a capture-bearing hunk did not fit the evidence cap';
  return 'a line that may add a capture never reached the judge';
}
