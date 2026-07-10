#!/usr/bin/env node

/**
 * conventions-eval: accuracy benchmark for the conventions-reviewer gate
 * (`guard-review --gate` → REVIEWERS' `conventions-reviewer` entry — ../../reviewers.mts +
 * ../../run-review.mts + ../../claude-md.mts + ../../diff-evidence.mts + agents/conventions-reviewer.md).
 *
 * A prompt edit to the reviewer brief, or an edit to the CLAUDE.md-scoping/diff-evidence modules it
 * depends on, is unverifiable without a measured check; this scores the EXACT gate path against a
 * labelled corpus so an edit is a delta, not a vibe. The bench calls `runCascade()` — the SAME
 * function `runReviewGate` calls per selected reviewer — with a spy `exec` that delegates to the
 * real judge runner: prompt construction (`wrapConventionsPrompt`), the governing-CLAUDE.md render
 * (`renderGoverningClaudeMd`), the capped diff evidence (`buildCappedDiffEvidence`), the pinned
 * haiku model, and the isolation flags all run INSIDE the gate; the spy only observes the
 * transcript. Bench and gate cannot drift.
 *
 * Unlike reviewer-eval (../reviewers/bench.mts), conventions-reviewer is SKILL-LESS — no checklist
 * artifact to snapshot, no `expectItems` right-item attribution. Its output is free text exactly
 * like completeness-eval's (../bench.mts), so this bench borrows THAT scoring shape instead: each
 * corpus row carries a GOLD slot-set (rule violations that MUST surface) and DECOYS (things that
 * must NOT be flagged — a recorded exception, a pattern outside any rule's scope, or code that
 * merely resembles an anti-pattern but is working as intended). An audited LLM matcher
 * (matcher.mts) maps emitted VIOLATION/OFFENDING pairs onto those slots with per-slot forced-choice
 * questions; scoring is recall against gold and flag-rate against decoys — never string equality,
 * never "did it produce output". This combination — driving the real cascade like reviewer-eval,
 * scoring via gold slots like completeness-eval — is new: no existing bench needs both, because
 * every OTHER reviewer that runs through runCascade is checklist-driven, and completeness's own
 * gate (runCompleteness) isn't a REVIEWERS-table entry at all.
 *
 *   node bench.mts                 # full run: reviewer + matcher, headline metrics
 *   node bench.mts --baseline      # write results.baseline.json (committed here)
 *   node bench.mts --fail          # exit 1 on floor breach or significant stable case flips
 *   node bench.mts --dev           # prompt-iteration tier: holdout rows excluded
 *   node bench.mts --only <id>     # id-prefix subset (iteration; usage lands in runs.log)
 *   node bench.mts validate        # 0 LLM calls: corpus + selection linter
 *   node bench.mts coverage        # 0 LLM calls: corpus coverage matrix
 *   node bench.mts matcher-audit   # matcher agreement vs committed hand-labels (percent + Cohen's κ)
 *
 * Sweeps: BENCH_MATCH_MODEL=haiku|sonnet (matcher; default haiku) · BENCH_MATCH_RUNS=1|3 (matcher
 * votes; default 3). The REVIEWER has NO model sweep — unlike completeness (whose gate hardcodes
 * opus by a BENCH-independent user ruling) this reviewer's single-pass haiku, no-cascade execution
 * is a TICKET MANDATE (reviewers.mts Reviewer.model docstring: "per the ticket's own haiku
 * mandate"), not a choice this bench measured its way into — so there is nothing to sweep FROM.
 *
 * Headline metrics — one per failure mode:
 *   gap recall        H/G  — a missed rule violation is what the reviewer exists to prevent → HARD FLOOR
 *   false-flag rate   FD/D — decoys flagged (recorded exceptions re-litigated, or a rule extended
 *                            past its CLAUDE.md scope) → HARD CEILING
 * Finding precision (matched/emitted) prints informationally only: gold is not exhaustive, so an
 * unmatched violation is not provably wrong — the decoy set is the measured precision instrument.
 * Decoys additionally break out BY KIND (recorded-decision / out-of-scope / working-as-intended) —
 * `out-of-scope` is the AC's own scoping-boundary metric (see cases-conventions.jsonl's
 * `scoping-*` rows) and is worth reading on its own, not just folded into the pooled ceiling.
 *
 * Statistical honesty (verbatim from decisions-eval/completeness-eval, the house standard): every
 * headline ships raw counts + a Wilson 95% interval; --fail gates on hard floors plus the paired
 * flip table vs baseline under a mid-p McNemar test — never aggregate deltas. The flip gate
 * clusters by CASE (slots within one case share a single reviewer transcript and are correlated —
 * Miller arXiv:2411.00640). Baselines embed gateHash + matcherHash + corpusHash; any mismatch skips
 * the comparison mechanically. Every run appends to runs.log — the anti-Goodhart ledger.
 *
 * Outage policy (alignment-style): a dark reviewer scores the CASE as an outage and continues; a
 * dark matcher slot (after retry) scores the SLOT as an outage; either sets outages>0, which makes
 * --fail skip the comparison. All-outage aborts (exit 2). A gate FREE-SKIP (exec never called) is
 * NEVER an outage — it aborts as a fixture bug, because "the gate didn't run" must not read as
 * "the reviewer passed".
 *
 * Exit 0 = ran (no regression under --fail) · 1 = regression (with --fail) / validate found bad
 * rows · 2 = could not run.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveGuardConfig } from '../../../config.mts';
import {
  BenchAbort,
  cleanBenchEnv,
  materializeFixture,
  mcnemarMidP,
  parseCasesText,
  wilson,
} from '../../../decisions/eval/bench.mts';
import { execJudgeAsync } from '../../../judge/run-judge.mts';
import { parseReviewVerdict, REVIEWERS, selectReviewers } from '../../reviewers.mts';
import { runCascade } from '../../run-review.mts';
import {
  type CaseScore,
  type DecoySlot,
  type GoldSlot,
  kappa,
  parseFindings,
  runMatcher,
  scoreCase,
} from './matcher.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
// gate-engine/review/eval/conventions → repo root is four levels up (same depth as
// gate-engine/review/eval/reviewers, see that bench's identical repoRoot comment).
const repoRoot = path.resolve(here, '../../../..');
const baselinePath = path.join(here, 'results.baseline.json');
const casesPath = path.join(here, 'cases-conventions.jsonl');
const transcriptsDir = path.join(here, 'transcripts');
const auditLabelsPath = path.join(here, 'matcher-audit-conventions.labels.jsonl');
const AGENT_MD = path.join(repoRoot, 'agents', 'conventions-reviewer.md');

const MATCH_MODEL = process.env.BENCH_MATCH_MODEL ?? 'haiku';
const MATCH_RUNS = Math.max(1, Number.parseInt(process.env.BENCH_MATCH_RUNS ?? '3', 10) || 3);
const MATCH_CONCURRENCY = 4; // bounded — a slot storm gets judges SIGTERM'd under contention

// Hard floors on the safety metrics (same values as completeness-eval — sc-1058's own convention
// for an open-ended-finding reviewer bench; see cases-conventions.jsonl's dataset card for why).
export const FLOOR_GAP_RECALL = 0.7;
export const CEILING_FALSE_FLAG = 0.25;

/** The reviewer this bench covers. `REVIEWERS.filter` (not a direct table lookup) so a future
 * second conventions-flavoured entry is picked up without an edit here. */
