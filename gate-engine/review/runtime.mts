import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { GuardConfig } from '../config.mts';
import { consumerChecklistAssetRoot, readConsumerReviewAsset } from './cascade/consumer-assets.mts';
import type { ReviewInconclusiveCause } from './contracts/response.mts';
import type { RecordedWaiver } from './overrides.mts';
import {
  checklistAssetPath,
  checklistScriptAt,
  hasChecklist,
  REVIEWERS,
  type Reviewer,
  type ReviewerSelection,
} from './reviewers.mts';

const REVIEW_ROOTS_HELPER = 'skills/_devkit/review-roots.mjs';
// Imported by every checklist script (createChecklistStore), so its bytes are execution inputs of
// every checklist reviewer — the bench's gateHash already treats it that way (corpus.mts
// SHARED_HELPERS); omitting it here once shipped a store edit that no cache key noticed.
const CHECKLIST_STORE_HELPER = 'skills/_devkit/checklist-store.mjs';

/**
 * Cache-key salt for a reviewer whose consumer-side identity cannot be computed (an unreadable
 * synced asset → `consumerReviewerIdentity` returns null). Deliberately NOT '' — '' is the legacy
 * pre-salt namespace every historical PASS was keyed under, so an empty fallback would replay
 * exactly the stale PASSes the salt exists to invalidate. A distinct sentinel gives the
 * unattributable population its own namespace: still cached (identical diff re-runs stay free),
 * never aliased to a verdict produced by a different prompt version.
 */
export const UNATTRIBUTABLE_IDENTITY_SALT = 'devkit:unattributable-v1';

/** Entrypoint selected by the generated hook from a frozen review package runtime. */
export const PACKAGED_REVIEW_RUNTIME_ENTRYPOINT = 'gate-engine/review/baseline-gate';

/** Entrypoint plus every package-local module it imports, without source/build extensions. */
export const PACKAGED_REVIEW_RUNTIME_MODULE_STEMS: readonly string[] = Object.freeze(
  ['gate-engine/review/baseline-fallow-paths', PACKAGED_REVIEW_RUNTIME_ENTRYPOINT].sort(),
);

function reviewerAssetPaths(reviewer: Reviewer): string[] {
  const paths = [`agents/${reviewer.name}.md`];
  if (hasChecklist(reviewer)) {
    paths.push(
      `skills/${reviewer.skill}/SKILL.md`,
      checklistAssetPath(reviewer),
      REVIEW_ROOTS_HELPER,
      CHECKLIST_STORE_HELPER,
    );
    if (reviewer.skill === 'commit-guard') {
      paths.push('skills/commit-guard/references/co-occurrence.md');
    }
  }
  return paths;
}

/** The package-relative agent-facing asset contract, independent of consumer agent surfaces. */
export const PACKAGED_REVIEW_ASSET_PATHS: readonly string[] = Object.freeze(
  [...new Set([REVIEW_ROOTS_HELPER, ...REVIEWERS.flatMap(reviewerAssetPaths)])].sort(),
);

function readPackagedReviewAsset(assetRoot: string, relativePath: string): Buffer {
  return readFileSync(path.join(assetRoot, relativePath));
}

/** One row of a reviewer's checklist artifact (domain reviewers use `items[]`, commit-guard `files[]`). */
export interface ChecklistItem {
  status?: string;
  name?: string;
  path?: string;
  issues?: string[]; // failure reasons; checkItem clears them on a recovery pass, so a pass has none
}

/** Parsed checklist state-file artifact the judge's workflow leaves behind. */
export interface ChecklistState {
  items?: ChecklistItem[];
  files?: ChecklistItem[];
  /** Named reason the checklist deliberately enumerated nothing (sc-1439) — a valid empty
   * artifact, distinct from an absent one, which still voids a PASS. */
  skipped?: string;
}

/**
 * Independent verification of the checklist artifact the judge's workflow left behind — the
 * gate-side half of the anti-hallucination contract. Returns null when the artifact is complete
 * and consistent with the verdict, else a human-readable reason (→ the cascade result becomes
 * inconclusive, never a PASS). A FAIL verdict needs no artifact scrutiny — it blocks regardless.
 *
 * @param state parsed state-file JSON (null = missing/unreadable)
 * @param verdict the judge's parsed verdict
 */
