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
 * GUARD_AI_STRICT=1 ship mode (first-pass retry once, then fail closed) · cfg.noLlm skip.
 * FRINK_* aliases honoured. Judges are isolated (JUDGE_ISOLATION) with an airtight read-only
 * allowlist — a gate judge can never write, stage, or commit.
 *
 * W-3: config + git + agent .md files all resolve against the CONSUMER cwd.
 */

import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolveGuardConfig } from '../config.mjs';
import { JUDGE_ISOLATION } from '../judge/judge-isolation.mjs';
import { execJudgeAsync } from '../judge/run-judge.mjs';
import { loadCache, savePasses } from './cache.mjs';
import {
  allowedToolsFor,
  cacheKey,
  escalatePrompt,
  parseReviewVerdict,
  selectReviewers,
  verifyChecklist,
  wrapPrompt,
} from './reviewers.mjs';

// Judge timeouts include the checklist workflow (generate → per-item marks → finalize) on top of
// diff investigation. Budget arithmetic — the ship ceiling bounds the WHOLE hook chain, not this
// gate alone: deterministic prefix ~240s (≈0 on a guard-prefix hit) + decisions ≤60s (≈0 on a
// verdict-cache hit) + this cascade's worst case 2×300 (strict retry) + 420 = 1020s. First-ship
// worst ≈ 1800s = SHIP_COMMIT_TIMEOUT's default; a killed run converges on retry because PASSes
// checkpoint per-completion and the caches skip everything already earned.
const FIRST_TIMEOUT_MS = 300000;
const ESCALATE_TIMEOUT_MS = 420000; // only fires pre-block; never retried (see cascadeVerdict)

// GUARD_* env flag with FRINK_* back-compat alias (check-alignment's envFlag semantics).
function envFlag(name) {
  const v = process.env[`GUARD_${name}`] ?? process.env[`FRINK_${name}`];
  if (v === undefined) return false;
  const t = String(v).trim().toLowerCase();
  return !(t === '' || t === '0' || t === 'false' || t === 'no');
}

