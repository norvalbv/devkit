/**
 * Correctness lens split (pilot, default OFF) — the gate half of a mechanism whose SKILL half has
 * existed since the correctness checklist was written (`--lens` in
 * skills/correctness/scripts/checklist.mjs, whose own comment says "ship mode runs one judge PER
 * lens"). Nothing in the gate ever passed it; this module is what does.
 *
 * WHY. The correctness reviewer holds four lenses in ONE judge pass, and its accuracy is not
 * uniform across them. On the 128-row checkpoint, pooled first-pass recall is 0.90 for
 * {concurrency-races, state-transitions} against 0.75 for {writer-reader-contracts,
 * error-and-edge-classification}, and clean-pass 0.89 vs 0.77 — the headline 0.81/0.83 is a blend
 * hiding a ~15pp spread. Difficulty does NOT explain it: stratified, the effect is LARGER
 * (Mantel-Haenszel OR 2.69) and the strong pair carries the HARDER rows. Provenance explains ~1pp.
 * But n=69 leaves it underpowered (Fisher exact p=0.21), so this ships DARK and is decided by the
 * pre-registered A/B in docs/benchmarks/pre-registration-lens-split.md — never by conviction.
 *
 * DOSE. The default is TWO GROUPS OF TWO, not four judges. Four would cost 4x the per-commit judge
 * calls and compound the measured 4.2% single-judge inconclusive rate to ~15.8% on strict ships —
 * to decide a question whose weak-pair denominators (40 gold / 26 decoy rows) sit BELOW the repo's
 * own ~5-net-flip resolution floor, i.e. the 4-way A/B provably could not decide it. Two groups
 * test the same attention-dilution hypothesis at half the dose and leave the strong pair as a
 * near-control. A four-way split remains reachable as an explicit spec.
 *
 * INVARIANT THROUGHOUT: the reviewer NAME never changes. The override valve fingerprints on
 * (reviewer name + lens + diff), reviewer asset paths and the prompt-identity salt are keyed by
 * name, and gate-verdict-attribution expects ONE review_result row per reviewer — so renaming the
 * derived clones would void every committed waiver and split the telemetry in two.
 */

import { emitGateEvent } from '../../judge/gate-events.mts';
import { composeTranscript, saveTranscript } from '../../judge/transcript-store.mts';
import { itemFields } from '../evidence/items.mts';
import type { ChecklistReviewer, ReviewerSelection } from '../reviewers.mts';

export const CORRECTNESS_LENSES = Object.freeze([
  'state-transitions',
  'concurrency-races',
  'writer-reader-contracts',
  'error-and-edge-classification',
] as const);

/** Default pilot shape: the measured-strong pair together, the measured-weak pair together. */
export const DEFAULT_LENS_GROUPS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['concurrency-races', 'state-transitions']),
  Object.freeze(['writer-reader-contracts', 'error-and-edge-classification']),
]);

/** Stable id for a group — sorted, so `a,b` and `b,a` are the SAME group everywhere (state-file
 * name, cache key, progress label). Mirrors `lensPath` in the correctness checklist script. */
export const lensGroupId = (group: readonly string[]): string => [...group].sort().join('+');

/**
 * Parse `GUARD_CORRECTNESS_SPLIT` into lens groups, or null when the split is off.
 *
 * Accepted: unset/`0`/`off` → null (monolith, the default) · `1`/`on` → DEFAULT_LENS_GROUPS · an
 * explicit spec `a,b|c,d` → those groups. An explicit spec must be a PARTITION of the four lenses:
 * a missing lens would silently stop being reviewed — a correctness lens dropping out of a BLOCKING
 * gate is exactly the blindness this reviewer exists to prevent — and a duplicated one would
 * double-judge the same class. Both throw rather than degrade.
 */
