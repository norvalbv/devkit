#!/usr/bin/env node

/**
 * guard-review — the in-chain reviewer gate CLI.
 *
 *   guard-review --gate                          run the selected domain reviewers (pre-commit)
 *   guard-review completeness --gate <msg-file>  feature-completeness judge (commit-msg, warn-only)
 *   guard-review scan                            reviewer→files mapping + cache status (no judges)
 *   guard-review clear-cache                     drop cached PASS verdicts
 *   guard-review waive <reviewer>[:<lens>] <id> "<why>"   record an override (see valve/waive.mts)
 *   guard-review waive --list                    show active waives
 *   guard-review transcript <ref>                print a persisted agent transcript by its ref
 *   guard-review record-agent <label>            record one Task-dispatched agent run (stdin)
 *
 * Everything resolves from resolveGuardConfig(process.cwd()) — the CONSUMER repo, never the
 * package dir (W-3). Exit contract per sub-engine (run-review.mjs / completeness.mjs headers).
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { envFlag, resolveGuardConfig } from '../config.mts';
import { recordAgentRun } from '../judge/run-judge.mts';
import { readTranscript } from '../judge/transcript-store.mts';
import { clearCache, loadCache } from './cache.mts';
import { runCompleteness } from './completeness.mts';
import { gitCached, stagedFiles } from './evidence/staged-git.mts';
import { loadReviewerTargetsBlocks, reviewerTargetSalts } from './evidence/targets-block.mts';
import { planReviewWork, resolveChunkCap, resolveLensGroups } from './lens/split.mts';
import { cacheKey, resolveEscalationModel, resolveReviewModel } from './reviewers.mts';
import { selectRepositoryReviewers as selectReviewers } from './scope/repository.mts';
import { runReviewGate } from './run-review.mts';
import { resolveReviewerIdentities, skippedReviewers } from './runtime.mts';
import { runWaive } from './valve/waive.mts';

/**
 * `guard-review scan` — reviewer→files mapping + cache status, no judges. Informational. Cache
 * status is computed by `planReviewWork` — the gate's OWN planner — so scan can never diverge
 * from what the commit path would actually skip (sc-1473: a hand-rolled key here missed the
 * lens-split suffix and made a cached correctness-reviewer structurally unreportable). Scan is
 * not authoritative under review mode (no packaged-asset preflight here).
 */
async function printReviewScan(cwd: string): Promise<void> {
  const cfg = resolveGuardConfig(cwd);
  const cache = loadCache(cwd);
  // Same GUARD_REVIEW_SKIP filter as the gate: a skipped reviewer's cached PASS must not be
  // reported as work the gate would skip-by-cache — the gate never plans it at all.
  const skip = skippedReviewers();
  const staged = stagedFiles(cwd);
  const sels = selectReviewers(staged, cfg).filter(
    (selection) => !skip.has(selection.reviewer.name),
  );
  const { cacheSalts } = resolveReviewerIdentities(false, new Map(), sels, cwd, cfg);
  // Same salt composition as the gate (sc-1441/sc-1442: scope-only Target bytes join checklist
  // salts) — keying on cacheSalts alone reported '[cached PASS]' for entries the gate re-judges.
  const { saltBlock } = await loadReviewerTargetsBlocks(cwd, staged);
  const salts = reviewerTargetSalts(
    sels,
    cacheSalts,
    saltBlock,
    resolveReviewModel(cfg),
    resolveEscalationModel(cfg),
  );
  const diffs = sels.map((selection) => gitCached(cwd, [], selection.files));
  // Same consumer-cwd chunk resolution as the gate (W-3) — a divergent default here would make
  // scan disagree with the gate's plan on configured installs.
  const plan = planReviewWork(
    sels,
    diffs,
    cache,
    salts,
    cacheKey,
    resolveLensGroups(),
    resolveChunkCap(process.env.GUARD_CORRECTNESS_CHUNK, cfg.review.correctnessChunkLoc),
  );
  for (const { sel, cached } of plan.scope) {
    console.log(`${sel.reviewer.name}${cached ? ' [cached PASS]' : ''}: ${sel.files.join(', ')}`);
  }
}

