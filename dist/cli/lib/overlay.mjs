/**
 * Local-only overlay installs keep Devkit files invisible via `.git/info/exclude`, redirect the
 * clone's `core.hooksPath` through Devkit while preserving existing hooks, and extend committed
 * lint configs without touching package.json. Husky may reclaim the hook path after install;
 * `git ci`, re-running overlay init, or the optional global commit gate restores it.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILENAME, resolveGuardConfig } from '../../gate-engine/config.mjs';
import { FALLOW_CACHE, OVERLAY_WRITTEN } from '../../gate-engine/deterministic/gate-inputs.mjs';
import { syncAgents } from '../commands/sync/sync-agents.mjs';
import { syncSkills } from '../commands/sync/sync-skills.mjs';
import { AGENT_TARGETS, normalizeSelection, overlayStructureNotice, structureCmdFor, } from './components.mjs';
import { detectGitRoot } from './detect-git-root.mjs';
import { hooksDir, nativeHooksDir } from './doctor/hooks-path.mjs';
import { packageDir, readJson, writeIfAbsent } from './fs-helpers.mjs';
import { cutStructureBaselines } from './generate/cut-structure-baselines.mjs';
import { isTracked, trackedPathPredicate } from './git-tracked.mjs';
import { buildOverlayHook } from './husky/husky-block.mjs';
import { describeOverlayCommitMsg, syncOverlaySiblingHooks } from './husky/overlay/commit-msg.mjs';
import { installHealAlias } from './husky/overlay/heal-alias.mjs';
import { isOverlayHooksValue, LOCAL_HOOKS, overlayHooksPath, projectionPrelude, } from './husky/overlay/overlay-home.mjs';
import { ADHD_SKILL_DIR, syncAdhdSkill } from './install/adhd-skill.mjs';
import { resolveAssetConflicts } from './install/agent-assets/asset-conflict-picker.mjs';
import { wireOverlayAntiSlop } from './install/anti-slop/overlay/install.mjs';
import { selectedHookAssets } from './install/hook-registration-ledger/selection.mjs';
import { applyScanRoots } from './install/init/scan-roots.mjs';
import { resolveOverlayFallow } from './install/install-fallow.mjs';
import { installHookRegistrations, removeHookRegistrations, removeHookScripts, syncHookScripts, } from './install/install-hooks.mjs';
import { DECISIONS_INDEX_IGNORES } from './install/gitignore-cache.mjs';
import { installSearchCode, SEARCH_CODE_WRITTEN } from './install/install-search-code.mjs';
import { overlayAssetExcludes } from './install/overlay-asset-excludes.mjs';
import { writeBiomeOverlay, writeEslintOverlay } from './install/overlay-lint-configs.mjs';
import { addToGitExclude, overlayExcludeLines } from './install/overlay-excludes.mjs';
import { firstLine } from './standalone.mjs';
import { removeAgents, removeSkills } from './sync-manifest.mjs';
// husky sets core.hooksPath to `.husky/_`; the real committed script is the parent's hook.
const HUSKY_UNDERSCORE_RE = /\/_$/;
// Standard git hook names — used to pick the repo's real hooks out of a hooks dir (ignoring
// husky internals / .sample files / stray entries).
const GIT_HOOKS = new Set([
    'applypatch-msg',
    'pre-applypatch',
    'post-applypatch',
    'pre-commit',
    'pre-merge-commit',
    'prepare-commit-msg',
    'commit-msg',
    'post-commit',
    'pre-rebase',
    'post-checkout',
    'post-merge',
    'pre-push',
    'post-rewrite',
    'post-update',
    'pre-auto-gc',
]);
// The raw core.hooksPath (the repo's CURRENT hooks setting), '' if unset. Captured BEFORE we
// override it so `devkit clean` can restore exactly what was there.
function readHooksPath(gitRoot) {
    try {
        return execFileSync('git', ['config', '--get', 'core.hooksPath'], {
            cwd: gitRoot,
            encoding: 'utf8',
        }).trim();
    }
    catch {
        return '';
    }
}
export { HEAL_ALIAS_NAME, healAliasCmd, isHealAlias, removeHealAlias, } from './husky/overlay/heal-alias.mjs';
// The TRUE original core.hooksPath to record (so `devkit clean` restores it). CRITICAL: if a
// prior overlay is already in place (current === .devkit/hooks), recording that would make clean
// restore a value devkit itself deleted — so recover the real original from the prior overlay's
// config, else detect husky (.husky/_), else '' (unset). This makes re-running overlay idempotent.
export function captureOrigHooksPath(gitRoot, cwd) {
    const current = readHooksPath(gitRoot);
    if (current && !isOverlayHooksValue(current, gitRoot))
        return current;
    const prev = readJson(join(cwd, '.devkit', 'config.json'));
    if (prev &&
        typeof prev === 'object' &&
        'origHooksPath' in prev &&
        typeof prev.origHooksPath === 'string') {
        return prev.origHooksPath;
    }
    return existsSync(join(gitRoot, '.husky', '_')) ? '.husky/_' : '';
}
// Where the repo's hook SCRIPTS live (git-root-relative). husky's .husky/_ → the scripts are the
// parent's .husky/<hook>; a custom hooksPath holds them directly; unset → .git/hooks.
export function overlayHookScriptDir(origHooksPath) {
    if (origHooksPath && origHooksPath !== LOCAL_HOOKS) {
        return origHooksPath.replace(HUSKY_UNDERSCORE_RE, '');
    }
    return '.git/hooks';
}
// The repo's own hooks we must keep running once we take over core.hooksPath. `.git/hooks` names
// git's own dir in the COMMON dir — the one chainWord runs at commit time, linked worktrees included.
function repoHooks(gitRoot, origHooksPath) {
    const scriptDir = overlayHookScriptDir(origHooksPath);
    const native = /^(?:\.\/)?\.git\/hooks\/*$/.test(scriptDir);
    const scriptsAbs = native ? nativeHooksDir(gitRoot) : hooksDir(gitRoot, scriptDir);
    // Never "no hooks" on an unanswerable git: that would silently drop the repo's own hooks.
    if (!scriptsAbs)
        throw new Error(`could not resolve the git common dir of ${gitRoot}; retry`);
    const names = existsSync(scriptsAbs) ? readdirSync(scriptsAbs) : [];
    const gitRuns = !HUSKY_UNDERSCORE_RE.test(origHooksPath);
    return { scriptDir, scriptsAbs, gitRuns, existing: names.filter((f) => GIT_HOOKS.has(f)) };
}
/** The overlay pre-commit as written: the gates plus the linked-worktree prelude (sc-4157), whose
 * projection check is rendered from the gate inputs of the overlay installed at `root`. */
