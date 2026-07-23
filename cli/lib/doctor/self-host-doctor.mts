/**
 * `devkit doctor` for a SELF-HOSTED repo (devkit itself): the hook is generated from source paths
 * rather than `bunx guard-*`, so it is compared against the generator directly instead of going
 * through the CheckResult pipeline. Split out of doctor.mts, which is at its line budget.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { printQavisAdvisoryHealth } from '../../commands/doctor.mts';
import type { Selection } from '../components.mts';
import { detectGitRoot } from '../detect-git-root.mts';
import { extractGuardBlock } from '../husky/husky-block.mts';
import {
  buildSelfHostBlock,
  installSelfHostHook,
  SELF_HOST_EXTRAS,
  SELF_HOST_STRUCTURE_CMD,
  selfHostSelection,
} from '../husky/self-host.mts';
import { resolveExistingAgentProviders } from '../install/agent-providers.mts';
import { checkAgentAssets } from './asset-checks.mts';
import type { CheckResult } from './check-result.mts';
import { checkHookRunner } from './hook-checks.mts';
import { printStrayGateCalls } from './stray-gate-calls.mts';

/** The recorded config fields this path consults. */
interface SelfHostConfig {
  components?: Partial<Selection>;
}

export async function runSelfHostDoctor(
  cwd: string,
  cfg: SelfHostConfig,
  fix: boolean,
): Promise<number> {
  const { gitRoot, pkgRel } = detectGitRoot(cwd);
  const hookPath = join(gitRoot, '.husky', 'pre-commit');
  console.log('devkit doctor — self-host (source-mode dogfood)\n');

  let hookOk = false;
  if (!existsSync(hookPath)) {
    console.log('  ✗ .husky/pre-commit MISSING — run `devkit init` (self-host)');
  } else {
    const currentBlock = extractGuardBlock(readFileSync(hookPath, 'utf8'), pkgRel);
    const expectedBlock = buildSelfHostBlock(
      { ...selfHostSelection(), structureCmd: SELF_HOST_STRUCTURE_CMD, extras: SELF_HOST_EXTRAS },
      pkgRel,
      cwd,
    );
    if (currentBlock !== null && currentBlock.trim() === expectedBlock.trim()) {
      hookOk = true;
      console.log('  ✓ .husky/pre-commit in sync with the generator');
    } else if (fix) {
      installSelfHostHook(gitRoot, pkgRel, selfHostSelection(), false, cwd);
      hookOk = true;
      console.log(
        '  ✓ .husky/pre-commit regenerated (was stale — refreshed to the current generator)',
      );
    } else {
      console.log(
        '  ⚠ .husky/pre-commit is STALE (generator changed or the hook was hand-edited) — run `devkit doctor --fix`',
      );
    }
    // Self-host never runs checkHusky, so without this the duplicate-gate warning is unreachable in
    // exactly the repo that dogfoods devkit — the one most likely to grow a hand-written gate copy.
    printStrayGateCalls(readFileSync(hookPath, 'utf8'), pkgRel, cwd);
  }

  // Agent assets — advisory (never gate the exit code; a re-run re-syncs them).
  const recorded: Partial<Selection> = cfg.components ?? {};
  const surfaces = resolveExistingAgentProviders(gitRoot, recorded.agentTargets);
  const sel: Partial<Selection> = { ...recorded, agentTargets: surfaces };
  const advise = (r: CheckResult) =>
    console.log(`  ${r.status === 'OK' ? '✓' : '·'} ${r.name}: ${r.detail}`);
  if (sel.skills && surfaces.length)
    advise(checkAgentAssets(cwd, 'skills', surfaces, { guards: sel.guards ?? [] }));
  if (sel.agents && surfaces.length) advise(checkAgentAssets(cwd, 'agents', surfaces));
  printQavisAdvisoryHealth(cwd, sel.guards ?? []);

  // The dogfood repo is gated by the same mechanism devkit ships to consumers, so it owes itself the
  // same worktree-safety verdict — a self-host repo whose runner is unreachable gates nothing either.
  const runner = checkHookRunner(cwd);
  console.log(`  ${runner.status === 'OK' ? '✓' : '⚠'} ${runner.name}: ${runner.detail}`);
  if (runner.status !== 'OK') console.log(`      → ${runner.remediation}`);

  return hookOk && runner.status === 'OK' ? 0 : 1;
}
