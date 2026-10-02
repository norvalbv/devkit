import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checklistAssetPath, hasChecklist } from '../reviewers.mjs';
const CONSUMER_SKILL_ROOTS = ['.claude', '.agents', '.cursor'];
/** Inside a ship/reship worktree (incl. --dry-gates)? DEVKIT_RUN_MODE alone can leak into a plain
 *  commit; DEVKIT_SHIP_MODE is exported only by ship-branch.sh/reship.sh after the brief refresh. */
export function isShipLane(env = process.env) {
    const mode = env.DEVKIT_RUN_MODE;
    return (mode === 'ship' || mode === 'dry-gates') && !!env.DEVKIT_SHIP_MODE;
}
/** Where `refresh_ship_reviewer_assets` (cli/lib/ship/prepare-gate-worktree.sh) projects the
 *  running package's briefs inside a ship worktree. The shell target and this constant are twins. */
export const SHIP_AGENTS_PROJECTION = '.claude/agents';
/** Absolute brief dir: the refreshed projection in a ship lane (ship never refreshes a custom
 *  `review.agentsDir`, sc-1882), else the configured dir resolved against `cwd`. */
export function reviewAgentsDir(cwd, cfg, env = process.env) {
    if (isShipLane(env))
        return path.resolve(cwd, SHIP_AGENTS_PROJECTION);
    const dir = cfg.review.agentsDir;
    return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
}
// The running devkit's own root (gate-engine/review/cascade → ../../..), which ships `agents/` and
// `skills/` — keyed to import.meta.url like JSCPD_OWN_ROOT, never to the consumer's cwd (W-3).
export const OWN_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** A consumer brief under a devkit reviewer name in `reviewAgentsDir` wins; otherwise the packaged
 *  one is the brief. */
export function reviewBriefPath(cwd, cfg, name, packagedRoot = OWN_PACKAGE_ROOT) {
    const consumer = path.join(reviewAgentsDir(cwd, cfg), `${name}.md`);
    return existsSync(consumer) ? consumer : path.join(packagedRoot, 'agents', `${name}.md`);
}
/** The skill root a checklist reviewer runs from: a consumer projection wins, else the package. */
export function checklistAssetRoot(cwd, reviewer, packagedRoot = OWN_PACKAGE_ROOT) {
    if (!hasChecklist(reviewer))
        return packagedRoot;
    const relativePath = checklistAssetPath(reviewer);
    return (CONSUMER_SKILL_ROOTS.find((root) => existsSync(path.resolve(cwd, root, relativePath))) ??
        packagedRoot);
}
/** Read one package-relative asset (`agents/x.md`, `skills/…`) from where the judge resolves it. */
export function readReviewAsset(cwd, cfg, skillRoot, relativePath, packagedRoot) {
    if (relativePath.startsWith('agents/'))
        return readFileSync(reviewBriefPath(cwd, cfg, path.basename(relativePath, '.md'), packagedRoot));
    return readFileSync(path.resolve(cwd, skillRoot, relativePath));
}
