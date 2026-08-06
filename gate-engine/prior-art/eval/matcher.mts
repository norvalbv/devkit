// prior-art-eval MATCHER — maps the agent's open-ended evidence onto a row's labelled slots.
//
// The unit of truth is the SLOT: a gold prior-art finding the agent must surface as evidence, or a
// within-frame decoy fix it must not endorse as the way forward. The bounded-concurrency mapping,
// per-slot voting, forced-choice reply parsing, and the K-vote runner + audit kappa come from
// gate-engine/judge/matcher-core.mts (shared engine). The prompt nouns below are DELIBERATELY this
// suite's own copies — each suite owns its buildGoldPrompt/buildDecoyPrompt (matcher-core.mts
// documents the split; critique, completeness, and conventions each carry theirs) so a judge-prompt
// change in one suite can never silently invalidate another suite's scorer hash.
//
// Everything except the matcher-core exec call is pure and unit-testable without spawning anything.

import {
  kappa,
  MATCH_TIMEOUT_MS,
  type MatcherOptions,
  mapPool,
  parseSlotReply,
  runSlotQuestions,
  type SlotOutcome,
  type SlotQuestion,
  voteSlot,
} from '../../judge/matcher-core.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { parsePriorArtResponse } from '../response-contract.mts';

export type { MatcherOptions, SlotOutcome };
export { kappa, MATCH_TIMEOUT_MS, mapPool, parseSlotReply, voteSlot };

/** A prior-art finding the agent MUST surface: the artifact/pattern that solves or dissolves the
 * problem. Matched against the response's evidence claims + summary. */
export interface GoldSlot {
  id: string;
  desc: string;
}

/** A within-frame fix the agent must NOT endorse as the way forward (a better heuristic, a tuned
 * timeout — the patch the frame invites). Matched against the suggested next step + summary. */
export interface DecoySlot {
  id: string;
  desc: string;
}

/** One projected item the matcher sees: an evidence claim, or the response's own conclusion. */
export interface ProjectedItem {
  desc: string;
  body: string;
}

/**
 * Project the closed prior_art JSON into the matcher's item list. Deterministic — the LLM matcher
 * only ever sees this projection. Item 1 is always the response's own CONCLUSION (verdict + next
 * step + summary) so a decoy endorsed in the conclusion is visible even with sparse evidence;
 * subsequent items are the evidence claims.
 */
export function projectResponse(raw: string): ProjectedItem[] {
  const response = parsePriorArtResponse(raw);
  if (!response.ok || response.value.status !== 'reviewed') return [];
  const value = response.value;
  const conclusion: ProjectedItem = {
    desc: `CONCLUSION (${value.verdict}): ${value.suggestedNextStep?.detail ?? ''}`,
    body: value.summary,
  };
  const evidence = value.evidence.map((item) => ({
    desc: item.claim,
    body: `Kind: ${item.kind} · Source: ${item.source}${item.quote ? ` · Quote: ${item.quote}` : ''}`,
  }));
  return [conclusion, ...evidence];
}

function numberedItems(items: ProjectedItem[]): string {
  return items
    .map(
      (item, i) =>
        `F${i + 1}: ${item.desc}${item.body ? ` — ${item.body.replaceAll('\n', ' ')}` : ''}`,
    )
    .join('\n');
}

/** Gold question: does any item identify the SAME prior-art finding — the same artifact, pattern,
 * or upstream fact, with the same implication for the problem? */
export function buildGoldPrompt(slot: GoldSlot, items: ProjectedItem[]): string {
  return (
    'You are a strict EVIDENCE MATCHER for a prior-art-research benchmark. The agent investigated\n' +
    'a problem and emitted the numbered ITEMS below (its conclusion, then its evidence claims).\n' +
    'Decide whether any item identifies the SAME prior-art finding as the GOLD FINDING — the same\n' +
    'existing artifact, pattern, or upstream fact, carrying the same implication for the problem.\n' +
    'Different wording or detail of the same finding IS a match. The same source cited for a\n' +
    'DIFFERENT finding is NOT a match. Do not force a match.\n\n' +
    `ITEMS:\n${numberedItems(items)}\n\n` +
    `GOLD FINDING: ${slot.desc}\n\n` +
    'Reply with EXACTLY one line and nothing else:\n' +
    'SLOT: F<number>   (the single item that best covers the gold finding)\n' +
    'SLOT: NONE        (no item covers it)'
  );
}

/** Decoy question: does the response ENDORSE the within-frame fix as its way forward? Mentioning
 * or refuting the fix does not count — only endorsement is the failure. */
export function buildDecoyPrompt(slot: DecoySlot, items: ProjectedItem[]): string {
  return (
    'You are a strict EVIDENCE MATCHER for a prior-art-research benchmark. The agent investigated\n' +
    'a problem and emitted the numbered ITEMS below (its conclusion, then its evidence claims).\n' +
    "The DECOY describes a WITHIN-FRAME fix — a patch that accepts the problem's framing instead\n" +
    'of questioning it. Decide whether any item ENDORSES the decoy as the recommended way forward.\n' +
    'An item that merely mentions the decoy, lists it as something already tried, or argues\n' +
    'AGAINST it does NOT count. Do not force a match.\n\n' +
    `ITEMS:\n${numberedItems(items)}\n\n` +
    `DECOY: ${slot.desc}\n\n` +
    'Reply with EXACTLY one line and nothing else:\n' +
    'SLOT: F<number>   (the item that endorses the decoy)\n' +
    'SLOT: NONE        (nothing endorses it)'
  );
}

/**
 * Ask every slot question for one run's projection via the shared matcher-core engine. Zero items
 * (invalid or non-reviewed response) short-circuits deterministically — all gold missed, all
 * decoys clean — with no claude call.
 */
export async function runMatcher(
  gold: GoldSlot[],
  decoys: DecoySlot[],
  items: ProjectedItem[],
  opts: MatcherOptions = {},
): Promise<SlotOutcome[]> {
  const slots: SlotQuestion[] = [
    ...gold.map((slot) => ({
      slotId: slot.id,
      kind: 'gold' as const,
      prompt: buildGoldPrompt(slot, items),
    })),
    ...decoys.map((slot) => ({
      slotId: slot.id,
      kind: 'decoy' as const,
      prompt: buildDecoyPrompt(slot, items),
    })),
  ];
  return runSlotQuestions(slots, items.length, {
    labelPrefix: 'prior-art-eval',
    exec: execJudgeAsync,
    ...opts,
  });
}

export interface CaseScore {
  slots: {
    slotId: string;
    kind: 'gold' | 'decoy';
    ok: boolean;
    got: 'hit' | 'miss' | 'endorsed' | 'clean';
    stable: boolean;
    outage: boolean;
  }[];
}

export function scoreCase(outcomes: SlotOutcome[]): CaseScore {
  return {
    slots: outcomes.map((outcome) => {
      if (outcome.kind === 'gold') {
        const hit = outcome.match > 0;
        return {
          slotId: outcome.slotId,
          kind: 'gold' as const,
          ok: hit,
          got: hit ? ('hit' as const) : ('miss' as const),
          stable: outcome.stable,
          outage: outcome.outage,
        };
      }
      const endorsed = outcome.match > 0;
      return {
        slotId: outcome.slotId,
        kind: 'decoy' as const,
        ok: !endorsed,
        got: endorsed ? ('endorsed' as const) : ('clean' as const),
        stable: outcome.stable,
        outage: outcome.outage,
      };
    }),
  };
}
