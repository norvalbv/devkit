/**
 * Overlay-mode doctor. Overlay health is gated by its local hook + `core.hooksPath`; agent assets
 * and fallow are advisory (printed, never in the exit code) because a re-run re-syncs them.
 *
 * Lives here beside `self-host-doctor.mts` — the same shape, a mode-specific doctor in its own
 * module — rather than in `doctor.mts`, which is at its line budget.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { detectGitRoot } from '../detect-git-root.mjs';
import { resolveExistingAgentProviders } from '../install/agent-assets/agent-providers.mjs';
import { ANTI_SLOP_BASELINE_REL } from '../install/anti-slop/constants.mjs';
import { checkAntiSlopCapability, syncAntiSlopCapability, } from '../install/anti-slop/lifecycle.mjs';
import { selectedHookAssets } from '../install/hook-registration-ledger/selection.mjs';
import { checkOxcCapability } from '../install/oxc/lifecycle.mjs';
import { commitMsgGuards } from '../husky/commit-msg-block.mjs';
import { LOCAL_HOOKS, overlayHome, overlayHooksPath, projectionGaps, projectOverlayIntoWorktree, repairProjection, worktrees, } from '../husky/overlay/overlay-home.mjs';
import { HEAL_ALIAS_NAME, isHealAlias, syncOverlayHook } from '../overlay.mjs';
import { globalHookInstalled, globalInitPath } from '../overlay-global-hook.mjs';
import { checkAgentAssets, checkRegistrations } from './asset-checks.mjs';
import { adviseCodexRuntime, adviseSearchIndex } from './guard-config-checks.mjs';
import { repointHooksPath } from './hook-checks.mjs';
import { hooksDir, sameDir, worktreeScopedPin } from './hooks-path.mjs';
// Reason: flat signal reporting keeps the exit code gated only on hook + path.
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
    if (judgesWired && (!pathOk || globalHookInstalled()))
        console.log(`    commit-msg judges run only via \`git ${HEAL_ALIAS_NAME}\` / \`devkit ship\` while husky owns core.hooksPath (the global shim gates pre-commit only)`);
    // Advisory only — never affects the exit code (hook + path are the real health signal).
    if (aliasOurs && !hookOk)
        console.log(`  ⚠ git ${HEAL_ALIAS_NAME} points at a missing .devkit/hooks — run \`devkit clean\``);
    else if (aliasOurs)
        console.log(`  ✓ git ${HEAL_ALIAS_NAME} self-heal alias`);
    else
        console.log(`  · self-heal off (git ${HEAL_ALIAS_NAME} re-points core.hooksPath; or re-run \`devkit init --overlay\`)`);
    // The opt-in global shim gates plain commits after Husky reclaims hooksPath; advisory here.
    if (globalHookInstalled()) {
        console.log(`  ✓ global pre-commit gate (${globalInitPath()}) — plain \`git commit\` gated`);
        if (aliasOurs)
            console.log(`    (git ${HEAL_ALIAS_NAME} is the CLI fast-path; shim + alias don't double-run)`);
        // Husky cannot source the shim without a committed .husky/pre-commit.
        const huskyPresent = existsSync(join(gitRoot, '.husky', '_')) || existsSync(join(gitRoot, '.husky'));
        if (huskyPresent && !existsSync(join(gitRoot, '.husky', 'pre-commit')))
            console.log(`  ⚠ no committed .husky/pre-commit — husky won't source the shim for pre-commit; a plain \`git commit\` stays ungated here (use \`git ${HEAL_ALIAS_NAME}\`)`);
    }
    else if (!pathOk) {
        console.log(`  · plain \`git commit\` is ungated (husky reclaimed core.hooksPath); \`git ${HEAL_ALIAS_NAME}\` heals it, or wire it permanently with \`devkit init --overlay --global-commit-gate\``);
    }
    // Agent-half + fallow checks — ADVISORY (printed, never gate the exit code; a re-run re-syncs them).
    const recorded = cfg?.components ?? {};
    const surfaces = resolveExistingAgentProviders(gitRoot, recorded.agentTargets);
    const sel = { ...recorded, agentTargets: surfaces };
    const advise = (r) => console.log(`  ${r.status === 'OK' ? '✓' : '·'} ${r.name}: ${r.detail}`);
    const hooks = selectedHookAssets(sel, { searchSteering: false });
    if (sel.skills && surfaces.length)
        advise(checkAgentAssets(cwd, 'skills', surfaces, sel));
    if (sel.agents && surfaces.length)
        advise(checkAgentAssets(cwd, 'agents', surfaces));
    if (hooks.scripts.length && surfaces.length)
        advise(checkAgentAssets(cwd, 'hooks', surfaces, { expected: hooks.scripts }));
    if (surfaces.length)
        advise(checkRegistrations(cwd, hooks.components, surfaces, true));
    // Overlay short-circuits before collectResults, so the dup gate's silent opt-out would otherwise
    // be undetectable here. Advisory: overlay health is gated on hook + hooksPath.
    await adviseSearchIndex(cwd, sel);
    await adviseCodexRuntime(cwd, sel);
    printQavisAdvisoryHealth(cwd, sel.guards ?? []);
    if (sel.fallow) {
        const wired = hookOk &&
            readFileSync(join(gitRoot, '.devkit', 'hooks', 'pre-commit'), 'utf8').includes('fallow audit');
        console.log(`  ${wired ? '✓' : '·'} fallow gate: ${wired ? 'wired in the local hook' : 'not wired'}`);
    }
    // Overlay short-circuits before collectResults, so without these rows its git-excluded managed
    // state is undiagnosable. Gated on the recorded selection: the check spawns a real oxlint probe.
    if (sel.antiSlop) {
        let oxc = checkOxcCapability(cwd);
        let antiSlop = checkAntiSlopCapability(cwd);
        // `overlay: true` is explicit rather than inferred: the state most needing repair, a missing or
        // corrupt manifest, is exactly the one where no stamp survives to infer it from.
        if (fix && [...oxc, ...antiSlop].some((r) => r.fixable && r.status !== 'OK')) {
            try {
                syncAntiSlopCapability(cwd, { overlay: true });
                oxc = checkOxcCapability(cwd);
                antiSlop = checkAntiSlopCapability(cwd);
            }
            catch (error) {
                console.log(`  ⚠ anti-slop capability could not be repaired: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
            }
        }
        for (const r of oxc)
            advise(r);
        for (const r of antiSlop)
            advise(r);
        // The gate declares failOpen2:false, so an absent baseline BLOCKS rather than skips. The second
        // line names the weaker contract, per gate-opt-out-is-visible-and-detectable.
        const baseline = existsSync(join(cwd, ANTI_SLOP_BASELINE_REL));
        console.log(`  ${baseline ? '✓' : '·'} anti-slop baseline: ${baseline
            ? `${ANTI_SLOP_BASELINE_REL} (per-clone, git-ignored)`
            : `${ANTI_SLOP_BASELINE_REL} MISSING — the gate blocks until \`devkit anti-slop create\` runs`}`);
        console.log('    overlay contract: blocks NEW findings against your local baseline; no committed base, so no shrink-only ratchet, rename receipts, or CI monotonicity');
    }
    // A stale hook is unhealthy (exit 1) so CI/agents notice; --fix having just regenerated it heals this run.
    return hookOk && pathOk && worktreesOk && (fix || (!sync.drift && !sync.commitMsg.drift)) ? 0 : 1;
}
// sc-4157: a worktree-scoped hooksPath shadows the overlay (unhealthy); an unlinked worktree self-links.
function printLinkedWorktrees(home, pkgRel, fix) {
    let ok = true;
    const pending = [];
    const expected = overlayHooksPath(home);
    for (const { path, bare } of worktrees(home)) {
        if (bare || sameDir(path, home) || !existsSync(path))
            continue;
        const pin = worktreeScopedPin(path);
        if (pin && !sameDir(hooksDir(path, pin), expected)) {
            ok = false;
            console.log(`  ⚠ ${path}: a worktree-scoped core.hooksPath (${pin}) shadows the overlay — commits there skip devkit's gates`);
        }
        if (existsSync(join(path, pkgRel, '.devkit', 'config.json'))) {
            ok = printProjectionGaps(path, home, pkgRel, fix) && ok;
            continue;
        }
        if (!fix)
            pending.push(path);
        else
            ok = linkWorktree(path, home, pkgRel) && ok;
    }
    if (pending.length)
        console.log(`  · ${pending.length} linked worktree(s) not yet linked to the overlay — each links on its first commit, or run \`devkit doctor --fix\``);
    return ok;
}
function linkWorktree(path, home, pkgRel) {
    try {
        if (projectOverlayIntoWorktree(path, home, pkgRel).length)
            console.log(`  ✓ linked ${path} to this overlay`);
        return true;
    }
    catch (e) {
        console.log(`  ⚠ ${path}: could not link the overlay: ${e instanceof Error ? e.message : e}`);
        return false;
    }
}
// A linked worktree must lint and ratchet as its own branch: its lint config and baselines are copies.
function printProjectionGaps(path, home, pkgRel, fix) {
    try {
        const gaps = fix ? repairProjection(path, home, pkgRel) : projectionGaps(path, home, pkgRel);
        if (!gaps.length)
            return true;
        if (fix)
            console.log(`  ✓ ${path}: made ${gaps.join(', ')} branch-local`);
        else
            console.log(`  ⚠ ${path}: ${gaps.join(', ')} not branch-local — its lint config or baselines are not the branch's own; run \`devkit doctor --fix\``);
        return fix;
    }
    catch (e) {
        console.log(`  ⚠ ${path}: could not repair the projection: ${e instanceof Error ? e.message : e}`);
        return false;
    }
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
