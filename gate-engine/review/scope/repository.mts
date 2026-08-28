import { CONFIG_FILENAME, type GuardConfig, resolveGuardConfigJson } from '../../config.mts';
import { headFile, indexFile } from '../evidence/staged-git.mts';
import { effectiveReviewConfig, selectReviewers, type ReviewerSelection } from '../reviewers.mts';

/** Apply both staged and HEAD review policy when the commit changes its own scope. */
export function selectRepositoryReviewers(
  stagedFiles: string[],
  cfg: GuardConfig,
): ReviewerSelection[] {
  const effective = (snapshot: GuardConfig) =>
    process.env.DEVKIT_RUN_MODE === 'review' ? effectiveReviewConfig(snapshot) : snapshot;
  const indexedCfg = effective(
    resolveGuardConfigJson(indexFile(cfg.cwd, CONFIG_FILENAME), cfg.cwd),
  );
  const baselineCfg = stagedFiles.includes(CONFIG_FILENAME)
    ? effective(resolveGuardConfigJson(headFile(cfg.cwd, CONFIG_FILENAME), cfg.cwd))
    : undefined;
  return selectReviewers(stagedFiles, indexedCfg, baselineCfg);
}
