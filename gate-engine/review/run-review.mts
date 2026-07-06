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
 * Knobs: GUARD_NO_REVIEW=1 skip · GUARD_REVIEW_MODEL first-pass model (default sonnet) ·
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
import { JUDGE_ISOLATION } from '../judge/judge-isolation.mts';
import { execJudgeAsync } from '../judge/run-judge.mts';
import { loadCache, savePasses } from './cache.mts';
import { clearProgress, writeProgress } from './progress.mts';
import {
  allowedToolsFor,
  type ChecklistState,
  cacheKey,
  escalatePrompt,
  parseReviewVerdict,
  type Reviewer,
  type ReviewerSelection,
  selectReviewers,
  verifyChecklist,
  wrapPrompt,
} from './reviewers.mts';

/** One reviewer's cascade outcome. `transcript` rides along on a FAIL so the gate can print the
 * judge's full findings — a block whose evidence was discarded is undebuggable. */
interface CascadeResult {
  name: string;
  status: 'pass' | 'fail' | 'inconclusive';
  reason: string;
  escalated: boolean;
  transcript?: string;
}

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
// diff investigation. Budget arithmetic — the ship ceiling bounds the WHOLE hook chain, not this
// gate alone: deterministic prefix ~240s (≈0 on a guard-prefix hit) + decisions ≤60s (≈0 on a
// verdict-cache hit) + this cascade gate. Under strict (ship) the first pass gets the longer
// STRICT_FIRST_TIMEOUT_MS so a judge merely CONTENDED — not workload-slow — finishes on its one pass
// instead of a SIGTERM → spurious exit-3. PER-CASCADE worst ≈ 2×420 (strict retry on a TRANSIENT/
// empty first pass only — a TIMEOUT first pass is NOT re-run, capping a timed-out strict judge at
// 1×420) + 420 escalate = 1260s. With the concurrency cap (GUARD_REVIEW_CONCURRENCY, default 2) the
// gate runs cascades in ceil(N/K) WAVES, so its worst wall-clock ≈ ceil(N/K)×1260s — e.g. 5 reviewers
// at K=2 = 3×1260 = 3780s, which CAN exceed SHIP_COMMIT_TIMEOUT (1800s default). That is by design: a
// killed ship CONVERGES on re-run because PASSes checkpoint per-completion and the caches skip
// everything already earned (docs/decisions/ship-gates-converge-not-restart.md). A SINGLE attempt
// stays ≤420s, under the 600s foreground tool cap. The cap trades a possible extra ship attempt for
// each judge getting the CPU + subscription slots to finish under its timeout — the self-saturation
// this gate used to suffer when it fanned out ALL N judges at once.
const FIRST_TIMEOUT_MS = 300000; // normal developer commits
// ship/strict first pass gets the escalate-length cap: a judge merely CONTENDED (parallel `claude`
// CPU/subscription pressure), not workload-slow, finishes instead of a SIGTERM → false exit-3.
const STRICT_FIRST_TIMEOUT_MS = 420000;
const ESCALATE_TIMEOUT_MS = 420000; // only fires pre-block; never retried (see cascadeVerdict)

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

/** Parsed checklist state-file artifact for a reviewer, or null (missing/corrupt → unverifiable). */
function readChecklistState(cwd: string, reviewer: Reviewer): ChecklistState | null {
  try {
    return JSON.parse(
      readFileSync(path.resolve(cwd, reviewer.stateFile), 'utf8'),
    ) as ChecklistState;
  } catch {
    return null;
  }
}