export function verifyChecklist(
  state: ChecklistState | null,
  verdict: 'PASS' | 'FAIL',
): string | null {
  if (verdict === 'FAIL') return null;
  const items = state?.items ?? state?.files; // domain reviewers use items[]; commit-guard files[]
  // sc-1439: a deliberate, NAMED skip is a valid artifact — the gate selected this reviewer but
  // the checklist's own filters (prose/tests/extensions/deletions) excluded every file. Distinct
  // from an ABSENT artifact, which still voids the PASS: emptiness must be explained, never mute.
  if (
    Array.isArray(items) &&
    items.length === 0 &&
    typeof state?.skipped === 'string' &&
    state.skipped
  )
    return null;
  if (!Array.isArray(items) || items.length === 0)
    return (
      'checklist artifact missing — the judge skipped the checklist workflow (or its ' +
      'checklist script was never synced: devkit sync-skills)'
    );
  const pending = items.filter((i) => i.status === 'pending');
  if (pending.length > 0)
    return `checklist incomplete — ${pending.length} item(s) never resolved: ${pending
      .map((i) => i.name ?? i.path)
      .join(', ')}`;
  const failed = items.filter((i) => i.status === 'fail');
  if (failed.length > 0)
    return `checklist has ${failed.length} FAILED item(s) but the verdict says PASS: ${failed
      .map((i) => i.name ?? i.path)
      .join(', ')}`;
  return null;
}

/**
 * One checklist item as the judge left it, snapshotted before the gate deletes the artifact.
 * `disposition` is what the GATE then did with a failing item, which is not recoverable from the
 * artifact alone: an out-of-charter drop and a waived finding both end as a PASS verdict.
 */
export interface ReviewItem {
  lens: string;
  status: string;
  disposition?: 'blocking' | 'waived' | 'dropped_out_of_charter';
  issues?: string[];
  /** The waiver rationale, capped for the event (attachItems), when `disposition` is 'waived' —
   * present so a consumer reads it off the lens directly, no join against top-level `waivers[]`. */
  rationale?: string;
}

export interface ReviewOutcome {
  name: string;
  status: 'pass' | 'fail' | 'inconclusive' | 'error';
  reason: string;
  escalated: boolean;
  /** Machine-owned category set where the inconclusive outcome originates. Consumers must never
   * reverse-engineer this from the human-readable reason. */
  inconclusiveCause?: ReviewInconclusiveCause;
  /** Binary of the SPAWN that went dark; an engine-error rejection, where the failing pass is
   * unknowable, carries the backtick-joined candidate set exactly as the remedy renders it. */
  outageBin?: string;
  /** Epoch ms the provider said its limit clears, when it named one — so the fail-closed remedy can
   * say how long the wait is instead of telling the operator to re-run into the same wall. */
  outageResetsAt?: number;
  transcript?: string;
  /** Structured acknowledgement records for findings suppressed by the override valve. Present on
   * both all-waived PASS and mixed waived+blocking FAIL outcomes. */
  waivers?: RecordedWaiver[];
  /** The per-lens vector the judge produced, INCLUDING the passes — the only way to tell a reviewer
   * that cleared every lens from one that never looked. Absent when no artifact existed (a
   * skill-less reviewer, or a judge that never wrote one), which is itself the distinction a
   * consumer needs: no artifact is not the same fact as an artifact with zero failures. */
  items?: ReviewItem[];
  /** Total items in the artifact before any capping, so a truncated vector is never mistaken for a
   * short one. */
  itemCount?: number;
  /** Which artifact shape the vector came from: `items` (one per checklist lens — the domain
   * reviewers) or `files` (one per reviewed file — commit-guard). A consumer needs this because the
   * two are not the same unit: a `files` lens is a path, not a bug class. */
  itemArtifact?: 'items' | 'files';
  /** Per-status counts, ALWAYS present alongside a vector — the "did these lenses fire" answer that
   * has to survive a spill to `itemsRef`. */
  itemTally?: Record<string, number>;
  /** Sidecar ref holding the full vector when inlining it would breach the event byte budget. Set
   * INSTEAD of `items`, never alongside it. */
  itemsRef?: string;
  /** Off-wire copy of the vector with full issue text, for a bench that banks findings (sc-2493).
   * Present only when the cascade was asked for it; never serialized onto an event. */
  itemsFull?: Array<{ lens: string; status: string; issues: string[] }>;
  /** The model that actually ran the first pass (Reviewer.model pin, else the cascade default).
   * Absent only when no judge ran (missing brief). Telemetry/cache must report THIS, never the
   * global default — a sonnet-pinned reviewer's verdict labeled 'haiku' sends readers of the
   * usage dashboard chasing a model downgrade that never happened. */
  model?: string;
}

