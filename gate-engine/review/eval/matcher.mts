// completeness-eval MATCHER — maps the reviewer's open-ended findings onto a case's labelled slots.
//
// The completeness reviewer emits free-text findings (`CRITICAL: desc | paths | impact`), so the
// bench cannot confusion-matrix its output directly. The unit of truth is the SLOT: a gold gap the
// reviewer must surface, or a decoy it must not flag. This module owns the whole findings→slots
// pipeline: deterministic parsing of the reviewer transcript, one FORCED-CHOICE LLM question per
// slot, majority voting, and pure scoring.
//
// Per-slot forced choice, not one holistic list-to-list mapping call: decomposing a judge's task
// into per-item binary questions measurably raises judge–human agreement (TICK, arXiv:2410.03608).
// Each slot asks "does any emitted finding identify THIS gap — yes (which) or no?" and nothing
// else. Spurious findings fall out for free: a finding no slot claimed matched nothing.
//
// The matcher is itself an LLM and therefore itself a measurement instrument with error. Two
// consequences are load-bearing:
//   · every non-deterministic path is voted (BENCH_MATCH_RUNS, default 3) and a non-unanimous
//     slot is UNSTABLE — reported, never counted as regression evidence;
//   · the matcher's own agreement is audited (`bench.mts matcher-audit` vs committed labels) and
//     hashed into the baseline (matcherHash) — a matcher prompt edit invalidates comparisons
//     exactly like a gate edit. K same-family votes reduce variance, not family bias
//     (arXiv:2502.01534); the audit is the validity instrument.
//
// Everything except `runMatcher`'s claude call is pure and unit-tested without spawning anything.
//
// The bounded-concurrency mapping, per-slot voting, forced-choice reply parsing, and the K-vote
// runner + audit kappa are shared with critique-eval and conventions-eval via
// gate-engine/judge/matcher-core.mts (the third-consumer extraction trigger); this file keeps only
// what's completeness-specific: Finding/GoldSlot/DecoySlot, transcript parsing, the prompt nouns,
// and scoreCase's severity rule.

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

export type Severity = 'CRITICAL' | 'IMPORTANT' | 'LOW';
export const SEVERITIES: Severity[] = ['CRITICAL', 'IMPORTANT', 'LOW'];

/** One parsed reviewer finding. `paths`/`impact` come from the brief's `desc | paths | impact`
 * line shape; sloppier emissions leave them ''. `context` = the optional follow-up lines. */
export interface Finding {
  severity: Severity;
  desc: string;
  paths: string;
  impact: string;
  context: string[];
}

/** A gap the reviewer MUST surface (with its target severity). `paths` are matcher hints only. */
export interface GoldSlot {
  id: string;
  severity: Severity;
  desc: string;
  paths?: string[];
}

/** A thing the reviewer must NOT flag: a recorded decision it would be re-litigating, a
 * deliberate out-of-scope item, or working-as-intended behaviour. */
export interface DecoySlot {
  id: string;
  kind: 'recorded-decision' | 'out-of-scope' | 'working-as-intended';
  targetSlug?: string;
  desc: string;
}

// ─── Deterministic transcript parsing ─────────────────────────────────────────────