export const BENCH_REVIEWERS = REVIEWERS.filter((r) => r.domain === 'conventions');
const REVIEWER = BENCH_REVIEWERS[0];

// Fixture roots: every corpus row's staged files live under one of these four top-level
// directories — the small, closed set the whole corpus uses (mirrors reviewer-eval's
// FIXTURE_CONFIG). `domain: 'conventions'` fires on the DEDUPED UNION of
// scanRoots/backendRoots/frontendRoots (rootsFor in reviewers.mts), so declaring them all as
// scanRoots is enough; backend/frontendRoots stay empty so this fixture can never accidentally
// select a DIFFERENT reviewer's domain (there is none in BENCH_REVIEWERS, but the config is
// materialized as real guard.config.json — keep it inert for any future entry).
const FIXTURE_CONFIG = {
  scanRoots: ['app', 'packages', 'services', 'db'],
  review: { backendRoots: [], frontendRoots: [] },
};

// A staged file containing one of the reviewer's own OUTPUT tokens is a prompt-injection hazard —
// a case designed to test the reviewer's judgement must never accidentally hand it a pre-written
// verdict to parrot.
const INJECTION_RE = /\b(VIOLATION|OFFENDING|VERDICT|NO_VIOLATIONS)\s*:/;

// ─── Corpus ───────────────────────────────────────────────────────────────────────

export interface ConventionsCase {
  id: string;
  category: string;
  difficulty?: 'clear' | 'borderline' | 'adversarial';
  provenance?: 'authored' | 'mined' | 'adapted';
  note: string;
  variantOf?: string | null;
  variantKind?: 'invariance' | 'directional' | null;
  holdout?: boolean;
  message: string;
  repo: { base: Record<string, string>; staged: Record<string, string | null> };
  gold: GoldSlot[];
  decoys: DecoySlot[];
  expectedVerdict?: 'PASS' | 'FAIL';
}

/** Free corpus lint — every defect here would otherwise surface mid-run after paid haiku calls.
 * Exported so the unit tests run it over the committed corpus. */
export function lintCases(rows: ConventionsCase[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const r of rows) {
    const at = `row ${r.id ?? '(no id)'}`;
    if (!r.id) errors.push(`${at}: missing id`);
    else if (ids.has(r.id)) errors.push(`${at}: duplicate id`);
    else ids.add(r.id);
    for (const field of ['category', 'note', 'message'] as const)
      if (!r[field]) errors.push(`${at}: missing ${field}`);
    if (!r.repo?.base || !r.repo?.staged) errors.push(`${at}: missing repo.base/staged`);
    else if (Object.keys(r.repo.staged).length === 0) errors.push(`${at}: nothing staged`);
    if (!Array.isArray(r.gold) || !Array.isArray(r.decoys))
      errors.push(`${at}: gold/decoys must be arrays`);
    const slotIds = new Set<string>();
    for (const s of [...(r.gold ?? []), ...(r.decoys ?? [])]) {
      if (slotIds.has(s.id)) errors.push(`${at}: duplicate slot id ${s.id}`);
      slotIds.add(s.id);
    }
    if (r.difficulty && !['clear', 'borderline', 'adversarial'].includes(r.difficulty))
      errors.push(`${at}: bad difficulty ${r.difficulty}`);
    if (r.provenance && !['authored', 'mined', 'adapted'].includes(r.provenance))
      errors.push(`${at}: bad provenance ${r.provenance}`);
    if (r.expectedVerdict && !['PASS', 'FAIL'].includes(r.expectedVerdict))
      errors.push(`${at}: bad expectedVerdict ${r.expectedVerdict}`);
    for (const d of r.decoys ?? []) {
      if (d.kind === 'recorded-decision') {
        // Mirrors completeness-eval's rule: a recorded-decision decoy must be BACKED by a real
        // Target file in repo.base — existence is what makes the reviewer's own Read/Grep/Glob
        // tools able to find it; an unbacked decoy would never tempt the reviewer either way.
        const file = `docs/decisions/${d.targetSlug}.md`;
        if (!d.targetSlug) errors.push(`${at}: decoy ${d.id} recorded-decision needs targetSlug`);
        else if (!r.repo.base[file]) errors.push(`${at}: decoy ${d.id} — ${file} not in repo.base`);
      }
    }
  }
  return errors;
}