export function buildOverlayPreCommit(sel, chainTarget, pkgRel, opts) {
    const { root, fallow = false, stack = '', gitRuns = false } = opts;
    const notice = overlayStructureNotice(stack);
    const prelude = `${projectionPrelude(root, pkgRel)}${notice ? `\necho "${notice}"` : ''}`;
    const structureCmd = sel.structure ? structureCmdFor(stack) : undefined;
    const hookOpts = { fallow, prelude, gitRuns };
    return buildOverlayHook({ ...sel, structureCmd }, chainTarget, pkgRel, hookOpts);
}
// Take over core.hooksPath (at the GIT ROOT — repo-wide) and write our hooks dir. CRITICAL: git
// then runs ONLY our dir, so we wrap EVERY hook the repo already had (pre-push, commit-msg, …) as
// a pass-through, or they'd silently stop. pre-commit additionally runs devkit's gates (cd'd into
// the package for a monorepo) before chaining to the repo's pre-commit.
function installOverlayHook(gitRoot, pkgRel, sel, origHooksPath, dryRun, { fallow, stack }) {
    const { scriptDir, scriptsAbs, gitRuns, existing } = repoHooks(gitRoot, origHooksPath);
    const preCommitChain = existing.includes('pre-commit') ? `${scriptDir}/pre-commit` : '';
    const passthrough = existing.filter((h) => h !== 'pre-commit' && h !== 'commit-msg');
    const siblings = { gitRoot, scriptDir, scriptsAbs, gitRuns, existing, selection: sel, pkgRel };
    const commitMsgLine = describeOverlayCommitMsg(syncOverlaySiblingHooks(siblings, { dryRun: true }).plan);
    const hooksPath = overlayHooksPath(gitRoot);
    if (dryRun) {
        console.log(`  [dry-run] git config core.hooksPath ${hooksPath}; pre-commit (gates${preCommitChain ? ` → ${preCommitChain}` : ''}${fallow ? ' + fallow' : ''})${passthrough.length ? `; pass-through: ${passthrough.join(', ')}` : ''}${commitMsgLine ? `; ${commitMsgLine}` : ''}`);
        return;
    }
    const dir = join(gitRoot, LOCAL_HOOKS);
    mkdirSync(dir, { recursive: true });
    // pre-commit: devkit gates (+ optional fallow gate) + chain to the repo's pre-commit (if any).
    const pre = join(dir, 'pre-commit');
    writeFileSync(pre, buildOverlayPreCommit(sel, preCommitChain, pkgRel, { root: gitRoot, fallow, stack, gitRuns }));
    chmodSync(pre, 0o755);
    // every OTHER existing hook → pass-through (commit-msg: devkit's message judges, sc-1794).
    syncOverlaySiblingHooks(siblings, { dryRun: false });
    if (commitMsgLine)
        console.log(`  ✓ ${commitMsgLine}`);
    try {
        execFileSync('git', ['config', 'core.hooksPath', hooksPath], { cwd: gitRoot });
        const extra = passthrough.length ? ` (+ pass-through: ${passthrough.join(', ')})` : '';
        console.log(`  ✓ core.hooksPath → ${hooksPath} (local) — pre-commit + your hooks preserved${extra}`);
    }
    catch (e) {
        console.log(`  ! could not set core.hooksPath: ${firstLine(e)}`);
    }
}
/**
 * Recompute the overlay pre-commit hook from the RECORDED config and report — or, unless `dryRun`,
 * repair — drift against a freshly-built hook. `devkit update` re-pins the CLI but does NOT regenerate
 * the git-ignored `.devkit/hooks/pre-commit`, so an updated repo can keep running an OLD hook shape
 * (e.g. one predating a new ship gate) until re-init. This lets `devkit doctor --fix` refresh it
 * without a manual `devkit init --overlay`. Pass-through wrappers are refreshed alongside (idempotent).
 * `core.hooksPath` is left untouched — the `git ci` alias owns it and doctor reports it separately.
 * Returns the pre-commit { missing, drift } (what review reads) plus commitMsg, observed BEFORE any write.
 */
