// critique-eval MATCHER — maps the critic's open-ended findings onto a row's labelled slots.
//
// The feature-critique agent emits free-text Critical Issues / Warnings in its report file, so the
// bench cannot confusion-matrix them. The unit of truth is the SLOT: a gold flaw the critic must
// surface, or a decoy it must not raise as a blocker. This module owns the findings→slots pipeline:
// deterministic report parsing, one FORCED-CHOICE LLM question per slot, majority voting, pure
// scoring, and the audit kappa.
//
// The bounded-concurrency mapping, per-slot voting, forced-choice reply parsing, and the K-vote
// runner + audit kappa are shared with completeness-eval and conventions-eval via
// gate-engine/judge/matcher-core.mts (this was the extraction trigger: the third consumer arrived).
//
// Critique-specific and NOT shared: parseReportFindings (the report-md shape), the prompt nouns,
// and the decoy severity rule — a decoy matched by a WARNING is the critic hedging (allowed, shown
// informationally); only a decoy raised as a CRITICAL blocker scores against it. The matcher stays
// severity-blind (prompts never reveal tiers); the rule is applied in pure scoring.
//
// Everything except `runMatcher`'s claude call is pure and unit-tested without spawning anything.

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

export type { MatcherOptions, SlotOutcome };
export { kappa, MATCH_TIMEOUT_MS, mapPool, parseSlotReply, voteSlot };

export type FindingSeverity = 'CRITICAL' | 'WARNING';

export const CRITIQUE_CLASSES = [
  'feasibility',
  'ux',
  'security',
  'codebase-conflict',
  'data-flow',
  'runtime-config',
  'missing-consideration',
] as const;
export type CritiqueClass = (typeof CRITIQUE_CLASSES)[number];

/** One parsed report finding: a numbered item under `## Critical Issues` / `## Warnings`. */
export interface Finding {
  severity: FindingSeverity;
  /** The item's bold title (or first line when untitled). */
  desc: string;
  /** The item's sub-lines (Problem/Evidence/Impact/…), joined — matcher context. */
  body: string;
}

/** A flaw the critic MUST surface. `severity` is the target tier for calibration (withheld from
 * the matcher); `class` drives the per-class recall table (never averaged away). */
export interface GoldSlot {
  id: string;
  class: CritiqueClass;
  severity: FindingSeverity;
  desc: string;
}

/** A sound aspect the critic must NOT raise as a blocker: a deliberate design choice, a recorded
 * decision it would be re-litigating, or an explicitly out-of-scope item. */
export interface DecoySlot {
  id: string;
  kind: 'sound-choice' | 'recorded-decision' | 'out-of-scope';
  desc: string;
}

// ─── Deterministic report parsing ─────────────────────────────────────────────────

// Section heads per the md's report template ("## Critical Issues (Blockers)" / "## Warnings
// (Non-blocking but significant)") — tolerant of the parenthetical being dropped.
const SECTION_RE = /^##\s+(critical issues|warnings)\b.*$/gim;
// A finding item is a NUMBERED entry (the template's shape) or a bold-titled bullet (observed
// drift). A plain `- Problem: …` sub-bullet is detail, not a new finding — it attaches as body.
const NUMBERED_ITEM_RE = /^\s*\d+[.)]\s+(?:\*\*(.+?)\*\*.*|(.+?))\s*$/;
const BOLD_BULLET_RE = /^\s*[-*]\s+\*\*(.+?)\*\*.*$/;
const MAX_BODY_LINES = 8;

/**
 * Parse the full report md into findings. Deterministic — the LLM matcher only ever sees this
 * parsed list, so a parser bug can't be blamed on the critic. An absent/empty section parses to
 * zero findings of that tier (which the contract check reconciles against the summary's counts).
 */
export function parseReportFindings(report: string): Finding[] {
  const findings: Finding[] = [];
  const text = String(report);
  const sections = [...text.matchAll(SECTION_RE)];
  for (let s = 0; s < sections.length; s += 1) {
    const severity: FindingSeverity = sections[s][1].toLowerCase().startsWith('critical')
      ? 'CRITICAL'
      : 'WARNING';
    const start = sections[s].index + sections[s][0].length;
    const end = text.indexOf('\n## ', start);
    const body = text.slice(start, end === -1 ? undefined : end);
    let current: Finding | null = null;
    for (const rawLine of body.split('\n')) {
      const m = rawLine.match(NUMBERED_ITEM_RE) ?? rawLine.match(BOLD_BULLET_RE);
      if (m) {
        current = { severity, desc: (m[1] ?? m[2]).trim(), body: '' };
        findings.push(current);
        continue;
      }
      const trimmed = rawLine.trim();
      if (current && trimmed && current.body.split('\n').filter(Boolean).length < MAX_BODY_LINES)
        current.body = current.body ? `${current.body}\n${trimmed}` : trimmed;
    }
  }
  return findings;
}

// ─── Per-slot forced-choice prompts ───────────────────────────────────────────────

function numberedFindings(findings: Finding[]): string {
  return findings
    .map(
      (f, i) =>
        `F${i + 1} (${f.severity}): ${f.desc}${f.body ? ` — ${f.body.replaceAll('\n', ' ')}` : ''}`,
    )
    .join('\n');
}

/** Gold question: does any finding identify the SAME underlying flaw? Target severity/class are
 * withheld — calibration must come from the critic's emitted tier. */
