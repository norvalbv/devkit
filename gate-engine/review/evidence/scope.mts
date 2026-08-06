/**
 * What each reviewer was GIVEN, and which reviewers never ran.
 *
 * The forcing problem (docs/decisions/gate-verdict-attribution.md): a verdict alone is not evidence.
 * A cached PASS emits `cache_hit` and no `review_result`, so ~13% of reviewer outcomes left no row at
 * all and read downstream as "that reviewer was never selected" — indistinguishable from one that
 * genuinely never looked.
 *
 * Best-effort telemetry only: nothing here may influence a verdict. Every payload is bounded, because
 * gate-events.mts relies on sub-4KB single-append writes staying atomic under concurrent judges — an
 * unbounded array is a data-CORRUPTION bug, not a large row.
 *
 * This module also owns the HUMAN-facing non-run line (reportNonRuns, below) — the `guard-review: `
 * stderr prefix travels with the fact, not with the caller. "Nothing here may influence a verdict"
 * still holds: stderr does not.
 */
import { createHash } from 'node:crypto';
import { envFlag, type GuardConfig } from '../../config.mts';
import { emitGateEvent } from '../../judge/gate-events.mts';
import { saveTranscript } from '../../judge/transcript-store.mts';
import {
  declaredRoots,
  hasChecklist,
  REVIEWERS,
  type ReviewerSelection,
  underRoot,
} from '../reviewers.mts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/**
 * Why a reviewer produced no verdict on this run. Without this, a reviewer that was never selected,
 * one the knob dropped, and one that PASSED are indistinguishable downstream — so an external
 * finding on code the correctness reviewer never looked at reads as a correctness MISS.
 */
export type SkipReason =
  | 'gate_disabled'
  | 'no_llm'
  | 'GUARD_REVIEW_SKIP'
  | 'not_selected'
  // Distinct from 'not_selected' on purpose: "never ran because the consumer's topology is empty"
  // and "never ran because nothing in its domain was staged" are opposite conclusions in a
  // miss-analysis — one is a config bug, the other is the gate working.
  | 'empty_roots';

export function emitReviewSkipped(reviewer: string | null, reason: SkipReason): void {
  emitGateEvent({ type: 'review_skipped', reviewer, reason });
}

/** Every registered reviewer absent from `selected`, so non-selection is a row and not an absence. */
export function emitUnselected(selected: ReviewerSelection[], alreadyReported: Set<string>): void {
  const ran = new Set(selected.map((s) => s.reviewer.name));
  for (const { name } of REVIEWERS)
    if (!ran.has(name) && !alreadyReported.has(name)) emitReviewSkipped(name, 'not_selected');
}

// Only a repo with a real UI stages these. `.ts`/`.js` are deliberately ABSENT: they are the
// backend's extensions too, which is why the gate carries the frontend case only.
const FRONTEND_SIGNATURE_RE = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$/i;

// Past this many names the evidence line truncates — same reasoning as SCOPE_FILES_INLINE_BUDGET
// below: an unbounded line on a 400-file diff is a bug, not a long message.
const EVIDENCE_NAMES = 3;

/** A reviewer the gate never even considered, because its domain roots array is empty. */
export interface DisabledDomain {
  reviewer: string;
  rootsKey: 'review.frontendRoots';
  /** The staged files that prove the domain is live despite the empty roots. */
  evidence: string[];
}

/**
 * Reviewers dropped because their domain roots array is EMPTY — but only when THIS commit stages
 * files characteristic of that domain. Pure: no fs, no git.
 *
 * FRONTEND ONLY, by design. The frontend rule has a falsifier decidable from the diff alone ("a
 * .tsx is staged and frontendRoots is empty"); the backend rule has none — `.ts` belongs to both
 * domains, and templates/react-app empties backendRoots DELIBERATELY, so a symmetric warning would
 * misfire on every React consumer. `devkit doctor` carries the backend case because it reads a
 * second signal the gate never reads: the dependency manifest. The gate judges the DIFF; doctor
 * judges the REPO.
 *
 * Suppressions, each deliberate:
 *  - Signature files under a DECLARED root only. Server-rendered templates, transactional email
 *    HTML and docs assets live in genuinely frontend-less services; a .scss inside the repo's own
 *    stated review surface is evidence, a stray .html in emails/ is not. KNOWN true negative: a
 *    Next `app/` tree outside scanRoots stays silent here — doctor still catches that repo.
 *  - ...unless NOTHING is declared. An explicit `"scanRoots": []` survives config resolution
 *    (config.mts `arr`), and the root filter would then go silent on the most broken topology
 *    there is. Fall back to the same `['.']` sentinel effectiveReviewConfig already uses.
 *  - GUARD_REVIEW_NO_TOPOLOGY_WARN, plus any reviewer GUARD_REVIEW_SKIP already named. The skip
 *    knob alone is NOT an acceptable opt-out: it disables the reviewers, so "silence the warning"
 *    and "keep the reviewers off" would be one lever — a frontend-less service with .html inside
 *    its declared roots must be able to acknowledge the topology without turning two paid judge
 *    cascades on.
 */
