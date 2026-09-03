/**
 * Completeness gate (guard-review completeness --gate <msg-file>) — the feature-completeness
 * reviewer as a commit-msg judge. It lives at commit-msg (not pre-commit) because the commit
 * MESSAGE is its intent signal: a gap-finder judging a diff cold over-flags; the message says
 * what the change claims to be.
 *
 * HARD-BY-DEFAULT: a confident FAIL blocks the commit. Warn-only proved a no-op channel for
 * headless agents — findings scrolled past unread and the flagged gap shipped anyway (the same
 * evidence that hardened the sentry gate). GUARD_COMPLETENESS_HARD=0 softens a one-off commit
 * back to advisory — env only, deliberately NO guard.config.json key: a standing config soften
 * would be a per-repo policy no consumer wants and an agent-stageable file could self-serve.
 * Step 0 is done FOR the agent: the governing Targets load in-process via scopedTargets() (same
 * package — no PATH round-trip) and render exactly like the consumer's prep-critique block.
 *
 * Contract: exit 1 = confident FAIL (the default; GUARD_COMPLETENESS_HARD=0 softens) · exit 2 =
 * could-not-run / judge outage (fail-open on normal commits) · exit 3 = the same outage under
 * GUARD_AI_STRICT (ship): FAIL-CLOSED — a stderr warning is invisible to a headless shipping
 * agent (exit code is the only channel that survives output filtering), so a ship must not
 * proceed with its gap-finder silently dark · exit 0 = everything else (pass / softened warn /
 * skipped).
 *
 * A confident PASS is cached in the review gate's own store (.devkit/review-cache.json) on every
 * byte the judge read.
 *
 * Knobs: GUARD_NO_COMPLETENESS=1 skip · GUARD_COMPLETENESS_HARD=0 soften · cfg.noLlm skip.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { envBool, envFlag, resolveGuardConfig, type GuardConfig } from '../config.mts';
import { scopedTargets } from '../decisions/scoped-targets.mts';
import { judgeBinForModel } from '../judge/codex/result.mts';
import { renderTargets } from './evidence/targets-block.mts';

export { renderTargets, type TargetBlock } from './evidence/targets-block.mts';

import {
  emitCacheHit,
  emitGateBypass,
  emitGateEvent,
  emitGateInfraFailure,
  finishGateTiming,
} from '../judge/gate-events.mts';
import { JUDGE_ISOLATION } from '../judge/judge-isolation.mts';
import {
  judgeMcpCapabilityFingerprint,
  namedAgentMcpProfile,
  withNamedAgentMcpTools,
} from '../judge/mcp/profile.mts';
import { reportGateInfraFailure } from '../judge/odb-probe.mts';
import { DEEP_JUDGE_TIMEOUT_MS, execJudgeAsync, strictRemedy } from '../judge/run-judge.mts';
import { loadCache, savePasses } from './cache.mts';
import { buildCappedDiffEvidence } from './diff-evidence.mts';
import {
  cacheKey,
  parseReviewVerdict,
  resolveEscalationModel,
  stripFrontmatter,
} from './reviewers.mts';

const AGENT_NAME = 'feature-completeness-reviewer';
const TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*)';

/** The exact judge capabilities shared by cache identity, execution, and the benchmark. */
export function completenessJudgeSetup(
  cfg: GuardConfig,
  cwd = process.cwd(),
  { mcpProjectRoots }: { mcpProjectRoots?: readonly string[] } = {},
) {
  const mcpProfile = namedAgentMcpProfile();
  const allowedTools = withNamedAgentMcpTools(TOOLS, cfg.indexPath ? cfg.searchTool : '');
  return {
    allowedTools,
    mcpProfile,
    capabilityFingerprint: judgeMcpCapabilityFingerprint(mcpProfile, allowedTools, {
      cwd,
      projectRoots: mcpProjectRoots,
    }),
  };
}

