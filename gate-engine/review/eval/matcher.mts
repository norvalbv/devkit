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

import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';

export const MATCH_TIMEOUT_MS = 60000;

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
const ISSUES_LINE_RE = /^[\s>*#-]*\**ISSUES\**\s*:\s*(\d+)\s*critical\D+(\d+)\s*important\D+(\d+)\s*low/i;
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
    if (last && line.trim() && last.context.length < MAX_CONTEXT_LINES) last.context.push(line.trim());
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
    .map((f, i) => `F${i + 1} (${f.severity}): ${f.desc}${f.paths ? ` | ${f.paths}` : ''}${f.impact ? ` | ${f.impact}` : ''}`)
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

/**
 * Parse one forced-choice reply. The LAST `SLOT:` line wins (models sometimes think aloud first).
 * Returns the 1-based finding number, 0 for NONE, or null when unparseable / out of range —
 * null is a matcher outage for that trial, never a silent NONE.
 */
export function parseSlotReply(raw: string, findingCount: number): number | null {
  const lines = [...String(raw).matchAll(/^[\s>*#-]*\**SLOT\**\s*:\s*(NONE|F?\s*(\d+))\s*\**\s*$/gim)];
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  if (last[1].toUpperCase() === 'NONE') return 0;
  const n = Number(last[2]);
  return Number.isInteger(n) && n >= 1 && n <= findingCount ? n : null;
}

// ─── Matcher runs (the only claude-calling code in this module) ───────────────────

export interface SlotOutcome {
  slotId: string;
  kind: 'gold' | 'decoy';
  /** 1-based index of the matched finding, 0 = no match. */
  match: number;
  /** Unanimous across the K votes. Non-unanimous = instability, never regression evidence. */
  stable: boolean;
  /** Every vote was dark/unparseable — the slot could not be measured this run. */
  outage: boolean;
}

export interface MatcherOptions {
  model?: string;
  runs?: number;
  /** Max concurrent claude calls. Bounded — unbounded fan-out gets judges SIGTERM'd under
   * machine contention (the sc-1048/sc-1049 failure class), which reads as fake outages. */
  concurrency?: number;
  exec?: typeof execJudgeAsync;
  cwd?: string;
}

/** Tiny bounded-concurrency map — dep-free, order-preserving. */
export async function mapPool<T, R>(
  items: T[],
  width: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker));
  return results;
}

/** Majority vote over per-trial matches; a full tie or an all-null slot fails safe. Exported for
 * tests. Votes are stringified finding numbers ('0' = NONE); null trials vote 'NULL'. */
export function voteSlot(trials: (number | null)[]): { match: number; stable: boolean; outage: boolean } {
  const counts = new Map<string, number>();
  for (const t of trials) {
    const key = t === null ? 'NULL' : String(t);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const tie = sorted.length > 1 && sorted[0][1] === sorted[1][1];
  const winner = tie ? 'NULL' : sorted[0][0];
  if (winner === 'NULL') {
    // Distinguish "all trials dark" (outage) from "the votes disagreed" (instability → NONE).
    const allNull = trials.every((t) => t === null);
    return { match: 0, stable: false, outage: allNull };
  }
  return { match: Number(winner), stable: sorted.length === 1, outage: false };
}

/**
 * Ask every slot question for one case. Zero findings short-circuits deterministically (all gold
 * missed, all decoys clean) — no claude call. Each trial retries once on a dark/unparseable
 * reply before voting NULL.
 */
export async function runMatcher(
  gold: GoldSlot[],
  decoys: DecoySlot[],
  findings: Finding[],
  { model = 'haiku', runs = 3, concurrency = 4, exec = execJudgeAsync, cwd }: MatcherOptions = {},
): Promise<SlotOutcome[]> {
  const slots: { slotId: string; kind: 'gold' | 'decoy'; prompt: string }[] = [
    ...gold.map((s) => ({ slotId: s.id, kind: 'gold' as const, prompt: buildGoldPrompt(s, findings) })),
    ...decoys.map((s) => ({ slotId: s.id, kind: 'decoy' as const, prompt: buildDecoyPrompt(s, findings) })),
  ];
  if (findings.length === 0)
    return slots.map(({ slotId, kind }) => ({ slotId, kind, match: 0, stable: true, outage: false }));

  // One work item per (slot, trial) so the pool bounds TOTAL concurrent claude calls, not slots.
  const trials: (number | null)[][] = slots.map(() => []);
  const work: { si: number }[] = slots.flatMap((_, si) => Array.from({ length: runs }, () => ({ si })));
  await mapPool(work, concurrency, async ({ si }) => {
    const ask = () =>
      exec({
        label: `completeness-eval:matcher:${slots[si].slotId}`,
        args: ['-p', slots[si].prompt, '--model', model, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION],
        timeout: MATCH_TIMEOUT_MS,
        cwd,
      });
    let raw = await ask();
    let parsed = raw === null ? null : parseSlotReply(raw, findings.length);
    if (parsed === null) {
      raw = await ask(); // one retry — a single flake shouldn't cost the slot
      parsed = raw === null ? null : parseSlotReply(raw, findings.length);
    }
    trials[si].push(parsed);
  });
  return slots.map(({ slotId, kind }, si) => ({ slotId, kind, ...voteSlot(trials[si]) }));
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
  decoys: DecoySlot[],
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

/**
 * Cohen's kappa between two label sequences (the matcher-audit agreement stat). Chance-corrected
 * because raw percent agreement flatters a matcher on skewed slots — most slots are NONE, and a
 * matcher that always says NONE "agrees" often (arXiv:2606.19544's exact-match inflation).
 */
export function kappa(a: string[], b: string[]): number {
  if (a.length !== b.length || a.length === 0) return Number.NaN;
  const n = a.length;
  const labels = [...new Set([...a, ...b])];
  let observed = 0;
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    if (a[i] === b[i]) observed += 1;
    countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
    countB.set(b[i], (countB.get(b[i]) ?? 0) + 1);
  }
  const po = observed / n;
  let pe = 0;
  for (const l of labels) pe += ((countA.get(l) ?? 0) / n) * ((countB.get(l) ?? 0) / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}
