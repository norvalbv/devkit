/**
 * The governing-Targets prompt block, shared by every judge that reads recorded decisions
 * (sc-1440). Extracted from completeness.mts so the domain-reviewer cascade (sc-1441) can render
 * the SAME rulings under a different framing — completeness treats a recorded Target as "not a
 * gap" (its judge hunts omissions), while a reviewer treats it as the product's recorded boundary
 * (violating one is IN CHARTER). One renderer, two framings: the bytes a judge reads are the
 * contract, so the shape must never fork.
 */

import { type GoverningTarget, scopedTargets } from '../../decisions/scoped-targets.mts';
import { hasChecklist, type ReviewerSelection } from '../reviewers.mts';

/** One governing Target (scope-match or semantic) as returned by `scopedTargets`. */
export interface TargetBlock {
  slug: string;
  ruling: string;
  scope: string | null;
  via: string;
}

/** The words around the rulings — the only part that differs per judge. */
export interface TargetsFraming {
  /** Full `## …` header line above the rendered rulings. */
  header: string;
  /** Full `## …` header line for the no-Targets case. */
  skipHeader: string;
  /** Body of the no-Targets note. */
  skipNote: string;
}

/** completeness.mts's original bytes, verbatim — its judge must keep reading exactly this. */
export const COMPLETENESS_TARGETS_FRAMING: TargetsFraming = Object.freeze({
  header:
    '## RELEVANT RECORDED TARGETS (authoritative — a recorded decision is NOT a completeness gap)',
  skipHeader: '## RELEVANT RECORDED TARGETS — SKIP',
  skipNote:
    'No governing Target found (index unreachable, or none match). Do not claim ' +
    'decision-alignment you did not check; a recorded decision is not a completeness gap.',
});

/** The domain-reviewer framing (sc-1441): Targets describe what the product's boundary IS. */
export const REVIEWER_TARGETS_FRAMING: TargetsFraming = Object.freeze({
  header:
    "## RECORDED TARGETS (authoritative — what this product's security/performance boundary IS)",
  skipHeader: '## RECORDED TARGETS — SKIP',
  skipNote:
    'No governing Target found (no decisions store, index unreachable, or none match). Review on ' +
    'the checklist alone; do not claim Target-alignment you did not check.',
});

/**
 * Render the governing-Targets block (the consumer prep-critique shape) or its SKIP note.
 *
 * `capBytes` bounds the RENDERED block: rulings render 8–20KB files' Target sections and the
 * block rides in `-p` argv beside a ~8KB brief with several judges concurrent, so an unbounded
 * block risks argv limits and buries the checklist. Whole rulings are dropped from the end, and
 * every drop is NAMED (`OMITTED: …`) — silent truncation would read as "no other Targets govern".
 * Default Infinity keeps completeness byte-identical to its pre-extraction output.
 */
export function renderTargets(
  blocks: TargetBlock[],
  framing: TargetsFraming = COMPLETENESS_TARGETS_FRAMING,
  capBytes = Number.POSITIVE_INFINITY,
): string {
  if (blocks.length === 0) return `${framing.skipHeader}\n${framing.skipNote}`;
  const lines = [framing.header, ''];
  const omitted: string[] = [];
  // Measured in UTF-8 BYTES, not string length: the cap guards argv size, and this repo's rulings
  // are em-dash/middot-dense (each 2-3 bytes but 1 UTF-16 unit) — a char count under-measures and
  // silently blows the documented byte cap with no OMITTED note (sc-1474).
  let size = Buffer.byteLength(framing.header, 'utf8') + 1;
  for (const b of blocks) {
    const section = `### ${b.slug}${b.scope ? ` · scope: \`${b.scope}\`` : ''} _(${b.via})_\n${b.ruling.trim()}\n`;
    const sectionBytes = Buffer.byteLength(section, 'utf8');
    if (size + sectionBytes > capBytes) {
      omitted.push(b.slug);
      continue;
    }
    size += sectionBytes;
    lines.push(`### ${b.slug}${b.scope ? ` · scope: \`${b.scope}\`` : ''} _(${b.via})_`);
    lines.push(b.ruling.trim());
    lines.push('');
  }
  if (omitted.length > 0)
    lines.push(
      `OMITTED: ${omitted.length} further governing Target(s) over the size cap — ${omitted.join(', ')}. Read them under docs/decisions/ if this diff touches their scope.`,
      '',
    );
  return lines.join('\n');
}