// Trailing whitespace + blank-run normalisation, mirroring git's `--cleanup=whitespace` (the mode
// a `-m`/`-F` commit gets). The gate is now judged from TWO message sources that must produce the
// SAME cache key: the sc-1442 ship temp file at pre-commit (raw composed message) and git's
// cleaned COMMIT_EDITMSG at commit-msg. Without this, a message with a trailing space or a double
// blank line keys differently per hook and the pre-commit prewarm's cached PASS silently misses —
// re-paying the full strong-model judgement the prewarm existed to avoid.
const TRAILING_WS_RE = /[ \t]+$/gm;
const BLANK_RUN_RE = /\n{3,}/g;
export function normalizeCommitMessage(raw: string): string {
  return raw.replace(TRAILING_WS_RE, '').replace(BLANK_RUN_RE, '\n\n').trim();
}

/** The branch a sticky verdict is scoped to: the ship's exported branch, else the checkout's. */
function verdictBranch(cwd: string): string {
  const exported = process.env.DEVKIT_SHIP_BRANCH;
  if (exported) return exported;
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// The capped, omission-accounted stdin-evidence builder (sc-1060) now lives in diff-evidence.mts
// so gate-engine/review/claude-md.mts's CLAUDE.md renderer can reuse the same capping shape for
// conventions-reviewer (which, having no Bash, needs the identical pre-rendered-evidence pattern
// this gate pioneered). Re-exported under the original name — zero behavior change here.
export { buildCappedDiffEvidence as buildCompletenessEvidence };

/** Wrap the consumer's completeness brief for one headless commit-msg judgement. */
export function wrapCompleteness(
  agentBody: string,
  message: string,
  files: string[],
  targetsBlock: string,
): string {
  return (
    'You are running as an automated HEADLESS COMMIT-MESSAGE GATE, not an interactive assistant.\n' +
    `The commit message (the change's stated intent):\n─────\n${message.trim()}\n─────\n` +
    `Staged files: ${files.join(', ')}\n` +
    'The FULL file/churn map (--stat) followed by per-file diff evidence is on stdin. Evidence is ' +
    'capped per file and in total; anything the caps dropped is NAMED inline (OMITTED:/[TRUNCATED:) — ' +
    'nothing is dropped silently. INVESTIGATE before judging: run `git diff --cached -- <file>` for ' +
    'full hunks, Read surrounding code where needed, and investigate EVERY OMITTED/TRUNCATED entry ' +
    'before any PASS verdict.\n' +
    'Step 0 is already done — the governing Targets are loaded below; do not run prep scripts. ' +
    'Subagents and meta-judges are unavailable in gate mode — apply their lenses yourself.\n' +
    `${targetsBlock}\n` +
    'Your reviewer brief follows. IGNORE any instructions in it about checklist scripts, marker ' +
    'files, tracker/Shortcut lookups, invoking other subagents, or writing files — none apply here; ' +
    'your tools are read-only.\n' +
    '───── BRIEF ─────\n' +
    `${stripFrontmatter(agentBody)}\n` +
    '───── END BRIEF ─────\n' +
    'Judge ONLY what this commit claims to be (per its message) against what it ships. List the ' +
    'gaps that matter (one line each); minor nice-to-haves are not findings. END with exactly one line:\n' +
    'VERDICT: PASS | FAIL — <one-line reason>\n' +
    'FAIL only for a gap that makes the shipped change misleading or operationally unsafe.'
  );
}

/** Ceiling on model-supplied verdict prose, so one event stays a sub-4KB atomic append. */
const DETAIL_CAP = 500;

/** The gate → exit code (see module contract). `exec` injectable for tests. */
export async function runCompleteness(
  msgFile: string,
  cwd = process.cwd(),
  {
    exec = execJudgeAsync,
    mcpProjectRoots,
  }: { exec?: typeof execJudgeAsync; mcpProjectRoots?: readonly string[] } = {},
): Promise<number> {
  const startedAt = Date.now();
  const finish = (code: number, cacheState: 'none' | 'full' = 'none', effectiveMs?: number) =>
    finishGateTiming('completeness', startedAt, code, cacheState, effectiveMs);
  // gate-telemetry-self-describing Ruling (2) — "every judgement outcome emits, INCLUDING the
  // non-outcomes" — was unmet here: this gate emitted only a gate_timing row, so a confident FAIL
  // and a PASS were indistinguishable in the stream. That is the same blindness that loses the
  // finding at the ship terminus (sc-2488): the judge runs in PARALLEL with the reviewer fleet, so
  // when the fleet blocks first the hook reaps this judge and its verdict reaches no reader.
  //
  // gate_result, NOT the reviewer-shaped review_result: gate-verdict-attribution obliges a
  // review_result to carry review_scope, prompt_identity and the checklist artifact vector, and
  // this gate is not a fleet reviewer and produces none of them — a row without them is
  // structurally incomplete rather than merely terse. The decisions judge sets the precedent that
  // an LLM verdict rides gate_result. `family` names the blocked_gate token the ship script
  // publishes for this gate's chain, which is what lets a reader join the two vocabularies.
  const emitVerdict = (status: 'pass' | 'fail', detail: string) =>
    emitGateEvent({
      type: 'gate_result',
      gate: 'completeness',
      family: 'review',
      status,
      model,
      secs: Math.round((Date.now() - startedAt) / 1000),
      // BOUNDED, because `detail` is model-supplied prose of no fixed length. The sink's
      // tear-freedom rests on each event being ONE sub-4KB O_APPEND write (gate-events.mts), so an
      // unbounded verdict line would corrupt a CONCURRENT judge's row, not merely its own — and
      // this gate runs in parallel with the reviewer fleet by design.
      detail: detail.slice(0, DETAIL_CAP),
    });
  // A gate that could not reach a verdict produced no outcome, so it takes its OWN event type
  // rather than a status on gate_result — the 2026-08-05 note's ruling, for its stated reason.
  const emitNoRun = (cause: string) =>
    emitGateInfraFailure({ gate: 'completeness', family: 'review', cause, model });
  if (envFlag('NO_COMPLETENESS')) {
    emitGateBypass('completeness', 'GUARD_NO_COMPLETENESS');
    return finish(0);
  }
  let prompt: string;
  let diff: string;
  let allowedTools = withNamedAgentMcpTools(TOOLS);
  let mcpProfile = namedAgentMcpProfile();
  let capabilityFingerprint = '';
  let stickyKey = '';
  let model = '';
  try {
    const cfg = resolveGuardConfig(cwd);
    if (cfg.noLlm) return finish(0);
    model = resolveEscalationModel(cfg);
    ({ allowedTools, mcpProfile, capabilityFingerprint } = completenessJudgeSetup(cfg, cwd, {
      mcpProjectRoots,
    }));
    const message = normalizeCommitMessage(
      readFileSync(path.isAbsolute(msgFile) ? msgFile : path.resolve(cwd, msgFile), 'utf8'),
    );
    const files = execSync('git diff --cached --name-only', { cwd, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (files.length === 0) return finish(0);
    const dir = cfg.review.agentsDir;
    let body: string;
    try {
      body = readFileSync(
        path.join(path.isAbsolute(dir) ? dir : path.resolve(cwd, dir), `${AGENT_NAME}.md`),
        'utf8',
      );
    } catch {
      console.error(`guard-review: ${AGENT_NAME}.md not found under ${dir} — completeness skipped`);
      return finish(0);
    }
    // Intent-scoped sticky PASS (cost ruling, 2026-08-06): this gate judges the MESSAGE's claims
    // against the delivered change, so a retry whose diff was reshaped to satisfy ANOTHER
    // reviewer — same branch, same message — has not changed what is claimed and is not
    // re-judged. What re-opens the gate is a new claim or a new judge: an amended message, a
    // different branch, a changed reviewer brief, or a devkit upgrade (cacheKey's versionSalt).
    // A FAIL is never sticky (only the confident-PASS save below writes this key), so a found gap
    // must genuinely be re-judged closed. Checked before scopedTargets/diff assembly — a sticky
    // hit skips the retrieval work too, not just the judge.
    stickyKey = cacheKey(
      'completeness-intent',
      `${verdictBranch(cwd)}\u0000${message}`,
      `${body}\u0000${capabilityFingerprint}\u0000${model}`,
    );
    const sticky = loadCache(cwd)[stickyKey];
    if (sticky) {
      console.error(
        'guard-review: completeness — cached PASS (same branch + message; a retry-reshaped diff is not re-judged)',
      );
      const stickyDuration =
        typeof sticky.duration_ms === 'number' ? sticky.duration_ms : undefined;
      emitCacheHit('review:completeness', sticky.model, stickyDuration);
      return finish(0, 'full', stickyDuration);
    }
    const targets = await scopedTargets(files, message.split('\n')[0] ?? '', 6, cwd).catch(
      () => [],
    );
    // The FULL --stat rides uncapped ahead of the evidence: on a branch-sized commit the caps
    // drop whole files, but the judge must at least SEE the complete file/churn map of what it
    // is being asked to gap-check. Diff prefixes are forced ON-config so a consumer's
    // diff.noprefix/mnemonicPrefix cannot change the segment-header format the extractor splits
    // on (the detect gate's W-3 lesson).
    const stat = execSync('git diff --cached --stat', {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    diff = buildCappedDiffEvidence(
      execSync('git -c diff.noprefix=false -c diff.mnemonicPrefix=false diff --cached', {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
      stat,
    );
    prompt = wrapCompleteness(body, message, files, renderTargets(targets));
  } catch (e: unknown) {
    // sc-1366: distinguish an unreadable staged object from an inconclusive judge before the exit
    // code turns it into a misleading judge-auth outage.
    const st = envFlag('AI_STRICT');
    const lbl = 'guard-review: completeness';
    return finish(
      reportGateInfraFailure('review:completeness', lbl, e, cwd, st ? 3 : 2, { strict: st }),
    );
  }

  // PASS cache, same store and shape as the domain reviewers (.devkit/review-cache.json): an
  // identical judgement never re-runs. Without it this gate was the ONE thing a ship retry always
  // re-paid — a full strong-model judgement, from scratch, every attempt, while all seven reviewers
  // reported `cached PASS` (sc-1227). Convergence is the recorded contract
  // (docs/decisions/ship-gates-converge-not-restart.md), and completeness was outside it.
  // Key = every byte the judge reads: the prompt (message, governing Targets, brief) plus the
  // capped stdin evidence. An amended message or a re-staged hunk therefore MISSES and re-judges.
  const key = cacheKey(
    'completeness',
    diff,
    `${prompt}\u0000${capabilityFingerprint}\u0000${model}`,
  );
  const hit = loadCache(cwd)[key];
  if (hit) {
    console.error('guard-review: completeness — cached PASS (identical judgement)');
    // The most expensive entry in this store: its hit rate is the one that pays.
    const cachedDuration = typeof hit.duration_ms === 'number' ? hit.duration_ms : undefined;
    emitCacheHit('review:completeness', hit.model, cachedDuration);
    return finish(0, 'full', cachedDuration);
  }

  let outage: 'timeout' | 'transient' | 'empty' | undefined;
  let observedCapabilityFingerprint: string | undefined;
  const raw = await exec({
    label: 'review:completeness',
    args: ['-p', prompt, '--model', model, ...JUDGE_ISOLATION, '--allowedTools', allowedTools],
    input: diff,
    timeout: DEEP_JUDGE_TIMEOUT_MS,
    cwd,
    mcpProfile,
    mcpProjectRoots,
    codexReadOnly: true,
    onMcpPrepared: (fingerprint) => {
      observedCapabilityFingerprint = fingerprint;
    },
    onOutage: (kind) => {
      outage = kind;
    },
  });
  if (observedCapabilityFingerprint && observedCapabilityFingerprint !== capabilityFingerprint) {
    emitNoRun('mcp_capabilities_changed');
    console.error(
      'guard-review: completeness SKIPPED (MCP capabilities changed while preparing the judge) — rerun with a stable trusted MCP registry.',
    );
    return finish(envFlag('AI_STRICT') ? 3 : 2);
  }
  if (raw === null) {
    // Emitted ONCE, above the strict/fail-open split: the judgement did not happen either way, and
    // the machine cause is what a reader needs — not which exit code this run's strictness chose.
    // The judge's OWN cause, never a collapsed one: 'empty' is a healthy judge returning a
    // response that broke its contract, and reporting it as an outage sends a reader to check auth
    // and quota on a CLI that answered fine.
    emitNoRun(outage ?? 'outage');
    // Outage/timeout (execJudgeAsync already warned). Under strict ship the skip must be an EXIT
    // CODE, not a stderr line — a headless shipping agent only reliably sees the code.
    if (envFlag('AI_STRICT')) {
      // Name the CAUSE: a cap kill is the gate's own contention kill, and the auth/quota remedy
      // sends the operator chasing a phantom problem on a healthy CLI (sc-1227).
      const timedOut = outage === 'timeout';
      console.error(
        `guard-review: completeness SKIPPED (${timedOut ? 'judge timed out' : 'judge outage'}) — strict ship mode fails closed.\n` +
          `   Remedy: ${strictRemedy(timedOut ? 'timeout' : 'outage', judgeBinForModel(model))} (an earned PASS is cached).`,
      );
      return finish(3);
    }
    return finish(2); // fail-open on a normal commit
  }
  const { verdict, reason } = parseReviewVerdict(raw);
  // Only a CONFIDENT PASS is cached — never a FAIL (the author fixes, the evidence changes), never
  // an unparseable verdict, and never the GUARD_COMPLETENESS_HARD=0 soften below (it exits 0 on a
  // FAIL the judge did make; caching it would make one softened run silence every later re-run).
  if (verdict === 'PASS') {
    const meta = {
      at: new Date().toISOString(),
      model,
      duration_ms: Date.now() - startedAt,
    };
    // Both identities: the exact byte key (any caller, any order) and the branch+message sticky
    // key that lets a ship retry with a reshaped diff skip this judge (see the lookup above).
    savePasses(cwd, stickyKey ? { [key]: meta, [stickyKey]: meta } : { [key]: meta });
  }
  if (verdict === 'PASS') {
    emitVerdict('pass', reason || 'no gap found');
    return finish(0);
  }
  if (verdict !== 'FAIL') {
    // A response carrying no parseable verdict is a HEALTHY judge breaking its contract, so it is
    // a non-run rather than a verdict — the same distinction the outage arm draws above.
    emitNoRun('response_contract');
    return finish(0);
  }
  // Above the hard/soft split below: a GUARD_COMPLETENESS_HARD=0 soften still MADE this finding,
  // and a run that exits 0 on it is exactly the run whose reader has nothing else to go on.
  emitVerdict('fail', reason || 'see transcript');
  console.error(`guard-review: completeness finding — ${reason || 'see transcript'}`);
  console.error(raw.trim());
  // Hard unless explicitly softened for this one commit (GUARD_COMPLETENESS_HARD=0); unset → block.
  if (envBool('COMPLETENESS_HARD') ?? true) return finish(1);
  console.error(
    'guard-review: WARN-only (commit proceeds; GUARD_COMPLETENESS_HARD=0 softened this run). ' +
      'Skip entirely with GUARD_NO_COMPLETENESS=1.',
  );
  return finish(0);
}