export function agentBody(
  cwd: string,
  cfg: GuardConfig,
  name: string,
  assetRoot?: string,
): string | null {
  const dir = assetRoot ? path.join(assetRoot, 'agents') : cfg.review.agentsDir;
  const file = path.join(path.isAbsolute(dir) ? dir : path.resolve(cwd, dir), `${name}.md`);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Reads one asset named by its PACKAGE-relative path (`agents/x.md`, `skills/…`). */
type ReviewAssetReader = (relativePath: string) => Buffer;

/**
 * The identity of one reviewer's execution inputs: its brief, its registry entry, every registered
 * reviewer asset, and the config subset that changes WHAT it reviews.
 *
 * Deliberately shared by the packaged review-mode preflight and the consumer-path telemetry stamp:
 * one formula means a review-mode identity and a ship-mode identity are COMPARABLE whenever the
 * bytes match, which is the entire reason for recording it. Two formulas would silently produce two
 * incomparable namespaces and every cross-mode rate would be a blend.
 */
function hashReviewerIdentity(
  readAsset: ReviewAssetReader,
  reviewer: Reviewer,
  cfg: GuardConfig,
): string {
  const [brief, ...executionAssets] = reviewerAssetPaths(reviewer);
  const hash = createHash('sha256')
    .update(readAsset(brief as string))
    .update(JSON.stringify(reviewer));
  for (const asset of executionAssets) hash.update(readAsset(asset));
  hash.update(
    JSON.stringify({
      scanRoots: cfg.scanRoots,
      sourceExtensions: cfg.sourceExtensions,
      review: cfg.review,
      indexPath: cfg.indexPath,
      searchTool: cfg.searchTool,
    }),
  );
  return hash.digest('hex');
}

/** Validate and fingerprint current packaged assets before a review-mode cache lookup. */
export function preflightReviewAssets(
  assetRoot: string | undefined,
  selected: ReviewerSelection[],
  cfg: GuardConfig,
): Map<string, string> {
  if (!assetRoot || !path.isAbsolute(assetRoot))
    throw new Error('DEVKIT_REVIEW_ASSET_ROOT is missing or not absolute');
  // Eager, before the loop: an unreadable helper is a packaging fault, and it must surface even when
  // no selected reviewer happens to carry a checklist.
  readPackagedReviewAsset(assetRoot, REVIEW_ROOTS_HELPER);
  readPackagedReviewAsset(assetRoot, CHECKLIST_STORE_HELPER);
  const identities = new Map<string, string>();
  for (const { reviewer } of selected) {
    if (hasChecklist(reviewer)) {
      if (!reviewer.stateFile.startsWith('.claude/') || !reviewer.cmds.gen || !reviewer.cmds.check)
        throw new Error(`${reviewer.name} has an invalid checklist registry binding`);
    }
    identities.set(
      reviewer.name,
      hashReviewerIdentity((rel) => readPackagedReviewAsset(assetRoot, rel), reviewer, cfg),
    );
  }
  return identities;
}

/**
 * Per-reviewer prompt identity for the ordinary commit/ship path, where there is no packaged asset
 * root and `preflightReviewAssets` therefore never runs. This is what makes a production verdict
 * attributable to the prompt version that produced it — AND, since sc-1437, what salts the verdict
 * cache key on this path, so editing a synced brief/checklist/SKILL.md invalidates cached PASSes in
 * the field exactly as review mode's preflight does. Identity resolves from the RUNNING cwd while
 * the cache file anchors to the main checkout (verdict-store) — deliberate: the key describes what
 * the judge would actually read from here.
 *
 * Returns null on ANY unreadable asset rather than throwing: telemetry must never fail a gate, and
 * the cache path substitutes UNATTRIBUTABLE_IDENTITY_SALT for null (never '', the legacy
 * namespace). A genuinely missing brief is already handled upstream — `cascadeVerdict` resolves it
 * to `inconclusive` — so a null here means "unattributable", never "broken".
 */
/**
 * Identity + cache-salt resolution for one gate run — the ONE place the salt is composed (sc-1441
 * will fold the rendered Targets block in here).
 *
 * Review mode: the packaged preflight salts (throwing contract) serve both roles. Commit/ship path:
 * the consumer identity serves telemetry with honest nulls, while the cache salt substitutes
 * UNATTRIBUTABLE_IDENTITY_SALT for null — never '', the legacy pre-salt namespace whose reuse would
 * replay stale PASSes for exactly the unattributable population.
 */
export function resolveReviewerIdentities(
  reviewMode: boolean,
  identitySalts: Map<string, string>,
  selected: ReviewerSelection[],
  cwd: string,
  cfg: GuardConfig,
): { identities: Map<string, string | null>; cacheSalts: Map<string, string> } {
  if (reviewMode) return { identities: identitySalts, cacheSalts: identitySalts };
  const identities = new Map<string, string | null>();
  for (const s of selected)
    identities.set(s.reviewer.name, consumerReviewerIdentity(cwd, cfg, s.reviewer));
  const cacheSalts = new Map(
    [...identities].map(([name, id]) => [name, id ?? UNATTRIBUTABLE_IDENTITY_SALT]),
  );
  return { identities, cacheSalts };
}

export function consumerReviewerIdentity(
  cwd: string,
  cfg: GuardConfig,
  reviewer: Reviewer,
): string | null {
  try {
    const skillRoot = consumerChecklistAssetRoot(cwd, reviewer);
    return hashReviewerIdentity(
      (rel) => readConsumerReviewAsset(cwd, cfg, skillRoot, rel),
      reviewer,
      cfg,
    );
  } catch {
    return null;
  }
}

/** Recheck one completed reviewer's exact execution inputs before its PASS becomes durable. */
export function verifyReviewAssetIdentity(
  assetRoot: string | undefined,
  selected: ReviewerSelection,
  cfg: GuardConfig,
  expected: string,
): void {
  const actual = preflightReviewAssets(assetRoot, [selected], cfg).get(selected.reviewer.name);
  if (actual !== expected)
    throw new Error(`${selected.reviewer.name} assets changed while the reviewer was running`);
}

/** Build the PASS checkpoint guard once from the immutable review-run context. */
export function passAssetVerifier(
  reviewMode: boolean,
  assetRoot: string | undefined,
  cfg: GuardConfig,
  expectedByReviewer: ReadonlyMap<string, string>,
): (outcome: ReviewOutcome, selected: ReviewerSelection) => ReviewOutcome {
  return (outcome, selected) => {
    if (!reviewMode || outcome.status !== 'pass') return outcome;
    try {
      verifyReviewAssetIdentity(
        assetRoot,
        selected,
        cfg,
        expectedByReviewer.get(selected.reviewer.name) ?? '',
      );
      return outcome;
    } catch (cause) {
      return {
        ...outcome,
        status: 'error',
        reason: `asset integrity failure: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  };
}

export function reviewJudgeEnv(cfg: GuardConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEVKIT_REVIEW_BACKEND_ROOTS: JSON.stringify(cfg.review.backendRoots),
    DEVKIT_REVIEW_FRONTEND_ROOTS: JSON.stringify(cfg.review.frontendRoots),
  };
}

/**
 * Judge env for a cascade run on EVERY path (commit, ship, review) — sc-1438. The old wiring was
 * review-mode-gated (`reviewMode ? reviewJudgeEnv(cfg) : undefined`), which left commit-path
 * judges without DEVKIT_CHECKLIST_KEEP: a judge that ran its brief's own `cleanup` step deleted
 * the artifact the gate reads after it finishes, voiding its PASS to "checklist artifact missing"
 * (219 all-time). Env propagates from the judge process to its Bash subprocesses — the same
 * channel the review-roots injection uses. sc-1439 extends this with DEVKIT_REVIEW_STAGED_FILES.
 */
export function gateJudgeEnv(reviewMode: boolean, cfg: GuardConfig): NodeJS.ProcessEnv {
  return {
    ...(reviewMode ? reviewJudgeEnv(cfg) : process.env),
    DEVKIT_CHECKLIST_KEEP: '1',
  };
}

/**
 * Per-reviewer judge env (sc-1439): hand the gate's authoritative staged file list to the
 * reviewer's checklist script, so generate() can never resolve zero files while the gate selected
 * the reviewer — the second artifact-killer behind the "checklist artifact missing" inconclusives.
 * Checklist reviewers only; oversized lists fall back LOUDLY to script-side resolution.
 */
export function withStagedFiles(
  env: NodeJS.ProcessEnv,
  reviewer: Reviewer,
  files: string[],
): NodeJS.ProcessEnv {
  if (!hasChecklist(reviewer)) return env;
  const serialized = JSON.stringify(files);
  if (serialized.length > 100_000) {
    console.error(
      `guard-review: ${reviewer.name} staged list too large to inject (${serialized.length}B) — falling back to script-side resolution`,
    );
    return env;
  }
  return { ...env, DEVKIT_REVIEW_STAGED_FILES: serialized };
}

/** GUARD_REVIEW_SKIP / FRINK_REVIEW_SKIP: comma-list of reviewer names to drop from a run — the
 * per-reviewer rollback lever (GUARD_NO_REVIEW kills the whole gate; this surgically disables one). */
export function skippedReviewers(): Set<string> {
  return new Set(
    (process.env.GUARD_REVIEW_SKIP ?? process.env.FRINK_REVIEW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Parsed checklist state-file artifact for a reviewer, or null (missing/corrupt/no checklist at
 * all — a skill-less reviewer has no stateFile to read → unverifiable). */
export function readChecklistState(cwd: string, reviewer: Reviewer): ChecklistState | null {
  if (!reviewer.stateFile) return null;
  try {
    return JSON.parse(
      readFileSync(path.resolve(cwd, reviewer.stateFile), 'utf8'),
    ) as ChecklistState;
  } catch {
    return null;
  }
}

/** Remove a reviewer's checklist artifact so a stale one can never satisfy the NEXT run. A
 * skill-less reviewer has no stateFile — nothing to clean up. */
export function cleanupChecklistState(cwd: string, reviewer: Reviewer): void {
  if (reviewer.stateFile) rmSync(path.resolve(cwd, reviewer.stateFile), { force: true });
}

/**
 * Deterministically seed commit-guard's per-file checklist before the headless judge runs.
 * Domain reviewers reliably generate their small fixed-lens checklists themselves; commit-guard's
 * longer interactive brief has repeatedly returned a prose PASS without executing `init`, leaving
 * strict ship permanently inconclusive. The gate owns enumeration, while the judge still owns every
 * per-file pass/fail mark and `finalize` — a pre-seeded all-pending artifact grants no authority.
 */
export function initializeCommitGuardChecklist(
  cwd: string,
  reviewer: Reviewer,
  assetRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (reviewer.name !== 'commit-guard' || !hasChecklist(reviewer)) return;
  const script = checklistScriptAt(reviewer, assetRoot);
  try {
    execFileSync(process.execPath, [script, reviewer.cmds.gen], {
      cwd,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    const stderr =
      cause && typeof cause === 'object' && 'stderr' in cause ? String(cause.stderr).trim() : '';
    throw new Error(`commit-guard checklist initialization failed${stderr ? ` — ${stderr}` : ''}`);
  }
  const files = readChecklistState(cwd, reviewer)?.files;
  if (!Array.isArray(files) || files.length === 0)
    throw new Error('commit-guard checklist initialization produced no staged files');
}