export function resolveLensGroups(
  raw = process.env.GUARD_CORRECTNESS_SPLIT,
): readonly (readonly string[])[] | null {
  const spec = String(raw ?? '').trim();
  if (spec === '' || spec === '0' || spec.toLowerCase() === 'off') return null;
  if (spec === '1' || spec.toLowerCase() === 'on') return DEFAULT_LENS_GROUPS;
  const groups = spec
    .split('|')
    .map((g) =>
      g
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .filter((g) => g.length > 0);
  const flat = groups.flat();
  const known = new Set<string>(CORRECTNESS_LENSES);
  const unknown = flat.filter((l) => !known.has(l));
  if (unknown.length > 0)
    throw new Error(
      `GUARD_CORRECTNESS_SPLIT: unknown lens ${unknown.join(', ')} — expected a subset of ${CORRECTNESS_LENSES.join(', ')}`,
    );
  if (new Set(flat).size !== flat.length)
    throw new Error('GUARD_CORRECTNESS_SPLIT: a lens may appear in only one group');
  if (flat.length !== CORRECTNESS_LENSES.length)
    throw new Error(
      `GUARD_CORRECTNESS_SPLIT: every lens must appear exactly once (missing ${CORRECTNESS_LENSES.filter((l) => !flat.includes(l)).join(', ') || 'none'})`,
    );
  return Object.freeze(groups.map((g) => Object.freeze(g)));
}

/** A per-group clone. Only the state file and the checklist commands become group-scoped — see the
 * module header on why the name must not. */
export function deriveLensReviewer(
  reviewer: ChecklistReviewer,
  group: readonly string[],
): ChecklistReviewer {
  const arg = `--lens ${[...group].sort().join(',')}`;
  return Object.freeze({
    ...reviewer,
    lens: group,
    stateFile: `.claude/.correctness-review-${lensGroupId(group)}.json`,
    cmds: Object.freeze({
      gen: `${reviewer.cmds.gen} ${arg}`,
      check: `${reviewer.cmds.check} ${arg}`,
      fin: `${reviewer.cmds.fin ?? 'finalize'} ${arg}`,
    }),
  }) as ChecklistReviewer;
}

/**
 * The mandatory-checklist paragraph of a judge prompt.
 *
 * Deferring to the brief is safe ONLY for an undivided reviewer: agents/correctness-reviewer.md
 * spells out bare generate/check-item/finalize with NO `--lens`, so lens judges following it would
 * every one write the same un-lensed artifact, clobber each other, and leave every group-scoped
 * artifact missing — a guaranteed contract retry then error. A lens judge therefore gets the exact
 * commands spelled out even in review mode. The un-split text is byte-stable on purpose: the
 * monolith is the A/B's control arm and must stay comparable to its own history.
 */
export function checklistContractFor(
  reviewer: ChecklistReviewer,
  script: string,
  assetRoot?: string,
): string {
  const steps =
    `1. \`node ${script} ${reviewer.cmds.gen}\` — enumerates the review items for this diff.\n` +
    `2. Review each item against the brief, then mark it: \`node ${script} ${reviewer.cmds.check} <name> --pass\` or \`--fail "<reason>"\`. Every item, one at a time — no batch claims.\n` +
    `3. \`node ${script} ${reviewer.cmds.fin ?? 'finalize'}\` — refuses if any item is unresolved.\n`;
  if (reviewer.lens)
    return (
      "MANDATORY CHECKLIST WORKFLOW — use EXACTLY these commands (they scope the checklist to your lens group and keep your artifact separate from the other judges'; ignore any un-scoped command lines in the brief):\n" +
      steps
    );
  if (assetRoot)
    return 'The reviewer brief owns checklist enumeration and the exact generate/check/finalize commands. That workflow is mandatory and its resulting artifact is independently verified by the gate.\n';
  return `MANDATORY CHECKLIST WORKFLOW — this stops coverage hallucination and is independently verified:\n${steps}`;
}

/**
 * Rejoin one reviewer's lens-group outcomes into the single result the rest of the gate reasons
 * about. Pure, and shared by the gate AND the bench so the two can never drift on what a split
 * verdict MEANS — the bench exists to predict the gate.
 *
 * Status takes the worst outcome: one failing lens blocks, which is not a new rule but the existing
 * one restated across artifacts (verifyChecklist already voids a PASS when any single item failed).
 * Reasons from non-passing groups are joined so the blocking lens is named; items and waivers
 * concatenate, preserving the per-lens vector gate-verdict-attribution requires — passes included.
 */
export function mergeLensOutcomes<
  T extends {
    status: string;
    name: string;
    escalated?: boolean;
    reason?: string;
    items?: unknown[];
    waivers?: unknown[];
  },
>(parts: readonly T[], name: string): T {
  if (parts.length === 0) throw new Error('mergeLensOutcomes: no lens groups to merge');
  const worst =
    parts.find((p) => p.status === 'fail') ??
    parts.find((p) => p.status === 'error') ??
    parts.find((p) => p.status === 'inconclusive') ??
    parts[0];
  return {
    ...worst,
    name,
    escalated: parts.some((p) => p.escalated),
    reason:
      parts
        .filter((p) => p.status !== 'pass' && p.reason)
        .map((p) => p.reason)
        .join(' · ') || worst.reason,
    items: parts.flatMap((p) => p.items ?? []),
    waivers: parts.flatMap((p) => p.waivers ?? []),
  };
}

type LensPart = {
  res: { status: string; name: string; transcript?: string; model?: string; items?: unknown[] };
  secs: number;
  diffText: string;
};

/**
 * Emit the ONE review_result row per split reviewer that gate-verdict-attribution pairs with the
 * scope row. `secs` SUMS across groups — the honest cost of the split is the total judge time it
 * spent, not its wall-clock — while the item vectors concatenate so per-lens production rates stay
 * joinable across the flag.
 */
export function emitMergedLensResults(
  splitParts: Map<string, LensPart[]>,
  firstModel: string,
): void {
  for (const [name, parts] of splitParts) {
    const merged = mergeLensOutcomes(
      parts.map((p) => p.res),
      name,
    ) as LensPart['res'] & { reason?: string; escalated?: boolean; waivers?: unknown[] };
    const transcript = parts
      .filter((p) => p.res.transcript)
      .map((p) => p.res.transcript)
      .join('\n\n');
    const transcriptRef = transcript
      ? saveTranscript(`review-${name}`, composeTranscript(parts[0].diffText, transcript))
      : null;
    emitGateEvent({
      type: 'review_result',
      reviewer: name,
      status: merged.status,
      escalated: Boolean(merged.escalated),
      model: merged.model ?? firstModel,
      reason: merged.reason,
      secs: parts.reduce((sum, p) => sum + p.secs, 0),
      ...(merged.waivers?.length ? { waivers: merged.waivers } : {}),
      ...itemFields(merged as never),
      ...(transcriptRef ? { transcript_ref: transcriptRef } : {}),
    });
  }
}

export type ReviewTask = {
  sel: ReviewerSelection;
  key: string;
  diffText: string;
  splitOf?: string;
  group?: string;
  /** The UNDIVIDED selection this task came from. Asset identity is pre-computed per reviewer NAME
   * from the table entry, and hashReviewerIdentity hashes JSON.stringify(reviewer) — so verifying a
   * derived clone against it always mismatches and would flip every split PASS to `error` in review
   * mode. The on-disk assets are identical either way, so the base selection is what to verify. */
  base: ReviewerSelection;
};

/** Progress label. Group-qualified so a fanned-out reviewer's unfinished groups are named
 * individually — with a bare name repeated N times, `running − completed` could not say WHICH
 * group is still owed. */
export const taskLabel = (t: { sel: ReviewerSelection; group?: string }): string =>
  t.group ? `${t.sel.reviewer.name} [${t.group}]` : t.sel.reviewer.name;

/** Park a split group's outcome until every group of that reviewer has landed. */
export function holdLensPart(
  parts: Map<string, LensPart[]>,
  reviewer: string,
  part: LensPart,
  label: string,
): void {
  const held = parts.get(reviewer) ?? [];
  held.push(part);
  parts.set(reviewer, held);
  console.error(`guard-review: ${label} — ${part.res.status.toUpperCase()} in ${part.secs}s`);
}

/**
 * Decide what actually has to be judged, before any judge runs.
 *
 * A split reviewer fans out into one task per LENS GROUP, flattened into the SAME flat task list
 * as everyone else rather than nested inside one concurrency slot — so the cap still bounds total
 * judges in flight, each group's PASS checkpoints independently (a killed ship re-pays only the
 * unfinished groups), and the group rides the cache key so flipping GUARD_CORRECTNESS_SPLIT can
 * never serve one mode's cached verdict to the other.
 *
 * Exactly ONE scope row per reviewer regardless of fan-out (gate-verdict-attribution pairs it with
 * one review_result), and a reviewer counts as a cache HIT only when EVERY one of its groups was.
 */
export function planReviewWork(
  selected: ReviewerSelection[],
  diffs: string[],
  cache: Record<string, { at?: string; [k: string]: unknown }>,
  salts: Map<string, string>,
  keyOf: (name: string, diff: string, salt: string) => string,
  groups = resolveLensGroups(),
): {
  tasks: ReviewTask[];
  scope: { sel: ReviewerSelection; diff: string; cached: boolean }[];
  fullyCached: { name: string; duration: number; model: unknown }[];
  cachedLines: string[];
  splitParts: Map<string, LensPart[]>;
} {
  const tasks: ReviewTask[] = [];
  const scope: { sel: ReviewerSelection; diff: string; cached: boolean }[] = [];
  const fullyCached: { name: string; duration: number; model: unknown }[] = [];
  const cachedLines: string[] = [];
  // Pre-seeded with any group whose PASS was already checkpointed, so a resumed run still emits the
  // FULL per-lens vector — without this the merged row silently omits the cached groups' items.
  const splitParts = new Map<string, LensPart[]>();
  for (let i = 0; i < selected.length; i++) {
    const sel = selected[i];
    const name = sel.reviewer.name;
    const salt = salts.get(name) ?? '';
    const split = groups && name === 'correctness-reviewer' && sel.reviewer.skill ? groups : null;
    const parts: ReviewTask[] = split
      ? split.map((g) => ({
          sel: { ...sel, reviewer: deriveLensReviewer(sel.reviewer as ChecklistReviewer, g) },
          key: keyOf(name, diffs[i], `${salt}|split:${lensGroupId(g)}`),
          diffText: diffs[i],
          splitOf: name,
          group: lensGroupId(g),
          base: sel,
        }))
      : [{ sel, key: keyOf(name, diffs[i], salt), diffText: diffs[i], base: sel }];
    const allCached = parts.every((p) => Boolean(cache[p.key]));
    scope.push({ sel, diff: diffs[i], cached: allCached });
    if (allCached) {
      const duration = parts.reduce<number>((sum, p) => {
        const d = cache[p.key].duration_ms;
        return sum + (typeof d === 'number' ? d : 0);
      }, 0);
      fullyCached.push({ name, duration, model: cache[parts[0].key].model });
      cachedLines.push(`guard-review: ${name} — cached PASS (identical diff)`);
      continue;
    }
    for (const p of parts) {
      if (!cache[p.key]) {
        tasks.push(p);
        continue;
      }
      cachedLines.push(`guard-review: ${taskLabel(p)} — cached PASS (identical)`);
      if (!p.splitOf) continue;
      const items = cache[p.key].items;
      const held = splitParts.get(p.splitOf) ?? [];
      held.push({
        res: { status: 'pass', name, items: Array.isArray(items) ? items : [] } as LensPart['res'],
        secs: 0,
        diffText: p.diffText,
      });
      splitParts.set(p.splitOf, held);
    }
  }
  return { tasks, scope, fullyCached, cachedLines, splitParts };
}

/** Arm suffix for a bench section key — empty unless THIS reviewer is being split, so every
 * existing baseline key stays byte-identical and the monolith stays comparable to its history. */
export function lensArmSuffix(reviewerName: string, groups = resolveLensGroups()): string {
  return groups && reviewerName === 'correctness-reviewer'
    ? `@split:${groups.map(lensGroupId).join('_')}`
    : '';
}

/** Run one cascade per lens group over the same fixture and rejoin with the gate's own merge, so a
 * bench verdict predicts a gate verdict rather than approximating it. Serial: the bench already
 * parallelises across ROWS, and nesting a second fan-out would blow past its concurrency budget. */
export async function runLensCascades<R extends { status: string; name: string }>(
  sel: ReviewerSelection,
  groups: readonly (readonly string[])[],
  run: (s: ReviewerSelection) => Promise<R>,
): Promise<R> {
  const parts: R[] = [];
  for (const g of groups)
    parts.push(
      await run({ ...sel, reviewer: deriveLensReviewer(sel.reviewer as ChecklistReviewer, g) }),
    );
  return mergeLensOutcomes(parts as never, sel.reviewer.name) as R;
}

/** Run a reviewer's cascade, fanning out per lens group when THIS reviewer is being split. The
 * split decision lives here so callers stay one call — the bench and the gate must never disagree
 * about whether a given run was split. */
export async function runReviewerCascade<R extends { status: string; name: string }>(
  sel: ReviewerSelection,
  run: (s: ReviewerSelection) => Promise<R>,
  groups = resolveLensGroups(),
): Promise<R> {
  return groups && sel.reviewer.name === 'correctness-reviewer'
    ? runLensCascades(sel, groups, run)
    : run(sel);
}

type SpyCapture = {
  label: string;
  out?: string;
  ms?: number;
  snapshot?: unknown;
  synthetic?: boolean;
};

// Tolerates the same markdown dressing around the verdict token that parseReviewVerdict allows.
const CAPTURE_FAIL_RE = /VERDICT:\s*\**\s*FAIL\b/i;

/**
 * Merge the per-group spy captures a split arm produces into the ONE entry bench scoring expects.
 *
 * `deriveLensReviewer` deliberately keeps the reviewer NAME, so every lens group's judge pass is
 * captured under the SAME label — a `.find()` would silently score only the first group and drop
 * the other's verdict and artifact. The merged entry takes the worst verdict (any group's FAIL
 * blocks, matching the gate's own merge) and the UNION of the groups' checklist items, so
 * right-reason attribution still sees every failed lens. 0 or 1 entries pass straight through, so
 * the un-split path is byte-for-byte the previous `.find()` behaviour.
 */
export function mergeLensCaptures(entries: readonly SpyCapture[]): SpyCapture | undefined {
  if (entries.length < 2) return entries[0];
  const failing = entries.find((e) => CAPTURE_FAIL_RE.test(String(e.out ?? '')));
  const items = entries.flatMap((e) => {
    const snap = e.snapshot as { items?: unknown[] } | null;
    return Array.isArray(snap?.items) ? snap.items : [];
  });
  return {
    label: entries[0].label,
    out: (failing ?? entries[0]).out,
    ms: entries.reduce<number>((sum, e) => sum + (typeof e.ms === 'number' ? e.ms : 0), 0),
    snapshot: { items },
    synthetic: entries.every((e) => e.synthetic),
  };
}

// Bounded-concurrency map: at most `limit` fn calls in flight, input order preserved.
// LOAD-BEARING: fn must never reject — the caller pre-wraps the cascade body in .catch. A worker
// rejection here would reject Promise.all and abandon siblings' pending per-completion checkpoints.
// ponytail: static pool. Load-adaptive sizing (os.loadavg / live concurrent-`claude` count) is the
// upgrade path if one fixed cap ever proves too blunt across differently-loaded machines.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
