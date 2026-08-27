import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirm, isCancel, outro } from '@clack/prompts';
import { enableLineGrowth, hasLineCap, LINE_CAP, } from '../../gate-engine/ratchets/size-disable.mjs';
import { IMPORT_WALL_BASELINE, LEGACY_IMPORT_WALL_BASELINE, STRUCTURE_BASELINE_DIR, STRUCTURE_EXEMPT, reportRatchetBaselineMigration, } from '../../gate-engine/ratchets/baseline-paths.mjs';
import { loadImportWallExempt } from '../../gate-engine/structure/load-baseline.mjs';
import { AGENT_TARGETS, applyOverlayConstraints, COMPONENTS, CONFIG_DRIVEN_STRUCTURE, disabledGuardsFor, dropUndecided, GUARD_IDS, normalizeReviewProfile, RECORDED_COMPONENT_IDS, structureCmdFor, } from '../lib/components.mjs';
import { detectGitRoot } from '../lib/detect-git-root.mjs';
import { assertRunnerMayWrite } from '../lib/doctor/pin/runner-identity.mjs';
import { detectStack } from '../lib/detect-stack.mjs';
import { packageDir, readJson, writeIfAbsent } from '../lib/fs-helpers.mjs';
import { generateImportWallBaseline } from '../lib/generate/generate-import-wall-baseline.mjs';
import { generateStructureBaselines } from '../lib/generate/generate-structure-baseline.mjs';
import { INIT_HELP } from '../lib/help/init-help.mjs';
import { installCommitMsgHook, removeCommitMsgBlock } from '../lib/husky/commit-msg-block.mjs';
import { buildFullHook, buildGuardBlock, extractGuardBlock, hasFragment, removeFragment, removeGuardBlock, replaceGuardBlock, } from '../lib/husky/husky-block.mjs';
import { installSelfHostHook, isDevkitRepo, selfHostSelection } from '../lib/husky/self-host.mjs';
import { ADHD_SKILL_DIR, syncAdhdSkill } from '../lib/install/adhd-skill.mjs';
import { installAgentSurfaces as syncSurfaces } from '../lib/install/agent-assets/agent-surfaces.mjs';
import { resolveAssetConflicts } from '../lib/install/agent-assets/asset-conflict-picker.mjs';
import * as antiSlopLifecycle from '../lib/install/anti-slop/lifecycle.mjs';
import * as initFlags from '../lib/install/flags/init-flags.mjs';
import { reviewPlanFromFlags } from '../lib/install/flags/review-profile.mjs';
import { ensureDevkitCacheGitignore } from '../lib/install/gitignore-cache.mjs';
import { ensureFallowGitignore, installFallow, saveFallowBaselines, wireFallowHooks, } from '../lib/install/install-fallow.mjs';
import { installSearchCode } from '../lib/install/install-search-code.mjs';
import * as oxcLifecycle from '../lib/install/oxc/lifecycle.mjs';
import { patchPackageJson } from '../lib/install/package-json.mjs';
import * as upgradeOffers from '../lib/install/upgrade-offers.mjs';
import { installOverlay } from '../lib/overlay.mjs';
import { installGlobalHook } from '../lib/overlay-global-hook.mjs';
import { installStandaloneConfigs, installStandaloneHook } from '../lib/standalone.mjs';
import { removeAgents, removeSkills } from '../lib/sync-manifest.mjs';
import { runWizard } from '../lib/wizard.mjs';
import { repoUrl } from './update.mjs';
const INIT_VERSION = 2;
// Stacks with structure-lint presets; omitted stacks have no shipped template yet.
const STRUCTURE_STACKS = new Set(['electron', 'react-app', 'component-lib']);
// Config-driven stacks keep topology in guard.config and use Devkit's own structure binary.
// Electron remains package-mode because its preset imports consumer-side eslint dependencies.
const STRUCTURE_TEMPLATE_FILES = {
    electron: [
        ['eslint.config.mjs', 'eslint.config.mjs'],
        ['eslint/domains.mjs', 'eslint/domains.mjs'],
        ['.devkit/structure/exempt.mjs', STRUCTURE_EXEMPT],
    ],
    // react-app — CONFIG-DRIVEN (data): components + pages trees declared in guard.config.json, compiled
    // by the shared shim. No per-stack eslint.config / domains. (electron is the one remaining preset.)
    'react-app': [
        ['_shared/eslint.config.mjs', 'eslint.config.mjs'],
        ['_shared/exempt.mjs', STRUCTURE_EXEMPT],
    ],
    // Flat component lib — CONFIG-DRIVEN (the universal path): the topology is a `structure` block in
    // guard.config.json, and eslint.config.mjs is the shared shim that compiles it via devkit's
    // compileToEslint. No per-stack eslint.config / domains. `_shared/` srcs resolve from templates/.
    'component-lib': [
        ['_shared/eslint.config.mjs', 'eslint.config.mjs'],
        ['_shared/exempt.mjs', STRUCTURE_EXEMPT],
    ],
};
// devDeps/scripts owned by each component — used by both install (add) and remove (delete).
const BIOME_DEV_DEPS = ['@biomejs/biome'];
const BIOME_SCRIPTS = ['lint', 'format'];
// Matches the scanRoots array value in guard.config.json for an in-place --scan-root patch
// (preserves the //-comment guidance keys a JSON round-trip would drop). Hoisted (perf).
const SCANROOTS_RE = /("scanRoots"\s*:\s*)\[[^\]]*\]/;
// Which components are currently wired? Read the recorded set first (authoritative), then
// fall back to on-disk detection for a pre-wizard repo with no `components` block.
export function detectInstalled(cwd) {
    const cfg = readJson(join(cwd, '.devkit', 'config.json'));
    const installed = new Set();
    const recorded = cfg?.components;
    if (cfg?.review?.enabled)
        installed.add('devkit-review');
    if (recorded) {
        for (const id of RECORDED_COMPONENT_IDS) {
            if (recorded[id])
                installed.add(id);
        }
        if (recorded.guards?.length)
            installed.add('guards');
        return installed;
    }
    // Per-package configs live in cwd; the hook + skills are at the git root (monorepo) or cwd
    // (single-package, where gitRoot === cwd).
    if (existsSync(join(cwd, 'biome.jsonc')))
        installed.add('biome');
    if (existsSync(join(cwd, 'tsconfig.json')))
        installed.add('tsconfig');
    if (existsSync(join(cwd, 'eslint.config.mjs')))
        installed.add('structure');
    if (existsSync(join(cwd, '.devkit', 'anti-slop', 'manifest.json')))
        installed.add('antiSlop');
    const { gitRoot } = detectGitRoot(cwd);
    if (existsSync(join(gitRoot, '.devkit', 'skills-manifest.json')))
        installed.add('skills');
    if (existsSync(join(gitRoot, '.devkit', 'agents-manifest.json')))
        installed.add('agents');
    if (existsSync(join(gitRoot, '.devkit', 'agent-hooks-manifest.json')))
        installed.add('agentHooks');
    const hookPath = join(gitRoot, '.husky', 'pre-commit');
    if (existsSync(hookPath)) {
        installed.add('husky');
        const hook = readFileSync(hookPath, 'utf8');
        // Guards now surface as the single `deterministic` orchestrator fragment (size/fanout/dup/clone)
        // plus per-id AI fragments (decisions/review) — any of them means guards are wired.
        if (hasFragment(hook, 'deterministic') ||
            GUARD_IDS.some((g) => hasFragment(hook, `guard-${g}`)))
            installed.add('guards');
    }
    return installed;
}
function readText(path) {
    return readFileSync(path, 'utf8');
}
function logWrite(action, label) {
    const map = {
        created: '✓ created',
        forced: '✓ overwrote',
        exists: '• already wired',
    };
    console.log(`  ${map[action] ?? action} ${label}`);
}
// ── install steps ──────────────────────────────────────────────────────────
// Reason: flat orchestration: builds a [src,dest] item list from independent `if (sel.x)` toggles, then one write loop with a dry-run branch; high branch COUNT, each toggle trivial and non-nested
// fallow-ignore-next-line complexity
function installConfigs(cwd, sel, force, dryRun) {
    const tplDir = join(packageDir(), 'templates', 'generic');
    const items = [];
    if (sel.biome)
        items.push(['biome.jsonc', 'biome.jsonc']);
    if (sel.tsconfig)
        items.push(['tsconfig.json', 'tsconfig.json']);
    // guard.config.json is needed whenever ANY gate runs (guards or structure).
    if (sel.guards?.length || sel.structure)
        items.push(['guard.config.json', 'guard.config.json']);
    for (const [src, dest] of items) {
        const target = join(cwd, dest);
        if (dryRun) {
            console.log(`  [dry-run] ${existsSync(target) && !force ? 'skip (exists)' : 'write'} ${dest}`);
        }
        else {
            logWrite(writeIfAbsent(target, readText(join(tplDir, src)), { force }), dest);
        }
    }
}
function installStructureFiles(cwd, stack, sel, plan) {
    const { force, dryRun } = plan;
    const tplDir = join(packageDir(), 'templates', stack);
    // Structure-stack biome.jsonc / tsconfig.json supersede the generic ones (stack rules).
    const items = [...STRUCTURE_TEMPLATE_FILES[stack]];
    if (sel.biome)
        items.push(['biome.jsonc', 'biome.jsonc']);
    if (sel.tsconfig)
        items.push(['tsconfig.json', 'tsconfig.json']);
    items.push(['guard.config.json', 'guard.config.json']);
    for (const [src, dest] of items) {
        const target = join(cwd, dest);
        // A `_shared/<file>` src resolves from templates/ (the universal shim/exempt shared across stacks);
        // everything else from the stack's own template dir.
        const srcPath = src.startsWith('_shared/')
            ? join(packageDir(), 'templates', src)
            : join(tplDir, src);
        if (dryRun) {
            console.log(`  [dry-run] ${existsSync(target) && !force ? 'skip (exists)' : 'write'} ${dest}`);
        }
        else {
            logWrite(writeIfAbsent(target, readText(srcPath), { force }), dest);
        }
    }
}
// Override guard.config.json scanRoots from --scan-root, BEFORE the freezes run so they (and
// the react-app structureRoot, which derives from scanRoots[0]) grandfather the right tree —
// e.g. a non-`src` root like services/webapp/src. Patches the scanRoots array in place via
// regex to PRESERVE the template's //-comment guidance keys; falls back to a JSON round-trip if
// the key is absent. No-op when guard.config.json wasn't written (no guards/structure selected).
function applyScanRoots(cwd, scanRoots, dryRun) {
    if (!scanRoots?.length)
        return;
    const value = JSON.stringify(scanRoots);
    if (dryRun) {
        console.log(`  [dry-run] set guard.config.json scanRoots = ${value}`);
        return;
    }
    const path = join(cwd, 'guard.config.json');
    if (!existsSync(path))
        return;
    const raw = readText(path);
    let next = raw.replace(SCANROOTS_RE, `$1${value}`);
    if (next === raw) {
        const cfg = readJson(path) ?? {};
        cfg.scanRoots = scanRoots;
        next = `${JSON.stringify(cfg, null, 2)}\n`;
    }
    writeFileSync(path, next);
    console.log(`  ✓ guard.config.json scanRoots = ${value}`);
}
// Wire the pre-commit hook from the selection. The hook lives at `hookRoot` (the git root —
// `cwd` for a single-package repo, else the monorepo root). `pkgRel` scopes the block + `cd`s
// the gates into the package. Fresh repo → full hook; existing → replace THIS package's block.
function installHusky(sel, hookRoot, pkgRel, dryRun) {
    const where = pkgRel ? ` (git root, scoped to ${pkgRel})` : '';
    const hookPath = join(hookRoot, '.husky', 'pre-commit');
    if (!existsSync(hookPath)) {
        if (dryRun) {
            console.log(`  [dry-run] write .husky/pre-commit${where} (assembled from selection)`);
            return;
        }
        mkdirSync(join(hookRoot, '.husky'), { recursive: true });
        writeFileSync(hookPath, buildFullHook(sel, pkgRel));
        chmodSync(hookPath, 0o755);
        console.log(`  ✓ created .husky/pre-commit${where}`);
        return;
    }
    const current = readText(hookPath);
    const block = buildGuardBlock(sel, pkgRel);
    const merged = replaceGuardBlock(current, block, pkgRel);
    if (merged === current) {
        console.log('  • .husky/pre-commit already wired (devkit-guards block current)');
        return;
    }
    if (dryRun) {
        console.log(`  [dry-run] refresh devkit-guards block${where} in existing .husky/pre-commit`);
        return;
    }
    writeFileSync(hookPath, merged);
    console.log(`  ✓ refreshed devkit-guards block${where} in .husky/pre-commit`);
}
// True once the repo has been adopted — devkit init wrote .devkit/config.json. Baselines are cut
// exactly ONCE, at first init; an adopted repo NEVER re-snapshots (a re-run — e.g. the post-`bun
// install` overlay re-apply, or `devkit upgrade` — would grandfather debt added via the ungated
// channel and silently move the ratchet up; see docs/decisions/overlay-self-heal.md). Explicit
// re-cuts go through `guard-* freeze`, never an implicit re-apply. The marker is durable and survives
// deleting empty baseline files, so it — not a debt file's existence — is the "already frozen" bit.
// Ordering holds: freezes run before the config write, so the first adoption still freezes.
function repoAdopted(cwd) {
    return existsSync(join(cwd, '.devkit', 'config.json'));
}
function runFreezes(cwd, dryRun, { overlay = false } = {}) {
    if (dryRun) {
        console.log('  [dry-run] skip guard-fanout freeze + guard-size freeze');
        return;
    }
    if (repoAdopted(cwd)) {
        console.log('  • repo already adopted — keeping baselines (run `guard-* freeze` to re-cut)');
        return;
    }
    // Ratchet bins are .mts here but compiled .mjs in consumers; derive the extension from this module.
    const ext = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
    const bins = [
        ['guard-fanout', join(packageDir(), 'gate-engine', 'ratchets', `folder-fanout${ext}`)],
        ['guard-size', join(packageDir(), 'gate-engine', 'ratchets', `size-disable${ext}`)],
    ];
    const env = overlay ? { ...process.env, DEVKIT_OVERLAY: '1' } : process.env;
    for (const [name, bin] of bins) {
        try {
            execFileSync(process.execPath, [bin, 'freeze'], { cwd, stdio: 'pipe', env });
            console.log(`  ✓ ${name} freeze (baseline grandfathered)`);
        }
        catch (e) {
            // SAFETY: execFileSync throws Error-shaped values whose optional stderr is declared by ExecError.
            const detail = e.stderr?.toString().trim() || firstLine(e);
            console.log(`  ! ${name} freeze failed: ${detail}`);
        }
    }
}
async function runStructureBaselines(cwd, stack, dryRun, regen = true) {
    if (dryRun) {
        console.log('  [dry-run] skip structure + import-wall baseline generators');
        return;
    }
    // Structure/import baselines are cut ONCE at first init. An adopted repo (.devkit/config.json
    // present) never re-snapshots — `devkit upgrade` passes regen=false so it skips here rather than
    // re-grandfathering violations added since init (silent debt laundering). Keyed off the durable
    // marker, not baseline-file existence, so deleting an empty baseline doesn't re-arm regeneration.
    if (!regen && repoAdopted(cwd)) {
        console.log('  • repo already adopted — keeping structure + import-wall baselines (run `devkit init` to re-snapshot)');
        return;
    }
    // The generators grandfather electron's process trees (the generator's own DEFAULT_ROOTS).
    // react-app needs no generated structure baseline: its preset is grandfathered via permissive
    // rules + EMPTY baselines (the eslint.config loadBaseline() returns [] when absent), and its
    // structureRoot is derived live from guard.config.json scanRoots — so for a src-rooted app
    // these calls are no-ops by design (the electron tree names never match).
    const opts = { log: (m) => console.log(m) };
    try {
        await generateStructureBaselines(cwd, opts);
    }
    catch (e) {
        console.log(`  ! structure baseline generator failed: ${firstLine(e)}`);
    }
    try {
        // Honour the consumer's hand-maintained import-wall exemptions:
        // an exempt file is a permanent architectural allowance, not a violator, so it must be skipped
        // during the scan — else it would be re-grandfathered every regen.
        generateImportWallBaseline(cwd, {
            ...opts,
            exemptPatterns: await loadImportWallExempt(cwd),
        });
    }
    catch (e) {
        console.log(`  ! import-wall baseline generator skipped: ${firstLine(e)}`);
        console.log(`    (install deps — bun install — then re-run \`devkit init --stack ${stack}\`)`);
    }
}
function firstLine(e) {
    const err = e;
    return (err.stderr || err.message || '').toString().trim().split('\n')[0];
}
// A @clack confirm that's safe in any context: only prompts on a TTY-interactive run,
// otherwise returns the non-interactive default. isCancel (Ctrl-C / Esc) → the default too.
async function subConfirm(message, { interactive, fallback }) {
    if (!interactive)
        return fallback;
    const v = await confirm({ message, initialValue: fallback });
    return isCancel(v) ? fallback : v;
}
// Does the repo carry fallow debt? `fallow audit` exits non-zero when it finds NEW issues
// against (absent) baselines — i.e. there's something to grandfather. Fail-open: any throw
// (missing binary, etc.) is treated as "no debt" so we never save empty baselines.
function fallowHasDebt(cwd) {
    try {
        execFileSync('fallow', ['audit'], { cwd, stdio: 'pipe' });
        return false; // exit 0 → clean → nothing to baseline
    }
    catch (e) {
        return e.status != null; // non-zero exit → debt; ENOENT (status null) → treat as none
    }
}
// Apply the OPTIONAL fallow component. Every step is fail-open (install-fallow never throws);
// order: install → gitignore (always) → optional `fallow init` (sub-confirm, default NO —
// fallow is zero-config) → wire fallow's own git hook → save baselines ONLY if the gate wired
// AND the repo has debt to grandfather. dryRun prints + writes nothing throughout.
// Reason: flat fail-open orchestration: each fallow step (install → gitignore → optional init → wire gate → save baselines) is a sequential guarded call with its own dryRun/ok branch; the branch COUNT is the step count, no nesting
// fallow-ignore-next-line complexity
async function applyFallow(cwd, dryRun, interactive) {
    const r = installFallow({ cwd, dryRun });
    console.log(`  ${r.ok ? '✓' : '!'} ${r.message}`);
    ensureFallowGitignore({ cwd, dryRun });
    console.log(`  ${dryRun ? '[dry-run] ensure' : '✓ ensured'} .fallow/ in .gitignore`);
    const doInit = await subConfirm('Run `fallow init`? (optional — fallow is zero-config)', {
        interactive,
        fallback: false,
    });
    if (doInit) {
        if (dryRun)
            console.log('  [dry-run] fallow init');
        else {
            try {
                execFileSync('fallow', ['init'], { cwd, stdio: 'inherit' });
                console.log('  ✓ fallow init');
            }
            catch (e) {
                console.log(`  ! fallow init skipped: ${firstLine(e)}`);
            }
        }
    }
    const gate = wireFallowHooks({ cwd, dryRun });
    for (const line of gate.log)
        console.log(`  ${line}`);
    if (gate.ok && (dryRun || fallowHasDebt(cwd))) {
        const saved = saveFallowBaselines({ cwd, dryRun });
        console.log(`  ${saved.ok ? '✓ saved' : '! some'} fallow baselines (grandfather debt)`);
    }
}
// ── removal steps (SAFE: never delete a file devkit didn't create) ───────────
// Reason: CRAP-flagged thin package.json mutator: two near-identical key-delete loops (devDeps, scripts) each gated on existence + dryRun; exercised end-to-end via every remove* caller, not unit-isolated
// fallow-ignore-next-line complexity
function removeFromPkg(cwd, devDeps, scripts, dryRun) {
    const pkgPath = join(cwd, 'package.json');
    const pkg = readJson(pkgPath);
    if (!pkg)
        return [];
    const removed = [];
    for (const k of devDeps) {
        if (pkg.devDependencies?.[k]) {
            removed.push(`devDep ${k}`);
            if (!dryRun)
                delete pkg.devDependencies[k];
        }
    }
    for (const k of scripts) {
        if (pkg.scripts?.[k]) {
            removed.push(`script ${k}`);
            if (!dryRun)
                delete pkg.scripts[k];
        }
    }
    if (removed.length && !dryRun)
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    return removed;
}
function removeBiome(cwd, dryRun) {
    const file = join(cwd, 'biome.jsonc');
    if (existsSync(file)) {
        console.log(`  ${dryRun ? '[dry-run] delete' : '✓ deleted'} biome.jsonc`);
        if (!dryRun)
            rmSync(file);
    }
    const pkgRemoved = removeFromPkg(cwd, BIOME_DEV_DEPS, BIOME_SCRIPTS, dryRun);
    if (pkgRemoved.length)
        console.log(`  ${dryRun ? '[dry-run]' : '✓'} package.json: -${pkgRemoved.join(', -')}`);
    // Drop the biome-format step from the husky block.
    removeHuskyPiece(cwd, 'biome-format', dryRun);
}
// Remove ONLY the devkit `extends` from tsconfig — never delete a tsconfig with user content.
// Reason: the branches ARE the safe-strip decision tiers: unparseable → bail, no-devkit-extends → bail, array-extends → filter, scalar-extends → delete; each guard exists to NEVER delete a tsconfig devkit didn't author
// fallow-ignore-next-line complexity
function removeTsconfig(cwd, dryRun) {
    const file = join(cwd, 'tsconfig.json');
    if (!existsSync(file))
        return;
    const raw = readFileSync(file, 'utf8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        console.log('  ! tsconfig.json unparseable — left untouched');
        return;
    }
    const ext = parsed.extends;
    const isDevkit = (e) => typeof e === 'string' && e.startsWith('@norvalbv/devkit/tsconfig');
    const onlyExtends = Object.keys(parsed).length === 1 && 'extends' in parsed;
    if (!ext || (Array.isArray(ext) ? !ext.some(isDevkit) : !isDevkit(ext))) {
        console.log('  • tsconfig.json has no devkit extends — left untouched');
        return;
    }
    if (Array.isArray(ext))
        parsed.extends = ext.filter((e) => !isDevkit(e));
    else
        delete parsed.extends;
    if (dryRun) {
        console.log('  [dry-run] strip devkit extends from tsconfig.json');
        return;
    }
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
    console.log(`  ✓ stripped devkit extends from tsconfig.json${onlyExtends ? ' (file now has no extends — review/remove if empty)' : ''}`);
}
// Remove this package's devkit-guards blocks (pre-commit + commit-msg), other content intact.
function removeHusky(hookRoot, pkgRel, dryRun) {
    removeCommitMsgBlock(hookRoot, pkgRel, dryRun);
    const hookPath = join(hookRoot, '.husky', 'pre-commit');
    if (!existsSync(hookPath))
        return;
    const { content, removed } = removeGuardBlock(readFileSync(hookPath, 'utf8'), pkgRel);
    if (!removed) {
        console.log('  • no devkit-guards block in .husky/pre-commit');
        return;
    }
    if (dryRun) {
        console.log('  [dry-run] remove devkit-guards block from .husky/pre-commit');
        return;
    }
    writeFileSync(hookPath, content);
    console.log('  ✓ removed devkit-guards block from .husky/pre-commit');
}
// Remove a single fragment (one guard, or the biome step) from THIS package's block. Scoped via
// extract→removeFragment→replace so a shared sentinel in another package's block is untouched.
// `id` is typed `string | boolean` because removeBiome calls this with only 3 args, so `dryRun`
// (a boolean) lands in the `id` slot — a pre-existing arg-order quirk this conversion preserves
// (that call passes pkgRel='biome-format', which matches no block, so extractGuardBlock returns null
// and it no-ops before `id` is ever read). Hence the trailing dryRun is optional.
function removeHuskyPiece(hookRoot, pkgRel, id, dryRun) {
    const hookPath = join(hookRoot, '.husky', 'pre-commit');
    if (!existsSync(hookPath))
        return false;
    const content = readFileSync(hookPath, 'utf8');
    const block = extractGuardBlock(content, pkgRel);
    if (!block)
        return false;
    // Reached only via applyRemovals (id is always a string there); the boolean-in-id quirk above
    // returns null at the block check, so this cast is erased over an already-string value.
    const { content: newBlock, removed } = removeFragment(block, id);
    if (!removed)
        return false;
    if (dryRun) {
        console.log(`  [dry-run] remove ${id} from .husky/pre-commit`);
        return true;
    }
    writeFileSync(hookPath, replaceGuardBlock(content, newBlock, pkgRel));
    console.log(`  ✓ removed ${id} from .husky/pre-commit`);
    return true;
}
// Remove ONLY devkit-created structure files (guarded by config marker). The structure-lint
// `--structure` arg is not a standalone hook line — installHusky (step 3) already rebuilt the
// deterministic line without it — so nothing to strip from the hook here.
// Reason: safe-removal sequence guarded per artifact: marker check → delete template files → delete baselines → strip pkg entries; each existsSync/dryRun branch is a separate file devkit must verify it created before touching
// fallow-ignore-next-line complexity
function removeStructure(cwd, prevConfig, dryRun) {
    if (!prevConfig?.components?.structure) {
        console.log('  ! structure not recorded as devkit-created — leaving eslint files untouched');
        return;
    }
    // Same structure file set across stacks today; key off the recorded stack to stay generic.
    const files = STRUCTURE_TEMPLATE_FILES[prevConfig.stack ?? ''] ?? STRUCTURE_TEMPLATE_FILES.electron;
    for (const [, dest] of files) {
        const p = join(cwd, dest);
        if (existsSync(p)) {
            console.log(`  ${dryRun ? '[dry-run] delete' : '✓ deleted'} ${dest}`);
            if (!dryRun)
                rmSync(p);
        }
    }
    const owned = [IMPORT_WALL_BASELINE, LEGACY_IMPORT_WALL_BASELINE, STRUCTURE_BASELINE_DIR];
    for (const relativePath of owned) {
        const target = join(cwd, relativePath);
        if (!existsSync(target))
            continue;
        console.log(`  ${dryRun ? '[dry-run] delete' : '✓ deleted'} ${relativePath}`);
        if (!dryRun)
            rmSync(target, { recursive: true, force: true });
    }
    const pkgRemoved = removeFromPkg(cwd, ['eslint', 'eslint-plugin-project-structure', '@typescript-eslint/parser'], ['lint:structure'], dryRun);
    if (pkgRemoved.length) {
        console.log(`  ${dryRun ? '[dry-run]' : '✓'} package.json: -${pkgRemoved.join(', -')}`);
    }
}
// fallow-ignore-next-line complexity
function applyRemovals(cwd, remove, prevConfig, gitRoot, pkgRel, dryRun) {
    if (!remove.length)
        return;
    console.log(`\nRemoving deselected component(s): ${remove.join(', ')}`);
    // Guards (individual lines) before husky (whole-block) so order is irrelevant.
    if (remove.includes('guards')) {
        for (const g of GUARD_IDS)
            removeHuskyPiece(gitRoot, pkgRel, `guard-${g}`, dryRun);
    }
    if (remove.includes('biome'))
        removeBiome(cwd, dryRun);
    if (remove.includes('tsconfig'))
        removeTsconfig(cwd, dryRun);
    if (remove.includes('skills'))
        removeSkills(gitRoot, dryRun);
    if (remove.includes('agents'))
        removeAgents(gitRoot, dryRun);
    // Agent-hook scripts + registrations are exact-reconciled by installAgentSurfaces before this
    // Avoid deleting a decisions-owned hook that survives a general agentHooks deselection.
    if (remove.includes('structure'))
        removeStructure(cwd, prevConfig, dryRun);
    if (remove.includes('antiSlop'))
        antiSlopLifecycle.removeAntiSlopCapability(cwd, dryRun);
    if (remove.includes('husky'))
        removeHusky(gitRoot, pkgRel, dryRun);
}
// ── orchestration ────────────────────────────────────────────────────────────
// Overlay (local-only) install: invisible to git (.git/info/exclude), non-invasive (extends the
// repo, edits nothing committed). Self-contained — writes its own git-ignored .devkit/config.json
// and returns; applyInit's package/standalone path never runs for an overlay.
function applyOverlay(cwd, plan, pkgRel, devkitRef) {
    const { stack, selection, force = false, dryRun = false } = plan;
    console.log(`devkit init${dryRun ? ' (dry-run)' : ''} — OVERLAY (local-only) — stack=${stack}, devkit=${devkitRef}`);
    console.log('  invisible to git (.git/info/exclude); extends the repo; edits nothing committed\n');
    const { origHooksPath, fallowWired } = installOverlay(cwd, selection, stack, force, dryRun);
    const ownsLineGrowth = upgradeOffers.overlayOwnsLineGrowth(cwd);
    upgradeOffers.applyOverlayMaxLines(cwd, selection, repoAdopted(cwd), ownsLineGrowth, dryRun);
    if (selection.guards?.includes('fanout') || selection.guards?.includes('size')) {
        console.log('  freeze baselines (grandfather current tree)');
        runFreezes(cwd, dryRun, { overlay: true });
    }
    // Optional machine-global shim closes the plain-commit gap; `devkit clean --global` removes it.
    const globalCommitGate = Boolean(plan.globalCommitGate);
    const prevConfig = readJson(join(cwd, '.devkit', 'config.json'));
    const review = normalizeReviewProfile(plan.review ?? prevConfig?.review, selection.guards ?? [], {
        enabledDefault: prevConfig !== null,
    });
    if (globalCommitGate) {
        console.log('  global pre-commit gate (opt-in — survives husky reclaim on a plain `git commit`)');
        installGlobalHook({ dryRun });
    }
    // Record what was actually wired so clean/doctor are selection-aware. fallow reflects the ACTUAL
    // outcome (fallowWired) — an aborted install (no binary) records false. dropUndecided keeps an
    // un-asked optional component absent, exactly as the package writer does.
    const overlayComponents = dropUndecided({
        guards: [...(selection.guards ?? [])],
        skills: Boolean(selection.skills),
        agents: Boolean(selection.agents),
        agentHooks: Boolean(selection.agentHooks),
        searchSteering: false, // never wired in overlay (no resolvable bin without the package)
        fallow: fallowWired,
        antiSlop: false,
        lineGrowth: Boolean(selection.lineGrowth),
        adhd: Boolean(selection.adhd),
        priorArtGate: Boolean(selection.priorArtGate),
        agentTargets: [...(selection.agentTargets ?? AGENT_TARGETS)],
    }, upgradeOffers.overlayUndecidedLineGrowth(cwd, selection, plan.undecided), prevConfig?.components);
    overlayComponents.disabledGuards = disabledGuardsFor(selection.guards ?? [], plan.disabledGuards);
    if (!dryRun) {
        mkdirSync(join(cwd, '.devkit'), { recursive: true });
        writeFileSync(join(cwd, '.devkit', 'config.json'), `${JSON.stringify({
            stack,
            devkitRef,
            initVersion: INIT_VERSION,
            overlay: true,
            pkgRel,
            origHooksPath, // what core.hooksPath was before — `devkit clean` restores it
            globalCommitGate, // opt-in machine-global init.sh shim wired (so doctor can report it)
            components: overlayComponents,
            review,
        }, null, 2)}\n`);
        console.log('  ✓ wrote .devkit/config.json (git-ignored)');
    }
    console.log(`\n${dryRun ? 'Dry-run complete (nothing written).' : 'devkit overlay complete — local-only.'}`);
    console.log(globalCommitGate
        ? '  Global pre-commit gate wired — a plain `git commit` stays gated across `bun install`s.'
        : '  Re-run `devkit init --overlay` after a `bun install` (husky re-claims core.hooksPath),\n  or add --global-commit-gate once to gate plain `git commit` too.');
}
/**
 * The testable apply layer: given a resolved selection (+ removals), install/remove and
 * record .devkit/config.json.components. No prompting — callers (the CLI dispatcher, tests)
 * pass a fully-resolved plan.
 *
 * @param {string} cwd consumer root
 * @param {object} plan
 * @param {string} plan.stack
 * @param {object} plan.selection
 * @param {string[]} [plan.remove] component ids to remove
 * @param {boolean} [plan.force]
 * @param {boolean} [plan.dryRun]
 * @param {boolean} [plan.interactive] TTY run — enables fallow sub-confirms (default false)
 * @param {string[]} [plan.scanRoots] override guard.config.json scanRoots (--scan-root)
 * @param {boolean} [plan.standalone] no-package mode — vendored configs + global fail-open hook
 * @param {boolean} [plan.overlay] local-only mode — git-ignored, non-invasive, extends the repo
 * @param {boolean} [plan.globalCommitGate] overlay only — also install the opt-in machine-global
 *   husky init.sh shim so a plain `git commit` stays gated across husky's core.hooksPath reclaim
 * @param {string} [plan.devkitRef]
 * @param {boolean} [plan.regenStructureBaselines] re-snapshot structure/import-wall baselines
 *   (default true — init grandfathers the current tree). `devkit upgrade` passes false so an
 *   existing baseline is kept (recreate-if-missing only), never re-snapshotted (no debt laundering).
 */
