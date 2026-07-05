/**
 * Completeness gate (guard-review completeness --gate <msg-file>) — the feature-completeness
 * reviewer as a commit-msg judge. It lives at commit-msg (not pre-commit) because the commit
 * MESSAGE is its intent signal: a gap-finder judging a diff cold over-flags; the message says
 * what the change claims to be.
 *
 * WARN-BY-DEFAULT: findings print to stderr and the commit proceeds (a gap-finder's verdicts are
 * judgment calls, not defects — the LLM-in-gate invariant's spirit). GUARD_COMPLETENESS_HARD=1
 * escalates a confident FAIL to a block. Straight opus, no cascade (user ruling: the gap-finder
 * gets the strongest model or it isn't worth running).
 *
 * Step 0 is done FOR the agent: the governing Targets load in-process via scopedTargets() (same
 * package — no PATH round-trip) and render exactly like the consumer's prep-critique block.
 *
 * Contract: exit 1 = confident FAIL under GUARD_COMPLETENESS_HARD · exit 2 = could-not-run /
 * judge outage (fail-open) · exit 0 = everything else (pass / warn / skipped).
 * Knobs: GUARD_NO_COMPLETENESS=1 skip · GUARD_COMPLETENESS_HARD=1 block · cfg.noLlm skip.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { envFlag, resolveGuardConfig } from '../config.mts';
import { scopedTargets } from '../decisions/scoped-targets.mts';
import { JUDGE_ISOLATION } from '../judge/judge-isolation.mts';
import { execJudgeAsync } from '../judge/run-judge.mts';
import { parseReviewVerdict, stripFrontmatter } from './reviewers.mts';

const AGENT_NAME = 'feature-completeness-reviewer';
const TIMEOUT_MS = 360000;
const DIFF_CAP = 60000; // stdin evidence cap; the judge reads full hunks itself via git diff
const TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*)';

/** One governing Target (scope-match or semantic) as returned by `scopedTargets`. */
export interface TargetBlock {
  slug: string;
  ruling: string;
  scope: string | null;
  via: string;
}

/** Render the governing-Targets block (the consumer prep-critique shape) or its SKIP note. */
export function renderTargets(blocks: TargetBlock[]): string {
  if (blocks.length === 0) {
    return (
      '## RELEVANT RECORDED TARGETS — SKIP\n' +
      'No governing Target found (index unreachable, or none match). Do not claim ' +
      'decision-alignment you did not check; a recorded decision is not a completeness gap.'
    );
  }
  const lines = [
    '## RELEVANT RECORDED TARGETS (authoritative — a recorded decision is NOT a completeness gap)',
    '',
  ];
  for (const b of blocks) {
    lines.push(`### ${b.slug}${b.scope ? ` · scope: \`${b.scope}\`` : ''} _(${b.via})_`);
    lines.push(b.ruling.trim());
    lines.push('');
  }
  return lines.join('\n');
}

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
    'A truncated staged diff is on stdin. INVESTIGATE before judging: run ' +
    '`git diff --cached -- <file>` for full hunks; Read surrounding code where needed.\n' +
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
  if (envFlag('NO_COMPLETENESS')) return 0;
  let prompt: string;
  let diff: string;
  try {
    const cfg = resolveGuardConfig(cwd);
    if (cfg.noLlm) return 0;
    const message = readFileSync(
      path.isAbsolute(msgFile) ? msgFile : path.resolve(cwd, msgFile),
      'utf8',
    );
    const files = execSync('git diff --cached --name-only', { cwd, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (files.length === 0) return 0;
    const dir = cfg.review.agentsDir;
    let body: string;
    try {
      body = readFileSync(
        path.join(path.isAbsolute(dir) ? dir : path.resolve(cwd, dir), `${AGENT_NAME}.md`),
        'utf8',
      );
    } catch {
      console.error(`guard-review: ${AGENT_NAME}.md not found under ${dir} — completeness skipped`);
      return 0;
    }
    const targets = await scopedTargets(files, message.split('\n')[0] ?? '', 6, cwd).catch(
      () => [],
    );
    diff = execSync('git diff --cached', {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).slice(0, DIFF_CAP);
    prompt = wrapCompleteness(body, message, files, renderTargets(targets));
  } catch (e: unknown) {
    console.error(
      `guard-review: completeness could not run — ${e instanceof Error ? e.message : String(e)}`,
    );
    return 2; // fail-open
  }

  const raw = await exec({
    label: 'review:completeness',
    args: ['-p', prompt, '--model', 'opus', ...JUDGE_ISOLATION, '--allowedTools', TOOLS],
    input: diff,
    timeout: TIMEOUT_MS,
    cwd,
  });
  if (raw === null) return 2; // outage (execJudgeAsync already warned) — fail-open
  const { verdict, reason } = parseReviewVerdict(raw);
  if (verdict !== 'FAIL') return 0;
  console.error(`guard-review: completeness finding — ${reason || 'see transcript'}`);
  console.error(raw.trim());
  if (envFlag('COMPLETENESS_HARD')) return 1;
  console.error(
    'guard-review: WARN-only (commit proceeds). Escalate with GUARD_COMPLETENESS_HARD=1; skip with GUARD_NO_COMPLETENESS=1.',
  );
  return 0;
}
