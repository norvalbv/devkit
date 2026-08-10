import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checklistAssetPath, hasChecklist } from "../reviewers.mjs";
const CONSUMER_SKILL_ROOTS = ['.claude', '.agents', '.cursor'];
/** Resolve the provider-projected checklist root actually present in a consumer checkout. */
export function consumerChecklistAssetRoot(cwd, reviewer) {
    if (!hasChecklist(reviewer))
        return '.claude';
    const relativePath = checklistAssetPath(reviewer);
    return (CONSUMER_SKILL_ROOTS.find((root) => existsSync(path.resolve(cwd, root, relativePath))) ??
        '.claude');
}
/** Read one package-relative asset from its consumer-projected brief or skill root. */
export function readConsumerReviewAsset(cwd, cfg, skillRoot, relativePath) {
    const agentsPrefix = 'agents/';
    if (relativePath.startsWith(agentsPrefix)) {
        const dir = cfg.review.agentsDir;
        const base = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
        return readFileSync(path.join(base, relativePath.slice(agentsPrefix.length)));
    }
    return readFileSync(path.resolve(cwd, skillRoot, relativePath));
}
