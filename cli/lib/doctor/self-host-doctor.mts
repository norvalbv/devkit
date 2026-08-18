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
import { checkAdhdSkill } from '../install/adhd-skill.mts';
import { readBaseline } from '../install/anti-slop/baseline.mts';
import {
  checkAntiSlopCapability,
  syncAntiSlopCapability,
} from '../install/anti-slop/lifecycle.mts';
import { checkOxcCapability } from '../install/oxc/lifecycle.mts';
import { checkAgents, checkSkills } from './asset-checks.mts';
import { type CheckResult, check } from './check-result.mts';
import { adviseSearchIndex } from './guard-config-checks.mts';
import { checkHookRunner, checkHooksPathOwner } from './hook-checks.mts';
import { printStrayGateCalls } from './stray-gate-calls.mts';
import { inspectHookFailOpen, renderUnguardedGateCalls } from './unguarded-gate-calls.mts';

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
  const selection = selfHostSelection(cfg.components);

  let capabilityResults = [...checkOxcCapability(cwd), ...checkAntiSlopCapability(cwd)];
  if (fix && capabilityResults.some((result) => result.status !== 'OK')) {
    syncAntiSlopCapability(cwd);
    capabilityResults = [...checkOxcCapability(cwd), ...checkAntiSlopCapability(cwd)];
  }
  for (const result of capabilityResults) {
    const glyph = result.status === 'OK' ? '✓' : result.status === 'MISSING' ? '✗' : '⚠';
    console.log(`  ${glyph} ${result.name}: ${result.detail}`);
    if (result.status !== 'OK' && result.remediation) console.log(`      → ${result.remediation}`);
  }
  let baselineResult: CheckResult;
  try {
    const baseline = readBaseline(cwd);
    baselineResult = baseline
      ? check(
          'anti-slop baseline',
          'OK',
          `${baseline.entries.reduce((sum, entry) => sum + entry.count, 0)} adopted finding(s)`,
        )
      : check(
          'anti-slop baseline',
          'MISSING',
          '.anti-slop-baseline.json',
          'run `devkit anti-slop create` explicitly',
        );
  } catch (error: unknown) {
    baselineResult = check(
      'anti-slop baseline',
      'DRIFT',
      error instanceof Error ? error.message : String(error),
      'inspect and explicitly recreate the baseline',
    );
  }
  console.log(
    `  ${baselineResult.status === 'OK' ? '✓' : baselineResult.status === 'MISSING' ? '✗' : '⚠'} ${baselineResult.name}: ${baselineResult.detail}`,
  );
  if (baselineResult.status !== 'OK' && baselineResult.remediation)
    console.log(`      → ${baselineResult.remediation}`);

  let hookOk = false;
  if (!existsSync(hookPath)) {
    console.log('  ✗ .husky/pre-commit MISSING — run `devkit init` (self-host)');
  } else {
    const currentBlock = extractGuardBlock(readFileSync(hookPath, 'utf8'), pkgRel);
    const expectedBlock = buildSelfHostBlock(
      { ...selection, structureCmd: SELF_HOST_STRUCTURE_CMD, extras: SELF_HOST_EXTRAS },
      pkgRel,
      cwd,
    );
    if (currentBlock !== null && currentBlock.trim() === expectedBlock.trim()) {
      hookOk = true;
      console.log('  ✓ .husky/pre-commit in sync with the generator');
    } else if (fix) {
      installSelfHostHook(gitRoot, pkgRel, selection, false, cwd);
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
    // Same reason for the fail-open check (sc-1366): devkit's own generated calls are `-e`-safe,
    // but a hand-added gate below the managed block would not be, and this is the repo where one
    // is most likely to appear.
    const failOpen = inspectHookFailOpen(gitRoot, join('.husky', 'pre-commit'));
    for (const line of renderUnguardedGateCalls(failOpen, '.husky/pre-commit')) {
      console.log(`  ⚠ ${line}`);
    }
  }

  // Agent assets — advisory (never gate the exit code; a re-run re-syncs them).
  const sel: Partial<Selection> = cfg.components ?? {};
  const surfaces = sel.agentTargets ?? ['claude', 'cursor'];
  const primary = surfaces.includes('claude') ? 'claude' : surfaces[0];
  const advise = (r: CheckResult) =>
    console.log(`  ${r.status === 'OK' ? '✓' : '·'} ${r.name}: ${r.detail}`);
  if (sel.skills && primary) advise(await checkSkills(cwd, primary));
  if (sel.agents && primary) advise(await checkAgents(cwd, primary));
  // A selected component whose payload is missing is its OWN finding, not a skills-manifest count.
  // Without this line the dogfood repo saw only "bundle has 1 skill(s) the manifest lacks
  // (i-have-adhd)" — which reads as bookkeeping drift, while what it actually meant was that a
  // component the config said was ON had no installed skill and a silently self-skipping hook.
  if (sel.adhd) advise(checkAdhdSkill(cwd));
  // Self-host never reaches collectResults, so without this the dup gate's silent opt-out is
  // undetectable in exactly the repo that dogfoods devkit — the one whose own index is most likely
  // to drift out of guard.config.json. Advisory: the exit code stays gated on hook + runner.
  await adviseSearchIndex(cwd, sel);
  printQavisAdvisoryHealth(cwd, sel.guards ?? []);

  // The dogfood repo is gated by the same mechanism devkit ships to consumers, so it owes itself the
  // same worktree-safety verdict — a self-host repo whose runner is unreachable gates nothing either.
  // For the same reason it owes itself the ownership verdict: devkit is developed almost entirely
  // from linked worktrees, which is exactly where a foreign core.hooksPath hides.
  const hookState = [checkHookRunner(cwd), ...checkHooksPathOwner(cwd)];
  for (const r of hookState) {
    console.log(`  ${r.status === 'OK' ? '✓' : '⚠'} ${r.name}: ${r.detail}`);
    if (r.status !== 'OK') console.log(`      → ${r.remediation}`);
  }

  const capabilitiesOk = capabilityResults.every((result) => result.status === 'OK');
  return hookOk &&
    hookState.every((r) => r.status === 'OK') &&
    capabilitiesOk &&
    baselineResult.status === 'OK'
    ? 0
    : 1;
}
