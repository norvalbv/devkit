/**
 * Recall-suite scoring: pure, deterministic, no I/O, no model.
 *
 * The five ways retrieval fails are scored against FIVE SEPARATE DENOMINATORS and never pooled into
 * a headline number. That is not fastidiousness — the failures have opposite fixes, and a single
 * score lets one mask another:
 *
 *   (a) the right axis is never returned          → Containment    (answerable cases)
 *   (b) it is returned but buried under noise     → Buried         (cases where it WAS contained)
 *   (c) a stale ruling is returned as if live     → CSA / SFER     (CURRENT_STATE cases)
 *   (d) it answers when nothing rules             → FANR / FAR     (a 2x2, never blended)
 *   (e) a question needs N axes and gets some     → SetRecall / PartialRecall (MULTI cases)
 *
 * Scoring is set arithmetic and substring matching over the CLI's `--json` envelope, so a full run
 * costs zero tokens and is CI-affordable — unlike the judge suites, which is the whole reason this
 * one can gate per-commit.
 */

/** A case's declared shape. `gold` is empty iff type is ABSTAIN — enforced by the corpus lint. */
export const CASE_TYPES = ['SINGLE', 'MULTI', 'ABSTAIN', 'CURRENT_STATE'] as const;
export type CaseType = (typeof CASE_TYPES)[number];

/** Per-case outcome. ERROR is its own bucket: excluded everywhere, never scored as a miss. */
export type Outcome =
  | 'HIT'
  | 'MISS'
  | 'ABSTAINED_CORRECTLY'
  | 'FALSE_ANSWER'
  | 'FALSE_ABSTAIN'
  | 'ERROR';

export interface RecallCase {
  id: string;
  q: string;
  type: CaseType;
  gold: string[];
  goldRequired?: string[];
  distractors?: string[];
  currentState?: {
    axis: string;
    liveId: string;
    staleId: string;
    mustSurface: string[];
    mustNotAssert: string[];
  };
}

/** The slice of the `--json` envelope scoring depends on. */
export interface Envelope {
  state: 'RULED' | 'NO_RULING';
  rows: {
    rank: number;
    slug: string;
    score: number;
    liveRulingId: string | null;
    ruling: string;
  }[];
}

export interface Scored {
  id: string;
  type: CaseType;
  outcome: Outcome;
  /** Rank of the first gold axis, or null when none was returned. */
  goldRank: number | null;
  buriedByRank: boolean;
  buriedByDistractor: boolean;
  partialRecall: number | null;
  setRecall: boolean | null;
  csa: boolean | null;
  sfer: boolean | null;
}

/**
 * An empty row set IS an abstain, whatever `state` says.
 *
 * Deliberately not `state === 'NO_RULING'`: keying on the label alone would let a retriever dodge
 * the false-answer metric by returning `RULED` with zero rows. The observable behaviour — did the
 * caller get any axes — is what an agent actually experiences, so that is what is scored.
 */
export const abstained = (env: Envelope) => env.rows.length === 0;

const SUPERSESSION_MARKERS = ['superseded', 'no longer', 'reversed by', 'supersedes', 'contradict'];
/** How far from a stale claim a supersession marker still counts as qualifying it. */
const MARKER_WINDOW = 200;

/**
 * Score one case. `env` is null when the CLI exited non-zero or emitted unparseable JSON.
 *
 * Reason: the branches ARE the five-denominator contract — each case type routes to a different
 * metric family and collapsing them is exactly the pooling this suite exists to prevent.
 * fallow-ignore-next-line complexity
 */
export function scoreCase(c: RecallCase, env: Envelope | null): Scored {
  const base = {
    id: c.id,
    type: c.type,
    goldRank: null,
    buriedByRank: false,
    buriedByDistractor: false,
    partialRecall: null,
    setRecall: null,
    csa: null,
    sfer: null,
  } as Scored;

  if (!env) return { ...base, outcome: 'ERROR' };

  if (c.type === 'ABSTAIN') {
    return {
      ...base,
      outcome: abstained(env) ? 'ABSTAINED_CORRECTLY' : 'FALSE_ANSWER',
    };
  }

  // A false abstain on an answerable case is counted TWICE on purpose: once here as its own event,
  // and once as a Containment miss below. Telling an agent "nothing is decided" when a ruling
  // exists makes it mint a contradicting decision, so the error must be visible in the recall table
  // too — never laundered into looking like a safe outcome.
  if (abstained(env)) return { ...base, outcome: 'FALSE_ABSTAIN' };

  const returned = env.rows.map((r) => r.slug);
  const rankOf = (slug: string) => {
    const i = returned.indexOf(slug);
    return i === -1 ? null : i + 1;
  };
  const hits = c.gold.filter((g) => returned.includes(g));
  const goldRank = hits.length ? Math.min(...hits.map((g) => rankOf(g) as number)) : null;

  if (c.type === 'MULTI') {
    const required = c.goldRequired?.length ? c.goldRequired : c.gold;
    const found = required.filter((g) => returned.includes(g));
    return {
      ...base,
      outcome: found.length ? 'HIT' : 'MISS',
      goldRank,
      // Macro-averaged by the caller across MULTI cases — never micro-pooled, or one 10-axis
      // question would outweigh several 2-axis ones.
      partialRecall: found.length / required.length,
      setRecall: found.length === required.length,
    };
  }

  if (c.type === 'CURRENT_STATE') return scoreCurrentState(c, env, base, goldRank);

  return {
    ...base,
    outcome: goldRank === null ? 'MISS' : 'HIT',
    goldRank,
    // Buried is CONDITIONAL on containment, which is what keeps failure (a) and (b) distinct: a
    // case that returned nothing is a Containment miss and is simply absent from this denominator,
    // rather than also counting as "not buried" and flattering the rank metric.
    buriedByRank: goldRank !== null && goldRank > 1,
    buriedByDistractor:
      goldRank !== null &&
      (c.distractors ?? []).some((d) => {
        const dr = rankOf(d);
        return dr !== null && dr < goldRank;
      }),
  };
}

