/**
 * Review-gate orchestration (guard-review --gate): the domain reviewers that used to be
 * root-agent-invoked subagents (+ forgeable `.passed` marker files) run HERE, in-chain, as
 * parallel headless judges over the staged diff.
 *
 * Per selected reviewer, a CASCADE (check-alignment shape): the first pass (sonnet) investigates
 * with read-only tools; ONLY its FAIL escalates to opus, which re-investigates with the full
 * first-pass transcript and independently confirms or overturns. A block requires an
 * opus-confirmed FAIL.
 *
 * Contract:
 *   exit 1 = at least one opus-confirmed FAIL
 *   exit 2 = no FAIL, but at least one judge was inconclusive (outage / no VERDICT line) → the
 *            hook treats this as fail-open (non-strict runs only)
 *   exit 3 = strict runs only (GUARD_AI_STRICT, set by devkit ship): a judge stayed inconclusive
 *            after the retry, or the gate could not run — FAIL-CLOSED, distinct from exit 1 so a
 *            hook never renders an outage as "opus-confirmed FAIL"
 *   exit 0 = every selected reviewer PASSed (live, or via the diff-hash cache), or nothing to do
 *
 * Knobs: GUARD_NO_REVIEW=1 skip · GUARD_REVIEW_MODEL first-pass model (default haiku — the
 *   reviewer-eval bench validated the domain reviewers at haiku, 6/6 block/6/6 clean; a FAIL still
 *   escalates to opus, so opus stays the block authority) ·
 * GUARD_REVIEW_SKIP comma-list of reviewer names to disable individually ·
 * GUARD_REVIEW_CONCURRENCY max judge cascades in flight (default 2, floor 1) ·
 * GUARD_AI_STRICT=1 ship mode (first-pass retry once, then fail closed) · cfg.noLlm skip.
 * FRINK_* aliases honoured. Judges are isolated (JUDGE_ISOLATION) with an airtight read-only
 * allowlist — a gate judge can never write, stage, or commit.
 *
 * W-3: config + git + agent .md files all resolve against the CONSUMER cwd.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { envFlag, type GuardConfig, resolveGuardConfig } from '../config.mts';
import { emitGateEvent } from '../judge/gate-events.mts';
import { JUDGE_ISOLATION } from '../judge/judge-isolation.mts';
import { execJudgeAsync } from '../judge/run-judge.mts';
import { composeTranscript, saveTranscript } from '../judge/transcript-store.mts';
import { loadCache, savePasses } from './cache.mts';
import { renderGoverningClaudeMd } from './claude-md.mts';
import { buildCappedDiffEvidence } from './diff-evidence.mts';
import { blockingNote, reconcile } from './overrides.mts';
import { clearProgress, writeProgress } from './progress.mts';
import {
  allowedToolsFor,
  type ChecklistState,
  cacheKey,
  escalatePrompt,
  hasChecklist,
  parseConventionFindings,
  parseReviewVerdict,
  type Reviewer,
  type ReviewerSelection,
  selectReviewers,
  verifyChecklist,
  wrapConventionsPrompt,
  wrapPrompt,
} from './reviewers.mts';

/** One reviewer's cascade outcome. `transcript` rides along on EVERY judged outcome (pass/fail/
 * no-VERDICT) — the FAIL loop prints it (a block whose evidence was discarded is undebuggable) and
 * every outcome persists it as a fetchable transcript (saveTranscript) so a passing reviewer's
 * reasoning is showcasable, not thrown away. Absent only when no judge ran (a hard outage). */
interface CascadeResult {
  name: string;
  status: 'pass' | 'fail' | 'inconclusive';
  reason: string;
  escalated: boolean;
  transcript?: string;
  /** The model that actually ran the first pass (Reviewer.model pin, else the cascade default).
   * Absent only when no judge ran (missing brief). Telemetry/cache must report THIS, never the
   * global default — a sonnet-pinned reviewer's verdict labeled 'haiku' sends readers of the
   * usage dashboard chasing a model downgrade that never happened. */
  model?: string;
}

