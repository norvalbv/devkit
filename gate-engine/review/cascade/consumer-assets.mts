import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GuardConfig } from '../../config.mts';
import { checklistAssetPath, hasChecklist, type Reviewer } from '../reviewers.mts';

const CONSUMER_SKILL_ROOTS = ['.claude', '.agents', '.cursor'] as const;

/** Inside a ship/reship worktree (incl. --dry-gates)? DEVKIT_RUN_MODE alone can leak into a plain
 *  commit; DEVKIT_SHIP_MODE is exported only by ship-branch.sh/reship.sh after the brief refresh. */
export function isShipLane(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.DEVKIT_RUN_MODE;
  return (mode === 'ship' || mode === 'dry-gates') && !!env.DEVKIT_SHIP_MODE;
}

/** Where `refresh_ship_reviewer_assets` (cli/lib/ship/prepare-gate-worktree.sh) projects the
 *  running package's briefs inside a ship worktree. The shell target and this constant are twins. */
export const SHIP_AGENTS_PROJECTION = '.claude/agents';

/** Absolute brief dir: the refreshed projection in a ship lane (ship never refreshes a custom
 *  `review.agentsDir`, sc-1882), else the configured dir resolved against `cwd`. */
export function reviewAgentsDir(
  cwd: string,
  cfg: GuardConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (isShipLane(env)) return path.resolve(cwd, SHIP_AGENTS_PROJECTION);
  const dir = cfg.review.agentsDir;
  return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
}

/** Resolve the provider-projected checklist root actually present in a consumer checkout. */
export function consumerChecklistAssetRoot(cwd: string, reviewer: Reviewer): string {
  if (!hasChecklist(reviewer)) return '.claude';
  const relativePath = checklistAssetPath(reviewer);
  return (
    CONSUMER_SKILL_ROOTS.find((root) => existsSync(path.resolve(cwd, root, relativePath))) ??
    '.claude'
  );
}

/** Read one package-relative asset from its consumer-projected brief or skill root. */
export function readConsumerReviewAsset(
  cwd: string,
  cfg: GuardConfig,
  skillRoot: string,
  relativePath: string,
): Buffer {
  const agentsPrefix = 'agents/';
  if (relativePath.startsWith(agentsPrefix)) {
    const base = reviewAgentsDir(cwd, cfg);
    return readFileSync(path.join(base, relativePath.slice(agentsPrefix.length)));
  }
  return readFileSync(path.resolve(cwd, skillRoot, relativePath));
}