// Reason: flat top-level init pipeline: numbered sequential steps (1 configs → 2 package.json → 3 husky → 4 freeze → 5/6 structure → 7 surfaces → 8 fallow → 9 config), each gated by a selection flag and delegated to a named installer; the branch COUNT is the step count, near-zero nesting
// fallow-ignore-next-line complexity
export async function applyInit(cwd, plan) {
    const { stack, selection, remove = [], force = false, dryRun = false, interactive = false, scanRoots = null, standalone = false, overlay = false, selfHost = false, regenStructureBaselines = true, undecided = [], } = plan;
    // Structure-lint: config-driven stacks (react-app, component-lib) run via devkit's own eslint (the
    // `guard-structure` bin), so they work even in standalone (no consumer eslint/plugin). Electron's
    // preset keeps its pinned local ESLint/plugin, but the Devkit-owned staged runner invokes it.
    const isStructure = selection.structure &&
        STRUCTURE_STACKS.has(stack) &&
        (!standalone || CONFIG_DRIVEN_STRUCTURE.has(stack));
    // Resolve the structure command once so hook generation and the recorded selection agree.
    const structureCmd = isStructure ? structureCmdFor(stack) : undefined;
    const devkitPkg = readJson(join(packageDir(), 'package.json'));
    const devkitRef = plan.devkitRef ?? (devkitPkg ? `v${devkitPkg.version}` : 'main');
    const prevConfig = readJson(join(cwd, '.devkit', 'config.json'));
    // Monorepo: configs/baselines stay in cwd (the package), but the husky hook + repo-wide
    // skills target the git root, with gates scoped `cd <pkgRel>`. Single-package repo → gitRoot
    // === cwd, pkgRel '' → everything as before.
    const { gitRoot, pkgRel } = detectGitRoot(cwd);
    // Overlay (local-only): a self-contained path — invisible to git, non-invasive. Returns early.
    if (overlay)
        return applyOverlay(cwd, plan, pkgRel, devkitRef);
    // Baselines are durable tracked state. Re-open their canonical directory before migration so a
    // consumer's broad `.devkit/` ignore cannot turn the move into a staged deletion-only commit.
    ensureDevkitCacheGitignore(cwd, dryRun);
    reportRatchetBaselineMigration(cwd, dryRun);
    console.log(`devkit init${dryRun ? ' (dry-run — no files written)' : ''} — stack=${stack}, devkit=${devkitRef}`);
    if (standalone) {
        console.log('  standalone: no package.json dep — global devkit CLI, fail-open hook');
    }
    if (selfHost) {
        console.log('  self-host: devkit dogfooding itself — source-mode hook, no self-dep');
    }
    if (pkgRel) {
        console.log(`  monorepo: package "${pkgRel}" — hook + skills at the git root (${gitRoot})`);
    }
    const on = COMPONENTS.filter((c) => c.id === 'guards'
        ? selection.guards.length
        : selection[c.id] && !(c.id === 'structure' && !isStructure)).map((c) => c.id);
    console.log(`  components: ${on.join(', ') || '(none)'}\n`);
    console.log('1. configs');
    if (selfHost) {
        // biome.jsonc / tsconfig.json / guard.config.json are hand-owned + committed in the devkit
        // repo (its tsconfig extends the LOCAL base, not @norvalbv/devkit) — never overwrite them.
        console.log('  • self-host: configs are hand-owned — leaving them untouched');
    }
    else if (standalone)
        installStandaloneConfigs(cwd, stack, selection, force, dryRun, isStructure);
    else if (isStructure)
        installStructureFiles(cwd, stack, selection, plan);
    else
        installConfigs(cwd, selection, force, dryRun);
    applyScanRoots(cwd, scanRoots, dryRun);
    // Line-growth block: write the cap only on FIRST adoption (so step-4's freeze grandfathers giants)
    // and only when the size guard runs it. An adopted repo enables it via `devkit upgrade` (freeze +
    // cap in one step), never here. Self-host is excluded: its guard.config.json is hand-owned.
    upgradeOffers.applyMaxLines(cwd, !selfHost &&
        !repoAdopted(cwd) &&
        Boolean(selection.lineGrowth) &&
        selection.guards.includes('size'), dryRun);
    // Standalone AND self-host touch NO package.json: standalone keeps a shared repo dep-free;
    // self-host must never add @norvalbv/devkit as a dependency on ITSELF (the whole reason a plain
    // `devkit init` can't run here).
    if (!standalone && !selfHost) {
        console.log('2. package.json');
        patchPackageJson(cwd, devkitRef, repoUrl(), selection, isStructure, dryRun, stack);
    }
    if (selection.husky) {
        console.log('3. husky pre-commit');
        // structureCmd threads into the selection; self-host rewrites bunx→`node …mts`.
        if (selfHost)
            installSelfHostHook(gitRoot, pkgRel, selection, dryRun, cwd);
        else if (standalone)
            installStandaloneHook(gitRoot, pkgRel, { ...selection, structureCmd }, dryRun);
        else
            installHusky({ ...selection, structureCmd }, gitRoot, pkgRel, dryRun);
        // Commit-msg judges (review→completeness, sentry): self-host opts out AND drops a stale block.
        if (!selfHost)
            installCommitMsgHook(gitRoot, pkgRel, selection, { dryRun, standalone });
        else
            removeCommitMsgBlock(gitRoot, pkgRel, dryRun);
    }
    // Self-host skips the size/fanout freezes: devkit has 0 eslint-disable directives and no folder over
    // the fan-out cap, so those baselines would be empty/no-op. But the RECOMMENDED line-growth ratchet is
    // off until enabled, and devkit has files over LINE_CAP — so enable maxLines + freeze size-lines.json
    // (grandfather the current giants shrink-only) on first adoption, exactly like `devkit upgrade` step-3b.
    // Guarded on !hasLineCap so a re-run/upgrade never re-freezes (which would launder newly-added giants).
    if (!selfHost && (selection.guards?.includes('fanout') || selection.guards?.includes('size'))) {
        console.log('4. freeze baselines');
        runFreezes(cwd, dryRun);
    }
    else if (selfHost &&
        !dryRun &&
        selection.lineGrowth &&
        selection.guards?.includes('size') &&
        !hasLineCap(cwd)) {
        console.log('4. line-growth baseline (enable maxLines + grandfather current files)');
        const { enabled, grandfathered } = enableLineGrowth(cwd);
        console.log(enabled
            ? `  ✓ maxLines ${LINE_CAP}; grandfathered ${grandfathered} file(s) (shrink-only)`
            : '  ! could not enable line-growth — guard.config.json unreadable');
    }
    if (isStructure) {
        console.log('5. structure + import-wall baselines (grandfather current tree)');
        await runStructureBaselines(cwd, stack, dryRun, regenStructureBaselines);
        // Structure-lint is wired at block-build time (step 3) via `--structure <structureCmd>` on the
        // deterministic orchestrator line — package and standalone alike. No separate enable step / hook
        // placeholder to flip.
    }
    const assets = { ...selection, structure: isStructure };
    const override = await resolveAssetConflicts(gitRoot, assets, {
        interactive,
        force,
    });
    const agentTargets = syncSurfaces(gitRoot, assets, dryRun, override, prevConfig?.components);
    if (selection.fallow) {
        console.log('8. fallow (optional code-health layer)');
        await applyFallow(cwd, dryRun, interactive);
    }
    if (selection.searchCode) {
        console.log('8b. search-code (opt-in semantic search)');
        installSearchCode(cwd, dryRun);
    }
    // Oxc repository state is core in every tracked install mode. Anti-slop remains the optional
    // policy layer and selects the extended managed base; overlay returned before this apply path.
    if (selection.antiSlop)
        antiSlopLifecycle.syncAntiSlopCapability(cwd, { dryRun });
    else
        oxcLifecycle.syncOxcCapability(cwd, { dryRun, antiSlop: false });
    // The vendored i-have-adhd skill, into devkit's own tree rather than the agent skills dirs — so it
    // no longer depends on the `skills` component. Called unconditionally: a false selection reclaims a
    // previously-installed copy, and syncSurfaces above has already reclaimed the `.claude/skills/`
    // copy older releases wrote (skillNamesForSelection now excludes it), which is the whole migration.
    if (selection.adhd)
        console.log(`8d. i-have-adhd → ${ADHD_SKILL_DIR}/`);
    syncAdhdSkill(gitRoot, Boolean(selection.adhd), dryRun);
    // Removals (deselected + present).
    applyRemovals(cwd, remove, prevConfig, gitRoot, pkgRel, dryRun);
    // .devkit/config.json with the component selection.
    console.log('9. .devkit/config.json');
    const guards = selection.husky
        ? [...selection.guards]
        : selection.guards.filter((guard) => guard === 'decisions');
    const components = {
        biome: selection.biome,
        tsconfig: selection.tsconfig,
        skills: selection.skills,
        agents: Boolean(selection.agents),
        searchSteering: Boolean(selection.searchSteering),
        agentHooks: Boolean(selection.agentHooks),
        husky: selection.husky,
        structure: isStructure,
        fallow: Boolean(selection.fallow),
        antiSlop: Boolean(selection.antiSlop),
        searchCode: Boolean(selection.searchCode),
        lineGrowth: Boolean(selection.lineGrowth),
        // Always written, including `false` — an ABSENT key is what marks a repo as never-offered, so
        // recording the decline is what stops `devkit upgrade` re-asking (see unofferedComponents).
        adhd: Boolean(selection.adhd),
        priorArtGate: Boolean(selection.priorArtGate),
        agentTargets: [...agentTargets],
        // Most guards are pre-commit capabilities and disappear with husky. Decisions additionally
        // owns an agent pre-edit hook, so it remains authoritative in config even without husky.
        guards,
        disabledGuards: disabledGuardsFor(guards, plan.disabledGuards),
    };
    // Keep an un-asked optional component ABSENT — see InitPlan.undecided.
    dropUndecided(components, undecided, prevConfig?.components);
    // Record pkgRel (monorepo: '' for a root install) so doctor finds the git-root hook + skills,
    // and standalone (no-package mode) so doctor doesn't flag a missing devkit pin / deps.
    // devkitRef ALSO doubles as the init-version stamp doctor's checkVersion reads (it's `v<version>`).
    // Carry forward consumer-authored top-level keys init doesn't manage (a hand-declared minDevkit
    // floor, the configOverrides opt-out doctor honours) — else every re-run (init/upgrade) wipes them.
    const config = {
        ...(prevConfig?.minDevkit !== undefined ? { minDevkit: prevConfig.minDevkit } : {}),
        ...(prevConfig?.configOverrides ? { configOverrides: prevConfig.configOverrides } : {}),
        stack,
        devkitRef,
        initVersion: INIT_VERSION,
        pkgRel,
        standalone,
        // Self-host marker: upgrade/doctor read this to skip the pin/dep checks and regenerate the
        // source-mode hook instead of the package-local `guard-*` one.
        selfHost,
        components,
        review: normalizeReviewProfile(plan.review ?? prevConfig?.review, components.guards, {
            enabledDefault: prevConfig !== null,
            available: selection.husky,
        }),
    };
    const configPath = join(cwd, '.devkit', 'config.json');
    if (dryRun) {
        console.log('  [dry-run] write .devkit/config.json');
    }
    else {
        mkdirSync(join(cwd, '.devkit'), { recursive: true });
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
        console.log('  ✓ wrote .devkit/config.json');
    }
    printReferencedSteps();
    console.log(`\n${dryRun ? 'Dry-run complete (nothing written).' : 'devkit init complete.'} Run \`devkit doctor\` to verify.`);
}
function printReferencedSteps() {
    console.log('\nNext, by hand (devkit prints these — it never runs them):');
    console.log('  • fallow (optional code-health audit): install per https://docs.fallow.tools');
    console.log('  • search-code (semantic dup matcher): point guard-dup at your index via');
    console.log('      GUARD_INDEX_PATH=<path/to/index.db>  (or indexPath in guard.config.json).');
    console.log('      Without it the duplication gate fails open (clone + ratchet gates still run).');
}
function structureAvailableFor(stack) {
    return STRUCTURE_STACKS.has(stack);
}
export const meta = {
    name: 'init',
    summary: 'Wire this repo onto devkit (interactive wizard; idempotent).',
    help: INIT_HELP,
};
// Reason: flat CLI dispatch: resolves one `selection` via three converging paths (interactive wizard / --yes flags / non-TTY) then hands a fully-resolved plan to applyInit; the branches ARE the resolution-mode fork, each path linear with no shared nesting
// fallow-ignore-next-line complexity
export default async function run(args, cwd) {
    const flags = initFlags.parseFlags(args);
    // Refuse a skewed runner HERE, not at the managed-Oxc write near the end: by then the package.json
    // patch, hook chain, baselines, skills/agents and the search-code wiring have all been rewritten
    // by the older devkit, so the throw would leave a half-applied init whose remedy ("doctor --fix")
    // is not the command that would finish it. A dry run writes nothing, so it stays open. (sc-2100)
    if (!flags.dryRun)
        assertRunnerMayWrite(cwd);
    const detectedStack = flags.stack ?? detectStack(cwd);
    // Mode: --overlay / --standalone seed it; the wizard asks (so the interactive flow exposes it).
    const detectedMode = flags.overlay ? 'overlay' : flags.standalone ? 'standalone' : 'package';
    const interactive = !flags.yes && process.stdout.isTTY && !flags.dryRun;
    let stack = detectedStack;
    let selection;
    let remove = [];
    let mode = detectedMode;
    let review;
    let disabledGuards;
    // --baselines-only re-derives structure/import-wall baselines only for package-mode presets.
    if (flags.baselinesOnly) {
        if (mode !== 'package') {
            console.error('devkit init --baselines-only: unsupported in overlay/standalone mode (no structure preset).');
            return 1;
        }
        if (!structureAvailableFor(stack)) {
            console.error(`devkit init --baselines-only: no structure-lint preset for stack "${stack}".`);
            return 1;
        }
        if (!existsSync(join(cwd, 'eslint.config.mjs'))) {
            console.error('devkit init --baselines-only: no eslint.config.mjs — run a full `devkit init` first.');
            return 1;
        }
        console.log('devkit init --baselines-only — regenerating structure + import-wall baselines');
        await runStructureBaselines(cwd, stack, flags.dryRun);
        return 0;
    }
    const selfHost = isDevkitRepo(cwd);
    if (selfHost) {
        mode = 'self-host';
        const recorded = readJson(join(cwd, '.devkit', 'config.json'));
        selection = selfHostSelection(recorded?.components);
        disabledGuards = recorded?.components?.disabledGuards;
    }
    else if (interactive) {
        const installed = detectInstalled(cwd);
        const result = await runWizard({
            detectedStack,
            detectedMode,
            structureAvailable: structureAvailableFor(detectedStack),
            installed,
            existingReview: readJson(join(cwd, '.devkit', 'config.json'))
                ?.review,
        });
        if (!result)
            return 0; // cancelled — nothing written
        ({ mode, stack, remove, review } = result);
        selection = result.selection;
        disabledGuards = selection.husky
            ? GUARD_IDS.filter((guard) => !selection.guards.includes(guard))
            : [];
    }
    else {
        selection = initFlags.selectionFromFlags(flags);
        selection = initFlags.recoverInterruptedCapabilitySelection(cwd, flags, selection);
        disabledGuards = initFlags.disabledGuardsFromFlags(flags);
    }
    antiSlopLifecycle.warnIfAntiSlopUnavailable(mode, flags.antiSlop);
    if (mode === 'overlay')
        selection = applyOverlayConstraints(selection);
    if (!selfHost && !interactive) {
        const reviewPlan = reviewPlanFromFlags(flags, selection);
        if (reviewPlan.error) {
            console.error(reviewPlan.error);
            return 1;
        }
        review = reviewPlan.profile;
        // Non-interactive removal of deselected-present components only with --remove-deselected.
        if (flags.removeDeselected) {
            const installed = detectInstalled(cwd);
            for (const id of installed) {
                const stillSelected = id === 'devkit-review' ||
                    (id === 'guards' ? selection.guards.length > 0 : selection[id]);
                if (!stillSelected)
                    remove.push(id);
            }
        }
    }
    // Self-host runs structure via `bun run lint:structure` (eslint), not a template preset, so skip
    // the "no preset → disable structure" flip (which would otherwise print a misleading notice).
    if (!selfHost && !structureAvailableFor(stack) && selection.structure) {
        selection.structure = false; // no template for this stack — silently skip (noted below)
        if (stack !== 'generic') {
            console.log(`devkit init: no structure-lint preset for stack "${stack}" yet — skipping it.`);
        }
    }
    await applyInit(cwd, {
        stack,
        selection,
        remove,
        force: flags.force,
        dryRun: flags.dryRun,
        interactive,
        scanRoots: flags.scanRoots,
        standalone: mode === 'standalone',
        overlay: mode === 'overlay',
        selfHost: mode === 'self-host',
        globalCommitGate: flags.globalCommitGate,
        review,
        disabledGuards,
    });
    if (interactive && !selfHost)
        outro('Done — run `devkit doctor` to verify.');
    return 0;
}
// Re-export flag helpers for existing test importers; their implementation lives under install/flags.
export { parseFlags, selectionFromFlags } from '../lib/install/flags/init-flags.mjs';