function loadCases(): ConventionsCase[] {
  let rows: ConventionsCase[];
  try {
    rows = parseCasesText(readFileSync(casesPath, 'utf8'));
  } catch (e) {
    throw new BenchAbort(2, `conventions-eval: cannot read ${path.basename(casesPath)} — ${e}`);
  }
  if (!rows.length) throw new BenchAbort(2, 'conventions-eval: corpus is empty');
  const errors = lintCases(rows);
  if (errors.length)
    throw new BenchAbort(2, `conventions-eval: corpus lint failed —\n  ${errors.join('\n  ')}`);
  return rows;
}

// ─── Fixture assets + wrapper ──────────────────────────────────────────────────────

/**
 * The gate files a fixture repo needs before the judge runs: guard.config.json (roots that make
 * selectReviewers fire conventions-reviewer) + the agent brief under the default agentsDir. No
 * checklist script — conventions-reviewer is skill-less (see reviewers.mts Reviewer.skill
 * docstring), so unlike reviewer-eval's buildAssets there is nothing else to write. Read from the
 * repo source of truth (agents/) — bench and gate share one copy, so a brief edit is automatically
 * what gets measured.
 */
export function buildAssets(): Record<string, string> {
  const brief = readFileSync(AGENT_MD, 'utf8');
  return {
    'guard.config.json': `${JSON.stringify(FIXTURE_CONFIG, null, 2)}\n`,
    '.claude/agents/conventions-reviewer.md': brief,
  };
}

/** A conventions fixture is an alignment fixture (disposable git repo, base committed, staged in
 * the index) plus the gate assets merged into base. Rows must never shadow an asset path. */
function materializeConventionsFixture(
  row: ConventionsCase,
): ReturnType<typeof materializeFixture> {
  const assets = buildAssets();
  for (const key of Object.keys(assets))
    if (row.repo.base[key] !== undefined || row.repo.staged[key] !== undefined)
      throw new BenchAbort(2, `${row.id}: row must not define gate asset path ${key}`);
  return materializeFixture({
    repo: { base: { ...row.repo.base, ...assets }, staged: row.repo.staged },
  });
}

/** gateHash: everything whose edit invalidates comparability — the cascade source, the pure gate
 * logic, the two NEW skill-less-reviewer modules this reviewer depends on, and the brief itself
 * (the brief IS gate code, the completeness-eval rule). */
function gateHash(): string {
  return sha12(
    [
      readFileSync(path.join(repoRoot, 'gate-engine/review/reviewers.mts'), 'utf8'),
      readFileSync(path.join(repoRoot, 'gate-engine/review/run-review.mts'), 'utf8'),
      readFileSync(path.join(repoRoot, 'gate-engine/review/claude-md.mts'), 'utf8'),
      readFileSync(path.join(repoRoot, 'gate-engine/review/diff-evidence.mts'), 'utf8'),
      readFileSync(AGENT_MD, 'utf8'),
    ].join('\n \n'),
  );
}

/** matcherHash: matcher-core.mts + this dir's matcher.mts. NOTE — post-extraction (sc-1058) this
 * hash's FIRST half (matcher-core.mts) is now SHARED with completeness-eval and critique-eval: an
 * edit to matcher-core.mts invalidates ALL THREE benches' matcherHash simultaneously, a new
 * cross-bench hazard versus each bench owning its own matcher file outright. Re-run every
 * consumer's matcher-audit after touching matcher-core.mts (documented in README.md). */
function matcherHash(): string {
  return sha12(
    [
      readFileSync(path.join(repoRoot, 'gate-engine/judge/matcher-core.mts'), 'utf8'),
      readFileSync(path.join(here, 'matcher.mts'), 'utf8'),
    ].join('\n \n'),
  );
}

const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

// ─── One case through the exact gate path ─────────────────────────────────────────

interface SpyCapture {
  called: boolean;
  args: string[] | null;
  raw: string | null;
}

/** Spy exec: delegates to the real judge runner (or a test stub), records what the gate sent and
 * what came back. Drift-proof by construction — the gate builds everything, the spy observes. */
function spyExec(capture: SpyCapture, delegate: typeof execJudgeAsync): typeof execJudgeAsync {
  return async (opts) => {
    capture.called = true;
    capture.args = opts.args;
    capture.raw = await delegate(opts);
    return capture.raw;
  };
}

export interface CaseResult {
  id: string;
  outage: boolean;
  score: CaseScore | null;
  verdict: string | null;
  /** The cascade's own status — informational (scoring is slot-based, not this). */
  status: 'pass' | 'fail' | 'inconclusive' | null;
}

/**
 * Run one corpus row through runCascade() + the matcher. Exported with an injectable exec chain so
 * the tests drive it without claude. Throws BenchAbort on fixture bugs (free-skip / no selection)
 * — "the gate didn't run" must never score as a pass.
 */