async function scanReview(cwd = process.cwd()): Promise<number> {
  try {
    await printReviewScan(cwd);
  } catch (e: unknown) {
    console.error(`guard-review: scan failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  return 0;
}

/** The dispositions a root agent may report. Anything else is dropped, so the field stays groupable. */
const DISPOSITIONS = new Set(['followed', 'overridden', 'unverified']);

/**
 * `guard-review record-agent <label>` — record ONE agent run the assistant dispatched itself.
 *
 * The reviewers reach telemetry through `execJudge`, which emits their `judge_exec` line and stores
 * their transcript. An agent spawned via the Task tool never enters that path: the `prior-art`
 * subagent the brainstorming skill invokes was therefore invisible in production, while its BENCH
 * runs — which do go through execJudgeAsync — were fully recorded. This is the entry point for those
 * runs; `recordAgentRun` is the one implementation both use, so a Task-dispatched agent and a
 * spawned judge land the same event shape.
 *
 * The response arrives on stdin. ALWAYS returns 0: telemetry must never block, and the caller here
 * is an assistant mid-conversation rather than a gate.
 */
function recordAgent(label: string, rest: string[]): number {
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i !== -1 && i + 1 < rest.length ? rest[i + 1] : undefined;
  };
  // One correlation id PER INVOCATION. Without it runId() falls back to `commit-<write-tree>`, and
  // two prior-art runs made before anything is staged — the normal case, since this fires during
  // brainstorming — would share an id and merge downstream into a single synthesized commit row.
  // A ship/review that legitimately owns the run still wins: runId() checks those first.
  process.env.DEVKIT_AGENT_RUN_ID ||= `agent-${randomUUID()}`;
  let output = '';
  try {
    output = readFileSync(0, 'utf8');
  } catch {
    // A tty or closed pipe — still emit the event. That the agent RAN is the fact the dashboard
    // needs most, and a run recorded without its transcript beats a run recorded nowhere.
  }
  const duration = Number.parseInt(flag('duration-ms') ?? '', 10);
  const disposition = flag('disposition');
  const reason = flag('reason');
  if (disposition !== undefined && !DISPOSITIONS.has(disposition))
    console.error(
      `guard-review: ignoring unknown --disposition "${disposition}" ` +
        `(expected ${[...DISPOSITIONS].join(' | ')})`,
    );
  recordAgentRun({
    label,
    output,
    model: flag('model') ?? null,
    ...(Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
    extra: {
      ...(disposition !== undefined && DISPOSITIONS.has(disposition) ? { disposition } : {}),
      ...(reason ? { disposition_reason: reason } : {}),
    },
  });
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === '--gate') return runReviewGate();
  if (cmd === 'completeness' && rest[0] === '--gate' && rest[1]) return runCompleteness(rest[1]);
  if (cmd === 'scan') return scanReview();
  if (cmd === 'clear-cache') {
    clearCache(process.cwd());
    return 0;
  }
  if (cmd === 'waive' && rest.length >= 1) return runWaive(rest);
  // The local "API" behind a transcript_ref: cat any persisted agent transcript (review-* OR
  // decisions) the telemetry stream referenced, so a human can read the full reasoning on demand.
  if (cmd === 'transcript' && rest[0]) {
    const text = readTranscript(rest[0]);
    if (text === null) {
      console.error(`guard-review: no transcript at ${rest[0]}`);
      return 1;
    }
    process.stdout.write(text);
    return 0;
  }
  if (cmd === 'record-agent' && rest[0]) return recordAgent(rest[0], rest.slice(1));
  console.error(
    'Usage: guard-review --gate | completeness --gate <msg-file> | scan | clear-cache | ' +
      'waive <reviewer>[:<lens>] <id> "<why>" | waive --list | transcript <ref> | ' +
      'record-agent <label> [--model <m>] [--duration-ms <n>] ' +
      '[--disposition followed|overridden|unverified] [--reason "<why>"]',
  );
  return 2;
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`guard-review: ${e?.message ?? e}`);
    // Fail-open — an engine crash must never hard-block a commit — EXCEPT on a strict ship
    // run (GUARD_AI_STRICT), where a dark gate must block rather than silently skip.
    process.exit(envFlag('AI_STRICT') ? 3 : 2);
  },
);
