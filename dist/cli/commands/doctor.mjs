/** `devkit doctor` diagnoses init drift. Read-only unless `--fix`; it never refreshes baselines.
 * Exit: 0 all-ok, 1 drift, 2 not-initialized. */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QAVIS_RECIPE, qavisOnPath } from "../../gate-engine/qavis-advisory/check.mjs";
import { RECOMMENDED_GUARD_IDS, structureCmdFor } from "../lib/components.mjs";
import { detectGitRoot } from "../lib/detect-git-root.mjs";
import { checkAgentAssets, checkRegistrations } from "../lib/doctor/asset-checks.mjs";
import { check } from "../lib/doctor/check-result.mjs";
import { checkHookRunner, checkHusky } from "../lib/doctor/hook-checks.mjs";
import { runSelfHostDoctor } from "../lib/doctor/self-host-doctor.mjs";
import { packageDir, readJson } from "../lib/fs-helpers.mjs";
import { checkCommitMsgHook, commitMsgGuards } from "../lib/husky/commit-msg-block.mjs";
import { extractGuardBlock, QAVIS_ADVISORY_ID } from "../lib/husky/husky-block.mjs";
import { resolveExistingAgentProviders, SUPPORTED_AGENT_PROVIDERS, } from "../lib/install/agent-providers.mjs";
import { selectedHookAssets } from "../lib/install/hook-registration-ledger/selection.mjs";
import { HEAL_ALIAS_NAME, isHealAlias, syncOverlayHook } from "../lib/overlay.mjs";
import { globalHookInstalled, globalInitPath } from "../lib/overlay-global-hook.mjs";
import { cmpSemver } from "./update.mjs";
// A devkit dep ref counts as "pinned" when it ends in a #v<digit> tag.
const PINNED_TAG = /#v\d/;
// Devkit modules are .mts in source and .mjs when installed; runtime string paths need the live ext.
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
function checkConfig(cwd) {
    if (!existsSync(join(cwd, '.devkit', 'config.json'))) {
        return check('.devkit/config.json', 'MISSING', 'not initialized', 'run `devkit init`');
    }
    return check('.devkit/config.json', 'OK', 'present');
}
// Structure-lint check (only when `structure` is selected). `structure` is NOT a guard, so
// checkHusky never verifies it. Structure joins the deterministic orchestrator via a `--structure
// "<cmd>"` arg on the `guard-deterministic` line: config-driven stacks run devkit's own
// `guard-structure gate` (no consumer eslint dep); electron keeps its consumer-side `bunx eslint
// src`. Match that exact arg — its absence means structure-lint is not wired.
function checkStructureLint(cwd, stack) {
    const { gitRoot, pkgRel } = detectGitRoot(cwd);
    const hookPath = join(gitRoot, '.husky', 'pre-commit');
    if (!existsSync(hookPath)) {
        return check('structure-lint', 'MISSING', 'no hook', 'run `devkit init`', true);
    }
    const block = extractGuardBlock(readFileSync(hookPath, 'utf8'), pkgRel) ?? '';
    const expectedCmd = structureCmdFor(stack);
    if (!block.includes(`--structure "${expectedCmd}"`)) {
        return check('structure-lint', 'DRIFT', `no \`--structure "${expectedCmd}"\` on the guard-deterministic line`, 'run `devkit init --force` to enable it', true);
    }
    return check('structure-lint', 'OK', `runs \`${expectedCmd}\``);
}
// Strip // line comments so a jsonc config parses as JSON.
const JSONC_LINE_COMMENT_RE = /^\s*\/\/.*$/gm;
function jsoncText(path) {
    return readFileSync(path, 'utf8').replace(JSONC_LINE_COMMENT_RE, '');
}
// Tolerant read for repair only; drift checks parse strictly and report syntax errors.
function readJsonc(path) {
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(jsoncText(path));
    }
    catch {
        return null;
    }
}
// Expected extends are shared by check and repair. Package Biome presets mirror templates by stack;
// standalone uses separately vendored .devkit paths, so keep its stack list aligned with standalone.
const PKG_REACT_BIOME = new Set(['react-app', 'component-lib']);
function expectedExtends(stack, standalone) {
    return {
        biome: standalone
            ? `./.devkit/biome/${['electron', 'react-app', 'next', 'component-lib'].includes(stack) ? 'react' : 'base'}.jsonc`
            : `@norvalbv/devkit/biome/${PKG_REACT_BIOME.has(stack) ? 'react' : 'base'}`,
        tsconfig: standalone
            ? `./.devkit/tsconfig/${stack === 'next' ? 'next' : stack === 'node-service' ? 'node' : 'base'}.json`
            : '@norvalbv/devkit/tsconfig/base',
    };
}
function checkExtends(cwd, file, expected, key = 'extends', overridden = false) {
    const path = join(cwd, file);
    if (!existsSync(path)) {
        return check(file, 'MISSING', 'absent', 'run `devkit init`', true);
    }
    let parsed;
    try {
        parsed = JSON.parse(jsoncText(path));
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return check(file, 'DRIFT', `invalid JSON: ${msg}`, 'fix the JSON syntax, then re-run');
    }
    // configOverrides marks deliberate hand-ownership, but only after syntax validation.
    if (overridden) {
        return check(file, 'OK', 'intentional override (configOverrides)');
    }
    const ext = parsed[key];
    const list = Array.isArray(ext) ? ext : [ext];
    if (!list.includes(expected)) {
        return check(file, 'DRIFT', `${key} is ${JSON.stringify(ext)}`, `should extend "${expected}" (if intentional, add "${file}" to .devkit/config.json configOverrides)`);
    }
    return check(file, 'OK', `extends ${expected}`);
}
async function checkGuardConfig(cwd) {
    const path = join(cwd, 'guard.config.json');
    if (!existsSync(path)) {
        return check('guard.config.json', 'MISSING', 'absent', 'run `devkit init`', true);
    }
    // resolveGuardConfig throws on a corrupt file — that's the validity signal.
    try {
        const mod = (await import(__rewriteRelativeImportExtension(pathToFileURL(join(packageDir(), 'gate-engine', `config${SELF_EXT}`)).href)));
        mod.resolveGuardConfig(cwd);
        return check('guard.config.json', 'OK', 'valid (resolveGuardConfig parsed it)');
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return check('guard.config.json', 'DRIFT', msg, 'fix the config JSON');
    }
}
// searchSteering: the guard + counter engine bins are present in the installed package.
function checkSearchToolBins() {
    const dir = join(packageDir(), 'gate-engine', 'search-tool');
    const missing = [`search-tool-guard${SELF_EXT}`, `search-tool-counter${SELF_EXT}`].filter((f) => !existsSync(join(dir, f)));
    if (missing.length) {
        return check('search-steering bins', 'MISSING', `engine bin(s) absent: ${missing.join(', ')}`, 'reinstall @norvalbv/devkit');
    }
    return check('search-steering bins', 'OK', 'guard + counter present');
}
function checkBaselines(cwd) {
    const has = (p) => existsSync(join(cwd, 'eslint', 'baselines', p));
    const present = ['fanout', 'size'].filter((n) => has(`${n}.json`));
    // A ratchet baseline holds ONLY grandfathered debt and is cut once at init. An absent one means
    // "no debt — cap enforced from guard.config.json", which is healthy, not drift. So this is purely
    // informational: never MISSING, never a --fix target.
    return check('baselines', 'OK', present.length
        ? `grandfathered debt: ${present.join(' + ')}`
        : 'no grandfathered debt (enforced from config)');
}
function checkPin(cwd) {
    const pkg = readJson(join(cwd, 'package.json'));
    const ref = pkg?.devDependencies?.['@norvalbv/devkit'] ?? pkg?.dependencies?.['@norvalbv/devkit'];
    if (!ref)
        return check('devkit pin', 'MISSING', 'not a dependency', 'run `devkit init`', true);
    if (PINNED_TAG.test(ref))
        return check('devkit pin', 'OK', `pinned ${ref.split('#').pop()}`);
    return check('devkit pin', 'DRIFT', 'not pinned to a #v* tag (bare SHA/branch)', 'pin to #v<version> for reproducible installs');
}
const SEMVER = /^\d+\.\d+\.\d+$/;
// Warn if the RUNNING devkit is OLDER than the version this repo was set up with (stamped in
// .devkit/config.json at init) or below a hand-declared `minDevkit` floor. Read-only, warn-only —
// a contributor on a stale devkit is told to `devkit update`, never blocked. Uses .devkit/config.json
// only (NOT package.json), so overlay/standalone repos introduce nothing into the shared tree.
export function checkVersion(cwd) {
    const pkg = readJson(join(packageDir(), 'package.json'));
    const running = pkg?.version;
    if (!running || !SEMVER.test(running))
        return check('devkit version', 'OK', 'unknown');
    const cfg = readJson(join(cwd, '.devkit', 'config.json'));
    const min = cfg?.minDevkit;
    // The init-time devkit version is the `devkitRef` pin (`vX.Y.Z`). Use it as the drift baseline
    // when it's a clean version tag — devkitRef can also be 'main'/a branch/SHA, which has no baseline.
    const ref = cfg?.devkitRef;
    const stamped = typeof ref === 'string' && ref.startsWith('v') ? ref.slice(1) : undefined;
    if (min && SEMVER.test(min) && cmpSemver(running, min) < 0) {
        return check('devkit version', 'DRIFT', `installed ${running} < required minimum ${min}`, 'devkit update');
    }
    if (stamped && SEMVER.test(stamped) && cmpSemver(running, stamped) < 0) {
        return check('devkit version', 'DRIFT', `installed ${running} older than this repo's init (${stamped})`, 'devkit update');
    }
    // Echo whichever floors are declared so a satisfied min/stamp is visibly active, not silent.
    const meta = [stamped && `repo init ${stamped}`, min && `min ${min}`].filter(Boolean).join(', ');
    return check('devkit version', 'OK', `installed ${running}${meta ? ` (${meta})` : ''}`);
}
// Configs whose drifted `extends` pointer --fix can repair IN PLACE (kind → expectedExtends key).
// The top-level config is the CONSUMER's (it carries paths, libs, plugins, overrides); only the
// pointer it extends is devkit-owned. guard.config.json is excluded: --fix never touches its content
// — it's only recreated when MISSING (by plain, create-if-absent init).
const EXTENDS_REPAIRABLE = {
    'biome.jsonc': 'biome',
    'tsconfig.json': 'tsconfig',
};
// Replace only the devkit extends token, preserving comments and consumer deltas.
function repairExtends(path, expected) {
    if (!existsSync(path))
        return false;
    const ext = readJsonc(path)?.extends;
    const list = Array.isArray(ext) ? ext : ext == null ? [] : [ext];
    if (list.includes(expected))
        return false;
    const old = list.find((v) => typeof v === 'string' && v.includes('devkit'));
    if (!old)
        return false;
    const raw = readFileSync(path, 'utf8');
    const next = raw.replace(JSON.stringify(old), JSON.stringify(expected));
    if (next === raw)
        return false;
    writeFileSync(path, next);
    return true;
}
// Reproduce the recorded selection rather than the all-on `--yes` default.
function selectionFlags(sel) {
    const flags = ['--yes'];
    const toggles = [
        'biome',
        'tsconfig',
        'skills',
        'agents',
        'husky',
        'structure',
    ];
    for (const id of toggles) {
        if (sel[id] === false)
            flags.push(`--no-${id}`);
    }
    if (sel.lineGrowth === false)
        flags.push('--no-line-growth');
    for (const [id, flag] of [
        ['fallow', '--fallow'],
        ['searchSteering', '--search-steering'],
        ['agentHooks', '--agent-hooks'],
        ['searchCode', '--search-code'],
    ])
        if (sel[id])
            flags.push(flag);
    if (!sel.guards?.length)
        flags.push('--no-guards');
    else
        flags.push('--guards', sel.guards.join(','));
    for (const t of SUPPORTED_AGENT_PROVIDERS) {
        if (sel.agentTargets && !sel.agentTargets.includes(t))
            flags.push(`--no-${t}`);
    }
    return flags;
}
// --fix repairs only fixable findings, preserves tuned config content, and never refreezes.
// Missing files/hooks use init with the recorded selection and install mode.
// Reason: flat repair orchestration: independent sequential `if (this kind drifted) repair it` steps (extends-repair loop, init re-run, sync-skills, recreate-missing-baseline) with near-zero nesting; high branch COUNT, each a trivial guarded fixup. Splitting scatters the deliberate repair ordering.
// fallow-ignore-next-line complexity
function applyFix(cwd, results, sel, stack, standalone) {
    console.log('\n--fix: re-running idempotent steps for the recorded selection...');
    // Repair only the mode-correct extends pointer; init recreates missing configs below.
    const want = expectedExtends(stack, standalone);
    for (const r of results) {
        const kind = EXTENDS_REPAIRABLE[r.name];
        if (kind && r.status === 'DRIFT' && repairExtends(join(cwd, r.name), want[kind])) {
            console.log(`  ✓ repaired ${r.name} extends → ${want[kind]}`);
        }
    }
    // MISSING template files / husky drift → init for the recorded selection (idempotent).
    const needsInit = results.some((r) => r.fixable &&
        r.status === 'MISSING' &&
        r.name !== 'baselines' &&
        r.name !== 'skills' &&
        r.name !== 'agents');
    // The guard blocks (pre-commit + commit-msg) AND the structure-lint `--structure` arg are all
    // rebuilt by init from the recorded selection — so a drifted result on any of them takes the
    // same init repair path (each flags itself fixable, else --fix would no-op it).
    // `r.fixable` is part of the condition, not just the name: a hook check can now report a problem
    // init CANNOT repair (a hand-written gate call OUTSIDE the managed block — regenerating the block
    // leaves it untouched). Without this, --fix re-inits on every run and the warning never clears.
    const HOOK_CHECKS = new Set(['.husky/pre-commit', '.husky/commit-msg', 'structure-lint']);
    const hookDrift = results.some((r) => r.fixable &&
        (HOOK_CHECKS.has(r.name) || r.name === 'agent-hooks' || r.name === 'hook registrations') &&
        r.status !== 'OK');
    if (needsInit || hookDrift) {
        const args = ['init', '--stack', stack, ...selectionFlags(sel)];
        if (standalone)
            args.push('--standalone');
        execFileSync(process.execPath, [join(packageDir(), 'cli', `index${SELF_EXT}`), ...args], {
            cwd,
            stdio: 'inherit',
        });
    }
    const skills = results.find((r) => r.name === 'skills');
    if (skills?.fixable && skills.status !== 'OK') {
        execFileSync(process.execPath, [join(packageDir(), 'cli', `index${SELF_EXT}`), 'sync-skills'], {
            cwd,
            stdio: 'inherit',
        });
    }
    const agents = results.find((r) => r.name === 'agents');
    if (agents?.fixable && agents.status !== 'OK') {
        execFileSync(process.execPath, [join(packageDir(), 'cli', `index${SELF_EXT}`), 'sync-agents'], {
            cwd,
            stdio: 'inherit',
        });
    }
    // Baselines are cut at init; an explicit re-cut uses `guard-* freeze`, never doctor.
}
/**
 * qavis-advisory health — ADVISORY, printed by every doctor mode, never a CheckResult and never a
 * `--fix` target. Deliberately outside the exit code: a repo that keeps the guard selected but has
 * no qavis installed is a choice, not drift.
 *
 * What it catches is the gate's one blind spot: it fails OPEN when qavis can't be reached, so a
 * missing binary looks exactly like a healthy "nothing to QA" at commit time. Resolved against the
 * git ROOT because that's the cwd the husky fragment shells the gate from — doctor should report
 * what the hook would actually see, not what this cwd sees.
 */
