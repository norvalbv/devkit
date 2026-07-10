// conventions-eval MATCHER — maps the conventions-reviewer's open-ended VIOLATION/OFFENDING pairs
// onto a case's labelled slots.
//
// The conventions reviewer emits free-text violations (`VIOLATION: <quoted rule> — <path>:<line>`
// paired with `OFFENDING: <quoted line> — <path>:<line>`), so the bench cannot confusion-matrix its
// output directly. The unit of truth is the SLOT: a gold rule-violation the reviewer must surface,
// or a decoy it must not flag. This module owns the whole findings→slots pipeline: deterministic
// parsing of the reviewer transcript, one FORCED-CHOICE LLM question per slot, majority voting, and
// pure scoring.
//
// Per-slot forced choice, not one holistic list-to-list mapping call: decomposing a judge's task
// into per-item binary questions measurably raises judge–human agreement (TICK, arXiv:2410.03608).
// Each slot asks "does any emitted violation identify THIS same underlying rule violation — yes
// (which) or no?" and nothing else. Spurious findings fall out for free: a violation no slot claimed
// matched nothing.
//
// Unlike completeness/critique, a conventions finding has NO severity tier — the brief's contract
// is a flat quote-both-or-stay-silent gate, not a graded CRITICAL/IMPORTANT/LOW (or
// CRITICAL/WARNING) emission — so Finding/GoldSlot carry no severity field and scoreCase has no
// severity-calibration section.
//
// The bounded-concurrency mapping, per-slot voting, forced-choice reply parsing, and the K-vote
// runner + audit kappa are shared with completeness-eval and critique-eval via
// gate-engine/judge/matcher-core.mts (conventions-eval was the third-consumer extraction trigger
// named in sc-1058's own ticket). This file keeps only what's conventions-specific:
// Finding/GoldSlot/DecoySlot, transcript parsing (VIOLATION+OFFENDING pairing), the prompt nouns,
// and scoreCase's (severity-free) scoring rule.
//
// Everything except `runMatcher`'s claude call is pure and unit-testable without spawning anything.

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
} from '../../../judge/matcher-core.mts';
import { execJudgeAsync } from '../../../judge/run-judge.mts';

export type { MatcherOptions, SlotOutcome };
export { kappa, MATCH_TIMEOUT_MS, mapPool, parseSlotReply, voteSlot };

/** One parsed VIOLATION/OFFENDING pair from a conventions-reviewer transcript. No severity field —
 * conventions violations aren't severity-tiered (unlike completeness's CRITICAL/IMPORTANT/LOW or
 * critique's CRITICAL/WARNING); the brief's contract is flat quote-both-or-stay-silent. */
export interface Finding {
  /** The exact quoted rule text (VIOLATION's left half). */
  ruleQuote: string;
  /** `<CLAUDE.md path>:<line>` the rule was quoted from. */
  ruleLoc: string;
  /** The exact quoted offending line (OFFENDING's left half). */
  offendingLine: string;
  /** `<file path>:<line>` the offending line was quoted from. */
  offendingLoc: string;
}

/** A rule violation the reviewer MUST surface. `paths` are matcher hints only (not string-match
 * keys) — mirrors GoldSlot.paths in review/eval/matcher.mts. */
export interface GoldSlot {
  id: string;
  desc: string;
  paths?: string[];
}

/** A thing the reviewer must NOT flag: a recorded decision it would be re-litigating, a rule
 * scoped OUTSIDE the touched file's governing CLAUDE.md set (the scoping boundary the AC exists
 * to enforce), or code that merely resembles the anti-pattern but is working as intended. */
export interface DecoySlot {
  id: string;
  kind: 'recorded-decision' | 'out-of-scope' | 'working-as-intended';
  targetSlug?: string;
  desc: string;
}

// ─── Deterministic transcript parsing ─────────────────────────────────────────────

