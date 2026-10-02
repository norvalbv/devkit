import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSelection, type Selection, structureCmdFor } from '../components.mts';
import { detectGitRoot } from '../detect-git-root.mts';
import { readJson } from '../fs-helpers.mts';
import { syncOverlayHook } from '../overlay.mts';
import { guardBlockMatches, selfHostHookParity } from './hook-parity.mts';
import { buildGuardBlock } from './husky-block.mts';

interface ReviewSetupConfig {
  overlay?: boolean;
  standalone?: boolean;
  selfHost?: boolean;
  stack?: string;
  pkgRel?: string;
  origHooksPath?: string;
  components?: Partial<Selection>;
}

/** Exact generator-backed hook drift check used before `devkit review` executes target code. */
export function reviewHookDrift(cwd: string): string | null {
  const cfg = readJson<ReviewSetupConfig>(join(cwd, '.devkit', 'config.json'));
  if (!cfg) return 'missing .devkit/config.json';
  const { gitRoot, pkgRel } = detectGitRoot(cwd);
  if (cfg.overlay) {
    // Pre-commit drift only: review never runs commit-msg (completeness is a commit gate, sc-2361).
    const sync = syncOverlayHook(gitRoot, cwd, cfg, { dryRun: true });
    return sync.drift ? 'overlay pre-commit differs from the current generator' : null;
  }
  if (cfg.selfHost) return selfHostHookParity(cwd, { components: cfg.components }).reason;

  const hookPath = join(gitRoot, '.husky', 'pre-commit');
  if (!existsSync(hookPath)) return 'missing .husky/pre-commit';
  const selection = normalizeSelection(cfg.components ?? {});
  const expected = buildGuardBlock(
    {
      ...selection,
      structureCmd: selection.structure ? structureCmdFor(cfg.stack ?? 'generic') : undefined,
    },
    pkgRel,
    { binDir: cfg.standalone ? 'global-optional' : 'package' },
  );
  return guardBlockMatches(readFileSync(hookPath, 'utf8'), expected, pkgRel)
    ? null
    : 'pre-commit gate block differs from the current generator';
}
