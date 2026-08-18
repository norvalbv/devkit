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
 * Straight opus, no cascade (user ruling: the gap-finder gets the strongest model or it isn't
 * worth running).
 *
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
 * byte the judge read, so a ship retry after an unrelated failure skips this judge instead of
 * re-spending opus on an unchanged judgement — the convergence contract the domain reviewers
 * already honoured (docs/decisions/ship-gates-converge-not-restart.md).
 *
 * Knobs: GUARD_NO_COMPLETENESS=1 skip · GUARD_COMPLETENESS_HARD=0 soften · cfg.noLlm skip.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { envBool, envFlag, resolveGuardConfig } from '../config.mts';
import { scopedTargets } from '../decisions/scoped-targets.mts';
import { renderTargets } from './evidence/targets-block.mts';

export { renderTargets, type TargetBlock } from './evidence/targets-block.mts';

import { emitCacheHit, finishGateTiming } from '../judge/gate-events.mts';
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
import { cacheKey, parseReviewVerdict, stripFrontmatter } from './reviewers.mts';

const AGENT_NAME = 'feature-completeness-reviewer';
const TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*)';

// Trailing whitespace + blank-run normalisation, mirroring git's `--cleanup=whitespace` (the mode
// a `-m`/`-F` commit gets). The gate is now judged from TWO message sources that must produce the
// SAME cache key: the sc-1442 ship temp file at pre-commit (raw composed message) and git's
// cleaned COMMIT_EDITMSG at commit-msg. Without this, a message with a trailing space or a double
// blank line keys differently per hook and the pre-commit prewarm's cached PASS silently misses —
// re-paying the full opus judgement the prewarm existed to avoid.
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

/** The gate → exit code (see module contract). `exec` injectable for tests. */
export async function runCompleteness(
  msgFile: string,
  cwd = process.cwd(),
  { exec = execJudgeAsync }: { exec?: typeof execJudgeAsync } = {},
): Promise<number> {
  const startedAt = Date.now();
  const finish = (code: number, cacheState: 'none' | 'full' = 'none', effectiveMs?: number) =>
    finishGateTiming('completeness', startedAt, code, cacheState, effectiveMs);
  if (envFlag('NO_COMPLETENESS')) return finish(0);
  let prompt: string;
  let diff: string;
  let allowedTools = withNamedAgentMcpTools(TOOLS);
  const mcpProfile = namedAgentMcpProfile();
  let capabilityFingerprint = '';
  let stickyKey = '';
  try {
    const cfg = resolveGuardConfig(cwd);
    if (cfg.noLlm) return finish(0);
    allowedTools = withNamedAgentMcpTools(TOOLS, cfg.indexPath ? cfg.searchTool : '');
    capabilityFingerprint = judgeMcpCapabilityFingerprint(mcpProfile, allowedTools, { cwd });
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
      `${body}\u0000${capabilityFingerprint}`,
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
    // code turns it into "judge unavailable — check `claude` CLI auth/quota".
    const st = envFlag('AI_STRICT');
    const lbl = 'guard-review: completeness';
    return finish(
      reportGateInfraFailure('review:completeness', lbl, e, cwd, st ? 3 : 2, { strict: st }),
    );
  }

  // PASS cache, same store and shape as the domain reviewers (.devkit/review-cache.json): an
  // identical judgement never re-runs. Without it this gate was the ONE thing a ship retry always
  // re-paid — ~7 minutes of opus, from scratch, every attempt, while all seven reviewers reported
  // `cached PASS` (sc-1227). Convergence is the recorded contract
  // (docs/decisions/ship-gates-converge-not-restart.md), and completeness was outside it.
  // Key = every byte the judge reads: the prompt (message, governing Targets, brief) plus the
  // capped stdin evidence. An amended message or a re-staged hunk therefore MISSES and re-judges.
  const key = cacheKey('completeness', diff, `${prompt}\u0000${capabilityFingerprint}`);
  const hit = loadCache(cwd)[key];
  if (hit) {
    console.error('guard-review: completeness — cached PASS (identical judgement)');
    // The most expensive entry in this store (~7min of opus): its hit rate is the one that pays.
    const cachedDuration = typeof hit.duration_ms === 'number' ? hit.duration_ms : undefined;
    emitCacheHit('review:completeness', hit.model, cachedDuration);
    return finish(0, 'full', cachedDuration);
  }

  let outage: 'timeout' | 'transient' | 'empty' | undefined;
  const raw = await exec({
    label: 'review:completeness',
    args: ['-p', prompt, '--model', 'opus', ...JUDGE_ISOLATION, '--allowedTools', allowedTools],
    input: diff,
    timeout: DEEP_JUDGE_TIMEOUT_MS,
    cwd,
    mcpProfile,
    onOutage: (kind) => {
      outage = kind;
    },
  });
  if (raw === null) {
    // Outage/timeout (execJudgeAsync already warned). Under strict ship the skip must be an EXIT
    // CODE, not a stderr line — a headless shipping agent only reliably sees the code.
    if (envFlag('AI_STRICT')) {
      // Name the CAUSE: a cap kill is the gate's own contention kill, and the auth/quota remedy
      // sends the operator chasing a phantom problem on a healthy CLI (sc-1227).
      const timedOut = outage === 'timeout';
      console.error(
        `guard-review: completeness SKIPPED (${timedOut ? 'judge timed out' : 'judge outage'}) — strict ship mode fails closed.\n` +
          `   Remedy: ${strictRemedy(timedOut ? 'timeout' : 'outage')} (an earned PASS is cached).`,
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
      model: 'opus',
      duration_ms: Date.now() - startedAt,
    };
    // Both identities: the exact byte key (any caller, any order) and the branch+message sticky
    // key that lets a ship retry with a reshaped diff skip this judge (see the lookup above).
    savePasses(cwd, stickyKey ? { [key]: meta, [stickyKey]: meta } : { [key]: meta });
  }
  if (verdict !== 'FAIL') return finish(0);
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