export async function runCase(
  row: ConventionsCase,
  {
    reviewerExec = execJudgeAsync,
    matcherExec = execJudgeAsync,
    matchModel = MATCH_MODEL,
    matchRuns = MATCH_RUNS,
    saveTranscript = true,
  }: {
    reviewerExec?: typeof execJudgeAsync;
    matcherExec?: typeof execJudgeAsync;
    matchModel?: string;
    matchRuns?: number;
    saveTranscript?: boolean;
  } = {},
): Promise<CaseResult> {
  const fx = materializeConventionsFixture(row);
  activeCleanup = fx.cleanup;
  try {
    const cfg = resolveGuardConfig(fx.repo);
    const sel = selectReviewers(fx.staged, cfg).find((s) => s.reviewer.name === REVIEWER.name);
    if (!sel)
      throw new BenchAbort(
        2,
        `conventions-eval: fixture bug in ${row.id} — selectReviewers did not fire ${REVIEWER.name} ` +
          "(check FIXTURE_CONFIG.scanRoots covers every staged path's top-level directory)",
      );
    const capture: SpyCapture = { called: false, args: null, raw: null };
    // The injectable exec is the seam runCascade's own tests use; everything else is the gate.
    const cas = await runCascade(sel, { cwd: fx.repo, cfg, exec: spyExec(capture, reviewerExec) });
    if (!capture.called)
      throw new BenchAbort(
        2,
        `conventions-eval: gate free-skipped ${row.id} — fixture bug, not a pass`,
      );
    if (capture.raw === null)
      return { id: row.id, outage: true, score: null, verdict: null, status: null };

    const findings = parseFindings(capture.raw);
    const outcomes = await runMatcher(row.gold, row.decoys, findings, {
      model: matchModel,
      runs: matchRuns,
      concurrency: MATCH_CONCURRENCY,
      exec: matcherExec,
    });
    const score = scoreCase(row.gold, row.decoys, findings, outcomes);
    const verdict = parseReviewVerdict(capture.raw).verdict;
    if (saveTranscript) {
      try {
        mkdirSync(transcriptsDir, { recursive: true });
        writeFileSync(
          path.join(transcriptsDir, `${row.id}.json`),
          `${JSON.stringify(
            {
              id: row.id,
              findings,
              gold: row.gold,
              decoys: row.decoys,
              outcomes,
              verdict,
              status: cas.status,
              raw: capture.raw,
            },
            null,
            2,
          )}\n`,
        );
      } catch {
        // Transcripts are audit material, not scoring input — never fail a paid run on them.
      }
    }
    return { id: row.id, outage: false, score, verdict, status: cas.status };
  } finally {
    activeCleanup = null;
    fx.cleanup();
  }
}

// Best-effort ^C cleanup: materializeFixture keeps no module-private handle of its own (that's
// decisions-eval's main() convention); this bench holds its own the same way completeness-eval does.
let activeCleanup: (() => void) | null = null;

// ─── Bench run + metrics ───────────────────────────────────────────────────────────

export interface BenchSummary {
  matchModel: string;
  matchRuns: number;
  cases: number;
  caseOutages: number;
  slotOutages: number;
  outages: number;
  gold: { total: number; hit: number };
  decoys: {
    total: number;
    flagged: number;
    byKind: Record<string, { total: number; flagged: number }>;
  };
  findings: { total: number; matched: number; spurious: number };
  verdicts: { total: number; correct: number };
  gapRecall: number;
  falseFlagRate: number;
  rows: Record<string, { ok: boolean; stable: boolean }>;
  slots: Record<
    string,
    { kind: 'gold' | 'decoy'; got: string; ok: boolean; stable: boolean; expected: string }
  >;
  gateHash?: string;
  matcherHash?: string;
  corpusHash?: string;
}

