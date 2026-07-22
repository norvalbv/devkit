import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSelection, structureCmdFor } from "../components.mjs";
import { detectGitRoot } from "../detect-git-root.mjs";
import { readJson } from "../fs-helpers.mjs";
import { syncOverlayHook } from "../overlay.mjs";
import { buildGuardBlock, buildStandaloneBlock, extractGuardBlock } from "./husky-block.mjs";
import { buildSelfHostBlock, SELF_HOST_EXTRAS, SELF_HOST_STRUCTURE_CMD, selfHostSelection, } from "./self-host.mjs";
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
    const hookPath = join(gitRoot, '.husky', 'pre-commit');
    if (!existsSync(hookPath))
        return 'missing .husky/pre-commit';
    const current = extractGuardBlock(readFileSync(hookPath, 'utf8'), pkgRel);
    const selection = normalizeSelection(cfg.components ?? {});
    const expected = cfg.selfHost
        ? buildSelfHostBlock({ ...selfHostSelection(), structureCmd: SELF_HOST_STRUCTURE_CMD, extras: SELF_HOST_EXTRAS }, pkgRel, cwd)
        : (cfg.standalone ? buildStandaloneBlock : buildGuardBlock)({
            ...selection,
            structureCmd: selection.structure ? structureCmdFor(cfg.stack ?? 'generic') : undefined,
        }, pkgRel);
    return current !== null && current.trim() === expected.trim()
        ? null
        : 'pre-commit gate block differs from the current generator';
}