function sh(cwd, cmd) {
  return execSync(cmd, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function stagedFiles(cwd) {
  return sh(cwd, 'git diff --cached --name-only')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function agentBody(cwd, cfg, name) {
  const dir = cfg.review.agentsDir;
  const file = path.join(path.isAbsolute(dir) ? dir : path.resolve(cwd, dir), `${name}.md`);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Parsed checklist state-file artifact for a reviewer, or null (missing/corrupt → unverifiable). */
function readChecklistState(cwd, reviewer) {
  try {
    return JSON.parse(readFileSync(path.resolve(cwd, reviewer.stateFile), 'utf8'));
  } catch {
    return null;
  }
}

/** Remove a reviewer's checklist artifact so a stale one can never satisfy the NEXT run. */
function cleanupChecklistState(cwd, reviewer) {
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
export async function runCascade(sel, opts) {
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
  { reviewer, files },
  { cwd, cfg, exec = execJudgeAsync, firstModel = 'sonnet', retryFirst = false },
) {
  const prompt = wrapPrompt(agentBody(cwd, cfg, reviewer.name) ?? '', reviewer, files);
  const args = (p, model) => [
    '-p',
    p,
    '--model',
    model,
    ...JUDGE_ISOLATION,
    '--allowedTools',
    allowedToolsFor(reviewer, cfg),
  ];
  const stat = sh(
    cwd,
    `git diff --cached --stat -- ${files.map((f) => JSON.stringify(f)).join(' ')}`,
  );
  const firstOpts = {
    label: `review:${reviewer.name}`,
    args: args(prompt, firstModel),
    input: stat,
    timeout: FIRST_TIMEOUT_MS,
    cwd,
  };
  let first = await exec(firstOpts);
  if (first === null && retryFirst) {
    // Strict (ship) runs get ONE first-pass retry — transient API failures must not fail a ship
    // closed. The escalation pass is never retried: its outage stays inconclusive (blocked under
    // strict), and retrying it would push the cascade's worst case past the ship ceiling.
    console.error(`guard-review: ${reviewer.name} — judge run failed, retrying once…`);
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
    return { name: reviewer.name, status: 'fail', reason: finalVerdict.reason, escalated: true };
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
 * The gate → exit code (see module contract). All selected reviewers run CONCURRENTLY — each
 * cascade is independent, so wall-clock is the slowest single reviewer, not the sum.
 */
export async function runReviewGate(cwd = process.cwd(), { exec = execJudgeAsync } = {}) {
  if (envFlag('NO_REVIEW')) return 0;
  const strict = envFlag('AI_STRICT'); // the ship path sets this: retry once, then fail CLOSED
  let cfg;
  let selected;
  let diffs;
  try {
    cfg = resolveGuardConfig(cwd);
    if (cfg.noLlm) return 0;
    selected = selectReviewers(stagedFiles(cwd), cfg);
    if (selected.length === 0) return 0;
    // One domain diff per reviewer (its cache identity): the exact staged bytes in its files.
    diffs = selected.map((s) =>
      sh(cwd, `git diff --cached -- ${s.files.map((f) => JSON.stringify(f)).join(' ')}`),
    );
  } catch (e) {
    console.error(
      `guard-review: could not run — ${e?.message ?? e}${strict ? ' (strict ship mode: failing closed)' : ''}`,
    );
    return strict ? 3 : 2; // fail-open, except on a ship
  }

  const cache = loadCache(cwd);
  const firstModel = process.env.GUARD_REVIEW_MODEL ?? process.env.FRINK_REVIEW_MODEL ?? 'sonnet';
  const toRun = [];
  for (let i = 0; i < selected.length; i++) {
    const key = cacheKey(selected[i].reviewer.name, diffs[i]);
    if (cache[key])
      console.error(`guard-review: ${selected[i].reviewer.name} — cached PASS (identical diff)`);
    else toRun.push({ sel: selected[i], key, diffText: diffs[i] });
  }
  if (toRun.length === 0) return 0;

  console.error(
    `guard-review: running ${toRun.map((t) => t.sel.reviewer.name).join(', ')} (parallel, ${firstModel} → opus on FAIL)…`,
  );
  // Each cascade CHECKPOINTS as it lands: its PASS is persisted per-completion (not after
  // Promise.all), so a run killed by the ship timeout keeps every finished verdict and the
  // retry re-runs only the unfinished reviewers. The completion line doubles as a heartbeat
  // through git's stderr → the ship log. The .catch keeps one cascade's throw from rejecting
  // the whole Promise.all and discarding its siblings' still-pending completions.
  const results = await Promise.all(
    toRun.map((t) => {
      const t0 = Date.now();
      return runCascade(t.sel, { cwd, cfg, exec, firstModel, retryFirst: strict })
        .catch((e) => ({
          name: t.sel.reviewer.name,
          status: 'inconclusive',
          reason: `engine error: ${e?.message ?? e}`,
          escalated: false,
        }))
        .then((res) => {
          if (res.status === 'pass')
            savePasses(cwd, { [t.key]: { at: new Date().toISOString(), model: firstModel } });
          const secs = Math.round((Date.now() - t0) / 1000);
          console.error(
            `guard-review: ${res.name} — ${res.status.toUpperCase()}${res.escalated ? ' (escalated)' : ''} in ${secs}s${res.status === 'pass' ? ' (checkpointed)' : ''}`,
          );
          return res;
        });
    }),
  );

  const fails = results.filter((r) => r.status === 'fail');
  for (const f of fails) {
    console.error(
      `guard-review: ${f.name} FAILED (opus-confirmed) — ${f.reason || 'see transcript above'}`,
    );
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
      const diff = sh(
        cwd,
        `git diff --cached -- ${s.files.map((f) => JSON.stringify(f)).join(' ')}`,
      );
      const hit = cache[cacheKey(s.reviewer.name, diff)] ? ' [cached PASS]' : '';
      console.log(`${s.reviewer.name}${hit}: ${s.files.join(', ')}`);
    }
  } catch (e) {
    console.error(`guard-review: scan failed — ${e?.message ?? e}`);
  }
  return 0;
}