const pct = (k: number, n: number) => (n ? k / n : 0);
const fmtCi = (k: number, n: number) => {
  const { lo, hi } = wilson(k, n);
  return `${k}/${n} = ${n ? (k / n).toFixed(2) : '—'} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
};

/** Aggregate per-case results into the summary. Pure — unit-tested on synthetic results. */
export function summarize(
  rows: ConventionsCase[],
  results: CaseResult[],
  { matchModel = MATCH_MODEL, matchRuns = MATCH_RUNS } = {},
): BenchSummary {
  const s: BenchSummary = {
    matchModel,
    matchRuns,
    cases: results.length,
    caseOutages: 0,
    slotOutages: 0,
    outages: 0,
    gold: { total: 0, hit: 0 },
    decoys: { total: 0, flagged: 0, byKind: {} },
    findings: { total: 0, matched: 0, spurious: 0 },
    verdicts: { total: 0, correct: 0 },
    gapRecall: 0,
    falseFlagRate: 0,
    rows: {},
    slots: {},
  };
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const res of results) {
    const row = byId.get(res.id);
    if (!row) continue;
    if (res.outage || !res.score) {
      s.caseOutages += 1;
      continue;
    }
    let caseOk = true;
    let caseStable = true;
    for (const slot of res.score.slots) {
      if (slot.outage) {
        s.slotOutages += 1;
        continue; // an unmeasured slot joins no metric — outages>0 already taints the run
      }
      const key = `${res.id}::${slot.slotId}`;
      s.slots[key] = {
        kind: slot.kind,
        got: slot.got,
        ok: slot.ok,
        stable: slot.stable,
        expected: slot.kind === 'gold' ? 'hit' : 'clean',
      };
      caseOk &&= slot.ok;
      caseStable &&= slot.stable;
      if (slot.kind === 'gold') {
        s.gold.total += 1;
        if (slot.ok) s.gold.hit += 1;
      } else {
        s.decoys.total += 1;
        const decoy = row.decoys.find((d) => d.id === slot.slotId);
        const flagged = !slot.ok;
        if (flagged) s.decoys.flagged += 1;
        const kind = decoy?.kind ?? 'unknown';
        s.decoys.byKind[kind] ??= { total: 0, flagged: 0 };
        s.decoys.byKind[kind].total += 1;
        if (flagged) s.decoys.byKind[kind].flagged += 1;
      }
    }
    s.rows[res.id] = { ok: caseOk, stable: caseStable };
    s.findings.total += res.score.findingCount;
    s.findings.spurious += res.score.spurious.length;
    s.findings.matched += res.score.findingCount - res.score.spurious.length;
    if (row.expectedVerdict) {
      s.verdicts.total += 1;
      // A null verdict reads as PASS — the gate's own fail-open interpretation (parseReviewVerdict
      // returns null on no VERDICT line, and runReviewGate never blocks on a null-verdict PASS path
      // the same way completeness-eval's convention treats it for its own informational metric).
      if ((res.verdict ?? 'PASS') === row.expectedVerdict) s.verdicts.correct += 1;
    }
  }
  s.outages = s.caseOutages + s.slotOutages;
  s.gapRecall = pct(s.gold.hit, s.gold.total);
  s.falseFlagRate = pct(s.decoys.flagged, s.decoys.total);
  return s;
}

/**
 * Metamorphic groups: invariance variants must land the same per-slot outcome pattern.
 *
 * Pattern by KIND+ORDINAL (`gold[0]`, `decoy[1]`, …), NOT by literal slot id: a cosmetic variant
 * row deliberately uses its OWN descriptive slot id (a different offending file/rule is the whole
 * point of varying the surface details), so comparing by id would read every variant pair as
 * "broken" even when the actual outcome is perfectly consistent — ordinal position within the
 * row's own gold/decoy arrays is the stable axis a variant pair actually shares.
 */
export function variantConsistency(rows: ConventionsCase[], summary: BenchSummary) {
  const groups: Record<string, Set<string>> = {};
  for (const r of rows) {
    if (!r.variantOf || r.variantKind === 'directional') continue;
    groups[r.variantOf] ??= new Set([r.variantOf]);
    groups[r.variantOf].add(r.id);
  }
  const ids = Object.keys(groups);
  if (!ids.length) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pattern = (caseId: string) => {
    const row = byId.get(caseId);
    if (!row) return '';
    const got = (slotId: string) => summary.slots[`${caseId}::${slotId}`]?.got ?? '';
    return [
      ...row.gold.map((s, i) => `gold[${i}]=${got(s.id)}`),
      ...row.decoys.map((s, i) => `decoy[${i}]=${got(s.id)}`),
    ]
      .sort()
      .join(',');
  };
  let consistent = 0;
  const broken: string[] = [];
  for (const g of ids) {
    const patterns = new Set([...groups[g]].map(pattern).filter((p) => p !== ''));
    if (patterns.size <= 1) consistent += 1;
    else broken.push(g);
  }
  return { consistent, total: ids.length, broken };
}

// ─── Baseline comparison — floors + case-level flip gate ──────────────────────────

/**
 * Statistically honest at small n, decisions-eval/completeness-eval order of evaluation:
 * (1) comparability preconditions (config, gateHash, matcherHash, corpusHash, outages) skip rather
 * than lie; (2) hard floors on the safety metrics; (3) the paired CASE-level flip table under
 * mid-p McNemar, stable flips only; (4) informational deltas + slot-level flips + the MDE line.
 */
export function compareConventions(summary: BenchSummary, base: BenchSummary | undefined) {
  if (!base) return { regressed: false, lines: ['  no baseline — skipped'] };
  const skip = (why: string) => ({
    regressed: false,
    lines: [`  ${why} — regenerate with --baseline; comparison skipped`],
  });
  for (const k of ['matchModel', 'matchRuns'] as const)
    if (summary[k] !== base[k]) return skip(`baseline config differs (${k})`);
  if (base.gateHash && summary.gateHash && base.gateHash !== summary.gateHash)
    return skip('gate code / agent brief changed since the baseline');
  if (base.matcherHash && summary.matcherHash && base.matcherHash !== summary.matcherHash)
    return skip('matcher changed since the baseline');
  if (base.corpusHash && summary.corpusHash && base.corpusHash !== summary.corpusHash)
    return skip('corpus changed since the baseline');
  if (summary.outages > 0) return skip(`${summary.outages} outage(s) this run — score is suspect`);

  const lines: string[] = [];
  let regressed = false;
  const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(3)}`;
  lines.push(`  gap recall Δ ${signed(summary.gapRecall - base.gapRecall)}  (informational)`);
  lines.push(
    `  false-flag rate Δ ${signed(summary.falseFlagRate - base.falseFlagRate)}  (informational)`,
  );

  if (summary.gapRecall < FLOOR_GAP_RECALL) {
    regressed = true;
    lines.push(
      `  FLOOR BREACH — gap recall ${summary.gapRecall.toFixed(2)} < ${FLOOR_GAP_RECALL} (catastrophic; fails regardless of flip statistics)`,
    );
  }
  if (summary.falseFlagRate > CEILING_FALSE_FLAG) {
    regressed = true;
    lines.push(
      `  CEILING BREACH — false-flag rate ${summary.falseFlagRate.toFixed(2)} > ${CEILING_FALSE_FLAG} (catastrophic; fails regardless of flip statistics)`,
    );
  }

  const b: string[] = [];
  const c: string[] = [];
  const unstable: string[] = [];
  for (const [id, cur] of Object.entries(summary.rows)) {
    const prev = base.rows?.[id];
    if (!prev) continue;
    if (prev.ok && !cur.ok) (cur.stable ? b : unstable).push(id);
    else if (!prev.ok && cur.ok) c.push(id);
  }
  const midP = mcnemarMidP(b.length, c.length);
  if (b.length + c.length > 0) {
    const n = Object.keys(summary.rows).length;
    const mde = 2.802 * Math.sqrt((b.length + c.length) / n / n);
    lines.push(
      `  case flips vs baseline — regressed [${b.join(', ') || '—'}] improved [${c.join(', ') || '—'}] (mid-p ${midP.toFixed(3)})`,
    );
    lines.push(
      `  this bench cannot distinguish deltas below ~${(mde * 100).toFixed(0)}pp from judge noise at n=${n} cases`,
    );
  }
  if (unstable.length)
    lines.push(
      `  unstable cases (unconfirmed flips — instability, not regression): [${unstable.join(', ')}]`,
    );
  const slotB = Object.entries(summary.slots)
    .filter(([k, cur]) => base.slots?.[k]?.ok && !cur.ok && cur.stable)
    .map(([k]) => k);
  const slotC = Object.entries(summary.slots)
    .filter(([k, cur]) => base.slots?.[k] && !base.slots[k].ok && cur.ok)
    .map(([k]) => k);
  if (slotB.length + slotC.length > 0)
    lines.push(
      `  slot flips (informational) — regressed [${slotB.join(', ') || '—'}] improved [${slotC.join(', ') || '—'}]`,
    );
  if (midP < 0.05 && b.length > c.length) {
    regressed = true;
    lines.push(
      `  REGRESSION — one-directional case flips are significant (mid-p ${midP.toFixed(3)} < 0.05)`,
    );
  }
  return { regressed, lines };
}

