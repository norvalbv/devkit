/**
 * `devkit init` — scaffold a consumer repo onto devkit's shared configs + gate-engine,
 * with an interactive SETUP WIZARD (clack) for component selection AND removal.
 *
 * Three resolution paths converge on one `selection` (see components.mjs):
 *   1. interactive  — TTY + no --yes → runWizard() asks per component + per guard.
 *   2. --yes        — all recommended defaults (EXACT pre-wizard behaviour), minus any --no-*.
 *   3. non-TTY      — same as --yes (never hangs waiting for stdin), minus any --no-*.
 *
 * Apply logic per component: selected+absent → install; selected+present → idempotent;
 * deselected+present → REMOVE (wizard confirms per component default-NO;
 * --remove-deselected removes without prompting). Removal is SAFE: it never deletes a file
 * devkit didn't create.
 *
 * The chosen set is recorded in .devkit/config.json.components so `doctor` is selection-aware.
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { confirm, isCancel, multiselect, outro } from '@clack/prompts';
import { enableLineGrowth, hasLineCap, LINE_CAP, setMaxLines, } from '../../gate-engine/ratchets/size-disable.mjs';
import { AGENT_TARGETS, applyOverlayConstraints, COMPONENTS, defaultSelection, GUARD_IDS, normalizeReviewProfile, } from '../lib/components.mjs';
import { detectGitRoot } from '../lib/detect-git-root.mjs';
import { detectStack } from '../lib/detect-stack.mjs';
import { packageDir, readJson, writeIfAbsent } from '../lib/fs-helpers.mjs';
import { generateImportWallBaseline } from '../lib/generate/generate-import-wall-baseline.mjs';
import { generateStructureBaselines } from '../lib/generate/generate-structure-baseline.mjs';
import { INIT_HELP } from '../lib/help/init-help.mjs';
import { installCommitMsgHook, removeCommitMsgBlock } from '../lib/husky/commit-msg-block.mjs';
import { buildFullHook, buildGuardBlock, extractGuardBlock, hasFragment, removeFragment, removeGuardBlock, replaceGuardBlock, } from '../lib/husky/husky-block.mjs';
import { installSelfHostHook, isDevkitRepo, selfHostSelection } from '../lib/husky/self-host.mjs';
import { ensureDevkitCacheGitignore } from '../lib/install/gitignore-cache.mjs';
import { ensureFallowGitignore, installFallow, saveFallowBaselines, wireFallowGate, } from '../lib/install/install-fallow.mjs';
import { detectHookConflicts, installHookRegistrations, removeHookRegistrations, removeHookScripts, syncHookScripts, } from '../lib/install/install-hooks.mjs';
import { installSearchCode } from '../lib/install/install-search-code.mjs';
import { parseReviewFlags, reviewPlanFromFlags, } from '../lib/install/review-profile.mjs';
import { installOverlay } from '../lib/overlay.mjs';
import { installGlobalHook } from '../lib/overlay-global-hook.mjs';
import { installStandaloneConfigs, installStandaloneHook } from '../lib/standalone.mjs';
import { removeAgents, removeSkills } from '../lib/sync-manifest.mjs';
import { runWizard } from '../lib/wizard.mjs';
import { detectAgentConflicts, syncAgents } from './sync/sync-agents.mjs';
import { detectSkillConflicts, syncSkills } from './sync/sync-skills.mjs';
import { repoUrl } from './update.mjs';
const INIT_VERSION = 2;
// Stacks with a structure-lint preset (eslint.config.mjs + eslint/domains.mjs + baselines).
// next/node-service are deliberately OUT until a template ships for them — listing one here
// would make init read a non-existent templates/<stack> dir.
const STRUCTURE_STACKS = new Set(['electron', 'react-app', 'component-lib']);
// Config-driven structure stacks — their topology lives in guard.config.json's `structure` block and
// the folder-structure rule runs from DEVKIT's own eslint via the `guard-structure` bin (no consumer
// eslint/plugin dep). These get structure-lint even in standalone mode. Electron is EXCLUDED: its
// preset imports the plugin + @typescript-eslint/parser directly in a consumer eslint.config.mjs and
// uses eslint/domains.mjs, so it stays package-mode with consumer-side deps.
const CONFIG_DRIVEN_STRUCTURE = new Set(['react-app', 'component-lib']);
// The structure-lint command a stack runs on the guard-deterministic `--structure` arg. Config-driven
// stacks use devkit's own `guard-structure` bin (the orchestrator resolves it as a sibling module, so
// no consumer eslint dep); every other structure stack (electron) keeps its consumer-side `bunx eslint
// src`. Shared with doctor's checkStructureLint so the expected arg stays in lockstep with what init
// emits when the stack rules change.
export function structureCmdFor(stack) {
    return CONFIG_DRIVEN_STRUCTURE.has(stack) ? 'guard-structure gate' : 'bunx eslint src';
}
// The structure files each stack emits, [src-relative-to-template, dest-relative-to-cwd].
// The full install set adds biome/tsconfig/guard.config on top (installStructureFiles).
const STRUCTURE_TEMPLATE_FILES = {
    electron: [
        ['eslint.config.mjs', 'eslint.config.mjs'],
        ['eslint/domains.mjs', 'eslint/domains.mjs'],
        ['eslint/baselines/exempt.mjs', 'eslint/baselines/exempt.mjs'],
    ],
    // react-app — CONFIG-DRIVEN (data): components + pages trees declared in guard.config.json, compiled
    // by the shared shim. No per-stack eslint.config / domains. (electron is the one remaining preset.)
    'react-app': [
        ['_shared/eslint.config.mjs', 'eslint.config.mjs'],
        ['_shared/exempt.mjs', 'eslint/baselines/exempt.mjs'],
    ],
    // Flat component lib — CONFIG-DRIVEN (the universal path): the topology is a `structure` block in
    // guard.config.json, and eslint.config.mjs is the shared shim that compiles it via devkit's
    // compileToEslint. No per-stack eslint.config / domains. `_shared/` srcs resolve from templates/.
    'component-lib': [
        ['_shared/eslint.config.mjs', 'eslint.config.mjs'],
        ['_shared/exempt.mjs', 'eslint/baselines/exempt.mjs'],
    ],
};
// devDeps/scripts owned by each component — used by both install (add) and remove (delete).
const BIOME_DEV_DEPS = ['@biomejs/biome'];
const BIOME_SCRIPTS = ['lint', 'format'];
// Matches the scanRoots array value in guard.config.json for an in-place --scan-root patch
// (preserves the //-comment guidance keys a JSON round-trip would drop). Hoisted (perf).
const SCANROOTS_RE = /("scanRoots"\s*:\s*)\[[^\]]*\]/;
function parseFlags(args) {
    const flags = {
        yes: false,
        dryRun: false,
        force: false,
        stack: null,
        removeDeselected: false,
        fallow: false,
        searchSteering: false,
        agentHooks: false,
        searchCode: false,
        standalone: false,
        overlay: false,
        baselinesOnly: false,
        no: new Set(),
        guards: null,
        scanRoots: null,
        ...parseReviewFlags(args),
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--yes' || a === '-y')
            flags.yes = true;
        else if (a === '--dry-run')
            flags.dryRun = true;
        else if (a === '--force')
            flags.force = true;
        else if (a === '--remove-deselected')
            flags.removeDeselected = true;
        else if (a === '--fallow')
            flags.fallow = true;
        else if (a === '--search-steering')
            flags.searchSteering = true;
        else if (a === '--agent-hooks')
            flags.agentHooks = true;
        else if (a === '--search-code')
            flags.searchCode = true;
        else if (a === '--standalone')
            flags.standalone = true;
        else if (a === '--overlay')
            flags.overlay = true;
        else if (a === '--global-commit-gate')
            flags.globalCommitGate = true;
        else if (a === '--baselines-only')
            flags.baselinesOnly = true;
        else if (a === '--stack')
            flags.stack = args[++i];
        else if (a === '--guards')
            flags.guards = (args[++i] ?? '').split(',').map((g) => g.trim());
        // --scan-root <comma-list>: override guard.config.json scanRoots up front, so the freezes
        // + the react-app structureRoot grandfather a non-standard tree (e.g. services/webapp/src).
        else if (a === '--scan-root' || a === '--scan-roots')
            flags.scanRoots = (args[++i] ?? '')
                .split(',')
                .map((r) => r.trim())
                .filter(Boolean);
        else if (a.startsWith('--no-'))
            flags.no.add(a.slice('--no-'.length));
    }
    return flags;
}
// Build a selection from flags (the --yes / non-TTY path): all recommended, minus --no-*,
// guards narrowed by --guards / --no-guards.
function selectionFromFlags(flags) {
    const sel = defaultSelection();
    for (const id of ['biome', 'tsconfig', 'skills', 'agents', 'husky', 'structure']) {
        if (flags.no.has(id))
            sel[id] = false;
    }
    if (flags.no.has('guards'))
        sel.guards = [];
    else if (flags.guards)
        sel.guards = flags.guards.filter((g) => GUARD_IDS.includes(g));
    // Line-growth block is recommended-on; --no-line-growth opts out under --yes / non-TTY.
    if (flags.no.has('line-growth'))
        sel.lineGrowth = false;
    // fallow + the agent-hook components are OPT-IN: off unless their flag is passed (and --no-* keeps off).
    sel.fallow = flags.fallow && !flags.no.has('fallow');
    sel.searchSteering = flags.searchSteering && !flags.no.has('search-steering');
    sel.agentHooks = flags.agentHooks && !flags.no.has('agent-hooks');
    sel.searchCode = flags.searchCode && !flags.no.has('search-code');
    // Agent surfaces: both by default; --no-claude / --no-cursor drop one (don't double-install).
    // ponytail: --no-claude --no-cursor leaves [] → skills/agents sync nowhere (explicit, allowed).
    sel.agentTargets = AGENT_TARGETS.filter((t) => !flags.no.has(t));
    return sel;
}
// Which components are currently wired? Read the recorded set first (authoritative), then
// fall back to on-disk detection for a pre-wizard repo with no `components` block.
function detectInstalled(cwd) {
    const cfg = readJson(join(cwd, '.devkit', 'config.json'));
    const installed = new Set();
    const recorded = cfg?.components;
    if (cfg?.review?.enabled)
        installed.add('devkit-review');
    if (recorded) {
        for (const id of [
            'biome',
            'tsconfig',
            'skills',
            'agents',
            'searchSteering',
            'agentHooks',
            'husky',
            'structure',
        ]) {
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
function installStructureFiles(cwd, stack, force, dryRun) {
    const tplDir = join(packageDir(), 'templates', stack);
    // Structure-stack biome.jsonc / tsconfig.json supersede the generic ones (stack rules).
    const items = [
        ...STRUCTURE_TEMPLATE_FILES[stack],
        ['biome.jsonc', 'biome.jsonc'],
        ['tsconfig.json', 'tsconfig.json'],
        ['guard.config.json', 'guard.config.json'],
    ];
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
// Enable the per-file line-growth block on FIRST adoption: write `maxLines` into guard.config.json so
// the guard-size ratchet caps source files. Called BEFORE the step-4 freeze so that same first-init
// `guard-size freeze` grandfathers the current giants into size-lines.json. Callers gate this on
// !repoAdopted — enabling the cap on an already-adopted repo without a fresh freeze would hard-error
// its giants, so that path goes through `devkit upgrade`'s offer (which freezes in the same step).
function applyMaxLines(cwd, on, dryRun) {
    if (!on)
        return;
    if (dryRun) {
        console.log(`  [dry-run] set guard.config.json maxLines = ${LINE_CAP} (line-growth block)`);
        return;
    }
    if (setMaxLines(cwd)) {
        console.log(`  ✓ guard.config.json maxLines = ${LINE_CAP} (per-file line-growth block)`);
    }
}
// Reason: the branches ARE the per-component devDep/script manifest: each `...(sel.x ? {...} : {})` spread names exactly which deps+scripts a component owns; flattening scatters this single source-of-truth table that remove() mirrors
// fallow-ignore-next-line complexity
function patchPackageJson(cwd, devkitRef, sel, isStructure, dryRun, stack) {
    const pkgPath = join(cwd, 'package.json');
    const pkg = readJson(pkgPath);
    if (!pkg) {
        console.log('  ! no package.json — skipping devDeps/scripts wiring');
        return;
    }
    // Zero-consumer-dependency model: devkit bundles the gate tools. jscpd is no longer a consumer dep
    // (the clone gate resolves devkit's OWN bundled jscpd), and the config-driven structure gate runs via
    // the `guard-structure` bin (devkit's own eslint + plugin). Only ELECTRON keeps consumer-side
    // eslint/parser/plugin — its preset imports them directly in a consumer eslint.config.mjs + domains.
    const electronPreset = isStructure && stack === 'electron';
    const devDeps = {
        '@norvalbv/devkit': `${repoUrl()}#${devkitRef}`,
        ...(sel.biome ? { '@biomejs/biome': '^2.5.0' } : {}),
        ...(sel.husky ? { husky: '^9.1.7' } : {}),
        ...(electronPreset
            ? {
                eslint: '^10.0.0',
                'eslint-plugin-project-structure': '^3.14.3',
                '@typescript-eslint/parser': '^8.0.0',
            }
            : {}),
    };
    const scripts = {
        ...(sel.biome ? { lint: 'biome check .', format: 'biome check --write .' } : {}),
        ...(sel.husky ? { prepare: 'husky' } : {}),
        ...(sel.guards?.includes('fanout') || sel.guards?.includes('size')
            ? { 'guard:freeze': 'guard-fanout freeze && guard-size freeze' }
            : {}),
        ...(electronPreset ? { 'lint:structure': 'eslint src' } : {}),
    };
    pkg.devDependencies = pkg.devDependencies ?? {};
    pkg.scripts = pkg.scripts ?? {};
    const added = [];
    for (const [k, v] of Object.entries(devDeps)) {
        if (!pkg.devDependencies[k]) {
            pkg.devDependencies[k] = v;
            added.push(`devDep ${k}`);
        }
    }
    for (const [k, v] of Object.entries(scripts)) {
        if (!pkg.scripts[k]) {
            pkg.scripts[k] = v;
            added.push(`script ${k}`);
        }
    }
    if (added.length === 0) {
        console.log('  • package.json already wired (devDeps + scripts)');
        return;
    }
    if (dryRun) {
        console.log(`  [dry-run] patch package.json: ${added.join(', ')}`);
        return;
    }
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`  ✓ package.json: ${added.join(', ')}`);
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
// Ordering holds: runFreezes/runStructureBaselines run BEFORE the config write on first init, so the
// very first adoption still freezes.
function repoAdopted(cwd) {
    return existsSync(join(cwd, '.devkit', 'config.json'));
}
function runFreezes(cwd, dryRun) {
    if (dryRun) {
        console.log('  [dry-run] skip guard-fanout freeze + guard-size freeze');
        return;
    }
    if (repoAdopted(cwd)) {
        console.log('  • repo already adopted — keeping baselines (run `guard-* freeze` to re-cut)');
        return;
    }
    // devkit's own ratchet bins are .mts in this repo (dev/tests, Node strips types) but compiled .mjs
    // in an installed consumer (dist). Derive the extension from THIS module so the path resolves in both.
    const ext = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
    const bins = [
        ['guard-fanout', join(packageDir(), 'gate-engine', 'ratchets', `folder-fanout${ext}`)],
        ['guard-size', join(packageDir(), 'gate-engine', 'ratchets', `size-disable${ext}`)],
    ];
    for (const [name, bin] of bins) {
        try {
            execFileSync(process.execPath, [bin, 'freeze'], { cwd, stdio: 'pipe' });
            console.log(`  ✓ ${name} freeze (baseline grandfathered)`);
        }
        catch (e) {
            console.log(`  ! ${name} freeze failed: ${firstLine(e)}`);
        }
    }
}
/** The consumer's permanent import-wall exemptions (eslint/baselines/exempt.mjs `importWallExempt`), or empty. */
export async function readImportWallExempt(cwd) {
    const file = join(cwd, 'eslint', 'baselines', 'exempt.mjs');
    if (!existsSync(file))
        return new Set();
    try {
        const { importWallExempt = [] } = (await import(__rewriteRelativeImportExtension(pathToFileURL(file).href)));
        return new Set(importWallExempt.map((m) => m.pattern));
    }
    catch {
        return new Set();
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
    // marker, not `eslint/baselines/*.mjs` existence, so deleting an empty baseline doesn't re-arm regen.
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
        // Honour the consumer's hand-maintained import-wall exemptions (eslint/baselines/exempt.mjs):
        // an exempt file is a permanent architectural allowance, not a violator, so it must be skipped
        // during the scan — else it would be re-grandfathered every regen.
        generateImportWallBaseline(cwd, { ...opts, exemptPatterns: await readImportWallExempt(cwd) });
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
// Resolve the non-devkit-collision policy → an `override(kind, name)` predicate the sync step
// consults. A collision is a same-named asset the consumer authored (on disk, unmanifested, content
// DIVERGES from the bundle). DEFAULT is to PRESERVE it (never silently clobber a user asset): force
// → adopt all; non-interactive → preserve all (loud, with a --force hint); interactive → a per-asset
// multiselect (none ticked = preserve all). Keyed by `${kind}:${name}` so kinds never alias.
// Reason: flat policy resolver: the branches ARE the four resolution modes (none / force / non-interactive / interactive-pick), each a single guarded return; no nesting
// fallow-ignore-next-line complexity
async function resolveAssetConflicts(gitRoot, selection, { interactive, force }) {
    const targets = selection.agentTargets ?? AGENT_TARGETS;
    const found = [];
    if (selection.skills)
        for (const name of detectSkillConflicts(gitRoot, targets))
            found.push({ kind: 'skill', name });
    if (selection.agents)
        for (const name of detectAgentConflicts(gitRoot, targets))
            found.push({ kind: 'agent', name });
    if (selection.agentHooks)
        for (const name of detectHookConflicts(gitRoot, targets))
            found.push({ kind: 'agent-hook', name });
    if (!found.length)
        return () => false;
    const list = found.map((c) => `${c.kind}:${c.name}`).join(', ');
    if (force) {
        console.log(`  overriding ${found.length} non-devkit collision(s) with devkit's version: ${list}`);
        return () => true;
    }
    if (!interactive) {
        console.log(`  ! preserving ${found.length} non-devkit asset(s) that collide with devkit's: ${list}`);
        console.log("    (re-run with --force to overwrite them with devkit's versions)");
        return () => false;
    }
    const picked = await multiselect({
        message: 'These assets already exist and were NOT installed by devkit. Select any to OVERWRITE with devkit’s version (unselected are kept):',
        options: found.map((c) => ({ value: `${c.kind}:${c.name}`, label: `${c.kind}: ${c.name}` })),
        initialValues: [],
        required: false,
    });
    if (isCancel(picked))
        return () => false;
    const set = new Set(picked);
    return (kind, name) => set.has(`${kind}:${name}`);
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
    const gate = wireFallowGate({ cwd, dryRun, target: 'git' });
    console.log(`  ${gate.ok ? '✓ wired' : '! could not wire'} fallow git hook`);
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
    const baselines = join(cwd, 'eslint', 'baselines', 'imports.mjs');
    if (existsSync(baselines)) {
        console.log(`  ${dryRun ? '[dry-run] delete' : '✓ deleted'} eslint/baselines/imports.mjs`);
        if (!dryRun)
            rmSync(baselines);
    }
    const pkgRemoved = removeFromPkg(cwd, ['eslint', 'eslint-plugin-project-structure', '@typescript-eslint/parser'], ['lint:structure'], dryRun);
    if (pkgRemoved.length) {
        console.log(`  ${dryRun ? '[dry-run]' : '✓'} package.json: -${pkgRemoved.join(', -')}`);
    }
}
// Reason: flat removal dispatch: one `if (remove.includes(id)) removeX()` per component, ordered so guards (line-level) precede husky (block-level); high branch COUNT mirrors the component list, each branch a single delegated call
// fallow-ignore-next-line complexity
function applyRemovals(cwd, remove, prevConfig, gitRoot, pkgRel, dryRun, selection) {
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
    if (remove.includes('agentHooks'))
        removeHookScripts(gitRoot, { dryRun });
    // searchSteering/agentHooks own hook registrations. Re-derive the survivors and re-install:
    // installHookRegistrations strips ALL devkit hooks first, so the deselected one's entries drop
    // and only the still-selected component's entries are re-added (idempotent). With none left,
    // strip-only via removeHookRegistrations.
    if (remove.includes('searchSteering') || remove.includes('agentHooks')) {
        const survivors = [
            selection.searchSteering && !remove.includes('searchSteering') && 'searchSteering',
            selection.agentHooks && !remove.includes('agentHooks') && 'agentHooks',
        ].filter((x) => Boolean(x));
        if (survivors.length)
            installHookRegistrations(gitRoot, survivors, { dryRun });
        else
            removeHookRegistrations(gitRoot, { dryRun });
    }
    if (remove.includes('structure'))
        removeStructure(cwd, prevConfig, dryRun);
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
    if (selection.guards?.includes('fanout') || selection.guards?.includes('size')) {
        console.log('  freeze baselines (grandfather current tree)');
        runFreezes(cwd, dryRun);
    }
    // Optional machine-global shim closes the plain-commit gap; `devkit clean --global` removes it.
    const globalCommitGate = Boolean(plan.globalCommitGate);
    const prevConfig = readJson(join(cwd, '.devkit', 'config.json'));
    const review = normalizeReviewProfile(plan.review ?? prevConfig?.review, selection.guards ?? [], prevConfig !== null);
    if (globalCommitGate) {
        console.log('  global pre-commit gate (opt-in — survives husky reclaim on a plain `git commit`)');
        installGlobalHook({ dryRun });
    }
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
            // Record what was actually wired so clean/doctor are selection-aware. fallow reflects the
            // ACTUAL outcome (fallowWired) — an aborted install (no binary) records false.
            components: {
                guards: [...(selection.guards ?? [])],
                skills: Boolean(selection.skills),
                agents: Boolean(selection.agents),
                agentHooks: Boolean(selection.agentHooks),
                searchSteering: false, // never wired in overlay (no resolvable bin without the package)
                fallow: fallowWired,
                agentTargets: [...(selection.agentTargets ?? AGENT_TARGETS)],
            },
            review,
        }, null, 2)}\n`);
        console.log('  ✓ wrote .devkit/config.json (git-ignored)');
    }
    console.log(`\n${dryRun ? 'Dry-run complete (nothing written).' : 'devkit overlay complete — local-only.'}`);
    console.log(globalCommitGate
        ? '  Global pre-commit gate wired — a plain `git commit` stays gated across `bun install`s.'
        : '  Re-run `devkit init --overlay` after a `bun install` (husky re-claims core.hooksPath),\n  or add --global-commit-gate once to gate plain `git commit` too.');
}
// Sync skills / agents / agent-hook scripts + their hook registrations to the SELECTED agent
// surface(s) (.claude / .cursor), then prune any surface a prior run installed but that's now
// deselected. Repo-wide → operates on the git root. Returns the resolved agentTargets (for config).
// Reason: flat orchestration: ordered `if (selection.x) syncX()` steps (skills → agents → hook scripts → registrations → prune) that must run in dependency order since registrations reference the scripts synced first; branch COUNT is the surface count, each step trivial
// fallow-ignore-next-line complexity
function installAgentSurfaces(gitRoot, selection, dryRun, override = () => false) {
    const agentTargets = selection.agentTargets ?? AGENT_TARGETS;
    if (selection.skills) {
        console.log('7. skills');
        // Skills are repo-wide → sync to the git root's selected agent surface(s) (+ manifest). A
        // consumer's own same-named skill is preserved unless `override` adopts it (resolveAssetConflicts).
        syncSkills(dryRun ? ['--dry-run'] : [], gitRoot, agentTargets, { override });
    }
    if (selection.agents) {
        console.log('7a. agents');
        // Agents are repo-wide too → sync to the git root's selected agent surface(s) (+ manifest).
        syncAgents(dryRun ? ['--dry-run'] : [], gitRoot, agentTargets, { override });
    }
    // Agent-hook scripts (agentHooks) live under <surface>/hooks; the registrations below reference
    // them, so sync the scripts first.
    if (selection.agentHooks) {
        console.log('7b. agent-hook scripts');
        syncHookScripts(gitRoot, { dryRun, targets: agentTargets, override });
    }
    // Register the agent hooks each selected component owns into the selected surfaces' settings.
    const hookComponents = [
        selection.searchSteering && 'searchSteering',
        selection.agentHooks && 'agentHooks',
    ].filter((x) => Boolean(x));
    if (hookComponents.length) {
        console.log('7c. agent hook registrations');
        installHookRegistrations(gitRoot, hookComponents, { dryRun, targets: agentTargets });
    }
    pruneDeselectedSurfaces(gitRoot, selection, agentTargets, hookComponents, dryRun);
    return agentTargets;
}
// A previous run may have synced to BOTH surfaces; if a surface is now deselected, remove devkit's
// files from it (manifests kept — the surviving surface still tracks them). Only for components
// staying selected; a fully-deselected component is removed wholesale by applyRemovals. Skipped on a
// fresh install where the dropped surface has no devkit dir (no work, no noise).
function pruneDeselectedSurfaces(gitRoot, selection, agentTargets, hookComponents, dryRun) {
    const prunedTargets = AGENT_TARGETS.filter((t) => !agentTargets.includes(t));
    // Settings file holding hook registrations differs per surface (Claude settings.json vs Cursor
    // hooks.json) — searchSteering writes one without a hooks/ script dir, so check it too.
    const settingsFile = {
        claude: '.claude/settings.json',
        cursor: '.cursor/hooks.json',
    };
    const hasPrunableContent = prunedTargets.some((t) => ['skills', 'agents', 'hooks'].some((kind) => existsSync(join(gitRoot, `.${t}`, kind))) ||
        existsSync(join(gitRoot, settingsFile[t])));
    if (!prunedTargets.length || !hasPrunableContent)
        return;
    console.log(`7d. prune deselected agent surface(s): ${prunedTargets.join(', ')}`);
    if (selection.skills)
        removeSkills(gitRoot, dryRun, prunedTargets, false);
    if (selection.agents)
        removeAgents(gitRoot, dryRun, prunedTargets, false);
    if (selection.agentHooks)
        removeHookScripts(gitRoot, { dryRun, targets: prunedTargets, dropManifest: false });
    if (hookComponents.length)
        removeHookRegistrations(gitRoot, { dryRun, targets: prunedTargets });
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
    const { stack, selection, remove = [], force = false, dryRun = false, interactive = false, scanRoots = null, standalone = false, overlay = false, selfHost = false, regenStructureBaselines = true, } = plan;
    // Structure-lint: config-driven stacks (react-app, component-lib) run via devkit's own eslint (the
    // `guard-structure` bin), so they work even in standalone (no consumer eslint/plugin). Electron's
    // preset needs consumer-side eslint/parser/plugin, so it stays package-only.
    const isStructure = selection.structure &&
        STRUCTURE_STACKS.has(stack) &&
        (!standalone || CONFIG_DRIVEN_STRUCTURE.has(stack));
    // The stack-resolved structure-lint command, joined to the deterministic orchestrator via
    // `--structure` (so a structure violation lands in the SAME aggregated report as the guards).
    // Config-driven stacks run devkit's own `guard-structure` bin (no consumer eslint dep — the
    // orchestrator resolves it as a sibling module); electron keeps its consumer-side `bunx eslint
    // src`. Undefined when structure is off → no `--structure` arg emitted.
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
        installStructureFiles(cwd, stack, force, dryRun);
    else
        installConfigs(cwd, selection, force, dryRun);
    applyScanRoots(cwd, scanRoots, dryRun);
    // Line-growth block: write the cap only on FIRST adoption (so step-4's freeze grandfathers giants)
    // and only when the size guard runs it. An adopted repo enables it via `devkit upgrade` (freeze +
    // cap in one step), never here — this apply pass would set the cap with no matching freeze.
    applyMaxLines(cwd, 
    // Self-host never writes maxLines — guard.config.json is hand-owned (and has no maxLines by design).
    !selfHost &&
        !repoAdopted(cwd) &&
        Boolean(selection.lineGrowth) &&
        selection.guards.includes('size'), dryRun);
    // Standalone AND self-host touch NO package.json: standalone keeps a shared repo dep-free;
    // self-host must never add @norvalbv/devkit as a dependency on ITSELF (the whole reason a plain
    // `devkit init` can't run here).
    if (!standalone && !selfHost) {
        console.log('2. package.json');
        patchPackageJson(cwd, devkitRef, selection, isStructure, dryRun, stack);
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
    // Skills / agents / agent-hooks → the selected agent surface(s), with a prune of any now-dropped
    // surface a prior run installed. First resolve the non-devkit-collision policy (preserve the
    // consumer's own same-named assets unless they opt in — interactive picker / --force). Returns the
    // resolved agentTargets (recorded in the config below).
    const override = await resolveAssetConflicts(gitRoot, selection, { interactive, force });
    const agentTargets = installAgentSurfaces(gitRoot, selection, dryRun, override);
    if (selection.fallow) {
        console.log('8. fallow (optional code-health layer)');
        await applyFallow(cwd, dryRun, interactive);
    }
    if (selection.searchCode) {
        console.log('8b. search-code (opt-in semantic search)');
        installSearchCode(cwd, dryRun);
    }
    // Removals (deselected + present).
    applyRemovals(cwd, remove, prevConfig, gitRoot, pkgRel, dryRun, selection);
    // .devkit/config.json with the component selection.
    console.log('9. .devkit/config.json');
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
        searchCode: Boolean(selection.searchCode),
        lineGrowth: Boolean(selection.lineGrowth),
        agentTargets: [...agentTargets],
        guards: selection.husky ? [...selection.guards] : [],
    };
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
        // source-mode hook instead of the `bunx guard-*` one.
        selfHost,
        components,
        review: normalizeReviewProfile(plan.review ?? prevConfig?.review, components.guards, prevConfig !== null, selection.husky),
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
    // Keep the gate engine's regenerated .devkit/ caches out of git (package/standalone; overlay
    // already hides all of .devkit/ via .git/info/exclude). Specific files only — manifests stay tracked.
    ensureDevkitCacheGitignore(cwd, dryRun);
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
    const flags = parseFlags(args);
    const detectedStack = flags.stack ?? detectStack(cwd);
    // Mode: --overlay / --standalone seed it; the wizard asks (so the interactive flow exposes it).
    const detectedMode = flags.overlay ? 'overlay' : flags.standalone ? 'standalone' : 'package';
    const interactive = !flags.yes && process.stdout.isTTY && !flags.dryRun;
    let stack = detectedStack;
    let selection;
    let remove = [];
    let mode = detectedMode;
    let review;
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
    // Self-host is package-name detected and deterministic, bypassing wizard/flags to preserve its bespoke config.
    const selfHost = isDevkitRepo(cwd);
    if (selfHost) {
        mode = 'self-host';
        selection = selfHostSelection();
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
        // The wizard returns a complete selection after overlay constraints fill package-only fields.
        selection = result.selection;
    }
    else {
        selection = selectionFromFlags(flags);
    }
    // Resolve overlay invariants before consumers validate or record them (Husky is always effective).
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
    });
    if (interactive && !selfHost)
        outro('Done — run `devkit doctor` to verify.');
    return 0;
}
export { detectInstalled, parseFlags, selectionFromFlags };
