import { CONFIG_FILENAME, type GuardConfig, resolveGuardConfigJson } from '../../config.mts';
import { headFile, indexFile } from '../evidence/staged-git.mts';
import { selectReviewers, type ReviewerSelection } from '../reviewers.mts';

/** Apply both staged and HEAD correctness policy when the commit changes its own scope. */
export function selectRepositoryReviewers(
  stagedFiles: string[],
  cfg: GuardConfig,
): ReviewerSelection[] {
  const indexedCfg = resolveGuardConfigJson(indexFile(cfg.cwd, CONFIG_FILENAME), cfg.cwd);
  const baselineCfg = stagedFiles.includes(CONFIG_FILENAME)
    ? resolveGuardConfigJson(headFile(cfg.cwd, CONFIG_FILENAME), cfg.cwd)
    : undefined;
  return selectReviewers(stagedFiles, cfg, baselineCfg, indexedCfg);
}