export function domainsDisabledByEmptyRoots(
  stagedFiles: string[],
  cfg: GuardConfig,
  skip: ReadonlySet<string> = new Set(),
): DisabledDomain[] {
  if (cfg.review.frontendRoots.length > 0 || envFlag('REVIEW_NO_TOPOLOGY_WARN')) return [];
  const declared = declaredRoots(cfg);
  const surface = declared.length > 0 ? declared : ['.'];
  const evidence = stagedFiles.filter(
    (f) => FRONTEND_SIGNATURE_RE.test(f) && surface.some((r) => underRoot(f, r)),
  );
  if (evidence.length === 0) return [];
  return REVIEWERS.filter((r) => r.domain === 'frontend' && !skip.has(r.name)).map((r) => ({
    reviewer: r.name,
    rootsKey: 'review.frontendRoots' as const,
    evidence,
  }));
}

/**
 * Name every reviewer that will produce no verdict — to the human on stderr AND to telemetry —
 * BEFORE the gate's nothing-selected early return (a .scss-only diff selects nothing at all, and
 * would otherwise return before anyone was told why). Mirrors the GUARD_REVIEW_SKIP precedent in
 * run-review.mts: never a silent cap.
 */
export function reportNonRuns(
  staged: string[],
  cfg: GuardConfig,
  selected: ReviewerSelection[],
  alreadyReported: Set<string>,
  skip: ReadonlySet<string> = new Set(),
): void {
  const disabled = domainsDisabledByEmptyRoots(staged, cfg, skip);
  for (const d of disabled) {
    console.error(
      `guard-review: ${d.reviewer} skipped (${d.rootsKey} is empty in guard.config.json)`,
    );
    alreadyReported.add(d.reviewer);
    emitReviewSkipped(d.reviewer, 'empty_roots');
  }
  const files = disabled[0]?.evidence ?? [];
  if (files.length > 0) {
    const more = files.length > EVIDENCE_NAMES ? ', …' : '';
    const names = `${files.slice(0, EVIDENCE_NAMES).join(', ')}${more}`;
    console.error(
      `guard-review: ${files.length} staged frontend file(s) went unreviewed (${names}) — ` +
        'declare "review": { "frontendRoots": [...] } in guard.config.json, or run `devkit doctor`',
    );
  }
  emitUnselected(selected, alreadyReported);
}

// Past this budget the path list spills to a sidecar and the event carries the ref instead.
// `file_count` + `files_sha256` ride inline either way, so a reader can always tell a truly-empty
// scope from a spilled one — the list is never silently dropped.
const SCOPE_FILES_INLINE_BUDGET = 2000;

/**
 * One row per reviewer the gate SELECTED — emitted before the judge runs, so it lands for a cached
 * PASS too. This is the row that answers "did this reviewer see this file, on which bytes, under
 * which prompt version".
 */
export function emitReviewScope(
  sel: ReviewerSelection,
  diffText: string,
  promptIdentity: string | null,
  cached: boolean,
  // sc-1442: bounded per-run context facts — did the prompt carry a commit message, and which
  // Targets tier loaded. Without these the epic's "reviewers with intent vs blind" field
  // comparison cannot be computed from the sink.
  contextFields: { commit_msg: boolean; targets_via: 'scope' | 'scope+semantic' } | null = null,
): void {
  const files = [...sel.files].sort();
  const inline = JSON.stringify(files);
  const spilled =
    inline.length > SCOPE_FILES_INLINE_BUDGET
      ? saveTranscript(`scope-${sel.reviewer.name}`, inline)
      : null;
  emitGateEvent({
    type: 'review_scope',
    reviewer: sel.reviewer.name,
    domain: sel.reviewer.domain,
    prompt_identity: promptIdentity,
    diff_sha256: sha256(diffText),
    diff_bytes: Buffer.byteLength(diffText, 'utf8'),
    file_count: files.length,
    files_sha256: sha256(files.join('\n')),
    ...(spilled ? { scope_ref: spilled } : { files }),
    // No static lens vocabulary here on purpose: the per-run `items` vector lists EVERY checklist
    // item including the passes, so "this lens never fired" and "this reviewer has no such lens" are
    // already distinguishable from the run itself. A duplicated ALL_ITEMS copy would only add a
    // second source of truth the gate cannot import and would have to sync-test.
    has_checklist: hasChecklist(sel.reviewer),
    cached,
    ...(contextFields ?? {}),
  });
}