export function printQavisAdvisoryHealth(cwd, guards) {
    if (!guards.includes(QAVIS_ADVISORY_ID))
        return;
    const { gitRoot } = detectGitRoot(cwd);
    if (!existsSync(join(gitRoot, QAVIS_RECIPE))) {
        console.log(`  · ${QAVIS_ADVISORY_ID}: no ${QAVIS_RECIPE} — gate inert (nothing to QA)`);
    }
    else if (!qavisOnPath()) {
        console.log(`  · ${QAVIS_ADVISORY_ID}: ${QAVIS_RECIPE} present but qavis is NOT on PATH — the QA advisory is skipped on every commit (install qavis, or drop the guard)`);
    }
    else {
        console.log(`  ✓ ${QAVIS_ADVISORY_ID}: qavis on PATH (${QAVIS_RECIPE} present)`);
    }
}
// The default component selection (pre-`components`-block configs, and the all-on fallback).
const DEFAULT_DOCTOR_SEL = {
    biome: true,
    tsconfig: true,
    skills: true,
    husky: true,
    structure: false,
    guards: [...RECOMMENDED_GUARD_IDS],
};
// Overlay health is gated by its local hook + hooksPath; agent assets and fallow are advisory.
// Reason: flat signal reporting keeps the exit code gated only on hook + path.
// fallow-ignore-next-line complexity
async function runOverlayDoctor(cwd, cfg, fix) {
    // hooksPath and its alias are repo-wide, including for a monorepo package.
    const { gitRoot } = detectGitRoot(cwd);
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
    const pathOk = hooksPath === '.devkit/hooks';
    console.log('devkit doctor — overlay (local-only)\n');
    if (!hookOk)
        console.log('  ✗ .devkit/hooks/pre-commit MISSING — run `devkit doctor --fix` (or `devkit init --overlay`)');
    else if (fix && (sync.missing || sync.drift))
        console.log('  ✓ .devkit/hooks/pre-commit regenerated (was stale/missing — refreshed to the current devkit)');
    else if (sync.drift)
        console.log('  ⚠ .devkit/hooks/pre-commit is STALE (predates the current devkit) — run `devkit doctor --fix` to refresh');
    else
        console.log('  ✓ .devkit/hooks/pre-commit present');
    console.log(`  ${pathOk ? '✓' : '⚠'} core.hooksPath = ${hooksPath || '(unset)'}${pathOk ? '' : ` — heal with \`git ${HEAL_ALIAS_NAME}\` (re-points it) or re-run \`devkit init --overlay\``}`);
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
        advise(checkAgentAssets(cwd, 'skills', surfaces, { guards: sel.guards ?? [] }));
    if (sel.agents && surfaces.length)
        advise(checkAgentAssets(cwd, 'agents', surfaces));
    if (hooks.scripts.length && surfaces.length)
        advise(checkAgentAssets(cwd, 'hooks', surfaces, { expected: hooks.scripts }));
    if (hooks.components.length && surfaces.length)
        advise(checkRegistrations(cwd, hooks.components, surfaces, true));
    printQavisAdvisoryHealth(cwd, sel.guards ?? []);
    if (sel.fallow) {
        const wired = hookOk &&
            readFileSync(join(gitRoot, '.devkit', 'hooks', 'pre-commit'), 'utf8').includes('fallow audit');
        console.log(`  ${wired ? '✓' : '·'} fallow gate: ${wired ? 'wired in the local hook' : 'not wired'}`);
    }
    // A stale hook is unhealthy (exit 1) so CI/agents notice; --fix having just regenerated it heals this run.
    return hookOk && pathOk && (fix || !sync.drift) ? 0 : 1;
}
// Self-host (the devkit repo dogfooding itself) doctor: the ONE health signal is whether the
// committed source hook still matches what the CURRENT generator produces — a mismatch means the
// generator changed without a regen, or the hook was hand-edited. `--fix` regenerates it. Skills/
// agents are advisory (a re-sync heals them). Pin/extends/structure/version checks don't apply —
// the configs are hand-owned local files, not `@norvalbv/devkit/*` extends, and there is no dep.
/** Build package/standalone checks from the recorded selection. */
// Reason: flat dispatch: one `if (selected) push(check())` per component; the branch COUNT is high but each is trivial and nesting is zero. Splitting obscures the check list.
// fallow-ignore-next-line complexity
async function collectResults(cwd, cfg, configResult) {
    // Selection-aware: only check the components actually installed (fresh init always records it).
    const recorded = cfg.components ?? DEFAULT_DOCTOR_SEL;
    const { gitRoot } = detectGitRoot(cwd);
    const surfaces = resolveExistingAgentProviders(gitRoot, recorded.agentTargets);
    const sel = { ...recorded, agentTargets: surfaces };
    // Standalone (no-package): biome/tsconfig extend VENDORED relative paths, and there is no devkit
    // pin to check (the whole point — no package dep).
    const standalone = Boolean(cfg.standalone);
    const stack = cfg.stack ?? 'generic';
    const expected = expectedExtends(stack, standalone);
    // Emitted configs the consumer has intentionally hand-owned — doctor treats their extends as OK.
    const overrides = new Set(cfg.configOverrides ?? []);
    const results = [configResult];
    if (sel.husky)
        results.push(checkHusky(cwd, sel.guards ?? []), checkHookRunner(cwd));
    if (sel.husky && commitMsgGuards(sel.guards ?? []).length)
        results.push(checkCommitMsgHook(cwd, sel.guards ?? []));
    if (sel.biome)
        results.push(checkExtends(cwd, 'biome.jsonc', expected.biome, 'extends', overrides.has('biome.jsonc')));
    if (sel.tsconfig)
        results.push(checkExtends(cwd, 'tsconfig.json', expected.tsconfig, 'extends', overrides.has('tsconfig.json')));
    if (sel.guards?.length || sel.structure)
        results.push(await checkGuardConfig(cwd));
    if (sel.structure && sel.husky)
        results.push(checkStructureLint(cwd, stack));
    const hooks = selectedHookAssets(sel);
    if (sel.skills && surfaces.length)
        results.push(checkAgentAssets(cwd, 'skills', surfaces, { guards: sel.guards ?? [] }));
    if (sel.agents && surfaces.length)
        results.push(checkAgentAssets(cwd, 'agents', surfaces));
    if (hooks.scripts.length && surfaces.length)
        results.push(checkAgentAssets(cwd, 'hooks', surfaces, { expected: hooks.scripts }));
    if (sel.searchSteering)
        results.push(checkSearchToolBins());
    if (hooks.components.length && surfaces.length)
        results.push(checkRegistrations(cwd, hooks.components, surfaces));
    if (sel.guards?.includes('fanout') || sel.guards?.includes('size'))
        results.push(checkBaselines(cwd));
    if (!standalone)
        results.push(checkPin(cwd));
    results.push(checkVersion(cwd));
    return { results, sel };
}
// Reason: flat CLI orchestration: sequential not-initialized short-circuit, overlay short-circuit, collectResults, print loop, then fix-if-drift; near-zero nesting, each branch a single guarded step. High branch COUNT, each trivial; splitting fragments the command's top-level flow.
// fallow-ignore-next-line complexity
export const meta = {
    name: 'doctor',
    summary: 'Diagnose drift for the installed component set (read-only).',
    help: `devkit doctor — diagnose drift for the installed component set (read-only).

Usage:
  devkit doctor [--fix]

  --fix    Re-run init for the recorded selection (recreates MISSING pieces; never re-freezes a
           baseline). In an overlay repo, regenerates a stale/missing local gate hook (e.g. after
           \`devkit update\` shipped a new hook shape). Exit 0 all-ok, 1 drift, 2 not-initialized.

Also warns if the RUNNING devkit is older than this repo's init stamp or a hand-declared
"minDevkit":"x.y.z" floor in .devkit/config.json.`,
};
export default async function run(args, cwd) {
    const fix = args.includes('--fix');
    // Not-initialized short-circuit (exit 2).
    const configResult = checkConfig(cwd);
    if (configResult.status === 'MISSING') {
        console.log('devkit doctor\n');
        console.log(`  ✗ ${configResult.name}: ${configResult.detail} — ${configResult.remediation}`);
        console.log('  (was this an overlay repo? `devkit clean` removes any leftover local git config — core.hooksPath / the git ci alias.)');
        return 2;
    }
    const cfg = (readJson(join(cwd, '.devkit', 'config.json')) ?? {});
    if (cfg.overlay)
        return runOverlayDoctor(cwd, cfg, fix);
    if (cfg.selfHost)
        return runSelfHostDoctor(cwd, cfg, fix);
    const { results, sel } = await collectResults(cwd, cfg, configResult);
    console.log('devkit doctor\n');
    const glyph = { OK: '✓', DRIFT: '⚠', MISSING: '✗' };
    for (const r of results) {
        let line = `  ${glyph[r.status]} ${r.name}: ${r.status} — ${r.detail}`;
        if (r.status !== 'OK' && r.remediation)
            line += `\n      → ${r.remediation}`;
        console.log(line);
    }
    printQavisAdvisoryHealth(cwd, sel.guards ?? []);
    const drifted = results.some((r) => r.status !== 'OK');
    if (fix && drifted) {
        applyFix(cwd, results, sel, cfg.stack ?? 'generic', Boolean(cfg.standalone));
        console.log('\n--fix applied. Re-run `devkit doctor` to confirm.');
    }
    if (!drifted) {
        console.log('\nAll checks OK.');
        return 0;
    }
    return 1;
}
export { collectResults, selectionFlags };
