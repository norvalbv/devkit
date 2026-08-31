import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSelection, structureCmdFor } from '../components.mjs';
import { detectGitRoot } from '../detect-git-root.mjs';
import { readJson } from '../fs-helpers.mjs';
import { syncOverlayHook } from '../overlay.mjs';
import { guardBlockMatches, selfHostHookParity } from './hook-parity.mjs';
import { buildGuardBlock, buildStandaloneBlock } from './husky-block.mjs';
/** Exact generator-backed hook drift check used before `devkit review` executes target code. */
export function reviewHookDrift(cwd) {
    const cfg = readJson(join(cwd, '.devkit', 'config.json'));
    if (!cfg)
        return 'missing .devkit/config.json';
    const { gitRoot, pkgRel } = detectGitRoot(cwd);
    if (cfg.overlay) {
        const sync = syncOverlayHook(gitRoot, cwd, cfg, { dryRun: true });
        return sync.drift ? 'overlay pre-commit differs from the current generator' : null;
    }
    if (cfg.selfHost)
        return selfHostHookParity(cwd, { components: cfg.components }).reason;
    const hookPath = join(gitRoot, '.husky', 'pre-commit');
    if (!existsSync(hookPath))
        return 'missing .husky/pre-commit';
    const selection = normalizeSelection(cfg.components ?? {});
    const expected = (cfg.standalone ? buildStandaloneBlock : buildGuardBlock)({
        ...selection,
        structureCmd: selection.structure ? structureCmdFor(cfg.stack ?? 'generic') : undefined,
    }, pkgRel);
    return guardBlockMatches(readFileSync(hookPath, 'utf8'), expected, pkgRel)
        ? null
        : 'pre-commit gate block differs from the current generator';
}