/**
 * CURRENT_STATE is three independent conditions, all required for CSA:
 *   (i)   the axis is returned at all           — otherwise it is a Containment problem, not staleness
 *   (ii)  the returned block IS the live one    — structural, off liveRulingId, never inferred
 *   (iii) the answer surfaces the live content and does not assert the stale ruling unqualified
 *
 * SFER counts (iii)-only failures — the stale ruling stated as if current, which is the specific
 * harm: an agent acts on a ruling that later notes already falsified.
 */
function scoreCurrentState(
  c: RecallCase,
  env: Envelope,
  base: Scored,
  goldRank: number | null,
): Scored {
  const cs = c.currentState;
  const row = cs ? env.rows.find((r) => r.slug === cs.axis) : undefined;
  if (!cs || !row) return { ...base, outcome: 'MISS', goldRank, csa: false, sfer: false };

  const liveBlockReturned = row.liveRulingId === cs.liveId;
  const text = row.ruling;
  const surfaced = cs.mustSurface.every((s) => text.toLowerCase().includes(s.toLowerCase()));
  const assertsStale = cs.mustNotAssert.some((s) => assertedUnqualified(text, s));

  return {
    ...base,
    outcome: 'HIT',
    goldRank,
    csa: liveBlockReturned && surfaced && !assertsStale,
    sfer: assertsStale,
  };
}

/** True when `claim` appears WITHOUT a supersession marker within MARKER_WINDOW chars of it. */
function assertedUnqualified(text: string, claim: string) {
  const hay = text.toLowerCase();
  const at = hay.indexOf(claim.toLowerCase());
  if (at === -1) return false;
  const around = hay.slice(Math.max(0, at - MARKER_WINDOW), at + claim.length + MARKER_WINDOW);
  return !SUPERSESSION_MARKERS.some((m) => around.includes(m));
}

export interface RecallSummary {
  containment: Record<'SINGLE' | 'MULTI', { hit: number; total: number }>;
  buried: { rank: number; distractor: number; total: number };
  abstention: { fanr: { bad: number; total: number }; far: { bad: number; total: number } };
  multi: { setRecall: { hit: number; total: number }; partialRecall: number | null };
  currentState: { csa: { hit: number; total: number }; sfer: { bad: number; total: number } };
  errors: number;
  rows: Record<string, { outcome: Outcome; goldRank: number | null }>;
}

/** Aggregate scored cases into the five independent metric families. */
export function summarize(scored: Scored[]): RecallSummary {
  const live = scored.filter((s) => s.outcome !== 'ERROR');
  const answerable = live.filter((s) => s.type !== 'ABSTAIN');
  const contained = (t: CaseType) => live.filter((s) => s.type === t);
  const hitCount = (t: CaseType) => contained(t).filter((s) => s.outcome === 'HIT').length;

  const buriedPool = live.filter((s) => s.type === 'SINGLE' && s.goldRank !== null);
  const multi = live.filter((s) => s.type === 'MULTI');
  const cs = live.filter((s) => s.type === 'CURRENT_STATE');
  const partials = multi.map((s) => s.partialRecall ?? 0);

  return {
    containment: {
      SINGLE: { hit: hitCount('SINGLE'), total: contained('SINGLE').length },
      MULTI: { hit: hitCount('MULTI'), total: multi.length },
    },
    buried: {
      rank: buriedPool.filter((s) => s.buriedByRank).length,
      distractor: buriedPool.filter((s) => s.buriedByDistractor).length,
      total: buriedPool.length,
    },
    abstention: {
      fanr: {
        bad: live.filter((s) => s.outcome === 'FALSE_ANSWER').length,
        total: contained('ABSTAIN').length,
      },
      far: {
        bad: answerable.filter((s) => s.outcome === 'FALSE_ABSTAIN').length,
        total: answerable.length,
      },
    },
    multi: {
      setRecall: { hit: multi.filter((s) => s.setRecall).length, total: multi.length },
      partialRecall: partials.length ? partials.reduce((a, b) => a + b, 0) / partials.length : null,
    },
    currentState: {
      csa: { hit: cs.filter((s) => s.csa).length, total: cs.length },
      sfer: { bad: cs.filter((s) => s.sfer).length, total: cs.length },
    },
    errors: scored.length - live.length,
    rows: Object.fromEntries(live.map((s) => [s.id, { outcome: s.outcome, goldRank: s.goldRank }])),
  };
}
