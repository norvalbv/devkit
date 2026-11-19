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
import { selectReviewFiles } from '../../../skills/_devkit/review-roots.mjs';
import {
  envFlag,
  type GuardConfig,
  JS_TS_SOURCE_RE,
  sourceMatchers,
  TEST_INFIX,
} from '../../config.mts';
import { emitAdvisoryResult } from '../../judge/advisory/emit.mts';
import { emitGateEvent } from '../../judge/gate-events.mts';
import { saveTranscript } from '../../judge/transcript-store.mts';
import { measureDiffEvidenceCap } from '../diff-evidence.mts';
import {
  type CachedBaseState,
  type CachedBaseVerdict,
  judgedBaseSha,
  reviewBaseContext,
} from './base-context.mts';
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
  | 'mass_deletion'
  | 'GUARD_REVIEW_SKIP'
  // `guard-review lens <reviewer>` ran one reviewer on purpose — not a knob, not an empty domain.
  | 'recheck'
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

/** The first EVIDENCE_NAMES paths, comma-joined, with an ellipsis when more were cut. */
const evidenceNames = (files: string[]): string =>
  `${files.slice(0, EVIDENCE_NAMES).join(', ')}${files.length > EVIDENCE_NAMES ? ', …' : ''}`;

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
 * run-review.mts: never a silent cap. `routing` is the selection before skip/recheck narrowing
 * (empty on a recheck), read only for the advisory unrouted-files lines.
 */
export function reportNonRuns(
  staged: string[],
  cfg: GuardConfig,
  selected: ReviewerSelection[],
  alreadyReported: Set<string>,
  skip: ReadonlySet<string> = new Set(),
  routing: ReviewerSelection[] = [],
  readStaged: StagedReader = () => null,
): void {
  const disabled = domainsDisabledByEmptyRoots(staged, cfg, skip);
  reportUnroutedFiles(routing, cfg, staged, new Set(disabled[0]?.evidence), readStaged);
  for (const d of disabled) {
    console.error(
      `guard-review: ${d.reviewer} SKIPPED (${d.rootsKey} is empty in guard.config.json)`,
    );
    alreadyReported.add(d.reviewer);
    emitReviewSkipped(d.reviewer, 'empty_roots');
  }
  const files = disabled[0]?.evidence ?? [];
  if (files.length > 0) {
    console.error(
      `guard-review: ${files.length} staged frontend file(s) went unreviewed (${evidenceNames(files)}) — ` +
        'declare "review": { "frontendRoots": [...] } in guard.config.json, or run `devkit doctor`',
    );
  }
  if (staged.length > 0 && selected.length === 0 && alreadyReported.size === 0)
    console.error(
      `guard-review: SKIPPED — no domain reviewer ran; none of the ${staged.length} staged file(s) is in review scope ` +
        '(scanRoots, review roots and review.paths in guard.config.json)',
    );
  reportSelected(selected);
  emitUnselected(selected, alreadyReported);
}

/** The roster line: which reviewers this commit's selection will run or replay from cache. */
function reportSelected(selected: ReviewerSelection[]): void {
  const names = selected.map((s) => s.reviewer.name);
  if (names.length > 0)
    console.error(`guard-review: ${names.length} reviewer(s) selected: ${names.join(', ')}`);
}

const DOMAIN_REVIEWED = new Set(['backend', 'frontend']);

/** The gate label of the unrouted-files advisory row, shared by the emitter and its tests. */
export const REVIEW_ROUTING_ADVISORY = 'review-routing';

/** Implementation code: a declared source extension or any JS/TS file, never a test file. */
function isRoutableCode(file: string, cfg: GuardConfig): boolean {
  const name = file.split('/').pop() ?? '';
  if (TEST_INFIX.test(name)) return false;
  return JS_TS_SOURCE_RE.test(name) || sourceMatchers(cfg.sourceExtensions).isSource(name);
}

/** Code files some reviewer received that no backend/frontend reviewer did, read off the real
 * selection so it never disagrees with routing. */
export function filesRoutedToNoDomain(selection: ReviewerSelection[], cfg: GuardConfig): string[] {
  const { backendRoots, frontendRoots } = cfg.review;
  if (backendRoots.length + frontendRoots.length === 0 || envFlag('REVIEW_NO_TOPOLOGY_WARN'))
    return [];
  const routed = new Set(
    selection.filter((s) => DOMAIN_REVIEWED.has(s.reviewer.domain)).flatMap((s) => s.files),
  );
  const received = new Set(selection.flatMap((s) => s.files));
  return [...received].filter((f) => !routed.has(f) && isRoutableCode(f, cfg));
}

/** Staged bytes for `paths` from the tree the gate judges; null when git cannot answer. */
export type StagedReader = (paths: readonly string[]) => Map<string, Buffer | null> | null;

