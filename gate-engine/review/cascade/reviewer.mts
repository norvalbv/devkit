import type { GuardConfig } from '../../config.mts';
import { JUDGE_ISOLATION } from '../../judge/judge-isolation.mts';
import { namedAgentMcpProfile } from '../../judge/mcp/profile.mts';
import { DEEP_JUDGE_TIMEOUT_MS, execJudgeAsync } from '../../judge/run-judge.mts';
import { renderGoverningClaudeMd } from '../claude-md.mts';
import { buildCappedDiffEvidence } from '../diff-evidence.mts';
import { attachItems } from '../evidence/items.mts';
import { gitCached } from '../evidence/staged-git.mts';
import { applyOverrideValve } from '../overrides.mts';
import {
  allowedToolsFor,
  escalatePrompt,
  hasChecklist,
  type PromptExtras,
  parseReviewVerdict,
  type ReviewerSelection,
  wrapConventionsPrompt,
  wrapPrompt,
} from '../reviewers.mts';
import {
  agentBody,
  cleanupChecklistState,
  enforceChecklistContract,
  initializeCommitGuardChecklist,
  type ReviewOutcome,
  readChecklistState,
  withStagedFiles,
} from '../runtime.mts';
import { consumerChecklistAssetRoot } from './consumer-assets.mts';

/** One reviewer cascade outcome, including its persisted transcript when a judge ran. */
export type CascadeResult = ReviewOutcome;

/** Orchestration inputs threaded through one reviewer's cascade. */
export interface CascadeOpts {
  cwd: string;
  cfg: GuardConfig;
  exec?: typeof execJudgeAsync;
  firstModel?: string;
  retryFirst?: boolean;
  assetRoot?: string;
  judgeEnv?: NodeJS.ProcessEnv;
  checklistRecoveryReason?: string;
  promptExtras?: PromptExtras;
  /** Review-only recovery scheduling; commit/ship never retries a checklist-contract miss. */
  recovery?: 'defer' | 'final';
}

/** Run one reviewer with checklist verification, override handling, and cleanup. */
export async function runCascade(
  sel: ReviewerSelection,
  opts: CascadeOpts,
): Promise<CascadeResult> {
  const { cwd } = opts;
  const checklistRoot = opts.assetRoot ?? consumerChecklistAssetRoot(cwd, sel.reviewer);
  cleanupChecklistState(cwd, sel.reviewer);
  try {
    initializeCommitGuardChecklist(cwd, sel.reviewer, checklistRoot, opts.judgeEnv);
    let res = await cascadeVerdict(sel, opts, checklistRoot);
    res = await enforceChecklistContract(sel, res, cwd, opts.assetRoot, async (reason) => {
      if (opts.recovery === 'defer')
        return { ...res, status: 'inconclusive', reason, retryable: reason } as CascadeResult;
      if (opts.recovery === 'final')
        return {
          ...res,
          status: 'error',
          reason: `reviewer checklist contract failed after one retry — ${reason}`,
        } as CascadeResult;
      throw new Error(`checklist recovery has no scheduling mode — ${reason}`);
    });
    const disposition = applyOverrideValve(sel, res, cwd, {
      readState: () => readChecklistState(cwd, sel.reviewer),
      stagedDiff: () => gitCached(cwd, [], sel.files),
    });
    attachItems(res, readChecklistState(cwd, sel.reviewer), disposition);
    return res;
  } finally {
    cleanupChecklistState(cwd, sel.reviewer);
  }
}

async function cascadeVerdict(
  { reviewer, files }: ReviewerSelection,
  {
    cwd,
    cfg,
    exec = execJudgeAsync,
    firstModel = 'haiku',
    retryFirst = false,
    assetRoot,
    judgeEnv,
    checklistRecoveryReason,
    promptExtras,
  }: CascadeOpts,
  checklistRoot: string,
): Promise<CascadeResult> {
  const env = withStagedFiles(judgeEnv ?? process.env, reviewer, files);
  const body = agentBody(cwd, cfg, reviewer.name, assetRoot);
  if (body === null)
    return {
      name: reviewer.name,
      status: 'inconclusive',
      reason: `agent brief ${reviewer.name}.md missing under ${cfg.review.agentsDir} — run devkit sync-agents && devkit sync-skills`,
      escalated: false,
    };
  const stat = gitCached(cwd, ['--stat'], files);
  const prompt = hasChecklist(reviewer)
    ? wrapPrompt(
        body,
        reviewer,
        files,
        assetRoot,
        checklistRecoveryReason,
        promptExtras,
        checklistRoot,
      )
    : wrapConventionsPrompt(body, files, renderGoverningClaudeMd(cwd, files), promptExtras);
  const input = buildCappedDiffEvidence(gitCached(cwd, [], files), stat);
  const allowedTools = allowedToolsFor(reviewer, cfg, checklistRoot);
  const mcpProfile = namedAgentMcpProfile();
  const args = (promptBody: string, model: string): string[] => [
    '-p',
    promptBody,
    '--model',
    model,
    ...JUDGE_ISOLATION,
    '--allowedTools',
    allowedTools,
  ];
  const passModel = reviewer.model ?? firstModel;
  let firstOutage: 'timeout' | 'transient' | 'empty' | undefined;
  const firstOpts = {
    label: `review:${reviewer.name}`,
    args: args(prompt, passModel),
    input,
    timeout: DEEP_JUDGE_TIMEOUT_MS,
    cwd,
    transcript: false,
    mcpProfile,
    env,
    onOutage: (kind: 'timeout' | 'transient' | 'empty') => {
      firstOutage = kind;
    },
  };
  let first = await exec(firstOpts);
  if (first === null && retryFirst && firstOutage !== 'timeout') {
    console.error(
      `guard-review: ${reviewer.name}: judge run failed (${firstOutage ?? 'transient'}), retrying once…`,
    );
    cleanupChecklistState(cwd, reviewer);
    initializeCommitGuardChecklist(cwd, reviewer, checklistRoot, judgeEnv);
    first = await exec(firstOpts);
  }
  if (first === null)
    return {
      name: reviewer.name,
      status: 'inconclusive',
      reason: firstOutage === 'timeout' ? 'judge timed out' : 'judge outage',
      escalated: false,
      model: passModel,
    };
  const firstVerdict = parseReviewVerdict(first);
  if (firstVerdict.verdict === 'PASS')
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
  if (reviewer.model)
    return {
      name: reviewer.name,
      status: 'fail',
      reason: firstVerdict.reason,
      escalated: false,
      model: passModel,
      transcript: first,
    };
  let secondOutage: 'timeout' | 'transient' | 'empty' | undefined;
  const second = await exec({
    label: `review:${reviewer.name}:escalate`,
    args: args(escalatePrompt(prompt, first), 'opus'),
    input,
    timeout: DEEP_JUDGE_TIMEOUT_MS,
    cwd,
    transcript: false,
    mcpProfile,
    env,
    onOutage: (kind: 'timeout' | 'transient' | 'empty') => {
      secondOutage = kind;
    },
  });
  if (second === null)
    return {
      name: reviewer.name,
      status: 'inconclusive',
      reason: secondOutage === 'timeout' ? 'escalation timed out' : 'escalation outage',
      escalated: true,
      model: passModel,
      transcript: first,
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
