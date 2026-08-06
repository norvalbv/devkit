/**
 * Overlay-mode doctor. Overlay health is gated by its local hook + `core.hooksPath`; agent assets
 * and fallow are advisory (printed, never in the exit code) because a re-run re-syncs them.
 *
 * Lives here beside `self-host-doctor.mts` — the same shape, a mode-specific doctor in its own
 * module — rather than in `doctor.mts`, which is at its line budget.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Selection } from '../components.mts';
import { detectGitRoot } from '../detect-git-root.mts';
import { resolveExistingAgentProviders } from '../install/agent-assets/agent-providers.mts';
import { selectedHookAssets } from '../install/hook-registration-ledger/selection.mts';
import { HEAL_ALIAS_NAME, isHealAlias, syncOverlayHook } from '../overlay.mts';
import { globalHookInstalled, globalInitPath } from '../overlay-global-hook.mts';
import { checkAgentAssets, checkRegistrations } from './asset-checks.mts';
import type { CheckResult } from './check-result.mts';
import { adviseSearchIndex } from './guard-config-checks.mts';
import { repointHooksPath } from './hook-checks.mts';

/** The recorded `.devkit/config.json` fields the overlay doctor consults. */
export interface OverlayDoctorConfig {
  components?: Partial<Selection>;
}

// Reason: flat signal reporting keeps the exit code gated only on hook + path.
// fallow-ignore-next-line complexity
export async function runOverlayDoctor(
  cwd: string,
  cfg: OverlayDoctorConfig,
  fix: boolean,
  printQavisAdvisoryHealth: (cwd: string, guards: string[]) => void,
): Promise<number> {
  // hooksPath and its alias are repo-wide, including for a monorepo package.
  const { gitRoot } = detectGitRoot(cwd);
  const gitGet = (key: string): string => {
    try {
      return execFileSync('git', ['config', '--get', key], {
        cwd: gitRoot,
        encoding: 'utf8',
      }).trim();
    } catch {
      return ''; // unset
    }
  };
  const hooksPath = gitGet('core.hooksPath');
  const aliasOurs = isHealAlias(gitGet(`alias.${HEAL_ALIAS_NAME}`));
  // Compare the ignored overlay hook with a fresh build; --fix rewrites stale/missing copies.
  const sync = syncOverlayHook(gitRoot, cwd, cfg, { dryRun: !fix });
  const hookOk = existsSync(join(gitRoot, '.devkit', 'hooks', 'pre-commit')); // post-fix presence
  const healed = fix && hooksPath !== '.devkit/hooks' && repointHooksPath(gitRoot, hookOk);
  const pathOk = healed || hooksPath === '.devkit/hooks';
  console.log('devkit doctor — overlay (local-only)\n');
  if (!hookOk)
    console.log(
      '  ✗ .devkit/hooks/pre-commit MISSING — run `devkit doctor --fix` (or `devkit init --overlay`)',
    );
  else if (fix && (sync.missing || sync.drift))
    console.log(
      '  ✓ .devkit/hooks/pre-commit regenerated (was stale/missing — refreshed to the current devkit)',
    );
  else if (sync.drift)
    console.log(
      '  ⚠ .devkit/hooks/pre-commit is STALE (predates the current devkit) — run `devkit doctor --fix` to refresh',
    );
  else console.log('  ✓ .devkit/hooks/pre-commit present');
  console.log(
    `  ${pathOk ? '✓' : '⚠'} core.hooksPath = ${healed ? `.devkit/hooks (re-pointed from ${hooksPath || '(unset)'}; husky reclaims it on every install — make it durable with \`devkit init --overlay --global-commit-gate\`)` : hooksPath || '(unset)'}${pathOk ? '' : ` — heal with \`git ${HEAL_ALIAS_NAME}\` (re-points it), \`devkit doctor --fix\`, or re-run \`devkit init --overlay\``}`,
  );
  // Advisory only — never affects the exit code (hook + path are the real health signal).
  if (aliasOurs && !hookOk)
    console.log(
      `  ⚠ git ${HEAL_ALIAS_NAME} points at a missing .devkit/hooks — run \`devkit clean\``,
    );
  else if (aliasOurs) console.log(`  ✓ git ${HEAL_ALIAS_NAME} self-heal alias`);
  else
    console.log(
      `  · self-heal off (git ${HEAL_ALIAS_NAME} re-points core.hooksPath; or re-run \`devkit init --overlay\`)`,
    );
  // The opt-in global shim gates plain commits after Husky reclaims hooksPath; advisory here.
  if (globalHookInstalled()) {
    console.log(`  ✓ global pre-commit gate (${globalInitPath()}) — plain \`git commit\` gated`);
    if (aliasOurs)
      console.log(
        `    (git ${HEAL_ALIAS_NAME} is the CLI fast-path; shim + alias don't double-run)`,
      );
    // Husky cannot source the shim without a committed .husky/pre-commit.
    const huskyPresent =
      existsSync(join(gitRoot, '.husky', '_')) || existsSync(join(gitRoot, '.husky'));
    if (huskyPresent && !existsSync(join(gitRoot, '.husky', 'pre-commit')))
      console.log(
        `  ⚠ no committed .husky/pre-commit — husky won't source the shim for pre-commit; a plain \`git commit\` stays ungated here (use \`git ${HEAL_ALIAS_NAME}\`)`,
      );
  } else if (!pathOk) {
    console.log(
      `  · plain \`git commit\` is ungated (husky reclaimed core.hooksPath); \`git ${HEAL_ALIAS_NAME}\` heals it, or wire it permanently with \`devkit init --overlay --global-commit-gate\``,
    );
  }
  // Agent-half + fallow checks — ADVISORY (printed, never gate the exit code; a re-run re-syncs them).
  const recorded: Partial<Selection> = cfg?.components ?? {};
  const surfaces = resolveExistingAgentProviders(gitRoot, recorded.agentTargets);
  const sel: Partial<Selection> = { ...recorded, agentTargets: surfaces };
  const advise = (r: CheckResult) =>
    console.log(`  ${r.status === 'OK' ? '✓' : '·'} ${r.name}: ${r.detail}`);
  const hooks = selectedHookAssets(sel, { searchSteering: false });
  if (sel.skills && surfaces.length) advise(checkAgentAssets(cwd, 'skills', surfaces, sel));
  if (sel.agents && surfaces.length) advise(checkAgentAssets(cwd, 'agents', surfaces));
  if (hooks.scripts.length && surfaces.length)
    advise(checkAgentAssets(cwd, 'hooks', surfaces, { expected: hooks.scripts }));
  if (surfaces.length) advise(checkRegistrations(cwd, hooks.components, surfaces, true));
  // Overlay short-circuits before collectResults, so the dup gate's silent opt-out would otherwise
  // be undetectable here. Advisory: overlay health is gated on hook + hooksPath.
  await adviseSearchIndex(cwd, sel);
  printQavisAdvisoryHealth(cwd, sel.guards ?? []);
  if (sel.fallow) {
    const wired =
      hookOk &&
      readFileSync(join(gitRoot, '.devkit', 'hooks', 'pre-commit'), 'utf8').includes(
        'fallow audit',
      );
    console.log(
      `  ${wired ? '✓' : '·'} fallow gate: ${wired ? 'wired in the local hook' : 'not wired'}`,
    );
  }
  // A stale hook is unhealthy (exit 1) so CI/agents notice; --fix having just regenerated it heals this run.
  return hookOk && pathOk && (fix || !sync.drift) ? 0 : 1;
}