// A findings line per the brief's output format, tolerant of markdown dressing the model adds
// (`**CRITICAL**:`, `- IMPORTANT:`, `### LOW:`). The colon is required — bare severity words in
// prose ("this is a CRITICAL gap") must not start a finding.
const FINDING_LINE_RE = /^[\s>*#-]*\**(CRITICAL|IMPORTANT|LOW)\**\s*:\s*(.+)$/;
const ISSUES_LINE_RE =
  /^[\s>*#-]*\**ISSUES\**\s*:\s*(\d+)\s*critical\D+(\d+)\s*important\D+(\d+)\s*low/i;
const VERDICT_LINE_RE = /^[\s>*#-]*\**VERDICT\**\s*:/i;
const MAX_CONTEXT_LINES = 5; // the brief allows 2–5 context lines per finding

export interface ParsedTranscript {
  findings: Finding[];
  /** The `ISSUES: N critical, N important, N low` self-tally, or null if absent/unparseable. */
  issues: { critical: number; important: number; low: number } | null;
  /** Non-fatal oddities (tally mismatch, missing ISSUES line) — printed, never failed on. */
  warnings: string[];
}

/** Parse the reviewer's raw transcript into findings. Deterministic — the ONLY thing the LLM
 * matcher ever sees is this parsed list, so a parser bug can't be blamed on the reviewer. */
export function parseFindings(raw: string): ParsedTranscript {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  let issues: ParsedTranscript['issues'] = null;
  for (const line of String(raw).split('\n')) {
    const issuesMatch = line.match(ISSUES_LINE_RE);
    if (issuesMatch) {
      issues = {
        critical: Number(issuesMatch[1]),
        important: Number(issuesMatch[2]),
        low: Number(issuesMatch[3]),
      };
      continue;
    }
    if (VERDICT_LINE_RE.test(line)) continue; // the PASS/FAIL line is parsed by the gate, not here
    const m = line.match(FINDING_LINE_RE);
    if (m) {
      const parts = m[2].split('|').map((s) => s.trim());
      findings.push({
        severity: m[1] as Severity,
        desc: parts[0] ?? '',
        paths: parts[1] ?? '',
        impact: parts.slice(2).join(' | '),
        context: [],
      });
      continue;
    }
    // Context lines attach to the finding above (the brief allows 2–5 explanatory lines).
    const last = findings[findings.length - 1];
    if (last && line.trim() && last.context.length < MAX_CONTEXT_LINES)
      last.context.push(line.trim());
  }
  if (issues === null) warnings.push('no ISSUES tally line in transcript');
  else {
    const counted = { CRITICAL: 0, IMPORTANT: 0, LOW: 0 };
    for (const f of findings) counted[f.severity] += 1;
    if (
      counted.CRITICAL !== issues.critical ||
      counted.IMPORTANT !== issues.important ||
      counted.LOW !== issues.low
    )
      warnings.push(
        `ISSUES tally (${issues.critical}/${issues.important}/${issues.low}) disagrees with parsed ` +
          `findings (${counted.CRITICAL}/${counted.IMPORTANT}/${counted.LOW})`,
      );
  }
  return { findings, issues, warnings };
}

// ─── Per-slot forced-choice prompts ───────────────────────────────────────────────

function numberedFindings(findings: Finding[]): string {
  return findings
    .map(
      (f, i) =>
        `F${i + 1} (${f.severity}): ${f.desc}${f.paths ? ` | ${f.paths}` : ''}${f.impact ? ` | ${f.impact}` : ''}`,
    )
    .join('\n');
}

/** The gold question: does any finding identify the SAME underlying gap? Target severities are
 * deliberately withheld — severity calibration must come from the reviewer's emitted tier. */
export function buildGoldPrompt(slot: GoldSlot, findings: Finding[]): string {
  return (
    'You are a strict FINDINGS MATCHER for a code-review benchmark. A completeness reviewer\n' +
    'emitted the numbered FINDINGS below. Decide whether any finding identifies the SAME\n' +
    'underlying gap as the GOLD GAP — the same root issue, the same implied remedy. A different\n' +
    'wording, severity, or level of detail of the same gap IS a match. The same file with a\n' +
    'DIFFERENT problem is NOT a match. Do not force a match.\n\n' +
    `FINDINGS:\n${numberedFindings(findings)}\n\n` +
    `GOLD GAP: ${slot.desc}${slot.paths?.length ? ` (files: ${slot.paths.join(', ')})` : ''}\n\n` +
    'Reply with EXACTLY one line and nothing else:\n' +
    'SLOT: F<number>   (the single finding that best covers the gold gap)\n' +
    'SLOT: NONE        (no finding covers it)'
  );
}

/** The decoy question: does any finding flag / re-litigate the thing it must leave alone? */
export function buildDecoyPrompt(slot: DecoySlot, findings: Finding[]): string {
  return (
    'You are a strict FINDINGS MATCHER for a code-review benchmark. A completeness reviewer\n' +
    'emitted the numbered FINDINGS below. The DECOY describes something the reviewer must NOT\n' +
    'raise (a recorded decision it would be re-litigating, a deliberately out-of-scope item, or\n' +
    'working-as-intended behaviour). Decide whether any finding raises the decoy as a gap or\n' +
    'problem. A finding that merely MENTIONS the topic while flagging a different, genuine gap\n' +
    'does NOT count. Do not force a match.\n\n' +
    `FINDINGS:\n${numberedFindings(findings)}\n\n` +
    `DECOY: ${slot.desc}\n\n` +
    'Reply with EXACTLY one line and nothing else:\n' +
    'SLOT: F<number>   (the finding that flags the decoy)\n' +
    'SLOT: NONE        (no finding flags it — the reviewer left it alone)'
  );
}

// ─── Matcher runs (the only claude-calling code in this module) ───────────────────

/**
 * Ask every slot question for one case via the shared matcher-core engine (mapPool/voteSlot/
 * parseSlotReply/the K-vote runner) — only the prompt-building (buildGoldPrompt/buildDecoyPrompt)
 * is completeness-specific. Zero findings short-circuits deterministically (all gold missed, all
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
    labelPrefix: 'completeness-eval',
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
  /** want×got severity pairs for the HIT gold slots only (missed gaps have no emitted tier). */
  severity: { expected: Severity; got: Severity }[];
  /** 1-based indices of findings no slot claimed — not provably wrong (gold isn't exhaustive),
   * reported as a directional signal only. */
  spurious: number[];
  findingCount: number;
}

export function scoreCase(
  gold: GoldSlot[],
  _decoys: DecoySlot[],
  findings: Finding[],
  outcomes: SlotOutcome[],
): CaseScore {
  const claimed = new Set<number>();
  const slots: CaseScore['slots'] = [];
  const severity: CaseScore['severity'] = [];
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
      if (hit) {
        const want = gold.find((g) => g.id === o.slotId)?.severity;
        const emitted = findings[o.match - 1]?.severity;
        if (want && emitted) severity.push({ expected: want, got: emitted });
      }
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
  return { slots, severity, spurious, findingCount: findings.length };
}