// Next.js's own server markers: a 'use server' directive (file-level or inline) or `server-only`.
const SERVER_MARKER_RE = /^[\uFEFF \t]*(?:(['"])use server\1|import[ \t]+(['"])server-only\2)/m;
const ROUTE_HANDLER_RE = /^route\.[jt]s$/;
const HTTP_METHOD_EXPORT_RE = /^export\b.*\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/m;

/** True when the module declares itself server code by a Next.js convention, never by extension. */
function isServerModule(file: string, text: string): boolean {
  if (SERVER_MARKER_RE.test(text)) return true;
  return ROUTE_HANDLER_RE.test(file.split('/').pop() ?? '') && HTTP_METHOD_EXPORT_RE.test(text);
}

const filesOfDomain = (selection: ReviewerSelection[], domain: string): Set<string> =>
  new Set(selection.filter((s) => s.reviewer.domain === domain).flatMap((s) => s.files));

// A type declaration holds no implementation for a duplication review to compare.
const TYPE_DECLARATION_RE = /\.d\.[cm]?ts$/;

/** Declared-source files some reviewer received that commit-guard did not (they sit outside
 * scanRoots), read off the real selection. guard-dup is index-scoped, so this never speaks for it. */
export function filesUnseenByCommitGuard(
  selection: ReviewerSelection[],
  cfg: GuardConfig,
): string[] {
  if (envFlag('REVIEW_NO_TOPOLOGY_WARN')) return [];
  const { isSource } = sourceMatchers(cfg.sourceExtensions);
  const seen = filesOfDomain(selection, 'code');
  const received = new Set(selection.flatMap((s) => s.files));
  return [...received].filter((f) => {
    const name = f.split('/').pop() ?? '';
    return (
      !seen.has(f) && !TEST_INFIX.test(name) && !TYPE_DECLARATION_RE.test(name) && isSource(name)
    );
  });
}

/** Server-marked code a frontend reviewer received and no backend reviewer did. Silent when the
 * repo declares no backend, so a pure-UI topology never hears it. */
export function serverFilesSeenOnlyByFrontend(
  selection: ReviewerSelection[],
  cfg: GuardConfig,
  readStaged: StagedReader,
): string[] {
  if (cfg.review.backendRoots.length === 0 || envFlag('REVIEW_NO_TOPOLOGY_WARN')) return [];
  const backend = filesOfDomain(selection, 'backend');
  const candidates = [...filesOfDomain(selection, 'frontend')].filter(
    (f) => !backend.has(f) && isRoutableCode(f, cfg),
  );
  const blobs = candidates.length > 0 ? readStaged(candidates) : null;
  if (!blobs) return [];
  return candidates.filter((f) => {
    const blob = blobs.get(f);
    return blob != null && isServerModule(f, blob.toString('utf8'));
  });
}

// devkit's synced agent assets and build output: every template's review.paths.exclude carries these.
export const SYNCED_ASSET_EXCLUDES = [
  '.agents/**',
  '.claude/**',
  '.codex/**',
  '.cursor/**',
  '.devkit/**',
  'node_modules/**',
  '**/node_modules/**',
  'dist/**',
  '**/dist/**',
  'coverage/**',
];

/** Code files the correctness reviewer never received because review.paths is absent, so its legacy
 * roots + sourceExtensions selector applied. Read off the real selection, like the line above. */
export function filesUnseenByCorrectness(
  staged: string[],
  selection: ReviewerSelection[],
  cfg: GuardConfig,
): string[] {
  if (cfg.review.paths !== undefined || selection.length === 0) return [];
  if (envFlag('REVIEW_NO_TOPOLOGY_WARN')) return [];
  const seen = new Set(selection.find((s) => s.reviewer.domain === 'all')?.files);
  const scope = { include: ['**'], exclude: SYNCED_ASSET_EXCLUDES };
  return selectReviewFiles(staged, { paths: scope, roots: [], sourceExtensions: [] }).filter(
    (f) => !seen.has(f) && isRoutableCode(f, cfg),
  );
}

/** One unrouted-files fact: a stderr line with its config remedy, and the bare fact for the row. */
function pushRoutingFact(facts: string[], files: string[], missed: string, keys: string): void {
  if (files.length === 0) return;
  const fact = `${files.length} source file(s) reached no ${missed} (${evidenceNames(files)})`;
  console.error(
    `guard-review: ${fact} — add each path or its directory to ${keys} in guard.config.json`,
  );
  facts.push(fact);
}

/** Names code that missed its security/performance or correctness review: one stderr line per kind, one row. */
function reportUnroutedFiles(
  selection: ReviewerSelection[],
  cfg: GuardConfig,
  staged: string[],
  alreadyNamed: ReadonlySet<string>,
  readStaged: StagedReader,
): void {
  const unnamed = (files: string[]) => files.filter((f) => !alreadyNamed.has(f));
  const facts: string[] = [];
  const server = serverFilesSeenOnlyByFrontend(selection, cfg, readStaged);
  if (server.length > 0) {
    const fact = `${server.length} server file(s) reached only the frontend reviewers (${evidenceNames(server)})`;
    console.error(
      `guard-review: ${fact} — add each path or its directory to review.backendRoots in guard.config.json`,
    );
    facts.push(fact);
  }
  const noDomain = unnamed(filesRoutedToNoDomain(selection, cfg));
  const noDup = unnamed(filesUnseenByCommitGuard(selection, cfg));
  const unseen = unnamed(filesUnseenByCorrectness(staged, selection, cfg));
  // A file that missed both is named once, first, so its commit-guard miss survives the digest's cut.
  const dup = new Set(noDup);
  const both = new Set(noDomain.filter((f) => dup.has(f)));
  const domainRoots = 'review.backendRoots/frontendRoots';
  pushRoutingFact(
    facts,
    [...both],
    'security/performance reviewer or commit-guard review',
    `${domainRoots} and scanRoots`,
  );
  pushRoutingFact(
    facts,
    noDomain.filter((f) => !both.has(f)),
    'security/performance reviewer',
    domainRoots,
  );
  pushRoutingFact(
    facts,
    noDup.filter((f) => !both.has(f)),
    'commit-guard review',
    'scanRoots',
  );
  if (unseen.length > 0) {
    const fact = `${unseen.length} code file(s) reached no correctness reviewer (${evidenceNames(unseen)})`;
    console.error(
      `guard-review: ${fact} — review.paths is absent, so correctness reviews only declared roots ` +
        'with a sourceExtensions suffix: declare review.paths in guard.config.json (templates ship ' +
        'include ["**"] with excludes), or add the extension to sourceExtensions',
    );
    facts.push(fact);
  }
  // The facts alone, server first: the ship digest cuts a detail short, and remedies stay in the log.
  if (facts.length > 0) emitAdvisoryResult(REVIEW_ROUTING_ADVISORY, 'finding', facts.join('; '));
}

/**
 * True added/removed line counts from unified-diff text. Only lines INSIDE an `@@` hunk count —
 * `+++`/`---` file headers sit between a `diff ` line and the first `@@`, so hunk state (not a
 * prefix-length test) is what keeps a real `---x`/`+++x` content line counted and a header not.
 */
export function diffLineCounts(diffText: string) {
  let insertions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (line.startsWith('diff ')) inHunk = false;
    else if (inHunk && line.startsWith('+')) insertions += 1;
    else if (inHunk && line.startsWith('-')) deletions += 1;
  }
  return { insertions, deletions };
}

// Past this budget the path list spills to a sidecar and the event carries the ref instead.
// `file_count` + `files_sha256` ride inline either way, so a reader can always tell a truly-empty
// scope from a spilled one — the list is never silently dropped.
const SCOPE_FILES_INLINE_BUDGET = 2000;

/** `base_sha` names the tree the verdict was JUDGED against: this run's for a judged row, the stored
 * one for a cache-served row (null when unknown or split across several bases). */
interface ScopeBaseFields {
  base_sha: string | null;
  current_base_sha?: string | null;
  base_state?: CachedBaseState;
  cached_parts_base_state?: CachedBaseState;
}

function baseFields(
  live: string | null,
  verdict: CachedBaseVerdict | null,
  wholly: boolean,
): ScopeBaseFields {
  if (!verdict) return { base_sha: live };
  // Partly cached (split parts): the live parts judged THIS base; the replayed parts' state rides along.
  if (!wholly)
    return { base_sha: live, current_base_sha: live, cached_parts_base_state: verdict.state };
  return { base_sha: judgedBaseSha(verdict), current_base_sha: live, base_state: verdict.state };
}

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
  // The tree the diff was computed against — without it a finding is not re-resolvable from the sink.
  cwd: string = process.cwd(),
  // A cache-served row was judged against the base its PASS stored, not this run's (sc-3468).
  { cachedBase = null }: { cachedBase?: CachedBaseVerdict | null } = {},
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
    ...diffLineCounts(diffText),
    ...measureDiffEvidenceCap(diffText),
    file_count: files.length,
    files_sha256: sha256(files.join('\n')),
    ...(spilled ? { scope_ref: spilled } : { files }),
    // No static lens vocabulary here on purpose: the per-run `items` vector lists EVERY checklist
    // item including the passes, so "this lens never fired" and "this reviewer has no such lens" are
    // already distinguishable from the run itself. A duplicated ALL_ITEMS copy would only add a
    // second source of truth the gate cannot import and would have to sync-test.
    has_checklist: hasChecklist(sel.reviewer),
    cached,
    ...baseFields(reviewBaseContext(cwd).baseSha, cachedBase, cached),
    ...(contextFields ?? {}),
  });
}