// The semantic supplement's wall-clock budget: on a cold vector index the embed tier may serially
// embed every axis (each with its own 15s abort) BEFORE any judge starts — unbounded, that is a
// multi-minute silent stall on the ship critical path. Timing out is free AND salt-safe: the
// fallback is the scope-only load, which is exactly the salt render.
const SEMANTIC_BUDGET_MS = 10_000;

/** The dual-rendered Targets blocks (sc-1441 + sc-1442) plus whether semantic hits arrived. */
export interface ReviewerTargetsBlocks {
  saltBlock: string;
  promptBlock: string;
  semantic: boolean;
}

/**
 * The domain-cascade Targets blocks, loaded ONCE per gate run: reviewer framing, 8KB
 * named-omission cap, fail-open (an unreadable decisions store renders the SKIP note).
 *
 * ONE `scopedTargets` call, TWO renders: `saltBlock` from the deterministic scope-glob matches
 * only, `promptBlock` additionally carrying the query's semantic supplement. The commit-message
 * subject supplies the query (sc-1442), so the supplement — and ONLY the supplement — may vary
 * with the message; salting on the scope-only render keeps the message out of every cache key
 * (ship-gates-converge-not-restart) while a Target EDIT still invalidates stale PASSes. Accepted
 * consequence: a Target retrieved only semantically never participates in cache invalidation.
 */
export async function loadReviewerTargetsBlocks(
  cwd: string,
  files: string[],
  query = '',
): Promise<ReviewerTargetsBlocks> {
  let targets: GoverningTarget[] | null = null;
  if (query.trim()) {
    targets = await Promise.race([
      scopedTargets(files, query, 6, cwd).catch((): null => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SEMANTIC_BUDGET_MS).unref()),
    ]);
  }
  // No query, supplement timed out, or the load itself threw → the scope-only load (cheap, sync
  // file reads; scopedTargets already survives semantic-tier errors internally).
  if (targets === null) targets = await scopedTargets(files, '', 6, cwd).catch(() => []);
  const scoped = targets.filter((t) => t.via === 'scope-match');
  const saltBlock = renderTargets(scoped, REVIEWER_TARGETS_FRAMING, 8_192);
  const promptBlock =
    scoped.length === targets.length
      ? saltBlock
      : renderTargets(targets, REVIEWER_TARGETS_FRAMING, 8_192);
  return { saltBlock, promptBlock, semantic: scoped.length !== targets.length };
}

/**
 * Per-reviewer cache salts (extracted from runReviewGate, sc-1442): Target bytes join every
 * CHECKLIST reviewer's salt — a Target edit invalidates stale PASSes like an asset edit (sc-1441).
 * `saltBlock` MUST be the scope-only render: the commit message and its semantic Target hits NEVER
 * enter this salt (ship-gates-converge-not-restart — amended-message retries must converge).
 */
export function reviewerTargetSalts(
  selected: ReviewerSelection[],
  cacheSalts: Map<string, string>,
  saltBlock: string,
  cascadeModel: string,
): Map<string, string> {
  const salted = (s: ReviewerSelection): string => {
    const base = cacheSalts.get(s.reviewer.name) ?? '';
    // The judging model is part of verdict identity (sc-2053): a PASS earned by one model must
    // not replay for another, or a model flip silently serves the old model's judgments.
    const model = `\0model:${s.reviewer.model ?? cascadeModel}`;
    return hasChecklist(s.reviewer) ? `${base}\0${saltBlock}${model}` : `${base}${model}`;
  };
  return new Map(selected.map((s): [string, string] => [s.reviewer.name, salted(s)]));
}
