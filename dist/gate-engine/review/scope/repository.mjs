import { CONFIG_FILENAME, resolveGuardConfigJson } from '../../config.mjs';
import { gitIgnores, headFile, indexFile } from '../evidence/staged-git.mjs';
import { effectiveReviewConfig, selectReviewers } from '../reviewers.mjs';
/** The commit's own policy is its index copy. A git-ignored config (an overlay's) can never be
 * staged, so the working-tree copy every other gate reads is the policy instead. */
function stagedPolicy(cfg) {
    const indexed = indexFile(cfg.cwd, CONFIG_FILENAME);
    if (indexed === null && gitIgnores(cfg.cwd, CONFIG_FILENAME))
        return cfg;
    return resolveGuardConfigJson(indexed, cfg.cwd);
}
/** Apply both staged and HEAD review policy when the commit changes its own scope. */
export function selectRepositoryReviewers(stagedFiles, cfg) {
    const effective = (snapshot) => process.env.DEVKIT_RUN_MODE === 'review' ? effectiveReviewConfig(snapshot) : snapshot;
    const baselineCfg = stagedFiles.includes(CONFIG_FILENAME)
        ? effective(resolveGuardConfigJson(headFile(cfg.cwd, CONFIG_FILENAME), cfg.cwd))
        : undefined;
    return selectReviewers(stagedFiles, effective(stagedPolicy(cfg)), baselineCfg);
}