// A missing brief / missing checklist artifact is a SYNC gap, not an auth/quota outage — the strict
// remedy branches on it (see the inconclusive loop). Matches the reasons set in cascadeVerdict
// (`agent brief …`) and verifyChecklist (`checklist artifact missing …`).
const SYNC_INCONCLUSIVE_RE = /^agent brief |^checklist artifact missing/;

// GUARD_REVIEW_SKIP / FRINK_REVIEW_SKIP: comma-list of reviewer names to drop from a run — the
// per-reviewer rollback lever (GUARD_NO_REVIEW kills the whole gate; this surgically disables one).
function skippedReviewers(): Set<string> {
  return new Set(
    (process.env.GUARD_REVIEW_SKIP ?? process.env.FRINK_REVIEW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Orchestration inputs threaded through a cascade (config + the injectable judge runner). */
interface CascadeOpts {
  cwd: string;
  cfg: GuardConfig;
  exec?: typeof execJudgeAsync;
  firstModel?: string;
  retryFirst?: boolean;
}

// Judge timeouts include the checklist workflow (generate → per-item marks → finalize) on top of
// diff investigation. The per-pass caps are GENEROUS (30 min): the correctness reviewer's deep
// four-lens investigation legitimately runs past the old 420s cap and got SIGKILLed mid-verdict —
// measured on the usage-tracker as repeated 421s inconclusive timeouts while the median run is
// ~60-250s. The cap is sized for the slow-but-working judge, not the median. A judge that TIMES OUT
// is never re-run (see cascadeVerdict), so a stuck judge still costs at most one cap, not two.
//
// Budget arithmetic — the ship ceiling bounds the WHOLE hook chain, not this gate alone: deterministic
// prefix ~240s + decisions ≤60s (both ≈0 on a cache hit) + this cascade gate. PER-CASCADE worst ≈
// 1×1800 (first pass) + 1800 (escalate) = 3600s. With the concurrency cap (GUARD_REVIEW_CONCURRENCY,
// default 2) cascades run in ceil(N/K) WAVES, so the theoretical worst wall-clock far exceeds
// SHIP_COMMIT_TIMEOUT (now 3600s default) — by design: a killed ship CONVERGES on re-run because
// PASSes checkpoint per-completion and the caches skip everything already earned
// (docs/decisions/ship-gates-converge-not-restart.md). In practice only correctness approaches the
// cap; the rest finish <300s, so a real ship is one slow wave + fast waves, comfortably under 3600s.
//
// NOTE: a single pass can now exceed the 600s foreground tool cap — an AGENT-driven commit (the gate
// run inside a Bash tool) is still killed at 600s, so the generous caps take FULL effect only for a
// commit run in a real terminal (or a detached ship), where SHIP_COMMIT_TIMEOUT is the outer bound.
const FIRST_TIMEOUT_MS = 1800000; // 30 min — the slow-but-working reviewer (correctness) needs the room
// ship/strict first pass shares the same generous cap; the outer SHIP_COMMIT_TIMEOUT is the safety net.
const STRICT_FIRST_TIMEOUT_MS = 1800000;
const ESCALATE_TIMEOUT_MS = 1800000; // opus re-investigation; only fires pre-block, never retried

// Bounded-concurrency map: at most `limit` fn calls in flight, input order preserved.
// LOAD-BEARING: fn must never reject — the caller pre-wraps the cascade body in .catch. A worker
// rejection here would reject Promise.all and abandon siblings' pending per-completion checkpoints.
// ponytail: static pool. Load-adaptive sizing (os.loadavg / live concurrent-`claude` count) is the
// upgrade path if one fixed cap ever proves too blunt across differently-loaded machines.
async function mapLimit<T, R>(
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

// Max judge cascades in flight (GUARD_REVIEW_CONCURRENCY / FRINK_ alias). Default 2 — enough to keep
// wall-clock down while leaving each judge the CPU + subscription slots to finish under its 300s
// timeout on a loaded box. Garbage / 0 / negative / float-below-1 → default; floor 1 (=1 serializes).
const DEFAULT_REVIEW_CONCURRENCY = 2;
function reviewConcurrency() {
  const n = Number.parseInt(
    process.env.GUARD_REVIEW_CONCURRENCY ?? process.env.FRINK_REVIEW_CONCURRENCY ?? '',
    10,
  );
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_REVIEW_CONCURRENCY;
}

// argv-based on purpose: staged FILENAMES ride these calls, and a shell string (even
// JSON.stringify-quoted) lets a crafted path like `$(cmd).ts` expand before git runs.
function gitCached(cwd: string, args: string[], files: string[]): string {
  return execFileSync('git', ['diff', '--cached', ...args, '--', ...files], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function stagedFiles(cwd: string): string[] {
  return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function agentBody(cwd: string, cfg: GuardConfig, name: string): string | null {
  const dir = cfg.review.agentsDir;
  const file = path.join(path.isAbsolute(dir) ? dir : path.resolve(cwd, dir), `${name}.md`);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Parsed checklist state-file artifact for a reviewer, or null (missing/corrupt/no checklist at
 * all — a skill-less reviewer has no stateFile to read → unverifiable). */
function readChecklistState(cwd: string, reviewer: Reviewer): ChecklistState | null {
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
function cleanupChecklistState(cwd: string, reviewer: Reviewer): void {
  if (!reviewer.stateFile) return;
  rmSync(path.resolve(cwd, reviewer.stateFile), { force: true });
}

/**
 * One reviewer's cascade → {name, status: 'pass'|'fail'|'inconclusive', reason, escalated}.
 * `exec` is injectable for tests; the gate always passes execJudgeAsync.
 *
 * Wraps the verdict cascade with the checklist-artifact contract: the state file is cleaned
 * BEFORE the judge runs (a stale artifact from an interactive session must never satisfy the
 * gate), a PASS is voided to inconclusive when the artifact is missing/incomplete/inconsistent
 * (verifyChecklist), and the artifact is removed afterwards either way.
 */
// Deterministic domain-exclusivity guard for the bench-measured cross-domain false-blocks
// (xdomain-sqli / xdomain-render: correctness FAILs a lens for a defect the security/performance
// reviewers own — see agents/correctness-reviewer.md <exclusions>). ONE-SIDED and best-effort:
// drops a failing lens ONLY when its reason matches an out-of-charter keyword AND matches NO
// correctness-signal keyword — biased to UNDER-fire (keep the FAIL when in doubt) so it carries no
// recall cost. It is NOT a semantic arbiter and NOT a guarantee: its safety is proportional to the
// CORRECTNESS_SIGNAL coverage below, so that list is kept deliberately broad. Covers cross-domain
// leaks ONLY (2 of the bench's 4 false-blocks). The in-domain surface-cue false-blocks want K-sample
// self-consistency with an asymmetric block rule (Wang 2203.11171), NOT a same-family verify/refute
// pass — such a pass overturns real FAILs (measured 0.78→0.67 here; Huang 2310.01798, Stechly
// 2402.08115) and only pays off cross-family (Lu 2512.02304). Precision to ~0.95 is also unmeasurable
// until the decoy corpus grows (n=28 → clean-pass CI [.69,.94]).
const OUT_OF_CHARTER =
  /\b(sql|injection|xss|csrf|sanitiz|escap|secrets?|credentials?|deserializ|n\+1|select\s+\*|pagination|unbounded|re-?render|bundle\s?size|memoiz|throughput|latenc|perf(ormance)?)\b/i;
// Deliberately broad — every miss here risks dropping a real FAIL, so err toward inclusion.
const CORRECTNESS_SIGNAL =
  /\b(race|interleav|concurren|clobber|overwrit|overwrote|lost\s?update|stale|reset|invalidat|discard|dropped|unhandled|unchecked|ignored\s+(return|result|error)|missing|contract|signature|call\s?site|broadcast|dedup|classif|pars(e|ing)|off-by|wrong\s+(result|state|value)|incorrect|stuck|deadlock|leak|finally|rollback|revert|strand|CAS|atomic|toctou|check[\s-]?then[\s-]?act|order(ing)?|sequenc|idempoten|mutat|await|promise|callback|null|undefined|double[\s-]?(fire|write)|early\s+(return|exit)|exit\s?code|fall[\s-]?through|latch|unclaim|revive|cancel|retry|resum|recover)\b/i;

/** Partition a checklist's failing lenses into ones that still block (`kept`) and ones dropped as
 * out-of-charter (`dropped`). A lens drops only when its issues are unambiguously security/perf. */
export function domainExclusivityDrop(
  items: { name?: string; status?: string; issues?: string[] }[] = [],
): { kept: string[]; dropped: { lens: string; reason: string }[] } {
  const kept: string[] = [];
  const dropped: { lens: string; reason: string }[] = [];
  for (const it of items) {
    if (it.status !== 'fail') continue;
    const lens = it.name ?? '(finding)';
    const text = (it.issues ?? []).join(' \n ');
    if (text && OUT_OF_CHARTER.test(text) && !CORRECTNESS_SIGNAL.test(text))
      dropped.push({ lens, reason: text });
    else kept.push(lens);
  }
  return { kept, dropped };
}

export async function runCascade(
  sel: ReviewerSelection,
  opts: CascadeOpts,
): Promise<CascadeResult> {
  const { cwd } = opts;
  cleanupChecklistState(cwd, sel.reviewer);
  const res = await cascadeVerdict(sel, opts);
  if (res.status === 'pass' && sel.reviewer.stateFile) {
    // A skill-less reviewer (no stateFile) has no artifact to verify — its PASS is trusted
    // directly, the same trust level completeness.mts already uses for its own straight verdict;
    // its substitute anti-hallucination mechanism is the AC's own quote-both-or-stay-silent
    // contract, enforced by the brief, not an artifact this gate can independently check.
    const hole = verifyChecklist(readChecklistState(cwd, sel.reviewer), 'PASS');
    if (hole) {
      res.status = 'inconclusive';
      res.reason = hole;
    }
  }
  // Override valve — a single-pass (model-pinned) reviewer's FAIL blocks unless each failed lens is
  // waived with a rationale (env OVERRIDE_<fp>_RATIONALE or .devkit/correctness-overrides.json). All
  // waived → PASS; any un-waived → still FAIL, its reason names the fingerprints + how to waive them.
  // Read the artifact BEFORE the cleanup below (the fingerprint needs the failed lens names).
  if (res.status === 'fail' && sel.reviewer.model) {
    // A checklist reviewer's lens is the checklist item name (stable: fixed per diff, deterministic
    // parsing). A skill-less reviewer has no checklist — its lens is the OFFENDING path:line each
    // violation names (parseConventionFindings), deterministic for a fixed diff exactly like a
    // checklist item name. Neither ever uses the free-text VERDICT reason: a haiku judge's one-line
    // paraphrase of the SAME violation can vary run-to-run on byte-identical input, which would
    // silently un-match a dev's already-committed waiver and re-block them.
    const state = readChecklistState(cwd, sel.reviewer);
    const items = state?.items ?? [];
    const failedCount = items.filter((i) => i.status === 'fail').length;
    // Domain-exclusivity guard (checklist reviewers only): drop failing lenses flagging a
    // security/performance defect this reviewer must stay silent on. One-sided/best-effort (see
    // domainExclusivityDrop); conventions has no checklist, so this is a no-op there.
    const { kept, dropped } = domainExclusivityDrop(items);
    for (const d of dropped)
      console.error(
        `guard-review: ${sel.reviewer.name} — ${d.lens} dropped as out-of-charter (security/performance is another reviewer's finding)`,
      );
    // A skill-less reviewer (conventions) has no checklist — its lens is the OFFENDING path:line each
    // violation names (parseConventionFindings), never the free-text VERDICT reason.
    const conventionLenses = parseConventionFindings(res.transcript ?? '').map(
      (f) => `${f.offendingPath}:${f.offendingLine}`,
    );
    const failedLenses = sel.reviewer.stateFile ? kept : conventionLenses;
    // All checklist lenses dropped as out-of-charter → not a correctness block (checklist reviewers only).
    if (sel.reviewer.stateFile && failedCount > 0 && kept.length === 0) {
      res.status = 'pass';
      res.reason = `${dropped.length} out-of-charter finding(s) dropped (owned by security/performance reviewer)`;
    } else {
      const lenses = failedLenses.length > 0 ? failedLenses : ['(finding)'];
      const diffText = gitCached(cwd, [], sel.files);
      const { suppressed, blocking } = reconcile(
        cwd,
        sel.reviewer.name,
        lenses,
        diffText,
        new Date().toISOString(),
      );
      for (const s of suppressed)
        console.error(
          `guard-review: ${sel.reviewer.name} — ${s.lens} overridden [${s.fp}]: ${s.rationale}`,
        );
      if (blocking.length === 0) {
        res.status = 'pass';
        res.reason = `all ${suppressed.length} finding(s) overridden`;
      } else {
        res.reason = blockingNote(sel.reviewer.name, blocking);
      }
    }
  }
  cleanupChecklistState(cwd, sel.reviewer);
  return res;
}

async function cascadeVerdict(
  { reviewer, files }: ReviewerSelection,
  { cwd, cfg, exec = execJudgeAsync, firstModel = 'haiku', retryFirst = false }: CascadeOpts,
): Promise<CascadeResult> {
  const body = agentBody(cwd, cfg, reviewer.name);
  if (body === null)
    // A missing brief must never be judged as an EMPTY brief (a wrapper-only prompt fake-passes):
    // inconclusive → fail-open on a normal commit, fail-closed on a ship — exactly the loudness
    // an updated-CLI-but-unsynced-agents consumer needs.
    return {
      name: reviewer.name,
      status: 'inconclusive',
      reason: `agent brief ${reviewer.name}.md missing under ${cfg.review.agentsDir} — run devkit sync-agents && devkit sync-skills`,
      escalated: false,
    };
  // A skill-less reviewer (no checklist, no Bash) gets its evidence PRE-RENDERED instead of a
  // "fetch it yourself" instruction: the capped diff (diff-evidence.mts) rides on stdin exactly
  // like completeness.mts's judge, and the governing CLAUDE.md rules (claude-md.mts) are baked
  // into the prompt itself.
  const stat = gitCached(cwd, ['--stat'], files);
  const prompt = hasChecklist(reviewer)
    ? wrapPrompt(body, reviewer, files)
    : wrapConventionsPrompt(body, files, renderGoverningClaudeMd(cwd, files));
  const input = hasChecklist(reviewer)
    ? stat
    : buildCappedDiffEvidence(gitCached(cwd, [], files), stat);
  const args = (p: string, model: string): string[] => [
    '-p',
    p,
    '--model',
    model,
    ...JUDGE_ISOLATION,
    '--allowedTools',
    allowedToolsFor(reviewer, cfg),
  ];
  // A model-pinned reviewer (correctness, conventions) runs single-pass at its pinned model — no escalation.
  const passModel = reviewer.model ?? firstModel;
  let firstOutage: 'timeout' | 'transient' | 'empty' | undefined;
  const firstOpts = {
    label: `review:${reviewer.name}`,
    args: args(prompt, passModel),
    input,
    timeout: retryFirst ? STRICT_FIRST_TIMEOUT_MS : FIRST_TIMEOUT_MS, // retryFirst === strict/ship
    cwd,
    transcript: false, // this gate persists its own review-<name> transcript — don't store twice
    onOutage: (kind: 'timeout' | 'transient' | 'empty') => {
      firstOutage = kind;
    },
  };
  let first = await exec(firstOpts);
  if (first === null && retryFirst && firstOutage !== 'timeout') {
    // Strict (ship) runs get ONE first-pass retry — a TRANSIENT/empty failure must not fail a ship
    // closed. A TIMEOUT is NOT retried: the strict first pass already ran on the longer
    // STRICT_FIRST_TIMEOUT_MS (a contended judge got its extra time UP FRONT), so a re-run burns the
    // same budget past the ship ceiling. The escalation pass never retries: outage stays inconclusive.
    // Colon (not " — ") on purpose: the ship timeout banner's awk reads `<name> — ` as COMPLETED.
    console.error(
      `guard-review: ${reviewer.name}: judge run failed (${firstOutage ?? 'transient'}), retrying once…`,
    );
    cleanupChecklistState(cwd, reviewer); // a dead first pass may have left partial rows
    first = await exec(firstOpts);
  }
  if (first === null)
    return {
      name: reviewer.name,
      status: 'inconclusive',
      reason: 'judge outage',
      escalated: false,
      model: passModel,
    };
  const firstVerdict = parseReviewVerdict(first);
  if (firstVerdict.verdict === 'PASS')
    // Keep the judge's one-line PASS reason (the tail of its VERDICT line) instead of dropping it —
    // it flows to the telemetry event + the terminal line, and `first` is persisted as a transcript.
    return {
      name: reviewer.name,
      status: 'pass',
      reason: firstVerdict.reason,
      escalated: false,
      model: passModel,
      transcript: first,
    };
  if (firstVerdict.verdict === null)
    return {
      name: reviewer.name,
      status: 'inconclusive',
      reason: 'no VERDICT line',
      escalated: false,
      model: passModel,
      transcript: first,
    };
  // Single-pass (model-pinned) reviewer: this FAIL is final — no opus escalation to second-guess it.
  if (reviewer.model)
    return {
      name: reviewer.name,
      status: 'fail',
      reason: firstVerdict.reason,
      escalated: false,
      model: passModel,
      transcript: first,
    };
  const second = await exec({
    label: `review:${reviewer.name}:escalate`,
    args: args(escalatePrompt(prompt, first), 'opus'),
    input: stat,
    timeout: ESCALATE_TIMEOUT_MS,
    cwd,
    transcript: false, // this gate persists its own review-<name> transcript — don't store twice
  });
  if (second === null)
    return {
      name: reviewer.name,
      status: 'inconclusive',
      reason: 'escalation outage',
      escalated: true,
      model: passModel,
      transcript: first, // the first-pass FAIL evidence survives even when opus was dark
    };
  const finalVerdict = parseReviewVerdict(second);
  if (finalVerdict.verdict === 'FAIL')
    return {
      name: reviewer.name,
      status: 'fail',
      reason: finalVerdict.reason,
      escalated: true,
      model: passModel,
      transcript: second,
    };
  if (finalVerdict.verdict === 'PASS')
    return {
      name: reviewer.name,
      status: 'pass',
      reason: finalVerdict.reason,
      escalated: true,
      model: passModel,
      transcript: second,
    };
  return {
    name: reviewer.name,
    status: 'inconclusive',
    reason: 'no VERDICT line',
    escalated: true,
    model: passModel,
    transcript: second,
  };
}

/**
 * The gate → exit code (see module contract). Selected reviewers run concurrently but BOUNDED to
 * `reviewConcurrency()` cascades in flight (GUARD_REVIEW_CONCURRENCY, default 2) — so under machine
 * load each judge keeps enough CPU + subscription slots to finish under its timeout. Wall-clock is
 * ceil(N/K) waves of the slowest cascade rather than the single slowest, a deliberate trade.
 */
export async function runReviewGate(
  cwd = process.cwd(),
  { exec = execJudgeAsync }: { exec?: typeof execJudgeAsync } = {},
): Promise<number> {
  if (envFlag('NO_REVIEW')) return 0;
  const strict = envFlag('AI_STRICT'); // the ship path sets this: retry once, then fail CLOSED
  let cfg: GuardConfig;
  let selected: ReviewerSelection[];
  let diffs: string[];
  try {
    cfg = resolveGuardConfig(cwd);
    if (cfg.noLlm) return 0;
    selected = selectReviewers(stagedFiles(cwd), cfg);
    const skip = skippedReviewers();
    if (skip.size > 0) {
      // never a silent cap: name what the knob dropped
      for (const d of selected.filter((s) => skip.has(s.reviewer.name)))
        console.error(`guard-review: ${d.reviewer.name} skipped (GUARD_REVIEW_SKIP)`);
      selected = selected.filter((s) => !skip.has(s.reviewer.name));
    }
    if (selected.length === 0) return 0;
    // One domain diff per reviewer (its cache identity): the exact staged bytes in its files.
    diffs = selected.map((s) => gitCached(cwd, [], s.files));
  } catch (e: unknown) {
    console.error(
      `guard-review: could not run — ${e instanceof Error ? e.message : String(e)}${strict ? ' (strict ship mode: failing closed)' : ''}`,
    );
    return strict ? 3 : 2; // fail-open, except on a ship
  }

  const cache = loadCache(cwd);
  const firstModel = process.env.GUARD_REVIEW_MODEL ?? process.env.FRINK_REVIEW_MODEL ?? 'haiku';
  const concurrency = reviewConcurrency();
  const toRun: { sel: ReviewerSelection; key: string; diffText: string }[] = [];
  for (let i = 0; i < selected.length; i++) {
    const key = cacheKey(selected[i].reviewer.name, diffs[i]);
    if (cache[key])
      console.error(`guard-review: ${selected[i].reviewer.name} — cached PASS (identical diff)`);
    else toRun.push({ sel: selected[i], key, diffText: diffs[i] });
  }
  if (toRun.length === 0) return 0;

  console.error(
    `guard-review: running ${toRun.map((t) => t.sel.reviewer.name).join(', ')} (≤${concurrency} concurrent, ${firstModel} → opus on FAIL)…`,
  );
  // Each cascade CHECKPOINTS as it lands: its PASS is persisted per-completion (not after the
  // barrier), so a run killed by the ship timeout keeps every finished verdict and the retry
  // re-runs only the unfinished reviewers. On a ship (DEVKIT_REVIEW_PROGRESS set by the ship's
  // commit-with-gate-capture.sh) each completion is ALSO recorded to that progress JSON — the
  // STRUCTURED contract the timeout banner reads to name unfinished reviewers (`progress.mjs
  // unfinished`), replacing the old awk-parse of these stderr heartbeat lines. The lines below stay,
  // but for humans only. The .catch keeps one cascade's throw from rejecting the whole mapLimit run
  // (a worker rejection would abandon its siblings' still-pending completions — see mapLimit).
  const progressFile = process.env.DEVKIT_REVIEW_PROGRESS || null;
  // `running` = every reviewer to run, recorded up front. Under the concurrency cap some are QUEUED,
  // not yet started, so on a mid-flight kill `unfinishedReviewers` (running − completed) also names
  // never-started reviewers. Correct for the banner's purpose — they're uncached and WILL be retried.
  const running = toRun.map((t) => t.sel.reviewer.name);
  const completed: string[] = [];
  if (progressFile) writeProgress(progressFile, { running, completed });
  const results = await mapLimit(toRun, concurrency, (t) => {
    const t0 = Date.now();
    return runCascade(t.sel, { cwd, cfg, exec, firstModel, retryFirst: strict })
      .catch(
        (e): CascadeResult => ({
          name: t.sel.reviewer.name,
          status: 'inconclusive',
          reason: `engine error: ${e?.message ?? e}`,
          escalated: false,
        }),
      )
      .then((res) => {
        if (res.status === 'pass')
          // res.model = the model that actually judged (a Reviewer.model pin wins over the cascade
          // default) — recording firstModel here mislabeled every pinned reviewer's cached PASS.
          savePasses(cwd, {
            [t.key]: { at: new Date().toISOString(), model: res.model ?? firstModel },
          });
        if (progressFile) {
          completed.push(res.name);
          writeProgress(progressFile, { running, completed });
        }
        const secs = Math.round((Date.now() - t0) / 1000);
        // Persist the full judge transcript — the reviewed diff AND the agent's output — so a PASS
        // reviewer's reasoning is fetchable on demand rather than discarded; the event carries only
        // the ref + one-liner. No-op off-run (see run-context.mts).
        const transcriptRef = res.transcript
          ? saveTranscript(`review-${res.name}`, composeTranscript(t.diffText, res.transcript))
          : null;
        // Ship telemetry (best-effort, no-op off-ship): every reviewer outcome (pass/fail/
        // inconclusive) so the usage tracker can report per-reviewer error counts and fail-rate.
        emitGateEvent({
          type: 'review_result',
          reviewer: res.name,
          status: res.status,
          escalated: res.escalated,
          // First-pass model that actually ran (pin-aware); firstModel only when no judge ran at
          // all (missing brief / engine error), keeping the field always present for consumers.
          model: res.model ?? firstModel,
          reason: res.reason,
          secs,
          ...(transcriptRef ? { transcript_ref: transcriptRef } : {}),
        });
        // Surface the one-line verdict reason on the completion line too (fails get theirs in the
        // dedicated block below, with the full transcript — don't double-print it here).
        const tail = res.status !== 'fail' && res.reason ? ` — ${res.reason}` : '';
        console.error(
          `guard-review: ${res.name} — ${res.status.toUpperCase()}${res.escalated ? ' (escalated)' : ''} in ${secs}s${res.status === 'pass' ? ' (checkpointed)' : ''}${tail}`,
        );
        return res;
      });
  });
  if (progressFile) clearProgress(progressFile); // ran to completion → nothing unfinished to report

  const fails = results.filter((r) => r.status === 'fail');
  for (const f of fails) {
    console.error(
      `guard-review: ${f.name} FAILED${f.escalated ? ' (opus-confirmed)' : ''} — ${f.reason || 'see findings below'}`,
    );
    if (f.transcript) console.error(f.transcript.trim());
  }
  if (fails.length > 0) return 1;
  const inconclusive = results.filter((r) => r.status === 'inconclusive');
  for (const r of inconclusive) {
    // The remedy must match the CAUSE: a missing brief (cascadeVerdict) or missing checklist artifact
    // (verifyChecklist) is a SYNC gap — the auth/quota remedy is actively wrong and contradicts the
    // reason. In a `devkit ship` worktree the briefs/skills must also be LINKED in (ship-branch.sh
    // does this); an un-synced main checkout is the other cause. Runtime outages (judge outage, no
    // VERDICT, engine error) keep the auth/quota remedy.
    const syncCause = SYNC_INCONCLUSIVE_RE.test(r.reason);
    const remedy = syncCause
      ? 'run `devkit sync-agents && devkit sync-skills` so the briefs + checklist scripts are present, then re-run devkit ship'
      : 'check `claude` CLI auth/quota, then re-run devkit ship';
    console.error(
      strict
        ? `guard-review: ${r.name} INCONCLUSIVE (${r.reason}) — strict ship mode fails closed.\n` +
            `   Remedy: ${remedy} (completed verdicts are cached).`
        : `guard-review: ${r.name} inconclusive — ${r.reason} (fail-open, not cached)`,
    );
  }
  if (inconclusive.length > 0) return strict ? 3 : 2;
  return 0;
}

/** `guard-review scan` — reviewer→files mapping + cache status, no judges. Informational. */
export function scanReview(cwd = process.cwd()) {
  try {
    const cfg = resolveGuardConfig(cwd);
    const cache = loadCache(cwd);
    for (const s of selectReviewers(stagedFiles(cwd), cfg)) {
      const diff = gitCached(cwd, [], s.files);
      const hit = cache[cacheKey(s.reviewer.name, diff)] ? ' [cached PASS]' : '';
      console.log(`${s.reviewer.name}${hit}: ${s.files.join(', ')}`);
    }
  } catch (e: unknown) {
    console.error(`guard-review: scan failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  return 0;
}
