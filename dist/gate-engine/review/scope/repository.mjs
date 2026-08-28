import { CONFIG_FILENAME, resolveGuardConfigJson } from '../../config.mjs';
import { headFile, indexFile } from '../evidence/staged-git.mjs';
import { selectReviewers } from '../reviewers.mjs';
/** Apply both staged and HEAD correctness policy when the commit changes its own scope. */
export function selectRepositoryReviewers(stagedFiles, cfg) {
    const indexedCfg = resolveGuardConfigJson(indexFile(cfg.cwd, CONFIG_FILENAME), cfg.cwd);
    const baselineCfg = stagedFiles.includes(CONFIG_FILENAME)
        ? resolveGuardConfigJson(headFile(cfg.cwd, CONFIG_FILENAME), cfg.cwd)
        : undefined;
    return selectReviewers(stagedFiles, cfg, baselineCfg, indexedCfg);
}
