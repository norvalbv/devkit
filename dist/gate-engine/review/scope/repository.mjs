import { CONFIG_FILENAME, resolveGuardConfigJson } from '../../config.mjs';
import { headFile, indexFile } from '../evidence/staged-git.mjs';
import { effectiveReviewConfig, selectReviewers } from '../reviewers.mjs';
/** Apply both staged and HEAD review policy when the commit changes its own scope. */
export function selectRepositoryReviewers(stagedFiles, cfg) {
    const effective = (snapshot) => process.env.DEVKIT_RUN_MODE === 'review' ? effectiveReviewConfig(snapshot) : snapshot;
    const indexedCfg = effective(resolveGuardConfigJson(indexFile(cfg.cwd, CONFIG_FILENAME), cfg.cwd));
    const baselineCfg = stagedFiles.includes(CONFIG_FILENAME)
        ? effective(resolveGuardConfigJson(headFile(cfg.cwd, CONFIG_FILENAME), cfg.cwd))
        : undefined;
    return selectReviewers(stagedFiles, indexedCfg, baselineCfg);
}