export function syncOverlayHook(gitRoot, cwd, cfg, { dryRun }) {
    // Raw `structure`: normalizeSelection defaults it on, which would gate an overlay never baselined.
    const sel = { ...normalizeSelection(cfg.components), structure: cfg.components?.structure };
    const pkgRel = cfg.pkgRel ?? '';
    const fallow = Boolean(cfg.components?.fallow);
    // Use the RECORDED origHooksPath — post-install core.hooksPath is devkit's own, so reading it
    // live would chain the overlay to ITSELF. Fall back to the same recovery init uses.
    const origHooksPath = cfg.origHooksPath ?? captureOrigHooksPath(gitRoot, cwd);
    const { scriptDir, scriptsAbs, gitRuns, existing } = repoHooks(gitRoot, origHooksPath);
    const preCommitChain = existing.includes('pre-commit') ? `${scriptDir}/pre-commit` : '';
    const expected = buildOverlayPreCommit(sel, preCommitChain, pkgRel, {
        root: gitRoot,
        fallow,
        stack: cfg.stack,
        gitRuns,
    });
    const pre = join(gitRoot, LOCAL_HOOKS, 'pre-commit');
    const current = existsSync(pre) ? readFileSync(pre, 'utf8') : null;
    const missing = current === null;
    const drift = current !== expected; // a missing hook (null) is drift too
    if (!dryRun && drift) {
        mkdirSync(join(gitRoot, LOCAL_HOOKS), { recursive: true });
        writeFileSync(pre, expected);
        chmodSync(pre, 0o755);
    }
    // Siblings sync on their own: a stale commit-msg must heal even when pre-commit is current.
    const cm = syncOverlaySiblingHooks({ gitRoot, scriptDir, scriptsAbs, gitRuns, existing, selection: sel, pkgRel }, { dryRun });
    return { missing, drift, commitMsg: { missing: cm.missing, drift: cm.drift } };
}
// Sync the agent-half (skills + agents + agentHooks) into the git root's selected surfaces, skipping
// any path git already TRACKS (C2 — exclude can't hide a tracked file), and return the git-root-
// relative paths to hide via .git/info/exclude (derived from each sync's returned manifest, so a
// skipped-because-tracked file is never excluded for). searchSteering stays unwired because its
// node_modules/@norvalbv/devkit command cannot resolve in a package-less overlay (C1).
// Reason: flat overlay agent-surface orchestration: ordered `if (sel.x) sync + derive excludes` steps (skills → agents → hook scripts → registrations) mirroring installAgentSurfaces; high branch COUNT, each trivial, no nesting
// fallow-ignore-next-line complexity
function installOverlayAgentSurfaces(gitRoot, sel, dryRun, override, legacyOwnedComponentIds) {
    const targets = sel.agentTargets ?? AGENT_TARGETS;
    // An override replaces only an untracked collision; tracked files always remain untouched.
    const skipTracked = trackedPathPredicate(gitRoot);
    const args = dryRun ? ['--dry-run'] : [];
    const excl = [];
    if (sel.skills) {
        console.log('  skills');
        const m = syncSkills(args, gitRoot, targets, { skipTracked, override, selection: sel });
        excl.push(...overlayAssetExcludes(m, 'skills', targets));
        // The manifest is always written, even if every asset is preserved.
        excl.push('.devkit/skills-manifest.json');
    }
    else if (existsSync(join(gitRoot, '.devkit', 'skills-manifest.json'))) {
        removeSkills(gitRoot, dryRun);
    }
    // Independent of `skills` — its own tree. Always called: false reclaims an earlier copy.
    syncAdhdSkill(gitRoot, Boolean(sel.adhd), dryRun);
    if (sel.adhd)
        excl.push(`${ADHD_SKILL_DIR}/`);
    if (sel.agents) {
        console.log('  agents');
        const m = syncAgents(args, gitRoot, targets, { skipTracked, override });
        excl.push(...overlayAssetExcludes(m, 'agents', targets));
        excl.push('.devkit/agents-manifest.json');
    }
    else if (existsSync(join(gitRoot, '.devkit', 'agents-manifest.json'))) {
        removeAgents(gitRoot, dryRun);
    }
    const hooks = selectedHookAssets(sel, { searchSteering: false });
    console.log('  · search-code steering hooks: not available in overlay (their command needs the package)');
    if (hooks.scripts.length) {
        console.log('  agent-hook scripts');
        const m = syncHookScripts(gitRoot, {
            dryRun,
            targets,
            desired: hooks.scripts,
            skipTracked,
            override,
        });
        excl.push(...overlayAssetExcludes(m, 'hooks', targets));
        excl.push('.devkit/agent-hooks-manifest.json');
    }
    else {
        if (existsSync(join(gitRoot, '.devkit', 'agent-hooks-manifest.json')))
            removeHookScripts(gitRoot, { dryRun });
    }
    console.log('  agent hook registrations');
    const { wrote } = installHookRegistrations(gitRoot, hooks.components, {
        dryRun,
        targets,
        overlay: true,
        legacyOwnedComponentIds,
    });
    excl.push(...wrote);
    const removal = { dryRun, overlay: true, legacyOwnedComponentIds };
    const prunedTargets = AGENT_TARGETS.filter((target) => !targets.includes(target));
    if (prunedTargets.length) {
        if (sel.skills)
            removeSkills(gitRoot, dryRun, prunedTargets, false);
        if (sel.agents)
            removeAgents(gitRoot, dryRun, prunedTargets, false);
        if (hooks.scripts.length)
            removeHookScripts(gitRoot, { dryRun, targets: prunedTargets, dropManifest: false });
        removeHookRegistrations(gitRoot, { ...removal, targets: prunedTargets });
    }
    return excl;
}
/** Components an earlier overlay recorded: their hook registrations predate the ledger. */
function legacyOwnedComponentIds(prior) {
    return [
        prior?.searchSteering && 'searchSteering',
        prior?.agentHooks && 'agentHooks',
        prior?.guards?.includes('decisions') && 'decisions',
        prior?.fallow && 'fallow',
    ].filter((id) => Boolean(id));
}
/** Re-sync the recorded agent half the way install does: doctor --fix and upgrade --force. */
export function resyncOverlayAgentSurfaces(cwd, sel, recorded, override, dryRun = false) {
    const { gitRoot } = detectGitRoot(cwd);
    const legacy = legacyOwnedComponentIds(recorded);
    addToGitExclude(gitRoot, installOverlayAgentSurfaces(gitRoot, sel, dryRun, override, legacy), dryRun);
}
/** Structure judges by guard.config.json's grammar; a config without one (kept, or tracked) cannot run it. */
function structureGrammarDeclared(cwd, stack) {
    let trees = [];
    try {
        trees = resolveGuardConfig(cwd).structure?.trees ?? [];
    }
    catch (e) {
        console.log(`  ! guard.config.json could not be read: ${firstLine(e)}`);
    }
    if (trees.some((tree) => tree.grammar))
        return true;
    console.log(`  ! structure skipped — guard.config.json declares no structure grammar; \`devkit init --overlay --force\` writes the ${stack} template.`);
    return false;
}
/** Install the overlay and return the cleanup metadata recorded in its config. */
// Reason: flat overlay install orchestration: ordered guarded steps (config → lint → fallow → hook → alias → surfaces → exclude) each a single delegated call; high branch COUNT, near-zero nesting — splitting scatters the install sequence
// fallow-ignore-next-line complexity
export async function installOverlay(cwd, sel, stack, force, dryRun, { interactive = false, scanRoots = null, } = {}) {
    // Configs live in cwd; hooks and git-exclude live at the git root (also in a monorepo).
    const { gitRoot, pkgRel } = detectGitRoot(cwd);
    // The real original hooksPath (never our own .devkit/hooks) — recorded for restore on clean.
    const origHooksPath = captureOrigHooksPath(gitRoot, cwd);
    const prior = readJson(join(cwd, '.devkit', 'config.json'));
    const pfx = pkgRel ? `${pkgRel}/` : '';
    // Every path devkit writes is excluded whether or not this selection writes it: a line for an
    // absent file hides nothing, and the list stays the registry's.
    const excludes = new Set([
        ...overlayExcludeLines('', { path: LOCAL_HOOKS, kind: 'dir' }), // at the git root
        ...overlayExcludeLines(pfx, { path: '.devkit', kind: 'dir' }), // config + vendored biome
        ...OVERLAY_WRITTEN.flatMap((input) => overlayExcludeLines(pfx, input)),
        // Any `guard-decisions query` writes it, whatever the guard selection.
        ...DECISIONS_INDEX_IGNORES.map((line) => `${pfx}${line}`),
    ]);
    if (pkgRel)
        console.log(`  monorepo: package "${pkgRel}" — hook + git-ignore at the git root`);
    // guard.config.json (data). Structure needs the stack template: it carries the `structure` grammar.
    console.log('  guard.config.json');
    let wroteConfig = false;
    if (sel.guards?.length || sel.structure) {
        const tpl = sel.structure ? stack : 'generic';
        const src = join(packageDir(), 'templates', tpl, 'guard.config.json');
        if (dryRun) {
            console.log('  [dry-run] write guard.config.json');
        }
        else {
            const dest = join(cwd, 'guard.config.json');
            wroteConfig = writeIfAbsent(dest, readFileSync(src, 'utf8'), { force }) !== 'exists';
            console.log('  ✓ guard.config.json');
        }
    }
    const configTracked = isTracked(gitRoot, `${pfx}${CONFIG_FILENAME}`);
    if (scanRoots?.length && configTracked)
        console.log('  ! --scan-root not applied: guard.config.json is tracked, and overlay edits nothing committed');
    else
        applyScanRoots(cwd, scanRoots, dryRun);
    const structure = Boolean(sel.structure) && (dryRun || structureGrammarDeclared(cwd, stack));
    // Grandfather the tree whenever the grammar it is judged by is new: first wired, or rewritten.
    if (structure && (wroteConfig || !prior?.components?.structure)) {
        console.log('  structure baselines (grandfather current tree)');
        if (dryRun)
            console.log('  [dry-run] skip structure + import-wall baseline generators');
        else
            await cutStructureBaselines(cwd, stack);
    }
    if (sel.searchCode) {
        installSearchCode(cwd, dryRun, { configTracked });
        for (const input of SEARCH_CODE_WRITTEN)
            for (const l of overlayExcludeLines(pfx, input))
                excludes.add(l);
    }
    // ours-extends-theirs lint overlays, in the package.
    console.log('  lint overlays (extend the repo config)');
    if (sel.biome)
        writeBiomeOverlay(cwd, stack, force, dryRun);
    writeEslintOverlay(cwd, force, dryRun);
    // Resolve fallow before rendering the hook; an unavailable binary aborts only that component.
    let fallowWired = false;
    if (sel.fallow) {
        console.log('  fallow (code-health gate)');
        fallowWired = resolveOverlayFallow(cwd, dryRun);
        if (fallowWired)
            for (const line of overlayExcludeLines(pfx, FALLOW_CACHE))
                excludes.add(line);
    }
    // Same shape as fallow: resolved before the hook renders, since the gate fragment is keyed on the
    // selection. Owns its own deselection — see wireOverlayAntiSlop.
    const antiSlop = wireOverlayAntiSlop(cwd, gitRoot, pfx, sel, dryRun);
    // local hook (core.hooksPath override) at the git root + chain + pass-through of all hooks.
    console.log('  local hook');
    // What was actually wired, as recorded below: the hook and agent half both follow it, as doctor does.
    const wired = { ...sel, structure, antiSlop: antiSlop.wired, fallow: fallowWired };
    installOverlayHook(gitRoot, pkgRel, wired, origHooksPath, dryRun, {
        fallow: fallowWired,
        stack,
    });
    // Per-clone alias restores this repo-wide hook path after husky reclaims it.
    installHealAlias(gitRoot, overlayHooksPath(gitRoot), dryRun);
    // Consumer-authored collisions resolve exactly as in package mode: preserved unless --force or picked.
    const override = await resolveAssetConflicts(gitRoot, wired, { interactive, force });
    const legacy = legacyOwnedComponentIds(prior?.components);
    for (const rel of installOverlayAgentSurfaces(gitRoot, wired, dryRun, override, legacy))
        excludes.add(rel);
    // make it all invisible to git (the git root's .git/info/exclude).
    console.log('  git-ignore (local)');
    addToGitExclude(gitRoot, [...excludes], dryRun);
    // Cleanup restores the original hook path and only removes components recorded as wired.
    const { searchCode } = sel;
    const components = { fallow: fallowWired, antiSlop: antiSlop.wired, structure, searchCode };
    return { origHooksPath, components };
}
