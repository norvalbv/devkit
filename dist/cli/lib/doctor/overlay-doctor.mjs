/**
 * Overlay-mode doctor. Overlay health is gated by its local hook, `core.hooksPath` and the synced
 * agent half, which `--fix` re-syncs; fallow and the other advisories never reach the exit code.
 *
 * Lives here beside `self-host-doctor.mts` — the same shape, a mode-specific doctor in its own
 * module — rather than in `doctor.mts`, which is at its line budget.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { applyOverlayConstraints, normalizeSelection } from '../components.mjs';
import { detectGitRoot } from '../detect-git-root.mjs';
import { resolveExistingAgentProviders, } from '../install/agent-assets/agent-providers.mjs';
import { ANTI_SLOP_BASELINE_REL } from '../install/anti-slop/constants.mjs';
import { checkAntiSlopCapability, syncAntiSlopCapability, } from '../install/anti-slop/lifecycle.mjs';
import { selectedHookAssets } from '../install/hook-registration-ledger/selection.mjs';
import { checkOxcCapability, syncOxcCapability } from '../install/oxc/lifecycle.mjs';
import { commitMsgGuards } from '../husky/commit-msg-block.mjs';
import { hasOwnOverlay, LOCAL_HOOKS, overlayHome, overlayHooksPath, worktrees, } from '../husky/overlay/overlay-home.mjs';
import { printProjectionGaps } from '../husky/overlay/projection-report.mjs';
import { HEAL_ALIAS_NAME, isHealAlias, resyncOverlayAgentSurfaces, syncOverlayHook, } from '../overlay.mjs';
import { globalHookInstalled, globalHookWired, globalInitPath, installGlobalHook, } from '../overlay-global-hook.mjs';
import { checkAgentAssets, checkRegistrations } from './asset-checks.mjs';
import { adviseCodexRuntime, adviseSearchIndex } from './guard-config-checks.mjs';
import { repointHooksPath } from './hook-checks.mjs';
import { hooksDir, sameDir, worktreeScopedPin } from './hooks-path.mjs';
import { printPriorArtAdvisoryHealth } from './qavis-health.mjs';
// Reason: flat signal reporting; the exit code is the conjunction of the gating rows.
// fallow-ignore-next-line complexity
export async function runOverlayDoctor(cwd, cfg, fix, printQavisAdvisoryHealth) {
    // hooksPath and its alias are repo-wide, including for a monorepo package.
    const { gitRoot, pkgRel } = detectGitRoot(cwd);
    const gitGet = (key) => {
        try {
            return execFileSync('git', ['config', '--get', key], {
                cwd: gitRoot,
                encoding: 'utf8',
            }).trim();
        }
        catch {
            return ''; // unset
        }
    };
    const hooksPath = gitGet('core.hooksPath');
    const aliasOurs = isHealAlias(gitGet(`alias.${HEAL_ALIAS_NAME}`));
    // Compare the ignored overlay hook with a fresh build; --fix rewrites stale/missing copies.
    const sync = syncOverlayHook(gitRoot, cwd, cfg, { dryRun: !fix });
    const hookOk = existsSync(join(gitRoot, '.devkit', 'hooks', 'pre-commit')); // post-fix presence
    // sc-4157: only the ABSOLUTE value reaches linked worktrees; the legacy relative one is drift.
    const home = overlayHome(gitRoot) ?? gitRoot; // never a linked worktree's legacy copy
    const expected = overlayHooksPath(home);
    const current = isAbsolute(hooksPath) && sameDir(hooksPath, expected);
    const healed = fix && !current && repointHooksPath(home, hookOk);
    const pathOk = healed || current;
    console.log('devkit doctor — overlay (local-only)\n');
    if (!hookOk)
        console.log('  ✗ .devkit/hooks/pre-commit MISSING — run `devkit doctor --fix` (or `devkit init --overlay`)');
    else if (fix && (sync.missing || sync.drift))
        console.log('  ✓ .devkit/hooks/pre-commit regenerated (was stale/missing — refreshed to the current devkit)');
    else if (sync.drift)
        console.log('  ⚠ .devkit/hooks/pre-commit is STALE (predates the current devkit) — run `devkit doctor --fix` to refresh');
    else
        console.log('  ✓ .devkit/hooks/pre-commit present');
    console.log(`  ${pathOk ? '✓' : '⚠'} core.hooksPath = ${healed ? `${expected} (re-pointed from ${hooksPath || '(unset)'}; husky reclaims it on every install — make it durable with \`devkit init --overlay --global-commit-gate\`)` : hooksPath || '(unset)'}${hooksPath === LOCAL_HOOKS && !pathOk ? ' — RELATIVE, so every linked worktree runs no hooks at all;' : ''}${pathOk ? '' : ` — heal with \`git ${HEAL_ALIAS_NAME}\` (re-points it), \`devkit doctor --fix\`, or re-run \`devkit init --overlay\``}`);
    const worktreesOk = printLinkedWorktrees(home, pkgRel, fix);
    const judgesWired = printCommitMsgRow(cfg, fix, sync.commitMsg);
    if (judgesWired && !pathOk && !globalHookInstalled())
        console.log(`    commit-msg judges run only via \`git ${HEAL_ALIAS_NAME}\` / \`devkit ship\` while husky owns core.hooksPath`);
    // Advisory only — never affects the exit code (hook + path are the real health signal).
    if (aliasOurs && !hookOk)
        console.log(`  ⚠ git ${HEAL_ALIAS_NAME} points at a missing .devkit/hooks — run \`devkit clean\``);
    else if (aliasOurs)
        console.log(`  ✓ git ${HEAL_ALIAS_NAME} self-heal alias`);
    else
        console.log(`  · self-heal off (git ${HEAL_ALIAS_NAME} re-points core.hooksPath; or re-run \`devkit init --overlay\`)`);
    // The opt-in global shim gates plain commits after Husky reclaims hooksPath; advisory here.
    if (globalHookInstalled()) {
        // An older devkit's shim gates pre-commit only; the user opted in, so --fix refreshes it.
        if (fix && !globalHookWired())
            installGlobalHook();
        if (globalHookWired())
            console.log(`  ✓ global commit gate (${globalInitPath()}) — plain \`git commit\` gated`);
        else
            console.log(`  ⚠ global commit gate (${globalInitPath()}) predates this devkit, so a plain \`git commit\` may skip the commit-msg judges — run \`devkit doctor --fix\``);
        if (aliasOurs)
            console.log(`    (git ${HEAL_ALIAS_NAME} is the CLI fast-path; shim + alias don't double-run)`);
        // Husky sources the shim only for a hook the repo commits under .husky/.
        const huskyPresent = existsSync(join(gitRoot, '.husky', '_')) || existsSync(join(gitRoot, '.husky'));
        for (const hook of judgesWired ? ['pre-commit', 'commit-msg'] : ['pre-commit'])
            if (huskyPresent && !existsSync(join(gitRoot, '.husky', hook)))
                console.log(`  ⚠ no committed .husky/${hook} — husky won't source the shim for ${hook}; a plain \`git commit\` skips its gates here (use \`git ${HEAL_ALIAS_NAME}\`)`);
    }
    else if (!pathOk) {
        console.log(`  · plain \`git commit\` is ungated (husky reclaimed core.hooksPath); \`git ${HEAL_ALIAS_NAME}\` heals it, or wire it permanently with \`devkit init --overlay --global-commit-gate\``);
    }
    const recorded = cfg?.components ?? {};
    // The agent half is installed once, at the overlay's own checkout: a linked worktree only links it.
    const agentRoot = hasOwnOverlay(gitRoot) ? gitRoot : home;
    const surfaces = resolveExistingAgentProviders(agentRoot, recorded.agentTargets);
    // What install wrote: the recorded choices under the overlay invariants, never a defaulted structure.
    const sel = applyOverlayConstraints({
        ...normalizeSelection(recorded),
        structure: Boolean(recorded.structure),
        agentTargets: surfaces,
    }, cfg.stack ?? 'generic');
    const advise = (r) => console.log(`  ${r.status === 'OK' ? '✓' : '·'} ${r.name}: ${r.detail}`);
    let agentRows = agentHalfChecks(agentRoot, sel, surfaces);
    // Package doctor gates and re-syncs the same rows; preserved collisions stay preserved.
    if (fix && agentRows.some((r) => r.fixable && r.status !== 'OK')) {
        resyncOverlayAgentSurfaces(agentRoot, sel, recorded, () => false);
        agentRows = agentHalfChecks(agentRoot, sel, surfaces);
    }
    for (const r of agentRows)
        console.log(`  ${r.status === 'OK' ? '✓' : '⚠'} ${r.name}: ${r.detail}${r.status !== 'OK' && r.fixable ? ' — run `devkit doctor --fix`' : ''}`);
    const agentsOk = agentRows.every((r) => r.status === 'OK');
    // Overlay short-circuits before collectResults, so the dup gate's silent opt-out would otherwise
    // be undetectable here. Advisory: never in the exit code.
    await adviseSearchIndex(cwd, sel);
    await adviseCodexRuntime(cwd, sel);
    printQavisAdvisoryHealth(cwd, sel.guards ?? []);
    printPriorArtAdvisoryHealth(cwd, sel);
    if (sel.fallow) {
        const wired = hookOk &&
            readFileSync(join(gitRoot, '.devkit', 'hooks', 'pre-commit'), 'utf8').includes('fallow audit');
        console.log(`  ${wired ? '✓' : '·'} fallow gate: ${wired ? 'wired in the local hook' : 'not wired'}`);
    }
    // Overlay short-circuits before collectResults, so without these rows its git-excluded managed
    // state is undiagnosable. Oxc is core in every mode; anti-slop rows follow the recorded selection.
    let oxc = checkOxcCapability(cwd);
    let antiSlop = sel.antiSlop ? checkAntiSlopCapability(cwd) : [];
    // `overlay: true` is explicit rather than inferred: the state most needing repair, a missing or
    // corrupt manifest, is exactly the one where no stamp survives to infer it from.
    if (fix && [...oxc, ...antiSlop].some((r) => r.fixable && r.status !== 'OK')) {
        try {
            if (sel.antiSlop)
                syncAntiSlopCapability(cwd, { overlay: true });
            else
                syncOxcCapability(cwd, { antiSlop: false, overlay: true });
            oxc = checkOxcCapability(cwd);
            antiSlop = sel.antiSlop ? checkAntiSlopCapability(cwd) : [];
        }
        catch (error) {
            console.log(`  ⚠ Oxc capability could not be repaired: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        }
    }
    for (const r of oxc)
        advise(r);
    for (const r of antiSlop)
        advise(r);
    if (sel.antiSlop) {
        // The gate declares failOpen2:false, so an absent baseline BLOCKS rather than skips. The second
        // line names the weaker contract, per gate-opt-out-is-visible-and-detectable.
        const baseline = existsSync(join(cwd, ANTI_SLOP_BASELINE_REL));
        console.log(`  ${baseline ? '✓' : '·'} anti-slop baseline: ${baseline
            ? `${ANTI_SLOP_BASELINE_REL} (per-clone, git-ignored)`
            : `${ANTI_SLOP_BASELINE_REL} MISSING — the gate blocks until \`devkit anti-slop create\` runs`}`);
        console.log('    overlay contract: blocks NEW findings against your local baseline; no committed base, so no shrink-only ratchet, rename receipts, or CI monotonicity');
    }
    // A stale hook is unhealthy (exit 1) so CI/agents notice; --fix having just regenerated it heals this run.
    const hookCurrent = fix || (!sync.drift && !sync.commitMsg.drift);
    return hookOk && pathOk && worktreesOk && agentsOk && hookCurrent ? 0 : 1;
}
/** The synced agent half: skills, agents, agent-hook scripts and their registrations. */
function agentHalfChecks(cwd, sel, surfaces) {
    if (!surfaces.length)
        return [];
    const hooks = selectedHookAssets(sel, { searchSteering: false });
    return [
        sel.skills && checkAgentAssets(cwd, 'skills', surfaces, sel),
        sel.agents && checkAgentAssets(cwd, 'agents', surfaces),
        hooks.scripts.length > 0 &&
            checkAgentAssets(cwd, 'hooks', surfaces, { expected: hooks.scripts }),
        checkRegistrations(cwd, hooks.components, surfaces, true),
    ].filter((r) => Boolean(r));
}
// sc-4157: a worktree-scoped hooksPath shadows the overlay, and a worktree missing any of the overlay's
// gate inputs runs its gates without them: both unhealthy. A checkout with its own overlay projects nothing.
function printLinkedWorktrees(home, pkgRel, fix) {
    let ok = true;
    const expected = overlayHooksPath(home);
    for (const { path, bare } of worktrees(home)) {
        if (bare || sameDir(path, home) || !existsSync(path))
            continue;
        const pin = worktreeScopedPin(path);
        if (pin && !sameDir(hooksDir(path, pin), expected)) {
            ok = false;
            console.log(`  ⚠ ${path}: a worktree-scoped core.hooksPath (${pin}) shadows the overlay — commits there skip devkit's gates`);
        }
        if (!hasOwnOverlay(path))
            ok = printProjectionGaps(path, home, pkgRel, fix) && ok;
    }
    return ok;
}
// sc-1794: the commit-msg judges (completeness, sentry) — a silently dropped message gate is
// unhealthy, so a stale/missing hook counts in the exit code (via sync.commitMsg.drift).
function printCommitMsgRow(cfg, fix, state) {
    const wanted = commitMsgGuards(cfg.components?.guards ?? []);
    // No judge selected: stay quiet when healthy, but a drifted pass-through still fails the exit code.
    if (!wanted.length && !state.drift)
        return false;
    const what = wanted.length
        ? `${wanted.map((id) => (id === 'review' ? 'completeness' : id)).join(' + ')} judge(s)`
        : 'pass-through';
    if (state.drift && !fix) {
        const impact = wanted.length
            ? `the ${what} do not run`
            : "the repo's own commit-msg may not run";
        console.log(`  ⚠ .devkit/hooks/commit-msg ${state.missing ? 'MISSING' : 'STALE'} — ${impact}; run \`devkit doctor --fix\``);
        return false;
    }
    console.log(`  ✓ .devkit/hooks/commit-msg: ${what} ${state.drift ? 'regenerated' : 'wired'}`);
    return wanted.length > 0;
}