export function buildGoldPrompt(slot: GoldSlot, findings: Finding[]): string {
  return (
    'You are a strict FINDINGS MATCHER for a pre-implementation-critique benchmark. The critic\n' +
    'emitted the numbered FINDINGS below about a proposal. Decide whether any finding identifies\n' +
    'the SAME underlying flaw as the GOLD FLAW — the same root problem, the same implied remedy.\n' +
    'Different wording, severity, or detail of the same flaw IS a match. The same file or topic\n' +
    'with a DIFFERENT problem is NOT a match. Do not force a match.\n\n' +
    `FINDINGS:\n${numberedFindings(findings)}\n\n` +
    `GOLD FLAW: ${slot.desc}\n\n` +
    'Reply with EXACTLY one line and nothing else:\n' +
    'SLOT: F<number>   (the single finding that best covers the gold flaw)\n' +
    'SLOT: NONE        (no finding covers it)'
  );
}

/** Decoy question: does any finding object to the thing the critic should leave alone? Severity-
 * blind by design — scoring applies the blocker-tier rule. */
export function buildDecoyPrompt(slot: DecoySlot, findings: Finding[]): string {
  return (
    'You are a strict FINDINGS MATCHER for a pre-implementation-critique benchmark. The critic\n' +
    'emitted the numbered FINDINGS below about a proposal. The DECOY describes a SOUND aspect of\n' +
    'the proposal (a deliberate design choice, a recorded decision, or an explicitly out-of-scope\n' +
    'item) that a good critic leaves alone. Decide whether any finding raises the decoy itself as\n' +
    'a problem with the proposal. A finding that merely MENTIONS the topic while flagging a\n' +
    'different, genuine flaw does NOT count. Do not force a match.\n\n' +
    `FINDINGS:\n${numberedFindings(findings)}\n\n` +
    `DECOY: ${slot.desc}\n\n` +
    'Reply with EXACTLY one line and nothing else:\n' +
    'SLOT: F<number>   (the finding that objects to the decoy)\n' +
    'SLOT: NONE        (no finding objects to it — the critic left it alone)'
  );
}

// ─── Matcher runs (the only claude-calling code in this module) ───────────────────

/**
 * Ask every slot question for one run's findings via the shared matcher-core engine — only the
 * prompt-building (buildGoldPrompt/buildDecoyPrompt) is critique-specific. Zero findings
 * short-circuits deterministically (all gold missed, all decoys clean) — no claude call.
 */
export async function runMatcher(
  gold: GoldSlot[],
  decoys: DecoySlot[],
  findings: Finding[],
  opts: MatcherOptions = {},
): Promise<SlotOutcome[]> {
  const slots: SlotQuestion[] = [
    ...gold.map((s) => ({
      slotId: s.id,
      kind: 'gold' as const,
      prompt: buildGoldPrompt(s, findings),
    })),
    ...decoys.map((s) => ({
      slotId: s.id,
      kind: 'decoy' as const,
      prompt: buildDecoyPrompt(s, findings),
    })),
  ];
  return runSlotQuestions(slots, findings.length, {
    labelPrefix: 'critique-eval',
    exec: execJudgeAsync,
    ...opts,
  });
}

// ─── Pure scoring ─────────────────────────────────────────────────────────────────

export interface CaseScore {
  /** Per-slot results, keyed into the baseline row map as `<rowId>::<slotId>`. */
  slots: {
    slotId: string;
    kind: 'gold' | 'decoy';
    ok: boolean;
    /** gold: hit|miss · decoy: flagged (raised as CRITICAL — the failure) | mentioned (raised as
     * WARNING — allowed hedging, informational) | clean. */
    got: 'hit' | 'miss' | 'flagged' | 'mentioned' | 'clean';
    class?: CritiqueClass;
    stable: boolean;
    outage: boolean;
  }[];
  /** want×got severity pairs for HIT gold slots only (missed flaws have no emitted tier). */
  severity: { slotId: string; expected: FindingSeverity; got: FindingSeverity }[];
  /** 1-based indices of CRITICAL findings no GOLD slot claimed. On a decoy-only row (empty gold)
   * these are fabricated blockers by construction — the measured false-alarm instrument. On rows
   * with gold they are directional only (gold is not exhaustive). */
  fabricatedCriticals: number[];
  findingCount: number;
}

export function scoreCase(
  gold: GoldSlot[],
  // Kept for signature parity with the sc-1058 matcher (decoy identity travels in `outcomes`).
  _decoys: DecoySlot[],
  findings: Finding[],
  outcomes: SlotOutcome[],
): CaseScore {
  const goldClaimed = new Set<number>();
  const slots: CaseScore['slots'] = [];
  const severity: CaseScore['severity'] = [];
  for (const o of outcomes) {
    if (o.kind === 'gold') {
      if (o.match > 0) goldClaimed.add(o.match);
      const hit = o.match > 0;
      const g = gold.find((s) => s.id === o.slotId);
      slots.push({
        slotId: o.slotId,
        kind: 'gold',
        ok: hit,
        got: hit ? 'hit' : 'miss',
        class: g?.class,
        stable: o.stable,
        outage: o.outage,
      });
      if (hit && g) {
        const emitted = findings[o.match - 1]?.severity;
        if (emitted) severity.push({ slotId: g.id, expected: g.severity, got: emitted });
      }
    } else {
      // The blocker-tier rule: a WARNING touching a decoy is hedging, not a false alarm.
      const matchedSeverity = o.match > 0 ? findings[o.match - 1]?.severity : undefined;
      const flagged = matchedSeverity === 'CRITICAL';
      slots.push({
        slotId: o.slotId,
        kind: 'decoy',
        ok: !flagged,
        got: flagged ? 'flagged' : o.match > 0 ? 'mentioned' : 'clean',
        stable: o.stable,
        outage: o.outage,
      });
    }
  }
  const fabricatedCriticals = findings
    .map((f, i) => ({ f, n: i + 1 }))
    .filter(({ f, n }) => f.severity === 'CRITICAL' && !goldClaimed.has(n))
    .map(({ n }) => n);
  return { slots, severity, fabricatedCriticals, findingCount: findings.length };
}