/** Remove a reviewer's checklist artifact so a stale one can never satisfy the NEXT run. */
function cleanupChecklistState(cwd: string, reviewer: Reviewer): void {
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
export async function runCascade(
  sel: ReviewerSelection,
  opts: CascadeOpts,
): Promise<CascadeResult> {
  const { cwd } = opts;
  cleanupChecklistState(cwd, sel.reviewer);
  const res = await cascadeVerdict(sel, opts);
  if (res.status === 'pass') {
    const hole = verifyChecklist(readChecklistState(cwd, sel.reviewer), 'PASS');
    if (hole) {
      res.status = 'inconclusive';
      res.reason = hole;
    }
  }
  cleanupChecklistState(cwd, sel.reviewer);
  return res;
}

async function cascadeVerdict(
  { reviewer, files }: ReviewerSelection,
  { cwd, cfg, exec = execJudgeAsync, firstModel = 'sonnet', retryFirst = false }: CascadeOpts,
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
  const prompt = wrapPrompt(body, reviewer, files);
  const args = (p: string, model: string): string[] => [
    '-p',
    p,
    '--model',
    model,
    ...JUDGE_ISOLATION,
    '--allowedTools',
    allowedToolsFor(reviewer, cfg),
  ];
  const stat = gitCached(cwd, ['--stat'], files);
  let firstOutage: 'timeout' | 'transient' | 'empty' | undefined;
  const firstOpts = {
    label: `review:${reviewer.name}`,
    args: args(prompt, firstModel),
    input: stat,
    timeout: retryFirst ? STRICT_FIRST_TIMEOUT_MS : FIRST_TIMEOUT_MS, // retryFirst === strict/ship
    cwd,
    onOutage: (kind: 'timeout' | 'transient' | 'empty') => {
      firstOutage = kind;
    },
  };
  let first = await exec(firstOpts);
  if (first === null && retryFirst && firstOutage !== 'timeout') {
    // Strict (ship) runs get ONE first-pass retry — a TRANSIENT API failure or empty output must not
    // fail a ship closed. A TIMEOUT is NOT retried: the strict first pass already ran on the longer
    // STRICT_FIRST_TIMEOUT_MS, so a re-run would burn that same budget again and push the cascade past
    // the ship ceiling for no gain (a contended judge got its extra time UP FRONT). The escalation
    // pass is never retried either: its outage stays inconclusive (blocked under strict).
    // Colon (not " — ") on purpose: the ship timeout banner's awk treats `guard-review: <name> — `
    // lines as COMPLETIONS when naming unfinished reviewers — a mid-retry reviewer is not done.
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
    };
  const firstVerdict = parseReviewVerdict(first);
  if (firstVerdict.verdict === 'PASS')
    return { name: reviewer.name, status: 'pass', reason: '', escalated: false };
  if (firstVerdict.verdict === null)
    return {
      name: reviewer.name,
      status: 'inconclusive',
      reason: 'no VERDICT line',
      escalated: false,
    };
  const second = await exec({
    label: `review:${reviewer.name}:escalate`,
    args: args(escalatePrompt(prompt, first), 'opus'),
    input: stat,
    timeout: ESCALATE_TIMEOUT_MS,
    cwd,
  });
  if (second === null)
    return {
      name: reviewer.name,
      status: 'inconclusive',
      reason: 'escalation outage',
      escalated: true,
    };
  const finalVerdict = parseReviewVerdict(second);
  if (finalVerdict.verdict === 'FAIL')
    return {
      name: reviewer.name,
      status: 'fail',
      reason: finalVerdict.reason,
      escalated: true,
      transcript: second,
    };
  if (finalVerdict.verdict === 'PASS')
    return { name: reviewer.name, status: 'pass', reason: '', escalated: true };
  return {
    name: reviewer.name,
    status: 'inconclusive',
    reason: 'no VERDICT line',
    escalated: true,
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
  const firstModel = process.env.GUARD_REVIEW_MODEL ?? process.env.FRINK_REVIEW_MODEL ?? 'sonnet';
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
          savePasses(cwd, { [t.key]: { at: new Date().toISOString(), model: firstModel } });
        if (progressFile) {
          completed.push(res.name);
          writeProgress(progressFile, { running, completed });
        }
        const secs = Math.round((Date.now() - t0) / 1000);
        console.error(
          `guard-review: ${res.name} — ${res.status.toUpperCase()}${res.escalated ? ' (escalated)' : ''} in ${secs}s${res.status === 'pass' ? ' (checkpointed)' : ''}`,
        );
        return res;
      });
  });
  if (progressFile) clearProgress(progressFile); // ran to completion → nothing unfinished to report

  const fails = results.filter((r) => r.status === 'fail');
  for (const f of fails) {
    console.error(
      `guard-review: ${f.name} FAILED (opus-confirmed) — ${f.reason || 'see findings below'}`,
    );
    if (f.transcript) console.error(f.transcript.trim());
  }
  if (fails.length > 0) return 1;
  const inconclusive = results.filter((r) => r.status === 'inconclusive');
  for (const r of inconclusive) {
    console.error(
      strict
        ? `guard-review: ${r.name} INCONCLUSIVE (${r.reason}) — strict ship mode fails closed.\n` +
            '   Remedy: check `claude` CLI auth/quota, then re-run devkit ship (completed verdicts are cached).'
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