// ─── validate / coverage (0 LLM calls) ─────────────────────────────────────────────

/** Corpus + selection linter for one row: prompt-injection hazard in staged content, and
 * selectReviewers actually firing conventions-reviewer (a row whose staged files never reach the
 * declared roots would silently score as "gate free-skipped" mid-paid-run instead of here, free). */
export function validateRow(row: ConventionsCase): { problems: string[] } {
  const problems: string[] = [];
  for (const content of Object.values(row.repo.staged))
    if (typeof content === 'string' && INJECTION_RE.test(content))
      problems.push(
        'staged content contains a VIOLATION:/OFFENDING:/VERDICT:/NO_VIOLATIONS: token (prompt-injection hazard)',
      );
  let fx: ReturnType<typeof materializeFixture> | null = null;
  try {
    fx = materializeConventionsFixture(row);
    const cfg = resolveGuardConfig(fx.repo);
    const sel = selectReviewers(fx.staged, cfg).find((s) => s.reviewer.name === REVIEWER.name);
    if (!sel)
      problems.push(
        `selectReviewers does not fire ${REVIEWER.name} for this row's staged files — check FIXTURE_CONFIG.scanRoots`,
      );
  } catch (e) {
    problems.push(`fixture build failed — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    fx?.cleanup();
  }
  return { problems };
}

function validate({ dev = false }: { dev?: boolean } = {}) {
  cleanBenchEnv();
  let rows = loadCases();
  if (dev) rows = rows.filter((r) => !r.holdout);
  console.log(`${REVIEWER.name} — ${rows.length} rows`);
  let bad = 0;
  for (const row of rows) {
    const { problems } = validateRow(row);
    if (problems.length === 0) console.log(`  ${row.id.padEnd(46)} OK`);
    else {
      bad += 1;
      console.log(`  ${row.id.padEnd(46)} BAD   ${problems.join(' | ')}`);
    }
  }
  if (bad > 0) throw new BenchAbort(1, `conventions-eval: validate found ${bad} bad row(s)`);
  console.log('\nvalidate: all rows OK');
}

/** Coverage matrix (zero claude calls): category × expectedVerdict × difficulty cell counts, plus
 * provenance/holdout/variant/decoy-kind tallies. */
function printCoverage(rows: ConventionsCase[]) {
  console.log(`── conventions (${rows.length} rows) ──`);
  const cells: Record<string, number> = {};
  const tag: {
    provenance: Record<string, number>;
    holdout: number;
    variants: number;
    decoyKinds: Record<string, number>;
  } = { provenance: {}, holdout: 0, variants: 0, decoyKinds: {} };
  for (const r of rows) {
    const key = `${r.category.padEnd(24)} ${(r.expectedVerdict ?? 'unset').padEnd(6)} ${r.difficulty ?? 'unset'}`;
    cells[key] = (cells[key] ?? 0) + 1;
    const p = r.provenance ?? 'adapted';
    tag.provenance[p] = (tag.provenance[p] ?? 0) + 1;
    if (r.holdout) tag.holdout += 1;
    if (r.variantOf) tag.variants += 1;
    for (const d of r.decoys) tag.decoyKinds[d.kind] = (tag.decoyKinds[d.kind] ?? 0) + 1;
  }
  console.log(`  ${'category'.padEnd(24)} ${'verdict'.padEnd(6)} difficulty  rows`);
  for (const key of Object.keys(cells).sort()) console.log(`  ${key}  ${cells[key]}`);
  const goldTotal = rows.reduce((s, r) => s + r.gold.length, 0);
  const decoyTotal = rows.reduce((s, r) => s + r.decoys.length, 0);
  console.log(
    `  gold slots: ${goldTotal} · decoy slots: ${decoyTotal} · provenance: ${Object.entries(
      tag.provenance,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')} · holdout=${tag.holdout} · variant rows=${tag.variants}`,
  );
  console.log(
    `  decoys by kind: ${
      Object.entries(tag.decoyKinds)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') || '—'
    }`,
  );
  const unset = rows.filter((r) => !r.difficulty).length;
  if (unset) console.log(`  COVERAGE DEBT: ${unset} row(s) missing a difficulty tag`);
}

// ─── Matcher audit ──────────────────────────────────────────────────────────────────

/**
 * Join committed audit labels ({caseId, slotId, match: "F<n>"|"NONE"}) against the latest run's
 * transcripts and print percent agreement + Cohen's κ — verbatim the completeness-eval instrument
 * (see gate-engine/judge/matcher-core.mts's kappa). Policy: κ < 0.7 → the matcher is not trusted;
 * fix matcher.mts before reading headline metrics.
 */
export function matcherAudit(
  labelsText: string,
  readTranscript: (caseId: string) => { outcomes: { slotId: string; match: number }[] } | null,
) {
  const labels = parseCasesText(labelsText) as { caseId: string; slotId: string; match: string }[];
  if (!labels.length) throw new BenchAbort(2, 'conventions-eval: no audit labels');
  const a: string[] = [];
  const b: string[] = [];
  const missing: string[] = [];
  for (const l of labels) {
    const t = readTranscript(l.caseId);
    const o = t?.outcomes.find((x) => x.slotId === l.slotId);
    if (!o) {
      missing.push(`${l.caseId}::${l.slotId}`);
      continue;
    }
    a.push(l.match.toUpperCase());
    b.push(o.match === 0 ? 'NONE' : `F${o.match}`);
  }
  const agree = a.filter((x, i) => x === b[i]).length;
  return { n: a.length, agree, kappa: kappa(a, b), missing };
}

// ─── Cost estimate + ledger ─────────────────────────────────────────────────────────

function preflightClaude() {
  try {
    execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000 });
  } catch {
    throw new BenchAbort(2, 'conventions-eval: `claude` CLI not available — cannot benchmark');
  }
}

/** Budget from per-row costs, printed BEFORE any token is spent. Reviewer rows are cheap relative
 * to completeness's (single-pass haiku, no cascade, no checklist workflow — just one judge call
 * against pre-rendered evidence) — 20–90s vs completeness's 60–360s. */
function printEstimate(rows: ConventionsCase[], matchRuns: number) {
  const slots = rows.reduce((n, r) => n + r.gold.length + r.decoys.length, 0);
  const revLo = rows.length * 20;
  const revHi = rows.length * 90;
  const matcher = Math.round((slots * matchRuns * 15) / MATCH_CONCURRENCY);
  console.log(
    `conventions-eval: budget ≈ ${Math.round((revLo + matcher) / 60)}–${Math.round((revHi + matcher) / 60)} min  ` +
      `(${rows.length} reviewer rows × 20–90s (single-pass haiku, no cascade) · ${slots} slots × K=${matchRuns} matcher ÷ pool ${MATCH_CONCURRENCY})`,
  );
}

function appendLedger(entry: object) {
  try {
    appendFileSync(path.join(here, 'runs.log'), `${JSON.stringify(entry)}\n`);
  } catch {
    // The ledger is telemetry; never let it break a run.
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────────────

async function main(argv: string[]) {
  const args = new Set(argv);

  if (args.has('validate')) {
    validate({ dev: args.has('--dev') });
    process.exit(0);
  }

  const writeBaseline = args.has('--baseline');
  const failOnRegression = args.has('--fail');
  const devOnly = args.has('--dev');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;

  process.on('SIGINT', () => {
    activeCleanup?.();
    process.exit(130);
  });
  const stripped = cleanBenchEnv();
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])
    if (process.env[k] !== undefined) {
      delete process.env[k];
      stripped.push(k);
    }
  if (stripped.length)
    console.log(`conventions-eval: stripped env for a clean run: ${stripped.join(', ')}`);

  let rows = loadCases();

  if (args.has('coverage')) {
    printCoverage(rows);
    process.exit(0);
  }
  if (args.has('matcher-audit')) {
    if (!existsSync(auditLabelsPath))
      throw new BenchAbort(
        2,
        `conventions-eval: no ${path.basename(auditLabelsPath)} — label a held sample first`,
      );
    const res = matcherAudit(readFileSync(auditLabelsPath, 'utf8'), (caseId) => {
      const f = path.join(transcriptsDir, `${caseId}.json`);
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    });
    console.log(
      `matcher-audit: agreement ${fmtCi(res.agree, res.n)} · Cohen's κ ${res.kappa.toFixed(3)}`,
    );
    if (res.missing.length)
      console.log(
        `  ${res.missing.length} labelled slot(s) missing a transcript (stale labels or no run yet): [${res.missing.join(', ')}]`,
      );
    console.log(
      res.kappa >= 0.7
        ? '  κ ≥ 0.7 — matcher trusted'
        : '  κ < 0.7 — MATCHER NOT TRUSTED: fix matcher.mts before reading headline metrics',
    );
    process.exit(0);
  }

  if (devOnly && (writeBaseline || failOnRegression))
    throw new BenchAbort(
      2,
      'conventions-eval: --dev excludes holdout rows — not valid with --baseline/--fail',
    );
  if (only && (writeBaseline || failOnRegression))
    throw new BenchAbort(
      2,
      'conventions-eval: --only is an iteration subset — not valid with --baseline/--fail',
    );
  if (devOnly) rows = rows.filter((r) => !r.holdout);
  if (only) rows = rows.filter((r) => r.id.startsWith(only));
  if (!rows.length) throw new BenchAbort(2, 'conventions-eval: no rows after filtering');

  preflightClaude();
  if (!existsSync(AGENT_MD))
    throw new BenchAbort(2, `conventions-eval: ${AGENT_MD} missing — nothing to measure`);
  printEstimate(rows, MATCH_RUNS);

  const gh = gateHash();
  const mh = matcherHash();
  const baseline: { conventions?: BenchSummary } = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : {};
  const retryAgainst = baseline.conventions ?? null;

  const results: CaseResult[] = [];
  for (const row of rows) {
    const res = await runCase(row);
    // Alignment convention: a case whose outcome disagrees with the baseline re-runs ONCE.
    // 1-of-2 disagreement = instability (never a counted flip); 2-of-2 = a real flip.
    if (!res.outage && res.score && retryAgainst?.rows?.[row.id]) {
      const caseOk = res.score.slots.every((sl) => sl.outage || sl.ok);
      if (caseOk !== retryAgainst.rows[row.id].ok) {
        console.log(`  ${row.id.padEnd(46)} …disagrees with baseline — retrying once`);
        const res2 = await runCase(row, { saveTranscript: false });
        if (!res2.outage && res2.score) {
          const byId = new Map(res2.score.slots.map((sl) => [sl.slotId, sl]));
          for (const sl of res.score.slots) {
            const again = byId.get(sl.slotId);
            if (again && again.ok !== sl.ok) sl.stable = false; // unconfirmed → instability
          }
        }
      }
    }
    results.push(res);
    if (res.outage) console.log(`  ${row.id.padEnd(46)} OUTAGE (reviewer dark — row excluded)`);
    else if (res.score) {
      const sc = res.score;
      const hits = sc.slots.filter((x) => x.kind === 'gold' && x.ok).length;
      const goldN = sc.slots.filter((x) => x.kind === 'gold').length;
      const flagged = sc.slots.filter((x) => x.kind === 'decoy' && !x.ok).length;
      const decoyN = sc.slots.filter((x) => x.kind === 'decoy').length;
      const ok = hits === goldN && flagged === 0;
      console.log(
        `  ${row.id.padEnd(46)} ${ok ? 'OK  ' : 'FAIL'}  gold ${hits}/${goldN} · decoys flagged ${flagged}/${decoyN} · spurious ${sc.spurious.length}`,
      );
    }
  }
  if (results.length && results.every((r) => r.outage))
    throw new BenchAbort(2, 'conventions-eval: every case was an outage');

  const s = summarize(rows, results);
  s.gateHash = gh;
  s.matcherHash = mh;
  s.corpusHash = sha12(JSON.stringify(rows));

  console.log(
    `\nconventions: ${results.length} case(s)  [matcher=${s.matchModel} K=${s.matchRuns} · reviewer=haiku single-pass, no cascade]`,
  );
  console.log(
    `  headline: gap recall ${fmtCi(s.gold.hit, s.gold.total)}  (floor ${FLOOR_GAP_RECALL})`,
  );
  console.log(
    `  headline: false-flag rate ${fmtCi(s.decoys.flagged, s.decoys.total)}  (ceiling ${CEILING_FALSE_FLAG})`,
  );
  for (const [kindName, k] of Object.entries(s.decoys.byKind))
    console.log(`    ${kindName.padEnd(18)} flagged ${fmtCi(k.flagged, k.total)}`);
  console.log(
    `  finding precision (informational): ${fmtCi(s.findings.matched, s.findings.total)} · spurious/case ${(s.findings.spurious / Math.max(1, s.cases - s.caseOutages)).toFixed(1)}`,
  );
  if (s.verdicts.total)
    console.log(`  verdict line (informational): ${fmtCi(s.verdicts.correct, s.verdicts.total)}`);
  if (s.outages)
    console.log(
      `  outages: ${s.caseOutages} case(s) + ${s.slotOutages} slot(s) — score is suspect, rerun before trusting`,
    );
  const vc = variantConsistency(rows, s);
  if (vc)
    console.log(
      `  variant consistency: ${vc.consistent}/${vc.total} groups${vc.broken.length ? ` — broken: [${vc.broken.join(', ')}]` : ''}`,
    );

  const { regressed, lines } = compareConventions(s, baseline.conventions);
  if (existsSync(baselinePath)) for (const l of lines) console.log(l);

  appendLedger({
    ts: new Date().toISOString(),
    args: [...args],
    matchModel: s.matchModel,
    matchRuns: s.matchRuns,
    gateHash: gh,
    matcherHash: mh,
    corpusHash: s.corpusHash,
    cases: s.cases,
    gapRecall: Number(s.gapRecall.toFixed(3)),
    falseFlagRate: Number(s.falseFlagRate.toFixed(3)),
    outages: s.outages,
    regressed,
  });

  if (writeBaseline) {
    baseline.conventions = s;
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\nwrote baseline → ${path.relative(process.cwd(), baselinePath)}`);
  }
  if (failOnRegression && regressed) {
    console.error(
      '\nFAIL: floor breach or statistically significant one-directional case flips vs baseline.',
    );
    process.exit(1);
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => {
    if (e instanceof BenchAbort) {
      console.error(e.message);
      process.exit(e.code);
    }
    throw e;
  });
}
