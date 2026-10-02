import { CONFIG_FILENAME, type GuardConfig, resolveGuardConfigJson } from '../../config.mts';
import { gitIgnores, headFile, indexFile } from '../evidence/staged-git.mts';
import { effectiveReviewConfig, selectReviewers, type ReviewerSelection } from '../reviewers.mts';

/** The commit's own policy is its index copy. A git-ignored config (an overlay's) can never be
 * staged, so the working-tree copy every other gate reads is the policy instead. */
function stagedPolicy(cfg: GuardConfig): GuardConfig {
  const indexed = indexFile(cfg.cwd, CONFIG_FILENAME);
  if (indexed === null && gitIgnores(cfg.cwd, CONFIG_FILENAME)) return cfg;
  return resolveGuardConfigJson(indexed, cfg.cwd);
}

/** Apply both staged and HEAD review policy when the commit changes its own scope. */
export function selectRepositoryReviewers(
  stagedFiles: string[],
  cfg: GuardConfig,
): ReviewerSelection[] {
  const effective = (snapshot: GuardConfig) =>
    process.env.DEVKIT_RUN_MODE === 'review' ? effectiveReviewConfig(snapshot) : snapshot;
  const baselineCfg = stagedFiles.includes(CONFIG_FILENAME)
    ? effective(resolveGuardConfigJson(headFile(cfg.cwd, CONFIG_FILENAME), cfg.cwd))
    : undefined;
  return selectReviewers(stagedFiles, effective(stagedPolicy(cfg)), baselineCfg);
}
