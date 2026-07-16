import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { GuardConfig } from '../config.mts';
import {
  type ChecklistState,
  checklistScriptAt,
  hasChecklist,
  type Reviewer,
  type ReviewerSelection,
  verifyChecklist,
} from './reviewers.mts';

export interface ReviewOutcome {
  name: string;
  status: 'pass' | 'fail' | 'inconclusive' | 'error';
  reason: string;
  escalated: boolean;
  transcript?: string;
  /** The model that actually ran the first pass; absent only when no judge ran. */
  model?: string;
}

export function agentBody(
  cwd: string,
  cfg: GuardConfig,
  name: string,
  assetRoot?: string,
): string | null {
  const dir = assetRoot ? path.join(assetRoot, 'agents') : cfg.review.agentsDir;
  const file = path.join(path.isAbsolute(dir) ? dir : path.resolve(cwd, dir), `${name}.md`);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Validate and fingerprint current packaged assets before a review-mode cache lookup. */
export function preflightReviewAssets(
  assetRoot: string | undefined,
  selected: ReviewerSelection[],
  cfg: GuardConfig,
): Map<string, string> {
  if (!assetRoot || !path.isAbsolute(assetRoot))
    throw new Error('DEVKIT_REVIEW_ASSET_ROOT is missing or not absolute');
  const identities = new Map<string, string>();
  for (const { reviewer } of selected) {
    const hash = createHash('sha256')
      .update(readFileSync(path.join(assetRoot, 'agents', `${reviewer.name}.md`)))
      .update(JSON.stringify(reviewer));
    if (hasChecklist(reviewer)) {
      if (!reviewer.stateFile.startsWith('.claude/') || !reviewer.cmds.gen || !reviewer.cmds.check)
        throw new Error(`${reviewer.name} has an invalid checklist registry binding`);
      hash.update(readFileSync(path.join(assetRoot, 'skills', reviewer.skill, 'SKILL.md')));
      hash.update(readFileSync(checklistScriptAt(reviewer, assetRoot)));
    }
    hash.update(
      JSON.stringify({
        scanRoots: cfg.scanRoots,
        sourceExtensions: cfg.sourceExtensions,
        review: cfg.review,
        indexPath: cfg.indexPath,
        searchTool: cfg.searchTool,
      }),
    );
    identities.set(reviewer.name, hash.digest('hex'));
  }
  return identities;
}

export function reviewJudgeEnv(cfg: GuardConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEVKIT_REVIEW_BACKEND_ROOTS: JSON.stringify(cfg.review.backendRoots),
    DEVKIT_REVIEW_FRONTEND_ROOTS: JSON.stringify(cfg.review.frontendRoots),
  };
}

export function readChecklistState(cwd: string, reviewer: Reviewer): ChecklistState | null {
  if (!reviewer.stateFile) return null;
  try {
    return JSON.parse(
      readFileSync(path.resolve(cwd, reviewer.stateFile), 'utf8'),
    ) as ChecklistState;
  } catch {
    return null;
  }
}

export function cleanupChecklistState(cwd: string, reviewer: Reviewer): void {
  if (reviewer.stateFile) rmSync(path.resolve(cwd, reviewer.stateFile), { force: true });
}

/** Review-mode packaged assets make a missing checklist an execution-contract error, not a sync gap. */
export async function enforceChecklistContract(
  selection: ReviewerSelection,
  initial: ReviewOutcome,
  cwd: string,
  assetRoot: string | undefined,
  retry: (reason: string) => Promise<ReviewOutcome>,
): Promise<ReviewOutcome> {
  if (initial.status !== 'pass' || !selection.reviewer.stateFile) return initial;
  let result = initial;
  let hole = verifyChecklist(readChecklistState(cwd, selection.reviewer), 'PASS');
  if (hole && assetRoot) {
    console.error(
      `guard-review: ${selection.reviewer.name} — checklist contract not satisfied; retrying once (${hole})`,
    );
    cleanupChecklistState(cwd, selection.reviewer);
    result = await retry(hole);
    if (initial.transcript && result.transcript)
      result.transcript = `${initial.transcript}\n\n───── CHECKLIST-CONTRACT RETRY ─────\n${result.transcript}`;
    if (result.status === 'pass') {
      hole = verifyChecklist(readChecklistState(cwd, selection.reviewer), 'PASS');
      if (hole) {
        result.status = 'error';
        result.reason = `reviewer checklist contract failed after one retry — ${hole}`;
      }
    }
  } else if (hole) {
    result.status = 'inconclusive';
    result.reason = hole;
  }
  return result;
}