// Per the brief's contract (agents/conventions-reviewer.md): a VIOLATION line is ALWAYS
// immediately followed by its OFFENDING line — one pair per violation. Both lines share the same
// `<quoted text> — <path>:<line>` shape; the greedy `(.+)` backs off only as far as needed to let
// the trailing em-dash/path:line anchor match at the line's end. Tolerant of markdown dressing
// (`**VIOLATION**:`, `- OFFENDING:`) like review/eval/matcher.mts's FINDING_LINE_RE. Non-global
// (matched per-line via .match()) so pairing stays a simple sequential scan — no lastIndex
// bookkeeping.
//
// BLOCK-based, not single-line-regex: a live haiku baseline run (2026-07-09) surfaced real
// transcripts a strict `^…: (.+)[—–]\s*(\S+):(\d+)\s*$` regex silently drops, corrupting recall —
// (1) a line RANGE ("CLAUDE.md:6-7", "db/CLAUDE.md:3–4") instead of a single line number, (2) the
// rule location missing a line number entirely ("— packages/ui/CLAUDE.md"), (3) a parenthetical
// annotation before the path ("CLAUDE.md (repo root):2-3"), (4) a multi-line OFFENDING quote (a
// SQL CREATE TABLE block) whose "— path:line" trailer lands several physical lines after the
// "OFFENDING:" marker. Every one of these is a real, well-formed violation the reviewer correctly
// found — the parser must not be stricter than the brief's actual contract tolerates. Fixture
// transcripts reproducing each case are exercised in the unit tests (grep "regression" there).
const VIOLATION_START_RE = /^[\s>*#-]*\**VIOLATION\**\s*:\s*(.*)$/i;
const OFFENDING_START_RE = /^[\s>*#-]*\**OFFENDING\**\s*:\s*(.*)$/i;
const CLOSER_RE = /^[\s>*#-]*\**(VERDICT|NO_VIOLATIONS)\b/i;
const CODE_FENCE_RE = /^\s*```/;
const LOC_UNSPECIFIED = '(location unspecified)';

/** Strip wrapping markdown emphasis/quote marks a model sometimes adds around a quoted string. */
function cleanQuote(s: string): string {
  return s
    .trim()
    .replace(/^\*{1,3}|\*{1,3}$/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

/**
 * Split an accumulated VIOLATION/OFFENDING block into {quote, loc} on the LAST em-dash. EM-DASH
 * ONLY as the primary split point (never en-dash, never a plain hyphen): a plain hyphen is far too
 * common inside a real path (`icon-manifest.ts`) or a numeric range ("6-7") to double as a
 * delimiter, and a numeric range can ALSO use an en-dash ("3–4") — if en-dash were accepted
 * unconditionally, `lastIndexOf` would find the RANGE's en-dash (further right) instead of the
 * true separator, splitting the location string in half. En-dash is tried only as a fallback when
 * NO em-dash is present at all (a model substituting one dash style for the other). No separator
 * found at all → the whole block is the quote; loc is explicitly UNSPECIFIED, never silently ''.
 */
function splitQuoteAndLoc(block: string): { quote: string; loc: string } {
  const text = block.trim();
  const em = text.lastIndexOf('—');
  const idx = em !== -1 ? em : text.lastIndexOf('–');
  if (idx === -1) return { quote: cleanQuote(text), loc: LOC_UNSPECIFIED };
  const loc = text.slice(idx + 1).trim();
  return { quote: cleanQuote(text.slice(0, idx)), loc: loc || LOC_UNSPECIFIED };
}

/**
 * Parse the `VIOLATION: …` / `OFFENDING: …` PAIRS from a conventions-reviewer transcript, in
 * order. Deterministic — the ONLY thing the LLM matcher ever sees is this parsed list, so a parser
 * bug can't be blamed on the reviewer. Each block accumulates every line until a blank line, a
 * code-fence marker, the next VIOLATION:/OFFENDING:, or a VERDICT:/NO_VIOLATIONS closer — so a
 * quote that wraps or spans several physical lines is captured whole, not truncated at the first
 * newline. A lone OFFENDING with no preceding VIOLATION is dropped, never crashes; likewise a
 * VIOLATION with no following OFFENDING before the next one/a closer/EOF is dropped — per the
 * brief's contract neither should occur, but a parser must never trust the model to be well-formed.
 */
export function parseFindings(raw: string): Finding[] {
  const findings: Finding[] = [];
  let mode: 'idle' | 'violation' | 'offending' = 'idle';
  let buffer: string[] = [];
  let pendingRule: { ruleQuote: string; ruleLoc: string } | null = null;

  const finalize = () => {
    if (mode === 'violation' && buffer.length) {
      const { quote, loc } = splitQuoteAndLoc(buffer.join(' '));
      pendingRule = { ruleQuote: quote, ruleLoc: loc };
    } else if (mode === 'offending' && buffer.length) {
      const { quote, loc } = splitQuoteAndLoc(buffer.join(' '));
      if (pendingRule) findings.push({ ...pendingRule, offendingLine: quote, offendingLoc: loc });
      pendingRule = null;
    }
    mode = 'idle';
    buffer = [];
  };

  for (const line of String(raw).split('\n')) {
    if (!line.trim() || CODE_FENCE_RE.test(line) || CLOSER_RE.test(line)) {
      finalize();
      continue;
    }
    const v = line.match(VIOLATION_START_RE);
    if (v) {
      finalize(); // a fresh VIOLATION always closes whatever block was in flight first
      mode = 'violation';
      buffer = [v[1]];
      continue;
    }
    const o = line.match(OFFENDING_START_RE);
    if (o) {
      finalize();
      mode = 'offending';
      buffer = [o[1]];
      continue;
    }
    if (mode !== 'idle') buffer.push(line.trim()); // a continuation line of a multi-line quote
  }
  finalize(); // EOF closes whatever was still open
  return findings;
}

// ─── Per-slot forced-choice prompts ───────────────────────────────────────────────

function numberedFindings(findings: Finding[]): string {
  return findings
    .map(
      (f, i) =>
        `F${i + 1}: rule "${f.ruleQuote}" (${f.ruleLoc}) — offending line "${f.offendingLine}" (${f.offendingLoc})`,
    )
    .join('\n');
}

/** The gold question: does any violation identify the SAME underlying rule violation? */
export function buildGoldPrompt(slot: GoldSlot, findings: Finding[]): string {
  return (
    'You are a strict FINDINGS MATCHER for a code-conventions-review benchmark. A conventions\n' +
    'reviewer emitted the numbered VIOLATIONS below, each pairing a quoted CLAUDE.md rule with a\n' +
    'quoted offending line. Decide whether any violation identifies the SAME underlying rule\n' +
    'violation as the GOLD VIOLATION — the same rule, the same offending change. A different\n' +
    'wording or quoted excerpt of the same rule/line IS a match. A DIFFERENT rule, or the same rule\n' +
    'applied to a DIFFERENT offending line, is NOT a match. Do not force a match.\n\n' +
    `VIOLATIONS:\n${numberedFindings(findings)}\n\n` +
    `GOLD VIOLATION: ${slot.desc}${slot.paths?.length ? ` (files: ${slot.paths.join(', ')})` : ''}\n\n` +
    'Reply with EXACTLY one line and nothing else:\n' +
    'SLOT: F<number>   (the single violation that best covers the gold violation)\n' +
    'SLOT: NONE        (no violation covers it)'
  );
}

/** The decoy question: does any violation flag / re-litigate the thing it must leave alone? */
export function buildDecoyPrompt(slot: DecoySlot, findings: Finding[]): string {
  return (
    'You are a strict FINDINGS MATCHER for a code-conventions-review benchmark. A conventions\n' +
    'reviewer emitted the numbered VIOLATIONS below. The DECOY describes something the reviewer\n' +
    'must NOT raise as a violation (a recorded decision it would be re-litigating, a pattern that\n' +
    'falls OUTSIDE the scope of any rule that actually governs it, or code that merely resembles an\n' +
    'anti-pattern but is working as intended). Decide whether any violation raises the decoy itself\n' +
    'as a rule violation. A violation that merely touches the same file or topic while citing a\n' +
    'DIFFERENT rule or a DIFFERENT offending line does NOT count. Do not force a match.\n\n' +
    `VIOLATIONS:\n${numberedFindings(findings)}\n\n` +
    `DECOY: ${slot.desc}\n\n` +
    'Reply with EXACTLY one line and nothing else:\n' +
    'SLOT: F<number>   (the violation that flags the decoy)\n' +
    'SLOT: NONE        (no violation flags it — the reviewer left it alone)'
  );
}

// ─── Matcher runs (the only claude-calling code in this module) ───────────────────

/**
 * Ask every slot question for one case via the shared matcher-core engine (mapPool/voteSlot/
 * parseSlotReply/the K-vote runner) — only the prompt-building (buildGoldPrompt/buildDecoyPrompt)
 * is conventions-specific. Zero findings short-circuits deterministically (all gold missed, all
 * decoys clean) — no claude call.
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
    labelPrefix: 'conventions-eval',
    exec: execJudgeAsync,
    ...opts,
  });
}

// ─── Pure scoring ─────────────────────────────────────────────────────────────────

export interface CaseScore {
  /** Per-slot results, keyed later into the baseline row map as `<caseId>::<slotId>`. */
  slots: {
    slotId: string;
    kind: 'gold' | 'decoy';
    ok: boolean;
    got: 'hit' | 'miss' | 'flagged' | 'clean';
    stable: boolean;
    outage: boolean;
  }[];
  /** 1-based indices of findings no slot claimed — not provably wrong (gold isn't exhaustive),
   * reported as a directional signal only. */
  spurious: number[];
  findingCount: number;
}

export function scoreCase(
  // Kept for signature parity with the sc-1058 matcher shape (completeness/critique both take
  // gold+decoys; conventions has no severity lookup so neither is read here).
  _gold: GoldSlot[],
  _decoys: DecoySlot[],
  findings: Finding[],
  outcomes: SlotOutcome[],
): CaseScore {
  const claimed = new Set<number>();
  const slots: CaseScore['slots'] = [];
  for (const o of outcomes) {
    if (o.match > 0) claimed.add(o.match);
    if (o.kind === 'gold') {
      const hit = o.match > 0;
      slots.push({
        slotId: o.slotId,
        kind: 'gold',
        ok: hit,
        got: hit ? 'hit' : 'miss',
        stable: o.stable,
        outage: o.outage,
      });
    } else {
      const flagged = o.match > 0;
      slots.push({
        slotId: o.slotId,
        kind: 'decoy',
        ok: !flagged,
        got: flagged ? 'flagged' : 'clean',
        stable: o.stable,
        outage: o.outage,
      });
    }
  }
  const spurious = findings.map((_, i) => i + 1).filter((n) => !claimed.has(n));
  return { slots, spurious, findingCount: findings.length };
}
