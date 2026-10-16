import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// The running devkit's own root (gate-engine/review/cascade → ../../..), which ships `agents/` and
// `skills/` — keyed to import.meta.url like JSCPD_OWN_ROOT, never to the consumer's cwd (W-3).
export const OWN_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/** True only in devkit's own repo: the gate code runs from the tree it judges, so that tree's
 *  `agents/` and `skills/` are the sources; any `.claude` copy is a possibly stale projection. */
function runsFromJudgedTree(cwd: string): boolean {
  try {
    return realpathSync(OWN_PACKAGE_ROOT) === realpathSync(cwd);
  } catch {
    return false;
  }
}

/** The judged tree's own brief in self-host; else a consumer brief under a devkit reviewer name in
 *  `reviewAgentsDir` wins, and otherwise the packaged one is the brief. */
export function reviewBriefPath(
  cwd: string,
  cfg: GuardConfig,
  name: string,
  packagedRoot = OWN_PACKAGE_ROOT,
): string {
  if (runsFromJudgedTree(cwd)) return path.join(OWN_PACKAGE_ROOT, 'agents', `${name}.md`);
  const consumer = path.join(reviewAgentsDir(cwd, cfg), `${name}.md`);
  return existsSync(consumer) ? consumer : path.join(packagedRoot, 'agents', `${name}.md`);
}

/** The skill root a checklist reviewer runs from: self-host's own `skills/` as a relative '.' (judge
 *  commands splice it unquoted), else a consumer projection, else the package. */
export function checklistAssetRoot(
  cwd: string,
  reviewer: Reviewer,
  packagedRoot = OWN_PACKAGE_ROOT,
): string {
  if (!hasChecklist(reviewer)) return packagedRoot;
  if (runsFromJudgedTree(cwd)) return '.';
  const relativePath = checklistAssetPath(reviewer);
  return (
    CONSUMER_SKILL_ROOTS.find((root) => existsSync(path.resolve(cwd, root, relativePath))) ??
    packagedRoot
  );
}

/** Read one package-relative asset (`agents/x.md`, `skills/…`) from where the judge resolves it. */
export function readReviewAsset(
  cwd: string,
  cfg: GuardConfig,
  skillRoot: string,
  relativePath: string,
  packagedRoot?: string,
): Buffer {
  if (relativePath.startsWith('agents/'))
    return readFileSync(
      reviewBriefPath(cwd, cfg, path.basename(relativePath, '.md'), packagedRoot),
    );
  return readFileSync(path.resolve(cwd, skillRoot, relativePath));
}
