/** Overlay's local `.devkit/hooks/commit-msg` (sc-1794): devkit's message judges from the global
 *  CLI, failing closed without it, then the repo's own commit-msg. Rationale: overlay-self-heal. */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_LOG_FINISH_PASS } from '../gate-policy/commit-gate-log.mts';
import { buildCommitMsgBlock, COMMIT_MSG_PREAMBLE, commitMsgGuards } from '../commit-msg-block.mts';
import { hookDrift, readHook, writeHookAtomic } from './hook-file.mts';
import { buildPassthroughHook, chainExec, GATES_ONLY_STOP } from '../husky-block.mts';

const LOCAL_HOOK = join('.devkit', 'hooks', 'commit-msg');

// Text that LOOKS like a repo hook already calls a judge. Advisory only (a double-run warning): hook
// text cannot prove execution, so a selected judge is never omitted on its strength.
const JUDGE_SIGNATURES = {
  review: /guard-review["']?\s+completeness\s+--gate/,
  sentry: /guard-sentry["']?\s+--gate/,
} satisfies Record<string, RegExp>;

/** The commit-msg guard ids a (repo-owned) hook body appears to call itself. */
export function judgesAlsoInRepoHook(hookContent: string): string[] {
  return Object.entries(JUDGE_SIGNATURES)
    .filter(([, signature]) => signature.test(hookContent))
    .map(([id]) => id);
}

/** Judge block, then the chain. `exec` drops the EXIT trap, so clear the handoff first (a no-op in a
 *  monorepo, where the package subshell already cleared it). */
export function buildOverlayCommitMsgHook(
  selection: { guards?: string[] },
  chainTarget: string,
  pkgRel = '',
  gitRuns = false,
): string {
  const block = buildCommitMsgBlock(selection, pkgRel, 'global');
  return `${COMMIT_MSG_PREAMBLE}
# devkit OVERLAY commit-msg (LOCAL, git-ignored): devkit's message judges, then the repo's OWN
# commit-msg unchanged. Global CLI; the commit is blocked when devkit is not installed.
${block}

# Judges passed — run the exit work now: \`exec\` replaces this process, so no EXIT trap fires after.
trap - EXIT
command -v __dk_clear_commit_state >/dev/null 2>&1 && { __dk_clear_commit_state || :; }
${GATE_LOG_FINISH_PASS}
${GATES_ONLY_STOP}

# Chain to the repo's own commit-msg (exec → its exit code becomes the hook's).
${chainExec(chainTarget, gitRuns)}
exit 0
`;
}

export interface OverlayCommitMsgInput {
  gitRoot: string;
  /** Where the repo's own hook scripts live, git-root-relative (overlayHookScriptDir). */
  scriptDir: string;
  /** Absolute dir of the repo's hook scripts, as git resolves it for this checkout. */
  scriptsAbs: string;
  /** git runs these hooks itself (not husky's runner), so the chain runs them as git would. */
  gitRuns: boolean;
  /** The repo's existing hook names in scriptDir. */
  existing: string[];
  selection: { guards?: string[] };
  pkgRel: string;
}

export type OverlayCommitMsgPlan =
  | { kind: 'judges'; content: string; judges: string[]; alsoInRepo: string[] }
  | { kind: 'passthrough'; content: string }
  | { kind: 'absent' };

/** Decide what `.devkit/hooks/commit-msg` must contain (or that it must not exist). */
export function planOverlayCommitMsg({
  scriptDir,
  scriptsAbs,
  gitRuns,
  existing,
  selection,
  pkgRel,
}: OverlayCommitMsgInput): OverlayCommitMsgPlan {
  const chainTarget = `${scriptDir}/commit-msg`;
  const hasRepoHook = existing.includes('commit-msg');
  const judges = commitMsgGuards(selection.guards);
  if (judges.length) {
    let repoHook = '';
    try {
      repoHook = hasRepoHook ? readFileSync(join(scriptsAbs, 'commit-msg'), 'utf8') : '';
    } catch {
      repoHook = ''; // unreadable: the warning is advisory, the judges run regardless
    }
    const alsoInRepo = judgesAlsoInRepoHook(repoHook).filter((id) => judges.includes(id));
    const content = buildOverlayCommitMsgHook({ guards: judges }, chainTarget, pkgRel, gitRuns);
    return { kind: 'judges', content, judges, alsoInRepo };
  }
  if (!hasRepoHook) return { kind: 'absent' };
  return { kind: 'passthrough', content: buildPassthroughHook(chainTarget, gitRuns) };
}

/** Compare the hook (bytes AND its exact 0755 mode) with the plan and, unless dryRun, repair it.
 *  Returns the state seen BEFORE any write; `missing` = a hook is wanted and none exists. */
export function syncOverlayCommitMsg(
  input: OverlayCommitMsgInput,
  { dryRun }: { dryRun: boolean },
) {
  const plan = planOverlayCommitMsg(input);
  const path = join(input.gitRoot, LOCAL_HOOK);
  const current = readHook(path);
  const expected = plan.kind === 'absent' ? null : plan.content;
  const drift = hookDrift(current, expected);
  const missing = expected !== null && current === null;
  if (!dryRun && drift) {
    if (expected === null) rmSync(path, { force: true });
    else writeHookAtomic(path, expected);
  }
  return { missing, drift, plan };
}

/** One human line describing the plan, for init / dry-run output. */
export function describeOverlayCommitMsg(plan: OverlayCommitMsgPlan): string | null {
  if (plan.kind !== 'judges') return null;
  const name = (id: string) => (id === 'review' ? 'completeness' : id);
  const line = `commit-msg: devkit ${plan.judges.map(name).join(' + ')} judge(s) → then the repo's own commit-msg`;
  if (!plan.alsoInRepo.length) return line;
  return `${line} (the repo's commit-msg also appears to call ${plan.alsoInRepo.map(name).join(' + ')} — it will run twice; a cached PASS makes the repeat cheap)`;
}

/** Write every non-pre-commit overlay hook: commit-msg per the plan, the rest as pass-throughs (git
 *  runs only `.devkit/hooks`). Shared by install and doctor sync. */
export function syncOverlaySiblingHooks(
  input: OverlayCommitMsgInput,
  { dryRun }: { dryRun: boolean },
) {
  const dir = join(input.gitRoot, '.devkit', 'hooks');
  for (const h of input.existing.filter((n) => n !== 'pre-commit' && n !== 'commit-msg')) {
    if (!dryRun)
      writeHookAtomic(join(dir, h), buildPassthroughHook(`${input.scriptDir}/${h}`, input.gitRuns));
  }
  return syncOverlayCommitMsg(input, { dryRun });
}
